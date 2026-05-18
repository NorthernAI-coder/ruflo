#!/usr/bin/env node
/**
 * #2037 regression smoke — verify memory_search_unified does NOT
 * silently drop custom namespaces.
 *
 * The reporter's repro:
 *   1. store entry under custom namespace ('my-team-decisions')
 *   2. memory_search_unified WITHOUT a namespace filter
 *   3. should return the entry; previously returned 0 because the
 *      tool hardcoded a 6-namespace whitelist
 *
 * Also tests the new `namespaces=[...]` explicit-list path.
 *
 * Run from repo root: `node scripts/smoke-cli-memory-search-unified-custom-ns.mjs`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliDist = path.join(repoRoot, 'v3/@claude-flow/cli/dist/src/mcp-tools/memory-tools.js');

const { memoryTools } = await import(cliDist);

function tool(name) {
  const t = memoryTools.find(t => t.name === name);
  if (!t) {
    console.error(`[FAIL] tool not registered: ${name}`);
    process.exit(1);
  }
  return t;
}

const storeTool = tool('memory_store');
const retrieveTool = tool('memory_retrieve');
const unifiedTool = tool('memory_search_unified');
const deleteTool = tool('memory_delete');

// Use a unique namespace name so we don't collide with anything
// already in the store + can clean up after.
const CUSTOM_NS = `iter28-2037-${Date.now()}`;
const KEY = 'reporter-repro';
const CONTENT = 'hello custom namespace search unified bug 2037';

console.log(`=== #2037 smoke: custom-namespace unified search ===`);
console.log(`Custom namespace: ${CUSTOM_NS}\n`);

function fail(msg, extra) {
  console.error(`[FAIL] ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

// Step 1 — store in the custom namespace
const stored = await storeTool.handler({ key: KEY, value: CONTENT, namespace: CUSTOM_NS });
if (!stored.success) fail('store failed', stored);
console.log(`[OK] stored '${KEY}' in namespace '${CUSTOM_NS}'`);

try {
  // Step 2 — direct retrieve works (sanity). The retrieve handler
  // returns `{ found, value, ... }`, not a `success` field.
  const direct = await retrieveTool.handler({ key: KEY, namespace: CUSTOM_NS });
  if (!direct.found || !direct.value) fail('direct retrieve missed the entry', direct);
  console.log(`[OK] direct retrieve found the entry`);

  // Step 3 — unified search WITHOUT a namespace filter — this was the bug
  const unified = await unifiedTool.handler({ query: 'custom namespace search unified', limit: 20 });
  if (!unified.success) fail('unified search returned !success', unified);
  console.log(`[OK] unified search executed`);
  console.log(`     searchedNamespaces:`, unified.searchedNamespaces);

  if (!unified.searchedNamespaces.includes(CUSTOM_NS)) {
    fail(`unified search did NOT include the custom namespace in searchedNamespaces (#2037 regression)`, {
      searchedNamespaces: unified.searchedNamespaces,
      expectedToInclude: CUSTOM_NS,
    });
  }
  console.log(`[OK] custom namespace '${CUSTOM_NS}' is in searchedNamespaces (fix verified)`);

  const found = (unified.results ?? []).find(r => r.namespace === CUSTOM_NS && r.key === KEY);
  if (!found) {
    fail(`unified search did not return the entry from the custom namespace`, {
      results: unified.results,
      expectedKey: KEY,
      expectedNamespace: CUSTOM_NS,
    });
  }
  console.log(`[OK] unified search returned the entry from the custom namespace`);

  // Step 4 — `namespaces=[...]` explicit-list path
  const explicit = await unifiedTool.handler({
    query: 'custom namespace search unified',
    limit: 20,
    namespaces: [CUSTOM_NS],
  });
  if (!explicit.success) fail('explicit-namespaces unified search returned !success', explicit);
  if (!explicit.searchedNamespaces.includes(CUSTOM_NS) || explicit.searchedNamespaces.length !== 1) {
    fail(`explicit namespaces=[CUSTOM_NS] did not honor the list`, explicit);
  }
  const explicitFound = (explicit.results ?? []).find(r => r.key === KEY);
  if (!explicitFound) fail('explicit-namespaces did not return the entry', explicit);
  console.log(`[OK] namespaces=[...] explicit-list parameter honored`);

  // Step 5 — single-namespace path still works
  const single = await unifiedTool.handler({
    query: 'custom namespace search unified',
    limit: 20,
    namespace: CUSTOM_NS,
  });
  if (!single.success) fail('single-namespace unified search returned !success', single);
  if (single.searchedNamespaces.length !== 1 || single.searchedNamespaces[0] !== CUSTOM_NS) {
    fail(`single namespace filter did not constrain searchedNamespaces`, single);
  }
  console.log(`[OK] single namespace= parameter still works`);

  // Step 6 — namespace validation rejects bad ids
  const bad = await unifiedTool.handler({ query: 'x', namespaces: ['nope/invalid'] });
  if (bad.success !== false) fail('expected failure on bad namespace in namespaces[]', bad);
  console.log(`[OK] namespaces[] validation rejects bad ids`);

  console.log(`\n=== #2037 smoke: PASS ===`);
} finally {
  // Clean up regardless of outcome.
  try {
    await deleteTool.handler({ key: KEY, namespace: CUSTOM_NS });
    console.log(`[cleanup] deleted '${KEY}' from '${CUSTOM_NS}'`);
  } catch (err) {
    console.error(`[cleanup] delete failed (non-fatal):`, err?.message ?? err);
  }
}

process.exit(0);
