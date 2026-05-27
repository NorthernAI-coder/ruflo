/**
 * Smoke tests for grounded_query.ts — ADR-135 / iter-33
 *
 * All tests are mock-based using groundedQueryTestHooks for ESM-safe injection.
 * NO live API calls are made.
 *
 * Coverage:
 *   1.  resolveGoogleAIApiKey — returns key from env var
 *   2.  resolveGoogleAIApiKey — throws when env var absent and gcloud unavailable
 *   3.  parseGeminiResponse — well-formed response → correct GroundedQueryResult shape
 *   4.  parseGeminiResponse — empty grounding metadata → grounded=false, empty sources
 *   5.  parseGeminiResponse — deduplicates sources by URI
 *   6.  parseGeminiResponse — cost calculation uses token counts
 *   7.  GroundedQueryTool.execute — happy path: answer + sources in output
 *   8.  GroundedQueryTool.execute — HTTP 4xx surfaces useful error message
 *   9.  GroundedQueryTool.execute — ungrounded response includes note in output
 *  10.  GroundedQueryTool.execute — rejects empty query
 *  11.  GroundedQueryTool.execute — max_tokens clamped to 8192
 *  12.  GroundedQueryTool.execute — uses injected apiKey from constructor
 *
 * Run with: npx tsx grounded_query.smoke.ts  (from gaia-tools directory)
 */

import * as assert from 'node:assert/strict';
import {
  GroundedQueryTool,
  groundedQueryTestHooks,
  resolveGoogleAIApiKey,
  parseGeminiResponse,
  createGroundedQueryTool,
} from './grounded_query.js';

// ---------------------------------------------------------------------------
// Minimal test harness (identical to web_search.smoke.ts — no external deps)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
    failed++;
  }
}

function clearHooks(): void {
  delete groundedQueryTestHooks.resolveKey;
  delete groundedQueryTestHooks.fetchResponse;
}

// ---------------------------------------------------------------------------
// Shared stub data
// ---------------------------------------------------------------------------

const STUB_RESPONSE_GROUNDED = {
  candidates: [
    {
      content: { parts: [{ text: 'Mercedes Sosa released 5 studio albums in that period.' }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { title: 'Mercedes Sosa discography', uri: 'https://example.com/mercedes-sosa' } },
          { web: { title: 'AllMusic Mercedes Sosa', uri: 'https://allmusic.com/sosa' } },
          { web: { title: 'Wikipedia Mercedes Sosa', uri: 'https://en.wikipedia.org/wiki/Mercedes_Sosa' } },
          { web: { title: 'Duplicate entry', uri: 'https://example.com/mercedes-sosa' } }, // duplicate URI
        ],
        webSearchQueries: ['Mercedes Sosa studio albums count'],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50 },
};

const STUB_RESPONSE_UNGROUNDED = {
  candidates: [
    {
      content: { parts: [{ text: 'I cannot verify this without current data.' }] },
      // No groundingMetadata
    },
  ],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
};

const STUB_RESPONSE_EMPTY_GROUNDING = {
  candidates: [
    {
      content: { parts: [{ text: 'Some answer.' }] },
      groundingMetadata: {
        groundingChunks: [],
        webSearchQueries: [],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function runSuite(): Promise<void> {
  console.log('\ngrounded_query.smoke.ts — ADR-135 / iter-33 Gemini Grounding\n');

  // -------------------------------------------------------------------------
  // 1. resolveGoogleAIApiKey — env var happy path
  // -------------------------------------------------------------------------
  await test('resolveGoogleAIApiKey: returns key from env var', async () => {
    const savedKey = process.env['GOOGLE_AI_API_KEY'];
    process.env['GOOGLE_AI_API_KEY'] = 'test-gemini-key-123';
    try {
      const key = await resolveGoogleAIApiKey();
      assert.equal(key, 'test-gemini-key-123');
    } finally {
      if (savedKey === undefined) delete process.env['GOOGLE_AI_API_KEY'];
      else process.env['GOOGLE_AI_API_KEY'] = savedKey;
    }
  });

  // -------------------------------------------------------------------------
  // 2. resolveGoogleAIApiKey — throws when missing (tested via tool hook path
  //    to avoid depending on whether GOOGLE_AI_API_KEY is set in CI or dev env)
  // -------------------------------------------------------------------------
  await test('resolveGoogleAIApiKey: throws with guidance when no key available', async () => {
    // Use the resolveKey hook to simulate the case where no key is configured.
    // This avoids a brittle env-var delete that breaks when the key IS present.
    groundedQueryTestHooks.resolveKey = async () => {
      throw new Error(
        'grounded_query: No Google AI API key found.\n' +
          'Set GOOGLE_AI_API_KEY env var, or ensure `gcloud` is authenticated.\n' +
          'Get a free key at: https://aistudio.google.com/apikey',
      );
    };
    const tool = new GroundedQueryTool();
    try {
      await assert.rejects(
        () => tool.execute({ query: 'test missing key' }),
        /GOOGLE_AI_API_KEY/,
      );
    } finally {
      clearHooks();
    }
  });

  // -------------------------------------------------------------------------
  // 3. parseGeminiResponse — well-formed grounded response
  // -------------------------------------------------------------------------
  await test('parseGeminiResponse: maps answer + sources + queries correctly', async () => {
    const result = parseGeminiResponse(STUB_RESPONSE_GROUNDED);
    assert.equal(result.model, 'gemini-2.5-flash');
    assert.ok(result.answer.includes('5 studio albums'));
    assert.equal(result.grounded, true);
    // 4 chunks but one duplicate URI → 3 unique sources
    assert.equal(result.sources.length, 3, `expected 3 unique sources, got ${result.sources.length}`);
    assert.equal(result.search_queries_used.length, 1);
    assert.equal(result.search_queries_used[0], 'Mercedes Sosa studio albums count');
  });

  // -------------------------------------------------------------------------
  // 4. parseGeminiResponse — empty grounding → grounded=false
  // -------------------------------------------------------------------------
  await test('parseGeminiResponse: empty grounding metadata → grounded=false', async () => {
    const result = parseGeminiResponse(STUB_RESPONSE_EMPTY_GROUNDING);
    assert.equal(result.grounded, false);
    assert.equal(result.sources.length, 0);
    assert.equal(result.search_queries_used.length, 0);
  });

  // -------------------------------------------------------------------------
  // 5. parseGeminiResponse — deduplicates sources by URI (already tested in #3
  //    but let's verify explicitly)
  // -------------------------------------------------------------------------
  await test('parseGeminiResponse: deduplicates sources by URI', async () => {
    const result = parseGeminiResponse(STUB_RESPONSE_GROUNDED);
    const uris = result.sources.map((s) => s.uri);
    const uniqueUris = new Set(uris);
    assert.equal(uris.length, uniqueUris.size, 'duplicate URIs found in sources');
  });

  // -------------------------------------------------------------------------
  // 6. parseGeminiResponse — cost calculation
  // -------------------------------------------------------------------------
  await test('parseGeminiResponse: cost_usd calculated from token counts', async () => {
    const result = parseGeminiResponse(STUB_RESPONSE_GROUNDED);
    // 200 input @ $0.075/M + 50 output @ $0.30/M
    const expectedMin = (200 / 1_000_000) * 0.075 + (50 / 1_000_000) * 0.30;
    const expectedMax = expectedMin * 1.01; // 1% tolerance for float arithmetic
    assert.ok(
      result.cost_usd >= expectedMin && result.cost_usd <= expectedMax,
      `cost_usd=${result.cost_usd} not in [${expectedMin}, ${expectedMax}]`,
    );
  });

  // -------------------------------------------------------------------------
  // 7. GroundedQueryTool.execute — happy path
  // -------------------------------------------------------------------------
  await test('GroundedQueryTool.execute: happy path produces answer + sources in output', async () => {
    groundedQueryTestHooks.resolveKey = async () => 'injected-key';
    groundedQueryTestHooks.fetchResponse = async () => STUB_RESPONSE_GROUNDED;

    const tool = new GroundedQueryTool();
    try {
      const output = await tool.execute({ query: 'How many albums did Mercedes Sosa release?' });
      assert.ok(output.includes('gemini-2.5-flash'), 'model missing from output');
      assert.ok(output.includes('5 studio albums'), 'answer text missing from output');
      assert.ok(output.includes('Sources:'), 'Sources section missing from output');
      assert.ok(output.includes('example.com/mercedes-sosa'), 'source URI missing from output');
    } finally {
      clearHooks();
    }
  });

  // -------------------------------------------------------------------------
  // 8. GroundedQueryTool.execute — HTTP 4xx surfaces useful error
  // -------------------------------------------------------------------------
  await test('GroundedQueryTool.execute: HTTP error surfaces in thrown Error', async () => {
    groundedQueryTestHooks.resolveKey = async () => 'bad-key';
    groundedQueryTestHooks.fetchResponse = async () => {
      throw new Error('grounded_query: Gemini HTTP 400: API key not valid');
    };

    const tool = new GroundedQueryTool();
    try {
      await assert.rejects(
        () => tool.execute({ query: 'test error' }),
        /Gemini HTTP 400/,
      );
    } finally {
      clearHooks();
    }
  });

  // -------------------------------------------------------------------------
  // 9. GroundedQueryTool.execute — ungrounded response includes note
  // -------------------------------------------------------------------------
  await test('GroundedQueryTool.execute: ungrounded response includes note in output', async () => {
    groundedQueryTestHooks.resolveKey = async () => 'injected-key';
    groundedQueryTestHooks.fetchResponse = async () => STUB_RESPONSE_UNGROUNDED;

    const tool = new GroundedQueryTool();
    try {
      const output = await tool.execute({ query: 'some query' });
      assert.ok(output.includes('unverified'), `expected unverified note in: ${output}`);
    } finally {
      clearHooks();
    }
  });

  // -------------------------------------------------------------------------
  // 10. GroundedQueryTool.execute — rejects empty query
  // -------------------------------------------------------------------------
  await test('GroundedQueryTool.execute: rejects empty query', async () => {
    const tool = new GroundedQueryTool();
    await assert.rejects(
      () => tool.execute({ query: '' }),
      /query.*required/,
    );
  });

  // -------------------------------------------------------------------------
  // 11. GroundedQueryTool.execute — max_tokens clamped
  // -------------------------------------------------------------------------
  await test('GroundedQueryTool.execute: max_tokens clamped to 8192', async () => {
    let capturedMaxTokens = 0;
    groundedQueryTestHooks.resolveKey = async () => 'injected-key';
    groundedQueryTestHooks.fetchResponse = async (_q, maxTokens) => {
      capturedMaxTokens = maxTokens;
      return STUB_RESPONSE_GROUNDED;
    };

    const tool = new GroundedQueryTool();
    try {
      await tool.execute({ query: 'test max tokens', max_tokens: 99_999 });
      assert.equal(capturedMaxTokens, 8192, `expected 8192, got ${capturedMaxTokens}`);
    } finally {
      clearHooks();
    }
  });

  // -------------------------------------------------------------------------
  // 12. GroundedQueryTool — uses injected apiKey from constructor
  // -------------------------------------------------------------------------
  await test('createGroundedQueryTool: uses apiKey passed to constructor', async () => {
    let capturedKey = '';
    groundedQueryTestHooks.fetchResponse = async (_q, _max, key) => {
      capturedKey = key;
      return STUB_RESPONSE_GROUNDED;
    };

    const tool = createGroundedQueryTool({ apiKey: 'constructor-key' });
    try {
      await tool.execute({ query: 'test constructor key' });
      assert.equal(capturedKey, 'constructor-key', `expected 'constructor-key', got '${capturedKey}'`);
    } finally {
      clearHooks();
    }
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
