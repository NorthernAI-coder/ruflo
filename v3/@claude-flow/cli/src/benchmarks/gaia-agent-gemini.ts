/**
 * GAIA Agent — Gemini 2.5 Pro Thinking adapter (Phase 2 pilot)
 *
 * Adapts the existing GAIA tool catalogue to Google's generateContent API,
 * translating Anthropic tool_use ↔ Gemini functionCall/functionResponse.
 *
 * Loop algorithm mirrors gaia-agent.ts:
 *   1. Build initial contents array with system instruction + first user turn.
 *   2. Call Gemini generateContent with functionDeclarations.
 *   3. On functionCall parts: execute tools, append functionResponse, repeat.
 *   4. On text-only response: scan for FINAL_ANSWER pattern.
 *   5. On maxTurns: return timedOut result.
 *
 * Gemini 2.5 Pro pricing (2026-05-28, per million tokens):
 *   Input:   $1.25 (≤200k tokens), $2.50 (>200k)
 *   Output:  $10.00 (≤200k tokens), $15.00 (>200k)
 *   Thinking tokens are billed as output tokens.
 *
 * Cost gate for pilot: ≤$0.12 per question average.
 * Expected per-question cost at ~10k input + ~2k output: ~$0.032 — well within gate.
 *
 * Refs: ADR-133, ADR-135, #2156 Phase 2
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GaiaQuestion,
} from './gaia-loader.js';
import {
  createDefaultToolCatalogue,
  GaiaToolCatalogue,
  ToolDefinition,
} from './gaia-tools/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOKENS_PER_TURN = 8192;
const DEFAULT_PER_TURN_TIMEOUT_MS = 120_000;

/** Gemini 2.5 Pro pricing (USD per million tokens, ≤200k bracket). */
const GEMINI_INPUT_COST_PER_M = 1.25;
const GEMINI_OUTPUT_COST_PER_M = 10.00;

const FINAL_ANSWER_RE = /FINAL_ANSWER:\s*(.+)/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeminiAgentResult {
  questionId: string;
  finalAnswer: string | null;
  turns: number;
  toolCallsByName: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  wallMs: number;
  estimatedCostUsd: number;
  timedOut?: boolean;
  error?: string;
}

export interface GeminiAgentOptions {
  model?: string;
  maxTurns?: number;
  maxTokensPerTurn?: number;
  perTurnTimeoutMs?: number;
  apiKey?: string;
  catalogue?: GaiaToolCatalogue;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

export function resolveGeminiApiKey(apiKey?: string): string {
  if (apiKey && apiKey.trim()) return apiKey.trim();

  const envKey = process.env['GOOGLE_AI_API_KEY'];
  if (envKey && envKey.trim()) return envKey.trim();

  try {
    const out = execSync(
      'gcloud secrets versions access latest --secret=GOOGLE_AI_API_KEY --project=ruv-dev 2>/dev/null',
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    if (out) return out;
  } catch {
    /* fall through */
  }

  throw new Error(
    'GOOGLE_AI_API_KEY not found. Set the env var or store in GCP Secret Manager.',
  );
}

// ---------------------------------------------------------------------------
// Schema translation: Anthropic ToolDefinition → Gemini FunctionDeclaration
// ---------------------------------------------------------------------------

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

function toGeminiType(anthropicType: string): string {
  const map: Record<string, string> = {
    string: 'STRING',
    number: 'NUMBER',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    array: 'ARRAY',
    object: 'OBJECT',
  };
  return map[anthropicType.toLowerCase()] ?? 'STRING';
}

function translateToolDef(def: ToolDefinition): GeminiFunctionDeclaration {
  const props: Record<string, { type: string; description?: string }> = {};
  for (const [key, val] of Object.entries(def.input_schema.properties)) {
    props[key] = { type: toGeminiType(val.type), description: val.description };
  }
  return {
    name: def.name,
    description: def.description,
    parameters: {
      type: 'OBJECT',
      properties: props,
      required: def.input_schema.required ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini API response types
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: { code: number; message: string; status: string };
}

// ---------------------------------------------------------------------------
// Single Gemini API call
// ---------------------------------------------------------------------------

async function callGemini(
  apiKey: string,
  model: string,
  contents: GeminiContent[],
  systemInstruction: string,
  functionDeclarations: GeminiFunctionDeclaration[],
  maxTokens: number,
  timeoutMs: number,
): Promise<GeminiGenerateContentResponse> {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const requestBody: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      maxOutputTokens: maxTokens,
      thinkingConfig: { thinkingBudget: 8192 },
    },
  };

  if (functionDeclarations.length > 0) {
    requestBody['tools'] = [{ functionDeclarations }];
    requestBody['toolConfig'] = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '<unreadable>');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 400)}`);
  }

  return (await res.json()) as GeminiGenerateContentResponse;
}

// ---------------------------------------------------------------------------
// Build initial contents (handles image attachments inline)
// ---------------------------------------------------------------------------

function buildInitialContents(question: GaiaQuestion): GeminiContent[] {
  const questionText = question.question;
  const parts: GeminiPart[] = [];

  if (question.file_path) {
    const ext = path.extname(question.file_path).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

    if (imageExts.includes(ext)) {
      try {
        const buf = fs.readFileSync(question.file_path);
        const mediaTypeMap: Record<string, string> = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp',
        };
        parts.push({ text: questionText });
        // Gemini inline image part
        (parts as unknown as Array<Record<string, unknown>>).push({
          inlineData: {
            mimeType: mediaTypeMap[ext] ?? 'image/png',
            data: buf.toString('base64'),
          },
        });
      } catch {
        parts.push({
          text: questionText + `\n\nAttached file: ${question.file_path}. Call file_read to read it.`,
        });
      }
    } else {
      parts.push({
        text: questionText + `\n\nThis question has an attached file. Call file_read with path="${question.file_path}" to read it, then answer.`,
      });
    }
  } else {
    parts.push({ text: questionText });
  }

  return [{ role: 'user', parts }];
}

// ---------------------------------------------------------------------------
// Extract FINAL_ANSWER from model response text
// ---------------------------------------------------------------------------

function extractFinalAnswer(candidate: GeminiCandidate | undefined): string | null {
  if (!candidate?.content?.parts) return null;
  for (const part of candidate.content.parts) {
    if (part.thought) continue;
    if (part.text) {
      const match = FINAL_ANSWER_RE.exec(part.text);
      if (match?.[1]) return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check if response has any functionCall parts
// ---------------------------------------------------------------------------

function getFunctionCalls(
  candidate: GeminiCandidate | undefined,
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!candidate?.content?.parts) return [];
  return candidate.content.parts
    .filter((p): p is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } =>
      !!p.functionCall,
    )
    .map((p) => p.functionCall);
}

// ---------------------------------------------------------------------------
// Main agent loop
// ---------------------------------------------------------------------------

export async function runGeminiAgent(
  question: GaiaQuestion,
  options: GeminiAgentOptions = {},
): Promise<GeminiAgentResult> {
  const {
    model = DEFAULT_GEMINI_MODEL,
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokensPerTurn = DEFAULT_MAX_TOKENS_PER_TURN,
    perTurnTimeoutMs = DEFAULT_PER_TURN_TIMEOUT_MS,
    apiKey: suppliedKey,
    catalogue: suppliedCatalogue,
  } = options;

  const wallStart = Date.now();
  const apiKey = resolveGeminiApiKey(suppliedKey);
  const catalogue = suppliedCatalogue ?? createDefaultToolCatalogue();
  const functionDeclarations = catalogue.map((t) => translateToolDef(t.definition));

  const systemInstruction = [
    'You are a precise question-answering agent. Answer the user\'s question using the tools available.',
    '',
    'RULES:',
    '1. Use tools when you need information you do not have with certainty.',
    '2. When you have a final answer, output it on its own line in this EXACT format:',
    '   FINAL_ANSWER: <your answer here>',
    '3. Keep answers concise. For numbers, give just the number. For names, give just the name.',
    '4. Do not include units unless the question specifically asks for them.',
    '5. MANDATORY: You MUST ALWAYS end your final response with a FINAL_ANSWER line.',
    '6. If the question text appears garbled or reversed, try to interpret it before concluding you cannot answer.',
  ].join('\n');

  const toolCallsByName: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;

  const contents: GeminiContent[] = buildInitialContents(question);
  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    turns = turn + 1;

    let resp: GeminiGenerateContentResponse;
    try {
      resp = await callGemini(
        apiKey, model, contents, systemInstruction,
        functionDeclarations, maxTokensPerTurn, perTurnTimeoutMs,
      );
    } catch (err) {
      return {
        questionId: question.task_id,
        finalAnswer: null,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens,
        wallMs: Date.now() - wallStart,
        estimatedCostUsd: estimateCost(totalInputTokens, totalOutputTokens),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (resp.error) {
      return {
        questionId: question.task_id,
        finalAnswer: null,
        turns,
        toolCallsByName,
        totalInputTokens,
        totalOutputTokens,
        totalThinkingTokens,
        wallMs: Date.now() - wallStart,
        estimatedCostUsd: estimateCost(totalInputTokens, totalOutputTokens),
        error: `Gemini error ${resp.error.code}: ${resp.error.message}`,
      };
    }

    // Accumulate token counts
    const usage = resp.usageMetadata ?? {};
    totalInputTokens += usage.promptTokenCount ?? 0;
    totalOutputTokens += usage.candidatesTokenCount ?? 0;
    totalThinkingTokens += usage.thoughtsTokenCount ?? 0;

    const candidate = resp.candidates?.[0];
    const functionCalls = getFunctionCalls(candidate);

    if (functionCalls.length > 0) {
      // Append model turn (with functionCall parts)
      if (candidate?.content) {
        contents.push({ role: 'model', parts: candidate.content.parts });
      }

      // Execute all function calls and build functionResponse parts
      const responseParts: GeminiPart[] = await Promise.all(
        functionCalls.map(async (call): Promise<GeminiPart> => {
          toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
          const tool = catalogue.find((t) => t.name === call.name);
          if (!tool) {
            return {
              functionResponse: {
                name: call.name,
                response: { error: `Unknown tool "${call.name}"` },
              },
            };
          }
          try {
            const output = await tool.execute(call.args);
            return {
              functionResponse: {
                name: call.name,
                response: { output },
              },
            };
          } catch (err) {
            return {
              functionResponse: {
                name: call.name,
                response: { error: err instanceof Error ? err.message : String(err) },
              },
            };
          }
        }),
      );

      contents.push({ role: 'user', parts: responseParts });
      continue;
    }

    // No function calls — extract final answer
    const finalAnswer = extractFinalAnswer(candidate);
    return {
      questionId: question.task_id,
      finalAnswer,
      turns,
      toolCallsByName,
      totalInputTokens,
      totalOutputTokens,
      totalThinkingTokens,
      wallMs: Date.now() - wallStart,
      estimatedCostUsd: estimateCost(totalInputTokens, totalOutputTokens + totalThinkingTokens),
    };
  }

  // Exhausted maxTurns
  return {
    questionId: question.task_id,
    finalAnswer: null,
    turns,
    toolCallsByName,
    totalInputTokens,
    totalOutputTokens,
    totalThinkingTokens,
    wallMs: Date.now() - wallStart,
    estimatedCostUsd: estimateCost(totalInputTokens, totalOutputTokens + totalThinkingTokens),
    timedOut: true,
  };
}

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * GEMINI_INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * GEMINI_OUTPUT_COST_PER_M
  );
}

// ---------------------------------------------------------------------------
// Answer matching (same as gaia-agent.ts)
// ---------------------------------------------------------------------------

export function isGeminiAnswerCorrect(modelAnswer: string, expected: string): boolean {
  if (!modelAnswer) return false;
  const norm = (s: string) => s.trim().toLowerCase();
  const normModel = norm(modelAnswer);
  const normExpected = norm(expected);
  if (normModel === normExpected) return true;
  if (normModel.includes(normExpected)) return true;
  if (normExpected.includes(normModel)) return true;
  const numModel = parseFloat(normModel.replace(/[^0-9.\-]/g, ''));
  const numExpected = parseFloat(normExpected.replace(/[^0-9.\-]/g, ''));
  if (
    !Number.isNaN(numModel) && !Number.isNaN(numExpected) &&
    numExpected !== 0 &&
    Math.abs((numModel - numExpected) / numExpected) < 0.01
  ) return true;
  return false;
}
