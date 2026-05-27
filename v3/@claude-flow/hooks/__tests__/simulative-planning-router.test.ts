/**
 * Unit tests for SimulativePlanningRouter (ADR-132)
 *
 * Coverage targets (per ADR-132 acceptance criteria):
 *   - Gate logic: low-horizon returns null, high-horizon triggers shadow pass
 *   - Prompt builder: produces JSON-only instruction
 *   - Response parser: happy path, JSON-fence stripping, malformed fallback
 *   - maybeSimulatePlan: full integration with mock collaborators
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shouldSimulate,
  buildShadowPrompt,
  parseShadowResponse,
  maybeSimulatePlan,
  type RouteContext,
  type HaikuClient,
  type SonaCache,
} from '../src/route/simulative-planning-router.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const simpleTask: RouteContext = {
  id: 'task-001',
  task: 'Rename a variable',
  estimatedHorizon: 2,
  predictedMcpCalls: 0,
};

const complexTask: RouteContext = {
  id: 'task-002',
  task: 'Implement OAuth2 PKCE flow across auth, session, and callback modules',
  estimatedHorizon: 8,
  predictedMcpCalls: 3,
};

const borderlineMcpTask: RouteContext = {
  id: 'task-003',
  task: 'Run two MCP searches and summarise',
  estimatedHorizon: 3,
  predictedMcpCalls: 2,
};

const borderlineHorizonTask: RouteContext = {
  id: 'task-004',
  task: 'Execute exactly 6 sequential steps',
  estimatedHorizon: 6,
  predictedMcpCalls: 0,
};

const validJsonResponse = JSON.stringify({
  steps: ['Analyse auth module', 'Write token exchange', 'Add callback handler'],
  estimatedTokens: 1800,
  confidence: 0.87,
});

function makeMockHaiku(response: string): HaikuClient {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

function makeMockSona(): SonaCache & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    storeShortTerm: vi.fn(async (key: string) => {
      calls.push(key);
    }),
  };
}

// ---------------------------------------------------------------------------
// shouldSimulate (gate logic)
// ---------------------------------------------------------------------------

describe('shouldSimulate', () => {
  it('returns false for low-horizon, low-MCP task (gate stays closed)', () => {
    expect(shouldSimulate(simpleTask)).toBe(false);
  });

  it('returns true when estimatedHorizon exceeds 5', () => {
    expect(shouldSimulate(borderlineHorizonTask)).toBe(true);
  });

  it('returns true when predictedMcpCalls reaches 2', () => {
    expect(shouldSimulate(borderlineMcpTask)).toBe(true);
  });

  it('returns true for complex task (both gate conditions met)', () => {
    expect(shouldSimulate(complexTask)).toBe(true);
  });

  it('returns false at exactly horizon=5 with mcp=1 (both below gate)', () => {
    const ctx: RouteContext = { id: 'x', task: 't', estimatedHorizon: 5, predictedMcpCalls: 1 };
    expect(shouldSimulate(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildShadowPrompt
// ---------------------------------------------------------------------------

describe('buildShadowPrompt', () => {
  it('includes the task description in the prompt', () => {
    const prompt = buildShadowPrompt(complexTask);
    expect(prompt).toContain(complexTask.task);
  });

  it('requests JSON-only output (no markdown prose)', () => {
    const prompt = buildShadowPrompt(complexTask);
    expect(prompt).toContain('JSON');
    expect(prompt.toLowerCase()).toContain('no prose');
  });

  it('specifies the required shape with steps, estimatedTokens, and confidence', () => {
    const prompt = buildShadowPrompt(complexTask);
    expect(prompt).toContain('"steps"');
    expect(prompt).toContain('"estimatedTokens"');
    expect(prompt).toContain('"confidence"');
  });
});

// ---------------------------------------------------------------------------
// parseShadowResponse
// ---------------------------------------------------------------------------

describe('parseShadowResponse', () => {
  it('parses a valid JSON response into a SimulativePlanResult', () => {
    const result = parseShadowResponse(validJsonResponse);
    expect(result.candidateSteps).toHaveLength(3);
    expect(result.candidateSteps[0]).toBe('Analyse auth module');
    expect(result.estimatedTokens).toBe(1800);
    expect(result.confidence).toBeCloseTo(0.87);
  });

  it('strips markdown code fences before parsing', () => {
    const fenced = '```json\n' + validJsonResponse + '\n```';
    const result = parseShadowResponse(fenced);
    expect(result.candidateSteps).toHaveLength(3);
    expect(result.confidence).toBeCloseTo(0.87);
  });

  it('caps confidence to [0, 1] when model returns out-of-range values', () => {
    const outOfRange = JSON.stringify({ steps: ['a'], estimatedTokens: 500, confidence: 1.5 });
    expect(parseShadowResponse(outOfRange).confidence).toBe(1);

    const negative = JSON.stringify({ steps: ['a'], estimatedTokens: 500, confidence: -0.3 });
    expect(parseShadowResponse(negative).confidence).toBe(0);
  });

  it('truncates candidateSteps to 7 items', () => {
    const tooMany = JSON.stringify({
      steps: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
      estimatedTokens: 1000,
      confidence: 0.7,
    });
    expect(parseShadowResponse(tooMany).candidateSteps).toHaveLength(7);
  });

  it('falls back gracefully on malformed JSON', () => {
    const result = parseShadowResponse('not valid json at all {{ }}');
    expect(result.candidateSteps).toHaveLength(1);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.confidence).toBe(0);
  });

  it('falls back gracefully on empty string', () => {
    const result = parseShadowResponse('');
    expect(result.confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maybeSimulatePlan — integration
// ---------------------------------------------------------------------------

describe('maybeSimulatePlan', () => {
  let haiku: HaikuClient;
  let sona: ReturnType<typeof makeMockSona>;

  beforeEach(() => {
    haiku = makeMockHaiku(validJsonResponse);
    sona = makeMockSona();
  });

  it('returns null and never calls Haiku for simple tasks (gate closed)', async () => {
    const result = await maybeSimulatePlan(simpleTask, haiku, sona);
    expect(result).toBeNull();
    expect(haiku.complete).not.toHaveBeenCalled();
    expect(sona.storeShortTerm).not.toHaveBeenCalled();
  });

  it('returns a SimulativePlanResult for complex tasks (gate open)', async () => {
    const result = await maybeSimulatePlan(complexTask, haiku, sona);
    expect(result).not.toBeNull();
    expect(result!.candidateSteps.length).toBeGreaterThan(0);
    expect(result!.estimatedTokens).toBeGreaterThan(0);
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
  });

  it('calls Haiku with maxTokens=256', async () => {
    await maybeSimulatePlan(complexTask, haiku, sona);
    expect(haiku.complete).toHaveBeenCalledWith(
      expect.any(String),
      { maxTokens: 256 },
    );
  });

  it('stores the result in SONA under task.id with ttlSeconds=300', async () => {
    await maybeSimulatePlan(complexTask, haiku, sona);
    expect(sona.storeShortTerm).toHaveBeenCalledWith(
      complexTask.id,
      expect.objectContaining({ candidateSteps: expect.any(Array) }),
      { ttlSeconds: 300 },
    );
  });

  it('still returns a result even when SONA cache write fails', async () => {
    const failingSona: SonaCache = {
      storeShortTerm: vi.fn().mockRejectedValue(new Error('cache unavailable')),
    };
    const result = await maybeSimulatePlan(complexTask, haiku, failingSona);
    expect(result).not.toBeNull();
  });

  it('handles Haiku returning malformed JSON gracefully (no throw)', async () => {
    const badHaiku = makeMockHaiku('oops, I forgot JSON format');
    const result = await maybeSimulatePlan(complexTask, badHaiku, sona);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0);
  });

  it('triggers on MCP-call boundary (predictedMcpCalls=2) independent of horizon', async () => {
    const result = await maybeSimulatePlan(borderlineMcpTask, haiku, sona);
    expect(result).not.toBeNull();
    expect(haiku.complete).toHaveBeenCalled();
  });
});
