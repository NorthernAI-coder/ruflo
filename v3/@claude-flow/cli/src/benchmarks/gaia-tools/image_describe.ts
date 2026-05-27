/**
 * GAIA Tool: image_describe — ADR-133-PR5
 *
 * Describes an image at a given URL or local file path using Anthropic's
 * claude-haiku-4-5 model with vision (image content blocks).  Covers the
 * subset of GAIA Level-1 questions that provide image attachments (graphs,
 * screenshots, photos, diagrams).
 *
 * ============================================================
 * DESIGN NOTES
 * ============================================================
 * - Uses the Anthropic Messages API directly via `fetch` (same approach as
 *   gaia-agent.ts / gaia-judge.ts) — no SDK dependency.
 * - API key resolution order mirrors gaia-agent.ts:
 *     1. `options.apiKey` (caller-supplied)
 *     2. ANTHROPIC_API_KEY env var
 *     3. gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY
 * - Model: claude-haiku-4-5 (cheapest vision-capable model, ~$0.001/call).
 * - URL images: sent as { type: 'url', url } — Anthropic fetches the image.
 * - Local files: read as Buffer, base64-encoded, MIME detected from extension.
 * - execute() NEVER throws — returns a structured error string so the agent
 *   loop can forward it to Claude rather than crashing.
 *
 * ============================================================
 * SUPPORTED IMAGE FORMATS
 * ============================================================
 * Anthropic vision accepts: JPEG, PNG, GIF, WebP.
 * Unsupported formats return a descriptive error that Claude can relay.
 *
 * Refs: ADR-133, #2156
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { GaiaTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISION_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 512;
const DEFAULT_PROMPT =
  'Describe this image in detail. Note any text, charts, diagrams, tables, ' +
  'numerical data, labels, axes, legends, or other content that would be ' +
  'useful to answer a factual question about what the image shows.';

// ---------------------------------------------------------------------------
// MIME detection
// ---------------------------------------------------------------------------

type SupportedMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const EXT_TO_MIME: Record<string, SupportedMime> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function detectMime(filePath: string, buf: Buffer): SupportedMime {
  // Magic bytes first
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return 'image/png';
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  )
    return 'image/gif';
  if (
    buf.length >= 4 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  )
    return 'image/webp';
  // Fall back to extension
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? 'image/png';
}

// ---------------------------------------------------------------------------
// API key resolution (mirrors gaia-agent.ts)
// ---------------------------------------------------------------------------

function resolveAnthropicApiKey(suppliedKey?: string): string {
  if (suppliedKey && suppliedKey.trim()) return suppliedKey.trim();
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }
  throw new Error(
    'ANTHROPIC_API_KEY not found.  Set the env var or store it in GCP Secret Manager ' +
      'under "ANTHROPIC_API_KEY".',
  );
}

// ---------------------------------------------------------------------------
// Anthropic vision call
// ---------------------------------------------------------------------------

interface AnthropicImageSource {
  type: 'url' | 'base64';
  url?: string;
  media_type?: SupportedMime;
  data?: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: AnthropicImageSource;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

async function callVisionApi(
  imageBlock: AnthropicImageBlock,
  prompt: string,
  apiKey: string,
): Promise<string> {
  const body = JSON.stringify({
    model: VISION_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [imageBlock, { type: 'text', text: prompt } as AnthropicTextBlock],
      },
    ],
  });

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'content-type': 'application/json',
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '(no body)');
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    error?: { message: string };
  };

  if (json.error) throw new Error(`Anthropic API error: ${json.error.message}`);

  const textBlock = json.content?.find((b) => b.type === 'text');
  return textBlock?.text ?? '(no description returned)';
}

// ---------------------------------------------------------------------------
// GaiaTool implementation
// ---------------------------------------------------------------------------

export class ImageDescribeTool implements GaiaTool {
  readonly name = 'image_describe';
  private readonly apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  readonly definition: ToolDefinition = {
    name: 'image_describe',
    description:
      'Describe an image at a given URL or local absolute file path. ' +
      'Returns a detailed text description suitable as input to answer ' +
      'factual questions about the image content (charts, graphs, photos, ' +
      'screenshots, diagrams, text in images). ' +
      `Uses ${VISION_MODEL} for cost-efficient vision (~$0.001/call). ` +
      'Supported formats: JPEG, PNG, GIF, WebP.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'URL (http/https) or absolute local file path of the image to describe.',
        },
        prompt: {
          type: 'string',
          description:
            'Optional instruction to guide the description ' +
            '(default: describe all visible content with focus on factual details).',
        },
      },
      required: ['source'],
    },
  };

  async execute(input: Record<string, unknown>): Promise<string> {
    const source = String(input['source'] ?? '').trim();
    if (!source) throw new Error('image_describe: `source` input is required and must be non-empty.');

    const prompt = input['prompt'] != null ? String(input['prompt']).trim() : DEFAULT_PROMPT;

    // Resolve API key — errors here are caught by the agent loop.
    let apiKey: string;
    try {
      apiKey = resolveAnthropicApiKey(this.apiKey);
    } catch (e: unknown) {
      return `[image_describe error] ${String(e)}`;
    }

    let imageBlock: AnthropicImageBlock;

    if (source.startsWith('http://') || source.startsWith('https://')) {
      // URL image — Anthropic fetches it directly.
      imageBlock = {
        type: 'image',
        source: { type: 'url', url: source },
      };
    } else {
      // Local file — validate, read, base64-encode.
      if (!path.isAbsolute(source)) {
        return (
          `[image_describe error] Local file paths must be absolute. ` +
          `Got: "${source}".`
        );
      }

      let buf: Buffer;
      try {
        buf = fs.readFileSync(source);
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return `[image_describe error] File not found: ${source}`;
        }
        return `[image_describe error] Cannot read file "${source}": ${String(e)}`;
      }

      const mime = detectMime(source, buf);
      imageBlock = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mime,
          data: buf.toString('base64'),
        },
      };
    }

    try {
      const description = await callVisionApi(imageBlock, prompt, apiKey);
      return `[image_describe: ${VISION_MODEL}]\n${description}`;
    } catch (e: unknown) {
      // Return error as string — never throw so the agent loop stays alive.
      return `[image_describe error] ${String(e)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Options type + convenience factory
// ---------------------------------------------------------------------------

export interface ImageDescribeToolOptions {
  /** Anthropic API key (falls back to env / gcloud if omitted). */
  apiKey?: string;
}

export function createImageDescribeTool(opts?: ImageDescribeToolOptions): ImageDescribeTool {
  return new ImageDescribeTool(opts?.apiKey);
}
