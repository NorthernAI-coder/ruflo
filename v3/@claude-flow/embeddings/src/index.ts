/**
 * V3 Embedding Service Module
 *
 * Production embedding service aligned with agentic-flow@alpha:
 * - OpenAI provider (text-embedding-3-small/large)
 * - Transformers.js provider (local ONNX models)
 * - Agentic-flow provider (optimized ONNX with SIMD)
 * - Mock provider (development/testing)
 *
 * Additional features:
 * - Persistent SQLite cache
 * - Document chunking with overlap
 * - L2/L1/minmax/zscore normalization
 * - Hyperbolic embeddings (Poincaré ball)
 * - Neural substrate integration (drift, memory, swarm)
 *
 * @module @claude-flow/embeddings
 */

export * from './types.js';
export * from './embedding-service.js';

// Re-export commonly used items at top level
export {
  createEmbeddingService,
  createEmbeddingServiceAsync,
  getEmbedding,
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
  computeSimilarity,
  OpenAIEmbeddingService,
  TransformersEmbeddingService,
  MockEmbeddingService,
  AgenticFlowEmbeddingService,
  BaseEmbeddingService,
} from './embedding-service.js';

// ADR-121 Phase 1 — WASM+SIMD ONNX provider via ruvector-onnx-embeddings-wasm.
export {
  RuvectorOnnxEmbeddingService,
  createRuvectorOnnxEmbeddingService,
} from './ruvector-onnx-embedding-service.js';

// ADR-121 Phase 2 — HNSW-backed searchable cache via @ruvector/core.
// Falls back to linear-scan when the optional peer dep isn't installed,
// so the contract holds end-to-end regardless of install state.
export {
  SearchableEmbeddingCache,
  createSearchableEmbeddingCache,
  type CacheSearchHit,
  type SearchableCacheOptions,
} from './searchable-embedding-cache.js';

// ADR-121 Phase 5 (lightweight) — ruvector sidecar availability probe.
// Foundation for the full MCP sidecar wire-up (which lives in the CLI
// package). Consumers: `ruflo doctor`, new
// `embeddings_check_ruvector_sidecar` MCP tool (follow-up).
export {
  probeRuvectorSidecar,
  formatRuvectorAvailability,
  type RuvectorAvailability,
  type RuvectorMcpTool,
  type RuvectorProbeOptions,
} from './ruvector-mcp-probe.js';

// ADR-121 Phase 3 — quantization.
//   int8        : 4× memory reduction, streaming-insert friendly,
//                 wired into SearchableEmbeddingCache via
//                 `quantize: 'int8'`. Recall ≥0.98 on unit-normalized
//                 vectors.
//   RabitqSnapshot : 32× memory reduction, batch-build only (suits
//                 fixed corpora — agent-fleet shared memory, etc.).
//                 Requires @ruvector/rabitq-wasm as an optional peer.
export {
  int8Encode,
  int8Decode,
  measureInt8RoundTripRecall,
  RabitqSnapshot,
  rabitqMemoryReduction,
  type Int8EncodedVector,
  type RabitqSnapshotOptions,
  type RabitqSnapshotHit,
} from './quantization.js';

// ADR-121 Phase 5b — `@ruvector/diskann` snapshot for billion-scale
// agent-fleet caches. Streaming insert + on-disk persistence
// (survives process restarts). Complements RabitqSnapshot (in-memory,
// build-once, 32× compression) — DiskannSnapshot is the right tool
// when the corpus outgrows RAM.
export {
  DiskannSnapshot,
  diskannAvailable,
  type DiskannSnapshotOptions,
  type DiskannSnapshotHit,
} from './diskann-snapshot.js';

// ADR-121 Phase 8 — AnnRouter composition. Auto-selects between
// HNSW (streaming/mutable), RaBitQ (batch/memory-tight), and DiskANN
// (persistent/billion-scale) based on the workload descriptor. Single
// unified search interface; degrades cleanly when the preferred
// backing's peer dep isn't installed.
export {
  AnnRouter,
  decideBacking,
  type AnnBacking,
  type AnnRouterWorkload,
  type AnnRouterHit,
  type AnnRouterDecision,
} from './ann-router.js';

// ADR-121 Phase 10 — Maximal Marginal Relevance diversity rerank.
// Pure function; takes (candidates, queryVec, {k, lambda}) and returns
// a diversified subset. Composable with any of the ANN backings.
export {
  mmrRerank,
  mmrIds,
  averagePairwiseSimilarity,
  type MmrCandidate,
  type MmrOptions,
  type MmrPickedHit,
} from './mmr.js';

// ADR-121 Phase 11 — Reciprocal Rank Fusion (Cormack-Clarke-Büttcher 2009).
// Combines N ranked lists into a single fused ranking without needing
// score comparability. Composes with `embeddings_search_text_batch`
// for ensemble RAG.
export {
  reciprocalRankFusion,
  rrfIds,
  type RrfListItem,
  type RrfOptions,
  type RrfFusedHit,
} from './rrf.js';

// ADR-121 Phase 12 — Embedding-level fusion (HyDE, Gao et al. 2022).
// Averages N embedding vectors into a single query vector — fuses at
// the embedding level (one search after average) vs RRF which fuses
// at the rank level (N searches then merge). Standard HyDE recipe
// for zero-shot dense retrieval. Composes with any retrieval shape.
export {
  averageEmbeddings,
  isUnitNorm,
  type AverageEmbeddingsOptions,
} from './embedding-fusion.js';

export type { AutoEmbeddingConfig } from './embedding-service.js';

// RVF embedding service (pure-TS hash-based embeddings)
export { RvfEmbeddingService } from './rvf-embedding-service.js';

// RVF embedding cache (binary file persistence)
export {
  RvfEmbeddingCache,
  type RvfEmbeddingCacheConfig,
} from './rvf-embedding-cache.js';

// Chunking utilities
export {
  chunkText,
  estimateTokens,
  reconstructFromChunks,
  type ChunkingConfig,
  type Chunk,
  type ChunkedDocument,
} from './chunking.js';

// Normalization utilities
export {
  l2Normalize,
  l2NormalizeInPlace,
  l1Normalize,
  minMaxNormalize,
  zScoreNormalize,
  normalize,
  normalizeBatch,
  l2Norm,
  isNormalized,
  centerEmbeddings,
  type NormalizationOptions,
} from './normalization.js';

// Hyperbolic embeddings (Poincaré ball)
export {
  euclideanToPoincare,
  poincareToEuclidean,
  hyperbolicDistance,
  mobiusAdd,
  mobiusScalarMul,
  hyperbolicCentroid,
  batchEuclideanToPoincare,
  pairwiseHyperbolicDistances,
  isInPoincareBall,
  type HyperbolicConfig,
} from './hyperbolic.js';

// ADR-121 Phase 3b — async Poincaré ops backed by @ruvector/attention
// when installed; falls back to the hand-rolled hyperbolic.ts above.
// Same conceptual surface, but Float32Array-native and routed through
// Rust NAPI bindings for ~order-of-magnitude precision improvement
// (the hand-rolled path is approximate for expMap/logMap).
export {
  projectToPoincareBall as projectToPoincareBallAsync,
  poincareDistance as poincareDistanceAsync,
  expMap as expMapAsync,
  logMap as logMapAsync,
  mobiusAddition as mobiusAdditionAsync,
  hyperbolicAttentionAvailable,
  type HyperbolicAttentionOptions,
} from './hyperbolic-attention.js';

// Persistent cache
export {
  PersistentEmbeddingCache,
  isPersistentCacheAvailable,
  type PersistentCacheConfig as DiskCacheConfig,
  type PersistentCacheStats,
} from './persistent-cache.js';

// Neural substrate integration
export {
  NeuralEmbeddingService,
  createNeuralService,
  isNeuralAvailable,
  listEmbeddingModels,
  downloadEmbeddingModel,
  type DriftResult,
  type MemoryEntry,
  type AgentState,
  type CoherenceResult,
  type SubstrateHealth,
  type NeuralSubstrateConfig,
} from './neural-integration.js';

export type {
  EmbeddingProvider,
  EmbeddingConfig,
  OpenAIEmbeddingConfig,
  TransformersEmbeddingConfig,
  MockEmbeddingConfig,
  AgenticFlowEmbeddingConfig,
  RvfEmbeddingConfig,
  RuvectorOnnxEmbeddingConfig,
  EmbeddingResult,
  BatchEmbeddingResult,
  IEmbeddingService,
  SimilarityMetric,
  SimilarityResult,
  NormalizationType,
  PersistentCacheConfig,
} from './types.js';
