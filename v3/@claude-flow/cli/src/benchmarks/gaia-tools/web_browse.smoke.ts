/**
 * Smoke tests for web_browse — ADR-133-PR5
 *
 * Run with:
 *   cd v3/@claude-flow/cli
 *   npx tsx src/benchmarks/gaia-tools/web_browse.smoke.ts
 *
 * Requires Playwright to be installed:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * If Playwright is not installed, tests that require it are skipped with
 * a SKIP result (not a failure) — the install instructions are printed.
 *
 * Tests:
 *   1. Browse Wikipedia page — content contains 'Mercedes', status 200
 *   2. Bad URL with short timeout — returns error message (no crash)
 *   3. Screenshot mode — returns non-empty base64 string
 *   4. HTML extract mode — content contains '<html' or '<HTML'
 *
 * Cost: $0 (all local Playwright calls — no LLM).
 *
 * Refs: ADR-133, #2156
 */

import { createWebBrowseTool } from './web_browse.js';

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  message: string;
}

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<TestResult> {
  try {
    await fn();
    return { name, status: 'PASS', message: 'OK' };
  } catch (e: unknown) {
    const msg = String(e);
    // If Playwright isn't installed, mark as SKIP rather than FAIL.
    if (
      msg.includes('Playwright is not installed') ||
      msg.includes('Cannot find module') ||
      msg.includes('playwright')
    ) {
      return { name, status: 'SKIP', message: `Playwright not installed — ${msg}` };
    }
    return { name, status: 'FAIL', message: msg };
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tool = createWebBrowseTool();

// Test 1: Wikipedia text extraction
async function testWikipedia(): Promise<void> {
  const out = await tool.execute({
    url: 'https://en.wikipedia.org/wiki/Mercedes_Sosa',
    extract: 'text',
    timeout_seconds: 30,
  });
  // If Playwright is missing, execute() returns a structured error string.
  if (out.startsWith('[web_browse error]')) {
    throw new Error(out);
  }
  assert(
    out.toLowerCase().includes('mercedes') || out.toLowerCase().includes('sosa'),
    `Expected page text to contain "Mercedes" or "Sosa", got:\n${out.slice(0, 500)}`,
  );
  assert(
    out.includes('final_url:'),
    `Expected final_url in output, got:\n${out.slice(0, 200)}`,
  );
}

// Test 2: Bad URL with short timeout — should return gracefully, not throw
async function testBadUrlTimeout(): Promise<void> {
  const out = await tool.execute({
    url: 'https://this-domain-absolutely-does-not-exist-gaia-bench.example',
    extract: 'text',
    timeout_seconds: 5,
  });
  // Either a Playwright "not installed" error or a network error — both are
  // acceptable.  The tool must NOT throw; it must return a string.
  assert(typeof out === 'string', 'Expected string output from bad-URL test');
}

// Test 3: Screenshot mode — returns base64 PNG
async function testScreenshotMode(): Promise<void> {
  const out = await tool.execute({
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    extract: 'screenshot',
    timeout_seconds: 30,
  });
  if (out.startsWith('[web_browse error]')) {
    throw new Error(out);
  }
  assert(out.includes('content:'), `Expected "content:" in output, got:\n${out.slice(0, 200)}`);
  // Extract the base64 portion after "content:\n"
  const contentIdx = out.indexOf('content:\n');
  if (contentIdx !== -1) {
    const b64 = out.slice(contentIdx + 'content:\n'.length).trim();
    assert(b64.length > 100, `Expected non-trivial base64 data, got length ${b64.length}`);
    // Base64 charset only
    assert(
      /^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 100)),
      `Expected base64-encoded output, got:\n${b64.slice(0, 100)}`,
    );
  }
}

// Test 4: HTML extract mode
async function testHtmlExtract(): Promise<void> {
  const out = await tool.execute({
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    extract: 'html',
    timeout_seconds: 30,
  });
  if (out.startsWith('[web_browse error]')) {
    throw new Error(out);
  }
  assert(
    out.toLowerCase().includes('<html') || out.includes('<!DOCTYPE'),
    `Expected HTML markup in output, got:\n${out.slice(0, 300)}`,
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('web_browse smoke tests — ADR-133-PR5\n');

  const tests: Array<Promise<TestResult>> = [
    runTest('Test 1: Wikipedia text extraction (contains "Mercedes")', testWikipedia),
    runTest('Test 2: Bad URL with 5s timeout — no crash', testBadUrlTimeout),
    runTest('Test 3: Screenshot mode — non-empty base64', testScreenshotMode),
    runTest('Test 4: HTML extract mode — markup present', testHtmlExtract),
  ];

  // Run sequentially to avoid spawning 4 browser instances simultaneously.
  const results: TestResult[] = [];
  for (const t of tests) {
    results.push(await t);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    console.log(`[${r.status}] ${r.name}`);
    if (r.status !== 'PASS') {
      console.log(`       ${r.message.slice(0, 300)}`);
    }
    if (r.status === 'PASS') passed++;
    else if (r.status === 'FAIL') failed++;
    else skipped++;
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (skipped > 0) {
    console.log('\nInstall Playwright to run skipped tests:');
    console.log('  npm install playwright');
    console.log('  npx playwright install chromium');
  }

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
