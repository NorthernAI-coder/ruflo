/**
 * RuVector ONNX MiniLM-L6 embedder for the browser.
 *
 * Uses `ruvector-onnx-embeddings-wasm` (the same RuVector embedding
 * stack the rest of the RuFlo platform uses, just running in WASM in
 * the browser). Lazy-loaded behind a dynamic import so:
 *
 *   1. The 23MB ONNX model + tokenizer aren't fetched until first call
 *   2. Pages that don't embed (e.g. Index/Demo/Agents idle states)
 *      don't pay the WASM init cost
 *   3. Build size doesn't include the WASM module statically
 *
 * The first call:
 *   - triggers a dynamic import of the ruvector WASM JS glue
 *   - `createEmbedder('all-MiniLM-L6-v2')` fetches the model + tokenizer
 *     from HF (cached via the browser's Cache API afterwards)
 *
 * Subsequent calls share the cached embedder instance.
 *
 * Embeddings are 384-dim, L2-normalized, mean-pooled. This matches what
 * ADR-088 used for the LongMemEval benchmark (Xenova/all-MiniLM-L6-v2 is
 * the same underlying model — both load the HF sentence-transformers ONNX).
 */

import { normalizeL2 } from './search';

let embedderPromise: Promise<Embedder> | null = null;

interface Embedder {
  /** Embedding dimension (384 for MiniLM-L6). */
  readonly dim: number;
  /** Embed one text → Float32Array of length `dim` (L2-normalized). */
  embedOne(text: string): Float32Array;
  /** Embed many. Returns flat array of length `texts.length * dim`. */
  embedBatch(texts: string[]): Float32Array;
}

/**
 * Get the singleton embedder. Initializes on first call.
 *
 * Throws if WASM init fails. Callers should defensive-catch and fall
 * back to keyword search if the embedder can't load (e.g. offline +
 * uncached, or HF rate-limit).
 */
export async function getEmbedder(): Promise<Embedder> {
  if (embedderPromise) return embedderPromise;
  embedderPromise = initEmbedder().catch((err) => {
    // Reset so a future call can retry.
    embedderPromise = null;
    throw err;
  });
  return embedderPromise;
}

async function initEmbedder(): Promise<Embedder> {
  // Dynamic import — keeps the static bundle slim.
  // @ts-expect-error - ruvector-onnx-embeddings-wasm has no TS types for loader.js
  const loader = await import('ruvector-onnx-embeddings-wasm/loader.js');
  const wasmEmbedder = await loader.createEmbedder('all-MiniLM-L6-v2');
  // ruvector's WasmEmbedder already L2-normalizes when configured with
  // setNormalize(true), which loader.js does. We still normalize defensively
  // because a future config change shouldn't silently break dot-product
  // search.
  return {
    dim: 384,
    embedOne(text: string): Float32Array {
      const v = wasmEmbedder.embedOne(text || ' ');
      // Defensive copy — WASM may reuse the buffer on next call.
      const copy = new Float32Array(v);
      return normalizeL2(copy);
    },
    embedBatch(texts: string[]): Float32Array {
      const safe = texts.map((t) => t || ' ');
      const flat = wasmEmbedder.embedBatch(safe);
      const copy = new Float32Array(flat);
      // Normalize each row. Skip if texts.length === 0.
      for (let i = 0; i < safe.length; i++) {
        const start = i * 384;
        let norm = 0;
        for (let j = 0; j < 384; j++) norm += copy[start + j] * copy[start + j];
        if (norm > 0) {
          const inv = 1 / Math.sqrt(norm);
          for (let j = 0; j < 384; j++) copy[start + j] *= inv;
        }
      }
      return copy;
    },
  };
}

/** Convenience: embed a single string, lazy-init on first call. */
export async function embedText(text: string): Promise<Float32Array> {
  const e = await getEmbedder();
  return e.embedOne(text);
}
