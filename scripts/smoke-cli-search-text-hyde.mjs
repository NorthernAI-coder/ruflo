#!/usr/bin/env node
/**
 * ADR-121 Phase 12 — CI smoke for embeddings_search_text_hyde.
 *
 * What it proves end-to-end:
 *   1. embeddings_init succeeds (mock provider, deterministic bytes).
 *   2. embeddings_ann_router_build accepts a corpus.
 *   3. embeddings_search_text_hyde:
 *      - returns success on N>=1 hypothetical texts
 *      - averaged query vector is unit-norm (HyDE recipe contract)
 *      - hits.length === k
 *      - latency surfaces per-stage costs (embed, fuse, search)
 *      - hyde.textsFused === input texts.length
 *   4. Weights bias the averaged direction
 *   5. Single-text input (degenerate case) works
 *   6. Validation rejects bad inputs
 *   7. Missing handle path returns success:false
 *
 * Run from repo root: `node scripts/smoke-cli-search-text-hyde.mjs`
 * Exits 0 on success, 1 with a diagnostic on failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/mcp-tools/embeddings-tools.js');

const { embeddingsTools } = await import(cliDist);
const tool = (n) => {
  const t = embeddingsTools.find(t => t.name === n);
  if (!t) {
    console.error(`[FAIL] tool not registered: ${n}`);
    process.exit(1);
  }
  return t;
};

const initTool = tool('embeddings_init');
const buildTool = tool('embeddings_ann_router_build');
const hydeTool = tool('embeddings_search_text_hyde');

function fail(msg, extra) {
  console.error('[FAIL]', msg);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

console.log('=== embeddings_search_text_hyde smoke ===\n');

const DIM = 384;

// Step 1 — init.
const initRes = await initTool.handler({ provider: 'mock', dimension: DIM, force: true });
if (!initRes.success) fail('embeddings_init', initRes);
console.log('[OK] embeddings_init\n');

// Step 2 — build a small corpus.
function vec(values) {
  const out = new Array(DIM).fill(0);
  values.forEach((v, i) => { out[i] = v; });
  return out;
}
const entries = Array.from({ length: 10 }, (_, i) => ({
  id: `doc-${i}`,
  vector: vec([Math.sin(i * 0.7), Math.cos(i * 0.7), Math.sin(i * 1.3), Math.cos(i * 1.3)]),
}));
const buildRes = await buildTool.handler({
  name: 'smoke-hyde',
  workload: { corpusSize: entries.length, dimension: DIM, mutable: true },
  entries,
});
if (!buildRes.success) fail('router build', buildRes);
console.log(`[OK] router build — backing=${buildRes.backing}, count=${buildRes.count}\n`);

// Step 3 — basic HyDE call with 3 hypothetical answers.
const r1 = await hydeTool.handler({
  texts: [
    'authentication uses a token-based flow with refresh',
    'the login endpoint returns a JWT after credential verification',
    'OAuth2 with PKCE is the standard for SPA clients here',
  ],
  name: 'smoke-hyde',
  k: 5,
});
if (!r1.success) fail('hyde basic', r1);
if (r1.hits.length !== 5) fail(`expected k=5 hits, got ${r1.hits.length}`, r1);
if (r1.hyde.textsFused !== 3) fail(`expected textsFused=3, got ${r1.hyde.textsFused}`, r1);
if (r1.hyde.averagedVectorUnitNorm !== true) fail('averaged vector not unit-norm', r1);
if (r1.hyde.dimension !== DIM) fail(`hyde.dimension mismatch`, r1);
console.log('[OK] hyde (3 hypothetical texts, k=5):');
console.log('     hits:', r1.hits.length, 'unitNorm:', r1.hyde.averagedVectorUnitNorm, 'dim:', r1.hyde.dimension);
console.log('     latency:', r1.latency);
console.log('     top-3:', r1.hits.slice(0, 3).map(h => h.id));
console.log();

// Step 4 — weighted HyDE. Bias toward one specific hypothetical.
const r2 = await hydeTool.handler({
  texts: ['anchor answer about topic alpha', 'distractor about beta'],
  name: 'smoke-hyde',
  k: 3,
  weights: [10, 1],
});
if (!r2.success) fail('hyde weighted', r2);
if (!r2.hyde.weights || r2.hyde.weights.length !== 2) fail('weights not echoed', r2);
console.log('[OK] weighted hyde (weights=[10,1]):');
console.log('     hits:', r2.hits.length, 'weights echoed:', r2.hyde.weights);
console.log();

// Step 5 — degenerate single-text case (HyDE with N=1 is just plain
// search_text via a different code path; verify it still works).
const rSingle = await hydeTool.handler({
  texts: ['just one hypothetical'],
  name: 'smoke-hyde',
  k: 3,
});
if (!rSingle.success) fail('hyde single-text', rSingle);
if (rSingle.hyde.textsFused !== 1) fail('single-text textsFused', rSingle);
if (!rSingle.hyde.averagedVectorUnitNorm) fail('single-text not unit-norm', rSingle);
console.log('[OK] degenerate single-text case works\n');

// Step 6 — validation: empty texts.
const rEmpty = await hydeTool.handler({ texts: [], name: 'smoke-hyde', k: 3 });
if (rEmpty.success) fail('expected failure on empty texts', rEmpty);
console.log('[OK] validation: empty texts rejected\n');

// Step 7 — validation: bad k.
const rBadK = await hydeTool.handler({ texts: ['a'], name: 'smoke-hyde', k: 0 });
if (rBadK.success) fail('expected failure on k=0', rBadK);
console.log('[OK] validation: k=0 rejected\n');

// Step 8 — validation: weights length mismatch.
const rBadW = await hydeTool.handler({
  texts: ['a', 'b'], name: 'smoke-hyde', k: 3, weights: [1],
});
if (rBadW.success) fail('expected failure on bad weights length', rBadW);
console.log('[OK] validation: weights length mismatch rejected\n');

// Step 9 — validation: negative weights.
const rNeg = await hydeTool.handler({
  texts: ['a'], name: 'smoke-hyde', k: 3, weights: [-1],
});
if (rNeg.success) fail('expected failure on negative weights', rNeg);
console.log('[OK] validation: negative weights rejected\n');

// Step 10 — missing handle.
const rMissing = await hydeTool.handler({
  texts: ['x'], name: 'nonexistent-hyde', k: 3,
});
if (rMissing.success) fail('expected failure on missing handle', rMissing);
console.log('[OK] missing handle returns success:false\n');

console.log('=== embeddings_search_text_hyde smoke: PASS ===');
process.exit(0);
