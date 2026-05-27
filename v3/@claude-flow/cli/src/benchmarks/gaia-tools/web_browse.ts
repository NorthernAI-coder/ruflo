/**
 * GAIA Tool: web_browse — ADR-133-PR5
 *
 * Opens a URL in a headless Chromium browser via Playwright and extracts
 * page content (text, HTML, or screenshot).  Covers the ~10-15pp of GAIA
 * Level-1 questions that require navigating dynamic JS pages, video pages
 * (YouTube, Vimeo), and paywalled/login-required content.
 *
 * ============================================================
 * PLAYWRIGHT DEPENDENCY — OPT-IN INSTALL
 * ============================================================
 * Playwright is NOT a hard runtime dep of @claude-flow/cli.  It is loaded
 * lazily via a dynamic import so the package installs cleanly without it.
 *
 * To use web_browse, run once:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * If Playwright is not installed, execute() returns a structured error
 * message that Claude can relay to the user rather than crashing.
 *
 * Install size: ~80 MB for the Playwright package + Chromium binary.
 * Add as a devDependency in benchmark-specific contexts to avoid bloating
 * the production bundle.
 *
 * ============================================================
 * RESOURCE CAPS
 * ============================================================
 * - Text/HTML extraction capped at 8 000 characters (prevents context-window
 *   overflow; roughly 2 000 tokens).
 * - Default timeout: 30 seconds.
 * - Screenshots returned as base64-encoded PNG strings.
 * - Browser instance is always closed in a `finally` block.
 *
 * Refs: ADR-133, #2156
 */

import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrowseExtract = 'text' | 'html' | 'screenshot';

export interface WebBrowseInput {
  url: string;
  wait_for_selector?: string;
  extract?: BrowseExtract;
  timeout_seconds?: number;
}

export interface WebBrowseResult {
  content: string;
  final_url: string;
  status: number;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Playwright lazy loader
// ---------------------------------------------------------------------------

// Playwright types — only referenced at runtime via dynamic import.
// We avoid static `import type` to keep Playwright fully out of the dep graph.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlaywrightChromium = any;

interface PlaywrightLoadResult {
  ok: true;
  chromium: PlaywrightChromium;
}
interface PlaywrightMissingResult {
  ok: false;
  reason: string;
}

/**
 * Attempt to load Playwright's `chromium` launch function.
 * Returns a missing-result (with install instructions) if Playwright is not
 * installed rather than throwing — callers return the reason string to Claude.
 */
async function loadPlaywright(): Promise<PlaywrightLoadResult | PlaywrightMissingResult> {
  try {
    // Dynamic import keeps Playwright out of the static dep graph.
    // The string is built at runtime to prevent TS from statically resolving
    // the module (which would fail with TS2307 when playwright is not installed).
    const pwModuleName = 'play' + 'wright';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pw: any = await import(/* @vite-ignore */ pwModuleName);
    return { ok: true, chromium: pw.chromium };
  } catch {
    return {
      ok: false,
      reason:
        'Playwright is not installed.  Install it with:\n' +
        '  npm install playwright\n' +
        '  npx playwright install chromium\n' +
        'Then retry.  web_browse requires Playwright to navigate dynamic pages.',
    };
  }
}

// ---------------------------------------------------------------------------
// Core browse logic
// ---------------------------------------------------------------------------

async function browseUrl(input: WebBrowseInput): Promise<WebBrowseResult> {
  const extract: BrowseExtract = input.extract ?? 'text';
  const timeoutMs = Math.min(
    Math.max(1_000, Math.round((input.timeout_seconds ?? DEFAULT_TIMEOUT_MS / 1000) * 1000)),
    120_000,
  );

  const pw = await loadPlaywright();
  if (!pw.ok) {
    // Return as a structured result so the agent loop can forward the error
    // to Claude without crashing.
    return {
      content: `[web_browse error] ${pw.reason}`,
      final_url: input.url,
      status: 0,
    };
  }

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // Capture final HTTP status from the main-frame response.
    let responseStatus = 200;
    page.on('response', (resp) => {
      if (resp.url() === page.url() || resp.url() === input.url) {
        responseStatus = resp.status();
      }
    });

    await page.goto(input.url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    if (input.wait_for_selector) {
      await page.waitForSelector(input.wait_for_selector, { timeout: timeoutMs });
    }

    let rawContent: string;

    if (extract === 'screenshot') {
      const buf = await page.screenshot({ type: 'png', fullPage: false });
      rawContent = buf.toString('base64');
    } else if (extract === 'html') {
      rawContent = await page.content();
    } else {
      // Default: extract visible text
      // page.evaluate runs inside the browser context (Chromium's V8 runtime),
      // so `document` / `window` are available there.  Cast to avoid the
      // TypeScript "lib does not include dom" error from the Node.js tsconfig.
      rawContent = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc: any = (globalThis as any).document;
        if (!doc) return '';
        doc
          .querySelectorAll('script, style, noscript, [hidden], [aria-hidden="true"]')
          .forEach((el: any) => el.remove());
        return (doc.body?.innerText ?? doc.documentElement?.innerText ?? '').trim();
      });
    }

    const finalUrl = page.url();

    // Cap text/html at MAX_CONTENT_CHARS; screenshots are kept as-is (base64
    // of a 1280×720 PNG ≈ 300–800 KB — large but necessary for vision pass).
    let content = rawContent;
    let truncated = false;
    if (extract !== 'screenshot' && rawContent.length > MAX_CONTENT_CHARS) {
      content = rawContent.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }

    return { content, final_url: finalUrl, status: responseStatus, truncated };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Format output for Claude
// ---------------------------------------------------------------------------

function formatBrowseResult(result: WebBrowseResult, extract: BrowseExtract): string {
  const lines: string[] = [];

  lines.push(`final_url: ${result.final_url}`);
  lines.push(`status: ${result.status}`);

  if (extract === 'screenshot') {
    lines.push(`extract: screenshot (base64 PNG)`);
    lines.push(`content:\n${result.content}`);
  } else {
    lines.push(`extract: ${extract}`);
    if (result.truncated) {
      lines.push(`[content truncated at ${MAX_CONTENT_CHARS} characters]`);
    }
    lines.push(`content:\n${result.content}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class WebBrowseTool implements GaiaTool {
  readonly name = 'web_browse';

  readonly definition: ToolDefinition = {
    name: 'web_browse',
    description:
      'Open a URL in a headless Chromium browser and extract page content. ' +
      'Use this for dynamic JavaScript pages, video pages (YouTube, Vimeo), ' +
      'or any URL that web_search cannot fetch directly.  ' +
      'Returns page text by default; pass extract="html" for raw HTML or ' +
      'extract="screenshot" for a base64 PNG screenshot.  ' +
      'Requires Playwright to be installed (npm install playwright && ' +
      'npx playwright install chromium).',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to (http or https).',
        },
        wait_for_selector: {
          type: 'string',
          description:
            'Optional CSS selector to wait for before extracting content. ' +
            'Useful for SPAs that render after the initial DOM load.',
        },
        extract: {
          type: 'string',
          description:
            'What to extract: "text" (default, visible text), ' +
            '"html" (full page HTML), or "screenshot" (base64 PNG).',
        },
        timeout_seconds: {
          type: 'number',
          description: `Navigation timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000}, max: 120).`,
        },
      },
      required: ['url'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const url = String(input['url'] ?? '').trim();
    if (!url) throw new Error('web_browse: `url` input is required and must be non-empty.');

    const rawExtract = String(input['extract'] ?? 'text').toLowerCase();
    const extract: BrowseExtract =
      rawExtract === 'html' ? 'html' : rawExtract === 'screenshot' ? 'screenshot' : 'text';

    const browseInput: WebBrowseInput = {
      url,
      wait_for_selector:
        input['wait_for_selector'] != null ? String(input['wait_for_selector']) : undefined,
      extract,
      timeout_seconds:
        input['timeout_seconds'] != null ? Number(input['timeout_seconds']) : undefined,
    };

    const result = await browseUrl(browseInput);
    return formatBrowseResult(result, extract);
  }
}

// ---------------------------------------------------------------------------
// Options type + convenience factory
// ---------------------------------------------------------------------------

export interface WebBrowseToolOptions {
  /** Override default timeout in milliseconds. */
  defaultTimeoutMs?: number;
}

export function createWebBrowseTool(_opts?: WebBrowseToolOptions): WebBrowseTool {
  return new WebBrowseTool();
}
