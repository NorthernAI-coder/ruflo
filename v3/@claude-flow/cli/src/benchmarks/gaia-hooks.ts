/**
 * GAIA Hook Integration — ADR-135 Track F
 *
 * Wires ruflo's hook system into the GAIA agent loop lifecycle. The agent
 * loop CAN call these functions at lifecycle boundaries to get adaptive
 * routing recommendations, risk assessment, and pattern learning.
 *
 * Design:
 *   - Each function shells out to `npx @claude-flow/cli@latest hooks <sub>`
 *   - Graceful degradation: if the hooks CLI is unavailable or returns
 *     malformed output, every function returns null/no-op rather than
 *     throwing. The GAIA agent works with or without hooks present.
 *   - Timeout: 5 s per hook call (non-blocking to the agent loop).
 *
 * Lifecycle hooks fired:
 *   pre-task   — before each GAIA question → recommendations (agent type,
 *                tool subset, model, max turns)
 *   route      — before model dispatch → picks model per accumulated patterns
 *   pre-tool   — before each tool call → risk assessment + adapt or block
 *   post-tool  — after each tool call → outcome record (via post-command)
 *   post-task  — after question completion → pattern learning
 *
 * Honest gap framing (post-iter-41):
 *   HAL = 82.07% on 53-Q L1, ruflo iter 35 = 49.1%, gap = 33pp.
 *   Track F adds the OBSERVABILITY + ADAPTIVE-ROUTING primitive.
 *   ADR-135 projected +5-15pp; honest after-iter-41 estimate: +3-8pp.
 *   HAL doesn't have this primitive, but the overall gap is wider than
 *   ADR-135 originally projected.
 *
 * NOT integrated into gaia-agent.ts yet — follow-up PR wires it in.
 * Plugin sync TODO: when wiring, add --enable-hooks flag to
 *   plugins/ruflo-workflows/commands/gaia-run.md and document the hook
 *   lifecycle in plugins/ruflo-workflows/skills/gaia-debugging/SKILL.md.
 *
 * Refs: ADR-135, ADR-133, iter 41 correction, #2156
 */

import { execSync } from 'node:child_process';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK_CLI = 'npx @claude-flow/cli@latest';
const HOOK_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Recommendations returned by pre-task or route hooks.
 * All fields are optional — the hook may only have partial recommendations.
 * `confidence` is always present (defaults to 0 if hook unavailable).
 */
export interface HookRecommendations {
  /** Suggested agent type, e.g. 'researcher', 'coder'. */
  agentType?: string;
  /** Subset of tool names the hook recommends enabling for this question. */
  toolSubset?: string[];
  /** Model the hook recommends, e.g. 'claude-haiku-4-5', 'claude-sonnet-4-6'. */
  model?: string;
  /** Turn-budget recommendation from accumulated patterns. */
  maxTurns?: number;
  /** Confidence in the recommendation, 0–1. */
  confidence: number;
}

/**
 * Outcome record passed to post-task hook for pattern learning.
 */
export interface HookOutcomeRecord {
  /** Unique task ID (GaiaQuestion.task_id). */
  taskId: string;
  /** Whether the question was answered correctly. */
  success: boolean;
  /** Wall-clock milliseconds from question start to completion. */
  durationMs: number;
  /** Names of tools actually invoked during the turn sequence. */
  toolsUsed: string[];
  /** Number of AgentDB patterns stored or updated. */
  patternsLearned: number;
}

/**
 * Risk assessment returned by pre-tool hook.
 */
export interface PreToolAssessment {
  /** Whether the tool call is allowed to proceed. */
  allowed: boolean;
  /** Risk level of the proposed tool call. */
  risk: 'low' | 'medium' | 'high';
  /** Human-readable reasoning from the hook system (optional). */
  reasoning?: string;
}

/**
 * Compound benefit metrics — how much hook recommendations have improved
 * results over accumulated runs.
 */
export interface HookCompoundBenefit {
  /** Total GAIA questions that have been post-task recorded. */
  runs: number;
  /**
   * Fraction of questions where the pre-task recommendation was available
   * (0 = hooks never fired, 1 = always fired).
   */
  recommendationFollowRate: number;
  /**
   * Estimated accuracy lift (pp) from hook-guided routing over baseline.
   * Derived from stored outcomes: mean(success | followed) - mean(success | baseline).
   * Returns 0 when insufficient data (<5 runs).
   */
  estimatedLift: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type for an injectable execSync-compatible function.
 * Mirrors the signature subset used by safeExecJson.
 */
export type ExecFn = (cmd: string, opts: { encoding: 'utf-8'; timeout: number; stdio: string[] }) => string;

/**
 * Safe shell-out: runs `cmd`, returns parsed JSON or null on any error.
 * Errors are intentionally swallowed — graceful degradation is required.
 *
 * @param cmd         Shell command to run.
 * @param _execFn     Injectable executor for testing (defaults to execSync).
 */
function safeExecJson<T>(cmd: string, _execFn?: ExecFn): T | null {
  const exec = _execFn ?? (execSync as unknown as ExecFn);
  try {
    const raw = exec(cmd, {
      encoding: 'utf-8',
      timeout: HOOK_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw.trim()) as T;
  } catch {
    return null;
  }
}

/**
 * Sanitise a question text for safe inclusion in a shell argument.
 * Strips double-quotes, newlines, and limits length.
 */
function sanitiseForShell(text: string, maxLen = 200): string {
  return text
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Raw hook response shapes (internal — not exported)
// ---------------------------------------------------------------------------

interface RawPreTaskResponse {
  suggestedAgent?: string;
  suggestedTools?: string[];
  suggestedModel?: string;
  suggestedMaxTurns?: number;
  confidence?: number;
}

interface RawRouteResponse {
  model?: string;
  tools?: string[];
  agentType?: string;
  maxTurns?: number;
  confidence?: number;
}

interface RawPreCommandResponse {
  allowed?: boolean;
  risk?: string;
  reasoning?: string;
}

interface RawPostTaskResponse {
  recorded?: boolean;
  patternsTriggered?: number;
}

interface RawMetricsResponse {
  totalRuns?: number;
  recommendationFollowRate?: number;
  estimatedLift?: number;
}

// ---------------------------------------------------------------------------
// Hook client factory
// ---------------------------------------------------------------------------

/**
 * GaiaHookClient: all hook functions bound to a specific exec implementation.
 *
 * In production, use the module-level singletons (which use real execSync).
 * In tests, call `createGaiaHookClient(mockExec)` to inject a mock.
 */
export interface GaiaHookClient {
  firePreTaskHook(
    question: GaiaQuestion,
    context?: { iterationContext?: string },
  ): Promise<HookRecommendations | null>;

  fireRouteHook(
    question: GaiaQuestion,
    candidates: { models: string[]; tools: string[] },
  ): Promise<HookRecommendations | null>;

  firePreToolHook(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PreToolAssessment>;

  firePostToolHook(
    toolName: string,
    success: boolean,
  ): Promise<void>;

  firePostTaskHook(
    question: GaiaQuestion,
    outcome: HookOutcomeRecord,
  ): Promise<{ recorded: boolean; patternsTriggered: number }>;

  computeHookCompoundBenefit(): Promise<HookCompoundBenefit>;
}

/**
 * Create a GaiaHookClient with an injectable exec function.
 *
 * @param _execFn  Optional override for execSync (used in tests).
 *                 When omitted, the real execSync is used.
 */
export function createGaiaHookClient(_execFn?: ExecFn): GaiaHookClient {
  function exec<T>(cmd: string): T | null {
    return safeExecJson<T>(cmd, _execFn);
  }

  async function firePreTaskHook(
    question: GaiaQuestion,
    context?: { iterationContext?: string },
  ): Promise<HookRecommendations | null> {
    const desc = sanitiseForShell(question.question);
    const ctxFlag = context?.iterationContext
      ? ` --context "${sanitiseForShell(context.iterationContext, 100)}"`
      : '';
    const cmd = `${HOOK_CLI} hooks pre-task --description "${desc}"${ctxFlag} --json`;

    const raw = exec<RawPreTaskResponse>(cmd);
    if (!raw) return null;

    return {
      agentType: raw.suggestedAgent,
      toolSubset: Array.isArray(raw.suggestedTools) ? raw.suggestedTools : undefined,
      model: raw.suggestedModel,
      maxTurns: typeof raw.suggestedMaxTurns === 'number' ? raw.suggestedMaxTurns : undefined,
      confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.5,
    };
  }

  async function fireRouteHook(
    question: GaiaQuestion,
    candidates: { models: string[]; tools: string[] },
  ): Promise<HookRecommendations | null> {
    const desc = sanitiseForShell(question.question);
    const modelsFlag = candidates.models.length
      ? ` --models "${candidates.models.join(',')}"`
      : '';
    const toolsFlag = candidates.tools.length
      ? ` --tools "${candidates.tools.join(',')}"`
      : '';
    const cmd = `${HOOK_CLI} hooks route --task "${desc}"${modelsFlag}${toolsFlag} --json`;

    const raw = exec<RawRouteResponse>(cmd);
    if (!raw) return null;

    return {
      agentType: raw.agentType,
      toolSubset: Array.isArray(raw.tools) ? raw.tools : undefined,
      model: raw.model,
      maxTurns: typeof raw.maxTurns === 'number' ? raw.maxTurns : undefined,
      confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.5,
    };
  }

  async function firePreToolHook(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PreToolAssessment> {
    const inputSummary = sanitiseForShell(JSON.stringify(input), 300);
    const cmd =
      `${HOOK_CLI} hooks pre-command --command "${toolName}" --input "${inputSummary}" --validate-safety --json`;

    const raw = exec<RawPreCommandResponse>(cmd);
    if (!raw) {
      return { allowed: true, risk: 'low' };
    }

    const risk = (raw.risk === 'high' || raw.risk === 'medium') ? raw.risk : 'low';
    const allowed = raw.allowed !== false;

    return { allowed, risk, reasoning: raw.reasoning };
  }

  async function firePostToolHook(
    toolName: string,
    success: boolean,
  ): Promise<void> {
    const cmd =
      `${HOOK_CLI} hooks post-command --command "${toolName}" --success ${success} --track-metrics --json`;
    exec(cmd); // fire-and-forget
  }

  async function firePostTaskHook(
    question: GaiaQuestion,
    outcome: HookOutcomeRecord,
  ): Promise<{ recorded: boolean; patternsTriggered: number }> {
    const cmd = [
      HOOK_CLI,
      'hooks post-task',
      `--task-id "${outcome.taskId}"`,
      `--success ${outcome.success}`,
      `--duration-ms ${outcome.durationMs}`,
      outcome.toolsUsed.length
        ? `--tools-used "${outcome.toolsUsed.join(',')}"` : '',
      '--store-results',
      '--train-neural',
      '--json',
    ].filter(Boolean).join(' ');

    const raw = exec<RawPostTaskResponse>(cmd);
    if (!raw) return { recorded: false, patternsTriggered: 0 };

    return {
      recorded: raw.recorded === true,
      patternsTriggered: typeof raw.patternsTriggered === 'number' ? raw.patternsTriggered : 0,
    };
  }

  async function computeHookCompoundBenefit(): Promise<HookCompoundBenefit> {
    const cmd = `${HOOK_CLI} hooks metrics --v3-dashboard --json`;
    const raw = exec<RawMetricsResponse>(cmd);

    if (!raw || typeof raw.totalRuns !== 'number' || raw.totalRuns < 5) {
      return { runs: 0, recommendationFollowRate: 0, estimatedLift: 0 };
    }

    return {
      runs: raw.totalRuns,
      recommendationFollowRate:
        typeof raw.recommendationFollowRate === 'number'
          ? Math.min(1, Math.max(0, raw.recommendationFollowRate))
          : 0,
      estimatedLift:
        typeof raw.estimatedLift === 'number' ? raw.estimatedLift : 0,
    };
  }

  return {
    firePreTaskHook,
    fireRouteHook,
    firePreToolHook,
    firePostToolHook,
    firePostTaskHook,
    computeHookCompoundBenefit,
  };
}

// ---------------------------------------------------------------------------
// Module-level singletons (production use — real execSync)
// ---------------------------------------------------------------------------

const _defaultClient = createGaiaHookClient();

/**
 * Fire `hooks pre-task` for a GAIA question.
 * Returns null when hook system unavailable (graceful degradation).
 */
export async function firePreTaskHook(
  question: GaiaQuestion,
  context?: { iterationContext?: string },
): Promise<HookRecommendations | null> {
  return _defaultClient.firePreTaskHook(question, context);
}

/**
 * Fire `hooks route` before model dispatch.
 * Returns null when hook system unavailable (graceful degradation).
 */
export async function fireRouteHook(
  question: GaiaQuestion,
  candidates: { models: string[]; tools: string[] },
): Promise<HookRecommendations | null> {
  return _defaultClient.fireRouteHook(question, candidates);
}

/**
 * Fire `hooks pre-command` as a pre-tool gate.
 * When `allowed === false`, the caller MUST NOT execute the tool.
 * When hook unavailable, defaults to `{ allowed: true, risk: 'low' }`.
 */
export async function firePreToolHook(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PreToolAssessment> {
  return _defaultClient.firePreToolHook(toolName, input);
}

/**
 * Fire `hooks post-command` after each tool call (fire-and-forget).
 */
export async function firePostToolHook(
  toolName: string,
  success: boolean,
): Promise<void> {
  return _defaultClient.firePostToolHook(toolName, success);
}

/**
 * Fire `hooks post-task` after question completion.
 * Records outcome for pattern learning.
 */
export async function firePostTaskHook(
  question: GaiaQuestion,
  outcome: HookOutcomeRecord,
): Promise<{ recorded: boolean; patternsTriggered: number }> {
  return _defaultClient.firePostTaskHook(question, outcome);
}

/**
 * Compute compound benefit metrics from accumulated hook runs.
 * Returns zero metrics when hook system unavailable or < 5 runs recorded.
 */
export async function computeHookCompoundBenefit(): Promise<HookCompoundBenefit> {
  return _defaultClient.computeHookCompoundBenefit();
}
