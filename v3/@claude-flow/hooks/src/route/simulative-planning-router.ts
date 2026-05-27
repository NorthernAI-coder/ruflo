/**
 * SimulativePlanningRouter — ADR-132
 *
 * Selective depth-allocation layer that fires a low-cost Haiku "shadow pass"
 * before committing to a Tier-3 (Sonnet/Opus) dispatch.  Modelled after the
 * SR²AM self-regulated simulative-reasoning architecture (arXiv:2605.22138).
 *
 * Gate condition (§3.2 of ADR-132):
 *   task.estimatedHorizon > 5 OR task.predictedMcpCalls >= 2
 *
 * When the gate fires:
 *   1. Ask the HaikuClient to outline 3-7 execution steps (≤256 tokens).
 *   2. Parse the response into a structured SimulativePlanResult.
 *   3. Cache the result in SONA short-term store (TTL: 300 s) keyed by task.id.
 *   4. Return the result so the caller can prune tokens from the Tier-3 prompt.
 *
 * When the gate does NOT fire:
 *   Return null (caller proceeds without simulation overhead).
 *
 * Target: ≤30 ms overhead, ≥20% token reduction on multi-step tasks.
 *
 * @module @claude-flow/hooks/route/simulative-planning-router
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Structured output of one simulative planning shadow pass. */
export interface SimulativePlanResult {
  /** Ordered list of 3–7 high-level execution steps the agent should take. */
  candidateSteps: string[];
  /** Rough token budget for the full Tier-3 execution, as estimated by Haiku. */
  estimatedTokens: number;
  /** Haiku's confidence in its own plan outline, normalised to [0, 1]. */
  confidence: number;
}

/** Minimal context the route hook passes in for the gate evaluation. */
export interface RouteContext {
  /** Stable, unique identifier for the task (used as SONA cache key). */
  id: string;
  /** Natural-language description of the task. */
  task: string;
  /**
   * Estimated number of sequential reasoning steps required.
   * A value ≤ 5 with predictedMcpCalls < 2 suppresses the shadow pass.
   */
  estimatedHorizon: number;
  /**
   * Number of MCP tool invocations expected.
   * ≥ 2 triggers the shadow pass regardless of estimatedHorizon.
   */
  predictedMcpCalls: number;
}

// ---------------------------------------------------------------------------
// Collaborator interfaces (injected to keep this module testable)
// ---------------------------------------------------------------------------

/** Minimal Haiku completion client the router depends on. */
export interface HaikuClient {
  /**
   * Complete a prompt synchronously (relative to the await).
   * @param prompt   System + user prompt assembled by the router.
   * @param opts     `maxTokens` is the only required option.
   * @returns        The model's raw text response.
   */
  complete(
    prompt: string,
    opts: { maxTokens: number },
  ): Promise<string>;
}

/** Minimal SONA short-term cache the router writes to. */
export interface SonaCache {
  /**
   * Persist a simulative plan result under `key` for `ttlSeconds`.
   * Failures are swallowed (cache is best-effort).
   */
  storeShortTerm(
    key: string,
    value: SimulativePlanResult,
    opts: { ttlSeconds: number },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum horizon that triggers the shadow pass (exclusive lower bound). */
const HORIZON_GATE = 5;

/** Minimum predicted MCP calls that triggers the shadow pass. */
const MCP_CALLS_GATE = 2;

/** Token budget for the Haiku shadow pass. */
const SHADOW_PASS_MAX_TOKENS = 256;

/** SONA TTL for cached plans (seconds). */
const CACHE_TTL_SECONDS = 300;

/** Default token estimate returned when Haiku's response is unparseable. */
const DEFAULT_ESTIMATED_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

/**
 * Returns true when the task qualifies for a simulative planning pass.
 * Exported for unit testing.
 */
export function shouldSimulate(ctx: RouteContext): boolean {
  return ctx.estimatedHorizon > HORIZON_GATE || ctx.predictedMcpCalls >= MCP_CALLS_GATE;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Builds the shadow-pass prompt sent to Haiku.
 * Kept short to stay within the 256-token budget.
 * Exported for unit testing.
 */
export function buildShadowPrompt(ctx: RouteContext): string {
  return [
    'You are a planning assistant. Output ONLY a JSON object — no prose, no markdown fences.',
    '',
    'Task: ' + ctx.task,
    '',
    'Return exactly this shape:',
    '{',
    '  "steps": ["step 1", "step 2", "step 3"],  // 3-7 items, each ≤ 15 words',
    '  "estimatedTokens": 1500,                  // integer, total tokens for full execution',
    '  "confidence": 0.85                        // float 0-1',
    '}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parses Haiku's raw text into a SimulativePlanResult.
 * Falls back to safe defaults on malformed output.
 * Exported for unit testing.
 */
export function parseShadowResponse(raw: string): SimulativePlanResult {
  try {
    // Strip optional markdown code fences that some models add despite instructions.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');

    const obj = parsed as Record<string, unknown>;

    const steps = Array.isArray(obj['steps'])
      ? (obj['steps'] as unknown[])
          .filter((s): s is string => typeof s === 'string')
          .slice(0, 7)
      : [];

    const estimatedTokens =
      typeof obj['estimatedTokens'] === 'number' && obj['estimatedTokens'] > 0
        ? Math.round(obj['estimatedTokens'])
        : DEFAULT_ESTIMATED_TOKENS;

    const confidence =
      typeof obj['confidence'] === 'number'
        ? Math.max(0, Math.min(1, obj['confidence']))
        : 0.5;

    return {
      candidateSteps: steps.length > 0 ? steps : ['(plan unavailable)'],
      estimatedTokens,
      confidence,
    };
  } catch {
    return {
      candidateSteps: ['(plan parse error)'],
      estimatedTokens: DEFAULT_ESTIMATED_TOKENS,
      confidence: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Conditionally runs a simulative planning shadow pass before Tier-3 dispatch.
 *
 * @param task         Route context supplied by the pre-route hook.
 * @param haikuClient  Low-cost LLM used for the shadow pass.
 * @param sonaCache    Short-term SONA cache; results are cached for reuse.
 * @returns            A SimulativePlanResult when the gate fires, or null when
 *                     the task is too simple to warrant simulation.
 *
 * @example
 * ```ts
 * const plan = await maybeSimulatePlan(ctx, haikuClient, sonaCache);
 * if (plan) {
 *   // Prepend plan.candidateSteps to the Tier-3 system prompt.
 * }
 * ```
 */
export async function maybeSimulatePlan(
  task: RouteContext,
  haikuClient: HaikuClient,
  sonaCache: SonaCache,
): Promise<SimulativePlanResult | null> {
  // Gate: skip for simple, low-horizon tasks (ADR-132 §3.2).
  if (!shouldSimulate(task)) {
    return null;
  }

  const prompt = buildShadowPrompt(task);
  const raw = await haikuClient.complete(prompt, { maxTokens: SHADOW_PASS_MAX_TOKENS });
  const result = parseShadowResponse(raw);

  // Best-effort cache write — do not let a cache failure abort routing.
  try {
    await sonaCache.storeShortTerm(task.id, result, { ttlSeconds: CACHE_TTL_SECONDS });
  } catch {
    // intentionally swallowed
  }

  return result;
}
