/**
 * GAIA Hooks Smoke — ADR-135 Track F
 *
 * Unit smoke tests for gaia-hooks.ts. All shell-outs are mocked via the
 * injectable `createGaiaHookClient(_execFn)` factory — zero cost, zero
 * network, zero API calls.
 *
 * Test matrix (7 tests):
 *   T1. pre-task returns valid recommendation → parsed into HookRecommendations
 *   T2. pre-task hook unavailable (exec throws) → returns null, no crash
 *   T3. pre-task returns malformed JSON → returns null, no crash
 *   T4. pre-tool hook blocks a dangerous tool → allowed=false, risk=high
 *   T5. post-task hook records outcome → recorded=true, patternsTriggered=3
 *   T6. route hook returns model recommendation → model field populated
 *   T7. computeHookCompoundBenefit — empty store + thin store → zero metrics
 *
 * Usage (no API key required):
 *   npx tsx src/benchmarks/gaia-hooks.smoke.ts
 *
 * Refs: ADR-135, ADR-133, iter 44, #2156
 */

import {
  createGaiaHookClient,
  HookOutcomeRecord,
  ExecFn,
} from './gaia-hooks.js';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Test harness (no external framework)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  PASS: ${msg}`);
    passed++;
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    console.error(`  FAIL: unexpected throw — ${(err as Error).message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Helper: build a mock ExecFn that always returns `raw`
// ---------------------------------------------------------------------------

function mockExecReturns(raw: string): ExecFn {
  return (_cmd: string, _opts: unknown) => raw;
}

function mockExecThrows(message: string): ExecFn {
  return (_cmd: string, _opts: unknown) => { throw new Error(message); };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_QUESTION: GaiaQuestion = {
  task_id: 'gaia-smoke-001',
  level: 1,
  question: 'What is the capital of France?',
  final_answer: 'Paris',
  file_name: null,
  file_path: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runSmoke(): Promise<void> {
  console.log('\n=== GAIA Hooks Smoke — ADR-135 Track F ===\n');

  // ── T1: pre-task returns valid recommendation ──
  await test('T1: pre-task returns valid recommendation', async () => {
    const payload = JSON.stringify({
      suggestedAgent: 'researcher',
      suggestedTools: ['web_search', 'calculator'],
      suggestedModel: 'claude-haiku-4-5',
      suggestedMaxTurns: 6,
      confidence: 0.85,
    });

    const client = createGaiaHookClient(mockExecReturns(payload));
    const rec = await client.firePreTaskHook(SAMPLE_QUESTION);

    assert(rec !== null, 'should return non-null recommendation');
    assert(rec?.agentType === 'researcher', `agentType should be 'researcher', got '${rec?.agentType}'`);
    assert(
      Array.isArray(rec?.toolSubset) && rec!.toolSubset!.includes('web_search'),
      `toolSubset should include 'web_search', got ${JSON.stringify(rec?.toolSubset)}`,
    );
    assert(rec?.model === 'claude-haiku-4-5', `model should be 'claude-haiku-4-5', got '${rec?.model}'`);
    assert(rec?.maxTurns === 6, `maxTurns should be 6, got ${rec?.maxTurns}`);
    assert(
      typeof rec?.confidence === 'number' && rec.confidence > 0,
      `confidence should be > 0, got ${rec?.confidence}`,
    );
  });

  // ── T2: hook unavailable (exec throws) → returns null ──
  await test('T2: pre-task hook unavailable → graceful null', async () => {
    const client = createGaiaHookClient(mockExecThrows('npx not found'));
    const rec = await client.firePreTaskHook(SAMPLE_QUESTION);
    assert(rec === null, `should return null when exec throws, got ${JSON.stringify(rec)}`);
  });

  // ── T3: malformed JSON → returns null ──
  await test('T3: pre-task returns malformed JSON → graceful null', async () => {
    const client = createGaiaHookClient(mockExecReturns('not-valid-json{{{'));
    const rec = await client.firePreTaskHook(SAMPLE_QUESTION);
    assert(rec === null, `should return null on JSON parse failure, got ${JSON.stringify(rec)}`);
  });

  // ── T4: pre-tool hook blocks dangerous tool ──
  await test('T4: pre-tool hook blocks high-risk tool call', async () => {
    const payload = JSON.stringify({
      allowed: false,
      risk: 'high',
      reasoning: 'filesystem write operations blocked in GAIA context',
    });

    const client = createGaiaHookClient(mockExecReturns(payload));
    const assessment = await client.firePreToolHook(
      'filesystem_write',
      { path: '/etc/passwd', content: 'x' },
    );

    assert(assessment.allowed === false, `allowed should be false, got ${assessment.allowed}`);
    assert(assessment.risk === 'high', `risk should be 'high', got '${assessment.risk}'`);
    assert(
      typeof assessment.reasoning === 'string' && assessment.reasoning.length > 0,
      `reasoning should be non-empty, got '${assessment.reasoning}'`,
    );
  });

  // ── T5: post-task hook records outcome ──
  await test('T5: post-task hook records outcome → recorded=true', async () => {
    const payload = JSON.stringify({
      recorded: true,
      patternsTriggered: 3,
    });

    const client = createGaiaHookClient(mockExecReturns(payload));

    const outcome: HookOutcomeRecord = {
      taskId: 'gaia-smoke-001',
      success: true,
      durationMs: 1200,
      toolsUsed: ['web_search', 'calculator'],
      patternsLearned: 3,
    };

    const result = await client.firePostTaskHook(SAMPLE_QUESTION, outcome);

    assert(result.recorded === true, `recorded should be true, got ${result.recorded}`);
    assert(result.patternsTriggered === 3, `patternsTriggered should be 3, got ${result.patternsTriggered}`);
  });

  // ── T6: route hook returns model recommendation ──
  await test('T6: route hook returns model recommendation', async () => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      tools: ['web_search'],
      agentType: 'researcher',
      maxTurns: 10,
      confidence: 0.9,
    });

    const client = createGaiaHookClient(mockExecReturns(payload));
    const rec = await client.fireRouteHook(SAMPLE_QUESTION, {
      models: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
      tools: ['web_search', 'calculator', 'python_exec'],
    });

    assert(rec !== null, 'should return non-null recommendation');
    assert(rec?.model === 'claude-sonnet-4-6', `model should be 'claude-sonnet-4-6', got '${rec?.model}'`);
    assert(
      Array.isArray(rec?.toolSubset) && rec!.toolSubset!.includes('web_search'),
      `toolSubset should include 'web_search', got ${JSON.stringify(rec?.toolSubset)}`,
    );
    assert(rec?.confidence === 0.9, `confidence should be 0.9, got ${rec?.confidence}`);
  });

  // ── T7: computeHookCompoundBenefit — empty / thin store ──
  await test('T7: computeHookCompoundBenefit on empty/thin store → zero metrics', async () => {
    // Case A: exec throws (no hooks system present)
    const clientA = createGaiaHookClient(mockExecThrows('command not found'));
    const benefitA = await clientA.computeHookCompoundBenefit();
    assert(benefitA.runs === 0, `runs should be 0, got ${benefitA.runs}`);
    assert(benefitA.estimatedLift === 0, `lift should be 0, got ${benefitA.estimatedLift}`);
    assert(
      benefitA.recommendationFollowRate === 0,
      `followRate should be 0, got ${benefitA.recommendationFollowRate}`,
    );

    // Case B: hooks system present but < 5 runs — should still return zeros
    const thinPayload = JSON.stringify({
      totalRuns: 2,
      recommendationFollowRate: 0.5,
      estimatedLift: 3,
    });
    const clientB = createGaiaHookClient(mockExecReturns(thinPayload));
    const benefitB = await clientB.computeHookCompoundBenefit();
    assert(benefitB.runs === 0, `runs should be 0 for thin store (<5), got ${benefitB.runs}`);
    assert(benefitB.estimatedLift === 0, `lift should be 0 for thin store, got ${benefitB.estimatedLift}`);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const total = passed + failed;
  console.log(`\n=== Results: ${passed}/${total} passed ===\n`);

  if (failed > 0) {
    console.error(`${failed} test(s) FAILED.\n`);
    process.exit(1);
  } else {
    console.log('All smoke tests PASSED.\n');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && (
  process.argv[1].endsWith('gaia-hooks.smoke.ts') ||
  process.argv[1].endsWith('gaia-hooks.smoke.js')
);

if (isMain) {
  runSmoke().catch((err) => {
    console.error('Smoke runner failed unexpectedly:', err);
    process.exit(1);
  });
}

export { runSmoke };
