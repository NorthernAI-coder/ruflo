/**
 * GAIA Phase 2 — Gemini 2.5 Pro Thinking 5-Question Pilot
 *
 * Runs 5 diverse questions through the Gemini adapter to evaluate:
 *   - Per-question cost vs $0.12 gate
 *   - Pass rate vs 3/5 gate
 *
 * If both gates pass, authorizes full 53Q run.
 *
 * Usage:
 *   npx tsx src/benchmarks/gaia-gemini-pilot.ts
 *   node dist/benchmarks/gaia-gemini-pilot.js
 *
 * Refs: ADR-133, #2156 Phase 2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGeminiAgent, isGeminiAnswerCorrect, DEFAULT_GEMINI_MODEL } from './gaia-agent-gemini.js';
import type { GaiaQuestion } from './gaia-loader.js';

// ---------------------------------------------------------------------------
// Cost gate constants
// ---------------------------------------------------------------------------

const COST_GATE_PER_Q_USD = 0.12;
const PASS_RATE_GATE = 3; // out of 5

// ---------------------------------------------------------------------------
// Load pilot questions from cache
// ---------------------------------------------------------------------------

const PILOT_IDS = [
  '9318445f-fe6a-4e1b-acbf-c68228c9906a', // PNG image: fractions worksheet
  '7bd855d8-463d-4ed5-93ca-5fe35145f733', // XLSX: fast-food sales
  '5188369a-3bbe-43d8-8b94-11558f909a08', // Retrieval: Merriam-Webster word-of-day writer
  '5d0080cb-90d7-4712-bc33-848150e917d3', // Calculation: fish bag volume
  '840bfca7-4f7b-481a-8794-c560c340185d', // Retrieval: NASA contract number
];

function loadPilotQuestions(): GaiaQuestion[] {
  const cacheDir = path.join(os.homedir(), '.cache', 'ruflo', 'gaia');
  const dataPath = path.join(cacheDir, 'level1-main.json');

  if (!fs.existsSync(dataPath)) {
    throw new Error(`GAIA cache not found at ${dataPath}. Run a full bench first.`);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as GaiaQuestion[];
  const byId = new Map(data.map((q) => [q.task_id, q]));

  const questions: GaiaQuestion[] = [];
  for (const id of PILOT_IDS) {
    const q = byId.get(id);
    if (!q) throw new Error(`Pilot question ${id} not found in cache`);

    // Resolve file_path from cache
    if (q.file_name && !q.file_path) {
      const fp = path.join(cacheDir, 'files', q.file_name);
      if (fs.existsSync(fp)) {
        q.file_path = fp;
      }
    }
    questions.push(q);
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Main pilot runner
// ---------------------------------------------------------------------------

async function runPilot(): Promise<void> {
  console.log('');
  console.log('=== GAIA Phase 2 Pilot — Gemini 2.5 Pro Thinking ===');
  console.log(`Model:          ${DEFAULT_GEMINI_MODEL}`);
  console.log(`Questions:      ${PILOT_IDS.length}`);
  console.log(`Cost gate:      $${COST_GATE_PER_Q_USD}/question`);
  console.log(`Pass rate gate: ${PASS_RATE_GATE}/${PILOT_IDS.length}`);
  console.log('');

  const questions = loadPilotQuestions();

  let passed = 0;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;

  const perQResults: Array<{
    taskId: string;
    correct: boolean;
    answer: string | null;
    expected: string;
    cost: number;
    turns: number;
    thinkingTokens: number;
    wallMs: number;
  }> = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`[Q${i + 1}/5] ${q.task_id}`);
    console.log(`  Question: ${q.question.slice(0, 100)}${q.question.length > 100 ? '...' : ''}`);
    console.log(`  File:     ${q.file_name ?? 'none'}`);

    const result = await runGeminiAgent(q, {
      model: DEFAULT_GEMINI_MODEL,
      maxTurns: 12,
      maxTokensPerTurn: 8192,
    });

    const correct =
      result.finalAnswer !== null &&
      isGeminiAnswerCorrect(result.finalAnswer, q.final_answer);

    if (correct) passed++;
    totalCost += result.estimatedCostUsd;
    totalInputTokens += result.totalInputTokens;
    totalOutputTokens += result.totalOutputTokens;
    totalThinkingTokens += result.totalThinkingTokens;

    perQResults.push({
      taskId: q.task_id,
      correct,
      answer: result.finalAnswer,
      expected: q.final_answer,
      cost: result.estimatedCostUsd,
      turns: result.turns,
      thinkingTokens: result.totalThinkingTokens,
      wallMs: result.wallMs,
    });

    const status = correct ? 'PASS' : 'FAIL';
    console.log(`  Expected: "${q.final_answer}"`);
    console.log(`  Got:      "${result.finalAnswer ?? 'null'}"`);
    console.log(
      `  Status: ${status} | turns=${result.turns} | ` +
      `input=${result.totalInputTokens.toLocaleString()} | ` +
      `output=${result.totalOutputTokens.toLocaleString()} | ` +
      `thinking=${result.totalThinkingTokens.toLocaleString()} | ` +
      `cost=$${result.estimatedCostUsd.toFixed(4)} | ` +
      `wall=${(result.wallMs / 1000).toFixed(1)}s`,
    );
    if (result.error) console.log(`  Error: ${result.error}`);
    if (result.timedOut) console.log(`  TIMED OUT`);
    console.log('');
  }

  const avgCost = totalCost / PILOT_IDS.length;
  const passRate = passed / PILOT_IDS.length;
  const costGatePasses = avgCost <= COST_GATE_PER_Q_USD;
  const passRateGatePasses = passed >= PASS_RATE_GATE;
  const bothGatesPass = costGatePasses && passRateGatePasses;

  console.log('=== Pilot Results ===');
  console.log(`Pass rate:        ${passed}/${PILOT_IDS.length} (${(passRate * 100).toFixed(0)}%)`);
  console.log(`Avg cost/Q:       $${avgCost.toFixed(4)}`);
  console.log(`Total cost:       $${totalCost.toFixed(4)}`);
  console.log(`Input tokens:     ${totalInputTokens.toLocaleString()}`);
  console.log(`Output tokens:    ${totalOutputTokens.toLocaleString()}`);
  console.log(`Thinking tokens:  ${totalThinkingTokens.toLocaleString()}`);
  console.log('');
  console.log(`Cost gate ($${COST_GATE_PER_Q_USD}/Q):  ${costGatePasses ? 'PASS' : 'FAIL'} (avg $${avgCost.toFixed(4)})`);
  console.log(`Pass rate gate (${PASS_RATE_GATE}/5):    ${passRateGatePasses ? 'PASS' : 'FAIL'} (${passed}/${PILOT_IDS.length})`);
  console.log(`Gate verdict:     ${bothGatesPass ? 'BOTH GATES PASS — authorize full 53Q run' : 'GATE FAILED — do NOT run full 53Q'}`);
  console.log('');

  // Emit machine-readable JSON artifact
  const artifact = {
    pilot: 'phase2-gemini-thinking',
    model: DEFAULT_GEMINI_MODEL,
    timestamp: new Date().toISOString(),
    summary: {
      passed,
      total: PILOT_IDS.length,
      passRate: (passRate * 100).toFixed(1),
      avgCostUsd: avgCost,
      totalCostUsd: totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalThinkingTokens,
      costGate: { threshold: COST_GATE_PER_Q_USD, value: avgCost, passed: costGatePasses },
      passRateGate: { threshold: PASS_RATE_GATE, value: passed, passed: passRateGatePasses },
      bothGatesPass,
    },
    questions: perQResults,
  };

  const outPath = path.join(
    process.cwd(),
    'docs/benchmarks/runs/gaia-l1-phase2-gemini-pilot.json',
  );
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`Artifact written to: ${outPath}`);

  if (!bothGatesPass) {
    process.exit(1);
  }
}

runPilot().catch((err) => {
  console.error('Pilot crashed:', err);
  process.exit(2);
});
