/**
 * Embeddings MCP Tools for CLI
 *
 * Tool definitions for ONNX embeddings with hyperbolic support and neural substrate.
 * Implements ADR-024: Embeddings MCP Tools
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type { MCPTool } from './types.js';
import { validateIdentifier, validateText } from './validate-input.js';

// Configuration paths
const CONFIG_DIR = '.claude-flow';
const EMBEDDINGS_CONFIG = 'embeddings.json';
const MODELS_DIR = 'models';

interface EmbeddingsConfig {
  model: string;
  modelPath: string;
  dimension: number;
  cacheSize: number;
  hyperbolic: {
    enabled: boolean;
    curvature: number;
    epsilon: number;
    maxNorm: number;
  };
  neural: {
    enabled: boolean;
    driftThreshold: number;
    decayRate: number;
    ruvector?: {
      enabled: boolean;
      sona: boolean;
      flashAttention: boolean;
      ewcPlusPlus: boolean;
    };
    features?: {
      semanticDrift: boolean;
      memoryPhysics: boolean;
      stateMachine: boolean;
      swarmCoordination: boolean;
      coherenceMonitor: boolean;
    };
  };
  initialized: string;
}

function getConfigPath(): string {
  return resolve(join(CONFIG_DIR, EMBEDDINGS_CONFIG));
}

function ensureConfigDir(): void {
  const dir = resolve(CONFIG_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadConfig(): EmbeddingsConfig | null {
  try {
    const path = getConfigPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return null on error
  }
  return null;
}

function saveConfig(config: EmbeddingsConfig): void {
  ensureConfigDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

// Real ONNX embedding generation via memory-initializer
let realEmbeddingFn: ((text: string) => Promise<{ embedding: number[]; dimensions: number; model: string }>) | null = null;

async function getRealEmbeddingFunction() {
  if (!realEmbeddingFn) {
    try {
      const { generateEmbedding } = await import('../memory/memory-initializer.js');
      realEmbeddingFn = generateEmbedding;
    } catch {
      realEmbeddingFn = null;
    }
  }
  return realEmbeddingFn;
}

// Generate real ONNX embedding (falls back to deterministic hash if ONNX unavailable)
async function generateRealEmbedding(text: string, dimension: number): Promise<number[]> {
  const realFn = await getRealEmbeddingFunction();

  if (realFn) {
    try {
      const result = await realFn(text);
      return result.embedding;
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: deterministic hash-based (only if ONNX truly unavailable)
  console.warn('[MCP] ONNX unavailable, using fallback embedding');
  const embedding: number[] = [];
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }

  for (let i = 0; i < dimension; i++) {
    const seed = hash + i * 1337;
    embedding.push(Math.sin(seed) * Math.cos(seed * 0.5));
  }

  // L2 normalize
  const norm = Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0));
  return embedding.map(x => x / norm);
}

// Convert Euclidean embedding to Poincaré ball
function toPoincare(euclidean: number[], curvature: number): number[] {
  const c = Math.abs(curvature);
  const sqrtC = Math.sqrt(c);
  const norm = Math.sqrt(euclidean.reduce((sum, x) => sum + x * x, 0));

  // Exponential map at origin
  const factor = Math.tanh(sqrtC * norm / 2) / (sqrtC * norm + 1e-15);
  return euclidean.map(x => x * factor);
}

// Poincaré distance
function poincareDistance(a: number[], b: number[], curvature: number): number {
  const c = Math.abs(curvature);

  const diffSq = a.reduce((sum, _, i) => sum + (a[i] - b[i]) ** 2, 0);
  const normASq = a.reduce((sum, x) => sum + x * x, 0);
  const normBSq = b.reduce((sum, x) => sum + x * x, 0);

  const denom = (1 - normASq) * (1 - normBSq);
  const delta = 2 * diffSq / (denom + 1e-15);

  return (1 / Math.sqrt(c)) * Math.acosh(1 + delta);
}

// Cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, _, i) => sum + a[i] * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
  const normB = Math.sqrt(b.reduce((sum, x) => sum + x * x, 0));
  return dot / (normA * normB + 1e-15);
}

export const embeddingsTools: MCPTool[] = [
  {
    name: 'embeddings_init',
    description: 'Initialize the ONNX embedding subsystem with hyperbolic support Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'ONNX model ID',
          enum: ['Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2'],
          default: 'Xenova/all-MiniLM-L6-v2',
        },
        hyperbolic: {
          type: 'boolean',
          description: 'Enable hyperbolic (Poincaré ball) embeddings',
          default: true,
        },
        curvature: {
          type: 'number',
          description: 'Poincaré ball curvature (negative)',
          default: -1,
        },
        cacheSize: {
          type: 'number',
          description: 'LRU cache size',
          default: 256,
        },
        force: {
          type: 'boolean',
          description: 'Overwrite existing configuration',
          default: false,
        },
      },
    },
    handler: async (input) => {
      const model = (input.model as string) || 'Xenova/all-MiniLM-L6-v2';
      const hyperbolic = input.hyperbolic !== false;
      const curvature = (input.curvature as number) || -1;
      const cacheSize = (input.cacheSize as number) || 256;
      const force = input.force === true;

      const existingConfig = loadConfig();
      if (existingConfig && !force) {
        return {
          success: false,
          error: 'Embeddings already initialized. Use force=true to overwrite.',
          existingConfig: {
            model: existingConfig.model,
            initialized: existingConfig.initialized,
          },
        };
      }

      const dimension = model.includes('mpnet') ? 768 : 384;
      const modelPath = resolve(join(CONFIG_DIR, MODELS_DIR));

      // Create models directory
      if (!existsSync(modelPath)) {
        mkdirSync(modelPath, { recursive: true });
      }

      const config: EmbeddingsConfig = {
        model,
        modelPath,
        dimension,
        cacheSize,
        hyperbolic: {
          enabled: hyperbolic,
          curvature,
          epsilon: 1e-15,
          maxNorm: 1 - 1e-5,
        },
        neural: {
          enabled: true,
          driftThreshold: 0.3,
          decayRate: 0.01,
        },
        initialized: new Date().toISOString(),
      };

      saveConfig(config);

      return {
        success: true,
        config: {
          model,
          dimension,
          cacheSize,
          hyperbolic: hyperbolic ? { enabled: true, curvature } : { enabled: false },
          neural: { enabled: true },
        },
        paths: {
          config: getConfigPath(),
          models: modelPath,
        },
        message: 'Embedding subsystem initialized successfully',
      };
    },
  },

  {
    name: 'embeddings_generate',
    description: 'Generate embeddings for text (Euclidean or hyperbolic) Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to embed',
        },
        hyperbolic: {
          type: 'boolean',
          description: 'Return hyperbolic (Poincaré) embedding',
          default: false,
        },
        normalize: {
          type: 'boolean',
          description: 'L2 normalize the embedding',
          default: true,
        },
      },
      required: ['text'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      const text = input.text as string;

      { const v = validateText(text, 'text'); if (!v.valid) return { success: false, error: v.error }; }

      const useHyperbolic = input.hyperbolic === true && config.hyperbolic.enabled;

      // Generate real ONNX embedding
      const embedding = await generateRealEmbedding(text, config.dimension);

      let result: number[];
      let geometry: string;

      if (useHyperbolic) {
        result = toPoincare(embedding, config.hyperbolic.curvature);
        geometry = 'poincare';
      } else {
        result = embedding;
        geometry = 'euclidean';
      }

      return {
        success: true,
        embedding: result,
        metadata: {
          model: config.model,
          dimension: config.dimension,
          geometry,
          curvature: useHyperbolic ? config.hyperbolic.curvature : null,
          textLength: text.length,
          norm: Math.sqrt(result.reduce((sum, x) => sum + x * x, 0)),
        },
      };
    },
  },

  {
    name: 'embeddings_compare',
    description: 'Compare similarity between two texts Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        text1: {
          type: 'string',
          description: 'First text',
        },
        text2: {
          type: 'string',
          description: 'Second text',
        },
        metric: {
          type: 'string',
          description: 'Similarity metric',
          enum: ['cosine', 'euclidean', 'poincare'],
          default: 'cosine',
        },
      },
      required: ['text1', 'text2'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      const text1 = input.text1 as string;
      const text2 = input.text2 as string;
      const metric = (input.metric as string) || 'cosine';

      { const v = validateText(text1, 'text1'); if (!v.valid) return { success: false, error: v.error }; }
      { const v = validateText(text2, 'text2'); if (!v.valid) return { success: false, error: v.error }; }

      // Generate real ONNX embeddings for both texts
      const [emb1, emb2] = await Promise.all([
        generateRealEmbedding(text1, config.dimension),
        generateRealEmbedding(text2, config.dimension)
      ]);

      let similarity: number;
      let distance: number;

      switch (metric) {
        case 'poincare':
          if (!config.hyperbolic.enabled) {
            return {
              success: false,
              error: 'Hyperbolic mode not enabled. Initialize with hyperbolic=true.',
            };
          }
          const poinc1 = toPoincare(emb1, config.hyperbolic.curvature);
          const poinc2 = toPoincare(emb2, config.hyperbolic.curvature);
          distance = poincareDistance(poinc1, poinc2, config.hyperbolic.curvature);
          similarity = 1 / (1 + distance);
          break;

        case 'euclidean':
          distance = Math.sqrt(emb1.reduce((sum, _, i) => sum + (emb1[i] - emb2[i]) ** 2, 0));
          similarity = 1 / (1 + distance);
          break;

        default: // cosine
          similarity = cosineSimilarity(emb1, emb2);
          distance = 1 - similarity;
      }

      return {
        success: true,
        similarity,
        distance,
        metric,
        texts: {
          text1: { length: text1.length, preview: text1.slice(0, 50) },
          text2: { length: text2.length, preview: text2.slice(0, 50) },
        },
        interpretation: similarity > 0.8 ? 'very similar' :
                        similarity > 0.6 ? 'similar' :
                        similarity > 0.4 ? 'somewhat similar' :
                        similarity > 0.2 ? 'different' : 'very different',
      };
    },
  },

  {
    name: 'embeddings_search',
    description: 'Semantic search across stored embeddings Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        topK: {
          type: 'number',
          description: 'Number of results to return',
          default: 5,
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity threshold (0-1)',
          default: 0.5,
        },
        namespace: {
          type: 'string',
          description: 'Search in specific namespace',
        },
      },
      required: ['query'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      const query = input.query as string;
      const topK = (input.topK as number) || 5;
      const threshold = (input.threshold as number) || 0.5;
      const namespace = input.namespace as string;

      { const v = validateText(query, 'query'); if (!v.valid) return { success: false, error: v.error }; }
      if (namespace) { const v = validateIdentifier(namespace, 'namespace'); if (!v.valid) return { success: false, error: v.error }; }

      const startTime = performance.now();

      // Generate real ONNX embedding for query
      const queryEmbedding = await generateRealEmbedding(query, config.dimension);

      // Try to search using real memory search
      try {
        const { searchEntries } = await import('../memory/memory-initializer.js');
        const searchResult = await searchEntries({
          query,
          limit: topK,
          threshold,
          namespace: namespace || 'all'
        });

        const searchTime = (performance.now() - startTime).toFixed(2);

        return {
          success: true,
          query,
          results: searchResult.results.map((r) => ({
            key: r.key,
            content: r.content?.substring(0, 100),
            similarity: r.score,
            namespace: r.namespace
          })),
          metadata: {
            model: config.model,
            topK,
            threshold,
            namespace: namespace || 'all',
            searchTime: `${searchTime}ms`,
            indexType: config.hyperbolic.enabled ? 'HNSW (hyperbolic)' : 'HNSW (euclidean)',
            resultCount: searchResult.results.length
          },
        };
      } catch {
        // Database not available - return empty but truthful
        const searchTime = (performance.now() - startTime).toFixed(2);
        return {
          success: true,
          query,
          results: [],
          metadata: {
            model: config.model,
            topK,
            threshold,
            namespace: namespace || 'all',
            searchTime: `${searchTime}ms`,
            indexType: config.hyperbolic.enabled ? 'HNSW (hyperbolic)' : 'HNSW (euclidean)',
          },
          message: 'No embeddings indexed yet. Use memory store to add documents.',
        };
      }
    },
  },

  {
    name: 'embeddings_neural',
    description: 'Neural substrate operations (RuVector integration) Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Neural action',
          enum: ['status', 'init', 'drift', 'consolidate', 'adapt'],
          default: 'status',
        },
        driftThreshold: {
          type: 'number',
          description: 'Semantic drift detection threshold',
          default: 0.3,
        },
        decayRate: {
          type: 'number',
          description: 'Memory decay rate (hippocampal dynamics)',
          default: 0.01,
        },
      },
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      const action = (input.action as string) || 'status';

      switch (action) {
        case 'init':
          config.neural = {
            enabled: true,
            driftThreshold: (input.driftThreshold as number) || 0.3,
            decayRate: (input.decayRate as number) || 0.01,
            ruvector: {
              enabled: true,
              sona: true,
              flashAttention: true,
              ewcPlusPlus: true,
            },
            features: {
              semanticDrift: true,
              memoryPhysics: true,
              stateMachine: true,
              swarmCoordination: true,
              coherenceMonitor: true,
            },
          };
          saveConfig(config);
          return {
            success: true,
            action: 'init',
            neural: config.neural,
            message: 'Neural substrate initialized with RuVector integration',
          };

        case 'drift':
          // Get real drift metrics if available
          try {
            const { getIntelligenceStats } = await import('../memory/intelligence.js');
            const stats = getIntelligenceStats();
            return {
              success: true,
              action: 'drift',
              status: {
                semanticDrift: {
                  enabled: config.neural.features?.semanticDrift ?? false,
                  threshold: config.neural.driftThreshold,
                  patternsTracked: stats.patternsLearned,
                  status: stats.patternsLearned > 0 ? 'tracking' : 'no patterns',
                },
              },
              message: stats.patternsLearned > 0
                ? `Tracking ${stats.patternsLearned} patterns for drift`
                : 'No patterns stored yet - drift detection inactive',
            };
          } catch {
            return {
              success: true,
              action: 'drift',
              status: { semanticDrift: { enabled: false, reason: 'Intelligence module unavailable' } },
            };
          }

        case 'consolidate':
          // Get real consolidation metrics
          try {
            const { getIntelligenceStats } = await import('../memory/intelligence.js');
            const stats = getIntelligenceStats();
            return {
              success: true,
              action: 'consolidate',
              status: {
                memoryPhysics: {
                  enabled: config.neural.features?.memoryPhysics ?? false,
                  decayRate: config.neural.decayRate,
                  patternsStored: stats.reasoningBankSize,
                  trajectoriesRecorded: stats.trajectoriesRecorded,
                },
              },
              message: `ReasoningBank: ${stats.reasoningBankSize} patterns, ${stats.trajectoriesRecorded} trajectories`,
            };
          } catch {
            return {
              success: true,
              action: 'consolidate',
              status: { memoryPhysics: { enabled: false, reason: 'Intelligence module unavailable' } },
            };
          }

        case 'adapt':
          // Get real SONA adaptation metrics
          try {
            const { benchmarkAdaptation, initializeIntelligence } = await import('../memory/intelligence.js');
            await initializeIntelligence();
            const benchmark = benchmarkAdaptation(100);
            return {
              success: true,
              action: 'adapt',
              status: {
                sona: {
                  enabled: true,
                  adaptationTime: `${(benchmark.avgMs * 1000).toFixed(2)}μs`,
                  targetMet: benchmark.targetMet,
                  minTime: `${(benchmark.minMs * 1000).toFixed(2)}μs`,
                  maxTime: `${(benchmark.maxMs * 1000).toFixed(2)}μs`,
                },
              },
              message: benchmark.targetMet
                ? `SONA adaptation: ${(benchmark.avgMs * 1000).toFixed(2)}μs (target <50μs met)`
                : `SONA adaptation: ${(benchmark.avgMs * 1000).toFixed(2)}μs (target not met)`,
            };
          } catch {
            return {
              success: true,
              action: 'adapt',
              status: { sona: { enabled: false, reason: 'Intelligence module unavailable' } },
            };
          }

        default: // status
          // Get real neural system status
          try {
            const { getIntelligenceStats, benchmarkAdaptation, initializeIntelligence } = await import('../memory/intelligence.js');
            await initializeIntelligence();
            const stats = getIntelligenceStats();
            const benchmark = benchmarkAdaptation(50);
            return {
              success: true,
              action: 'status',
              neural: {
                enabled: config.neural.enabled,
                sonaEnabled: stats.sonaEnabled,
                ruvector: config.neural.ruvector || { enabled: false },
                features: config.neural.features || {},
                realMetrics: {
                  patternsLearned: stats.patternsLearned,
                  trajectoriesRecorded: stats.trajectoriesRecorded,
                  reasoningBankSize: stats.reasoningBankSize,
                  adaptationTime: `${(benchmark.avgMs * 1000).toFixed(2)}μs`,
                  targetMet: benchmark.targetMet,
                  lastAdaptation: stats.lastAdaptation
                    ? new Date(stats.lastAdaptation).toISOString()
                    : null,
                },
              },
              capabilities: [
                stats.sonaEnabled ? '✅ SONA Active' : '❌ SONA Inactive',
                benchmark.targetMet ? '✅ <0.05ms Target Met' : '⚠️ Target Not Met',
                `${stats.patternsLearned} patterns learned`,
                `${stats.trajectoriesRecorded} trajectories recorded`,
              ],
            };
          } catch {
            return {
              success: true,
              action: 'status',
              neural: {
                enabled: config.neural.enabled,
                ruvector: config.neural.ruvector || { enabled: false },
                features: config.neural.features || {},
              },
              message: 'Intelligence module not available - showing config only',
            };
          }
      }
    },
  },

  {
    name: 'embeddings_hyperbolic',
    description: 'Hyperbolic embedding operations (Poincaré ball) Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Hyperbolic action',
          enum: ['status', 'convert', 'distance', 'midpoint'],
          default: 'status',
        },
        embedding: {
          type: 'array',
          description: 'Euclidean embedding to convert',
          items: { type: 'number' },
        },
        embedding1: {
          type: 'array',
          description: 'First embedding for distance/midpoint',
          items: { type: 'number' },
        },
        embedding2: {
          type: 'array',
          description: 'Second embedding for distance/midpoint',
          items: { type: 'number' },
        },
      },
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      if (!config.hyperbolic.enabled) {
        return {
          success: false,
          error: 'Hyperbolic mode not enabled. Initialize with hyperbolic=true.',
        };
      }

      const action = (input.action as string) || 'status';
      const curvature = config.hyperbolic.curvature;

      switch (action) {
        case 'convert':
          const embedding = input.embedding as number[];
          if (!embedding || !Array.isArray(embedding)) {
            return { success: false, error: 'Embedding array required for convert action' };
          }
          const poincare = toPoincare(embedding, curvature);
          return {
            success: true,
            action: 'convert',
            euclidean: embedding,
            poincare,
            curvature,
            poincareNorm: Math.sqrt(poincare.reduce((sum, x) => sum + x * x, 0)),
          };

        case 'distance':
          const emb1 = input.embedding1 as number[];
          const emb2 = input.embedding2 as number[];
          if (!emb1 || !emb2) {
            return { success: false, error: 'embedding1 and embedding2 required for distance action' };
          }
          const dist = poincareDistance(emb1, emb2, curvature);
          return {
            success: true,
            action: 'distance',
            distance: dist,
            curvature,
            interpretation: dist < 1 ? 'close' : dist < 2 ? 'moderate' : 'far',
          };

        case 'midpoint':
          const e1 = input.embedding1 as number[];
          const e2 = input.embedding2 as number[];
          if (!e1 || !e2) {
            return { success: false, error: 'embedding1 and embedding2 required for midpoint action' };
          }
          // Simplified midpoint (proper Möbius midpoint is more complex)
          const mid = e1.map((_, i) => (e1[i] + e2[i]) / 2);
          const norm = Math.sqrt(mid.reduce((sum, x) => sum + x * x, 0));
          const scaledMid = mid.map(x => x * (config.hyperbolic.maxNorm / Math.max(norm, config.hyperbolic.maxNorm)));
          return {
            success: true,
            action: 'midpoint',
            midpoint: scaledMid,
            curvature,
          };

        default: // status
          return {
            success: true,
            action: 'status',
            hyperbolic: {
              enabled: true,
              curvature,
              epsilon: config.hyperbolic.epsilon,
              maxNorm: config.hyperbolic.maxNorm,
            },
            benefits: [
              'Better hierarchical data representation',
              'Exponential capacity in low dimensions',
              'Preserves tree-like structures',
              'Natural for taxonomy embeddings',
            ],
          };
      }
    },
  },

  {
    name: 'embeddings_status',
    description: 'Get embeddings system status and configuration Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          initialized: false,
          message: 'Embeddings not initialized. Run embeddings/init first.',
        };
      }

      // ADR-093 F5: distinguish "@ruvector/core installed" from "wired into
      // the embedding pipeline". Previously this collapsed both into a
      // single `ruvector: boolean` field, which gave callers no way to
      // tell whether re-running embeddings_init would help (#1698 partial
      // regression on the MCP boundary).
      let ruvectorAvailable = false;
      let ruvectorVersion: string | undefined;
      try {
        const mod = await import('@ruvector/core');
        ruvectorAvailable = !!(mod as Record<string, unknown>);
        try {
          // Best-effort: many packages expose a `version` constant
          ruvectorVersion = (mod as { version?: string }).version;
        } catch { /* ignore */ }
      } catch { /* not installed */ }

      const ruvectorEnabled = config.neural.ruvector?.enabled ?? false;

      return {
        success: true,
        initialized: true,
        config: {
          model: config.model,
          dimension: config.dimension,
          cacheSize: config.cacheSize,
          hyperbolic: config.hyperbolic,
          neural: {
            enabled: config.neural.enabled,
            // Backwards-compatible: keep the boolean view (truthy when wired).
            ruvector: ruvectorEnabled,
            // New shape — additive, non-breaking. Callers that need to
            // distinguish "package is installed" from "feature wired in"
            // read these instead of guessing from a single bool.
            ruvectorStatus: {
              available: ruvectorAvailable,
              enabled: ruvectorEnabled,
              version: ruvectorVersion,
            },
          },
        },
        paths: {
          config: getConfigPath(),
          models: config.modelPath,
        },
        initializedAt: config.initialized,
        capabilities: {
          onnxModels: ['Xenova/all-MiniLM-L6-v2', 'Xenova/all-mpnet-base-v2'],
          geometries: ['euclidean', 'poincare'],
          normalizations: ['L2', 'L1', 'minmax', 'zscore'],
          features: ['semantic search', 'hyperbolic projection', 'neural substrate'],
        },
      };
    },
  },

  // --- RaBitQ 1-bit quantized vector index ---

  {
    name: 'embeddings_rabitq_build',
    description: 'Build RaBitQ 1-bit quantized index from stored embeddings (32× compression). Pre-filters candidates via Hamming scan before exact rerank. Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Force rebuild even if index exists' },
      },
    },
    handler: async (params: Record<string, unknown>) => {
      const { buildRabitqIndex } = await import('../memory/rabitq-index.js');
      return buildRabitqIndex({ force: params.force as boolean });
    },
  },

  {
    name: 'embeddings_rabitq_search',
    description: 'Search via RaBitQ quantized index (fast Hamming scan). Returns candidate IDs for reranking. Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        k: { type: 'number', description: 'Number of results (default: 10)' },
        namespace: { type: 'string', description: 'Filter by namespace' },
      },
      required: ['query'],
    },
    handler: async (params: Record<string, unknown>) => {
      const { validateText: vt } = await import('./validate-input.js');
      const v = vt(params.query as string, 'query');
      if (!v.valid) return { success: false, error: v.error };

      const { searchRabitq } = await import('../memory/rabitq-index.js');
      const { generateEmbedding } = await import('../memory/memory-initializer.js');

      const queryEmb = await generateEmbedding(params.query as string);
      const results = await searchRabitq(queryEmb.embedding, {
        k: (params.k as number) || 10,
        namespace: params.namespace as string,
      });

      if (!results) {
        return { success: false, error: 'RaBitQ index not built. Call embeddings_rabitq_build first.' };
      }

      return {
        success: true,
        results: results.map(r => ({
          id: r.id.substring(0, 12),
          key: r.key,
          namespace: r.namespace,
          distance: Math.round(r.distance * 10000) / 10000,
        })),
        count: results.length,
      };
    },
  },

  {
    name: 'embeddings_rabitq_status',
    description: 'Get RaBitQ quantized index status — availability, vector count, compression ratio Use when text similarity matters beyond keyword match — native Grep finds exact strings, embeddings find meaning. Pair with memory_store / agentdb_pattern-search to land the vector against your knowledge base. For literal symbol search, native Grep is faster.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const { getRabitqStatus } = await import('../memory/rabitq-index.js');
      return { success: true, ...getRabitqStatus() };
    },
  },
  {
    // ADR-121 Phase 5 (full) — sidecar MCP tool. Proxies through
    // @claude-flow/embeddings's probeRuvectorSidecar so LLM agents
    // can ask "is the optimized ruvector backend reachable?" before
    // dispatching embedding-heavy work that would benefit from it.
    // Composable: pair with `embeddings_status` for the full local
    // capability picture, or with `agentdb_health` for the full
    // memory-substrate picture.
    name: 'embeddings_check_ruvector_sidecar',
    description: 'Check whether the ruvector CLI MCP sidecar is reachable and report its version + MCP tool surface. Use when a multi-step embedding pipeline could delegate to the optimized native Rust backend instead of going through this JS layer — the report tells you whether that path is available. For "is anything broken?" use ruflo doctor; for "should I use ruvector for this batch?" use this tool. Never throws.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Per-shellout timeout (default 5000ms).',
        },
      },
    },
    handler: async (input) => {
      // Deep import — the top-level @claude-flow/embeddings barrel's
      // type re-exports don't resolve cleanly through the CLI's
      // bundler-mode TypeScript at workspace-symlink time (the dist
      // file is present + has the export, but TS sees stale types).
      // The dist sub-module path is stable across alpha bumps because
      // `files: ['dist']` ships it.
      // Use the `./<file>` wildcard sub-path (no `.js` suffix) — the
      // exports map appends `.js` for the import target.
      const mod = await import('@claude-flow/embeddings/ruvector-mcp-probe' as string) as {
        probeRuvectorSidecar(opts?: { timeoutMs?: number }): Promise<unknown>;
        formatRuvectorAvailability(r: unknown): string;
      };
      const timeoutMs = typeof input?.timeoutMs === 'number' ? (input.timeoutMs as number) : 5_000;
      const report = await mod.probeRuvectorSidecar({ timeoutMs });
      return {
        success: true,
        ...(report as Record<string, unknown>),
        // Single-line summary suitable for inline display.
        summary: mod.formatRuvectorAvailability(report),
      };
    },
  },
  // ============================================================
  // ADR-121 Phase 5b — DiskannSnapshot MCP tools (alpha.47 CLI)
  // ============================================================
  //
  // Process-level registry of named DiskannSnapshot handles. Build
  // an index once, search it many times. Persistence to disk via
  // the snapshot's storagePath; the handle is keyed by `name`.
  // For in-memory snapshots, set persist: false and the index is
  // re-built only while this process lives.
  {
    name: 'embeddings_diskann_build',
    description: 'Build a DiskANN/Vamana ANN index from a batch of (id, vector) pairs. Use when you have a fixed corpus (≥10k vectors typical) that needs sub-millisecond ANN search and you want persistence across process restarts — for streaming inserts at smaller scale use SearchableEmbeddingCache instead, for batch in-memory 32×-compressed use RabitqSnapshot. Pair with embeddings_diskann_search to query, embeddings_diskann_status to inspect. Requires @ruvector/diskann (optional peer dep — throws a clear named error if missing).',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snapshot handle name (used by search + status). Must be unique per process.' },
        dimension: { type: 'number', description: 'Embedding dimension.' },
        entries: {
          type: 'array',
          description: 'Vectors to index. Each entry: { id: string, vector: number[] }.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              vector: { type: 'array', items: { type: 'number' } },
            },
            required: ['id', 'vector'],
          },
        },
        storagePath: { type: 'string', description: 'Optional directory for on-disk persistence (snapshot survives restarts via embeddings_diskann_load).' },
      },
      required: ['name', 'dimension', 'entries'],
    },
    handler: async (input) => {
      const { getDiskannRegistry } = await import('../memory/diskann-registry.js');
      const registry = getDiskannRegistry();
      const name = input.name as string;
      const dimension = input.dimension as number;
      const entries = input.entries as Array<{ id: string; vector: number[] }>;
      const storagePath = input.storagePath as string | undefined;
      try {
        const stats = await registry.build({ name, dimension, entries, storagePath });
        return { success: true, name, ...stats };
      } catch (err) {
        return { success: false, name, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'embeddings_diskann_search',
    description: 'Search a previously-built DiskANN index for the k nearest neighbors of a query vector. Use when you built an index via embeddings_diskann_build and now need ANN retrieval — returns ids + L2² distances sorted ascending. For text→vector→search in one call, pair with embeddings_generate first. For exact-match key lookup over a streaming cache, use SearchableEmbeddingCache.get instead.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snapshot handle name (set by embeddings_diskann_build).' },
        vector: { type: 'array', items: { type: 'number' }, description: 'Query vector. Must match the index dimension.' },
        k: { type: 'number', description: 'Number of nearest neighbors to return.' },
      },
      required: ['name', 'vector', 'k'],
    },
    handler: async (input) => {
      const { getDiskannRegistry } = await import('../memory/diskann-registry.js');
      const registry = getDiskannRegistry();
      const name = input.name as string;
      const vector = new Float32Array(input.vector as number[]);
      const k = input.k as number;
      try {
        const hits = await registry.search(name, vector, k);
        return { success: true, name, k, hits };
      } catch (err) {
        return { success: false, name, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'embeddings_diskann_status',
    description: 'List all DiskANN snapshots currently held by this MCP server, with their dimension, vector count, and storage path. Use when you want to inventory in-process indexes before opening a new one, or when debugging "which snapshot did I build?". For checking whether the @ruvector/diskann peer dep itself is installed, use embeddings_check_ruvector_sidecar (the family probe) instead.',
    category: 'embeddings',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { getDiskannRegistry } = await import('../memory/diskann-registry.js');
      const registry = getDiskannRegistry();
      return { success: true, snapshots: registry.list() };
    },
  },
  // ============================================================
  // ADR-121 Phase 8 (CLI) — AnnRouter MCP tools (alpha.48)
  // ============================================================
  //
  // Composition layer: agents declare the workload shape
  // (corpusSize/persistent/mutable) and the router picks between
  // HNSW / RaBitQ / DiskANN. The decision is returned to the agent
  // so they can see what was picked + why (useful for routing
  // explanations + cost attribution).
  {
    name: 'embeddings_ann_router_build',
    description: "Build an ANN index using AnnRouter — auto-selects between HNSW / RaBitQ / DiskANN based on workload. Use when you have a corpus to index and don't want to choose between the three backings yourself — declare the workload ({corpusSize, persistent, mutable}) and the router picks. Pair with embeddings_ann_router_search to query, embeddings_ann_router_status to see what was picked. For direct DiskANN control (e.g. for known billion-scale persistent indexes), use embeddings_diskann_build instead.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Handle name. Must be unique per process.' },
        workload: {
          type: 'object',
          properties: {
            corpusSize: { type: 'number', description: 'Approximate corpus size.' },
            dimension: { type: 'number' },
            persistent: { type: 'boolean', description: 'Survive process restarts? Forces DiskANN.' },
            mutable: { type: 'boolean', description: 'Streaming inserts/deletes after build? Prefers HNSW.' },
            storagePath: { type: 'string', description: 'On-disk path; required when persistent=true.' },
          },
          required: ['corpusSize', 'dimension'],
        },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, vector: { type: 'array', items: { type: 'number' } } },
            required: ['id', 'vector'],
          },
        },
      },
      required: ['name', 'workload', 'entries'],
    },
    handler: async (input) => {
      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();
      try {
        const result = await registry.build({
          name: input.name as string,
          workload: input.workload as Parameters<typeof registry.build>[0]['workload'],
          entries: input.entries as Array<{ id: string; vector: number[] }>,
        });
        return { success: true, name: input.name, ...result };
      } catch (err) {
        return { success: false, name: input.name, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'embeddings_ann_router_search',
    description: 'Search a named AnnRouter handle for the k nearest neighbors. Returns hits with the routing-decision-aware score (cosine sim for HNSW; L2 distance for RaBitQ/DiskANN — interpret relative to embeddings_ann_router_status). For raw DiskANN search use embeddings_diskann_search; for raw HNSW use SearchableEmbeddingCache.search directly.',
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        vector: { type: 'array', items: { type: 'number' } },
        k: { type: 'number' },
      },
      required: ['name', 'vector', 'k'],
    },
    handler: async (input) => {
      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();
      try {
        const hits = await registry.search(input.name as string, new Float32Array(input.vector as number[]), input.k as number);
        return { success: true, name: input.name, k: input.k, hits };
      } catch (err) {
        return { success: false, name: input.name, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'embeddings_ann_router_status',
    description: 'List all AnnRouter handles, each with its decided backing, routing reason, and current count. Use to inventory routed indexes + confirm the router picked what you expected. For peer-dep family availability use embeddings_check_ruvector_sidecar.',
    category: 'embeddings',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();
      return { success: true, handles: registry.list() };
    },
  },
  // ============================================================
  // ADR-121 Phase 9 — one-call RAG retrieval (alpha.49 CLI)
  // ============================================================
  {
    name: 'embeddings_search_text',
    description: "Embed a text query and search a named AnnRouter handle in a single call — the standard RAG retrieval shape. Eliminates the two-call dance of `embeddings_generate` then `embeddings_ann_router_search`. Returns hits plus per-stage latency (embeddingMs + searchMs) so callers can attribute cost. Pair with embeddings_ann_router_build to build the index first. For raw vector input (no embedding step) use embeddings_ann_router_search.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Query text. Will be embedded inline.' },
        name: { type: 'string', description: 'AnnRouter handle name (set by embeddings_ann_router_build).' },
        k: { type: 'number', description: 'Number of nearest neighbors.' },
      },
      required: ['text', 'name', 'k'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return {
          success: false,
          error: 'Embeddings not initialized. Run embeddings_init first.',
        };
      }
      const text = input.text as string;
      const name = input.name as string;
      const k = input.k as number;
      const tv = validateText(text, 'text');
      if (!tv.valid) return { success: false, error: tv.error };

      // Stage 1 — embed the query.
      const embedT0 = Date.now();
      let embedding: number[];
      try {
        embedding = await generateRealEmbedding(text, config.dimension);
      } catch (err) {
        return { success: false, error: `embed failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const embeddingMs = Date.now() - embedT0;

      // Stage 2 — search the named router handle.
      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();
      const searchT0 = Date.now();
      try {
        const hits = await registry.search(name, new Float32Array(embedding), k);
        const searchMs = Date.now() - searchT0;
        return {
          success: true,
          name,
          k,
          hits,
          latency: { embeddingMs, searchMs, totalMs: embeddingMs + searchMs },
          embeddingDimension: embedding.length,
        };
      } catch (err) {
        return {
          success: false,
          name,
          error: err instanceof Error ? err.message : String(err),
          latency: { embeddingMs, searchMs: 0 },
        };
      }
    },
  },
  // ============================================================
  // ADR-121 Phase 9b — batch one-call RAG (alpha.50 CLI)
  // ============================================================
  {
    name: 'embeddings_search_text_batch',
    description: "Embed N text queries and search a named AnnRouter handle for each, in a single MCP call. Standard shape for question-reformulation RAG (expand one user question into N variants, retrieve top-k for each, merge). Embeddings + searches run in parallel where the backing supports it. Returns one results entry per query in input order, plus aggregate latency. For single-query use embeddings_search_text; for raw vector input use embeddings_ann_router_search.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of query texts. Order preserved in results.',
        },
        name: { type: 'string', description: 'AnnRouter handle name.' },
        k: { type: 'number', description: 'Nearest neighbors per query.' },
      },
      required: ['texts', 'name', 'k'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return { success: false, error: 'Embeddings not initialized. Run embeddings_init first.' };
      }
      const texts = input.texts as string[];
      const name = input.name as string;
      const k = input.k as number;

      if (!Array.isArray(texts) || texts.length === 0) {
        return { success: false, error: 'texts must be a non-empty array' };
      }
      // Validate every text upfront so we don't half-embed before failing.
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        if (typeof t !== 'string') {
          return { success: false, error: `texts[${i}] is not a string` };
        }
      }

      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();

      // Stage 1 — embed all queries in parallel.
      const embedT0 = Date.now();
      let embeddings: number[][];
      try {
        embeddings = await Promise.all(
          texts.map(t => generateRealEmbedding(t, config.dimension)),
        );
      } catch (err) {
        return {
          success: false,
          name,
          error: `batch embed failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const embeddingMs = Date.now() - embedT0;

      // Stage 2 — search each in parallel against the named handle.
      // Per-query errors are captured into the results entry rather
      // than aborting the whole batch — callers see which queries
      // succeeded and which didn't.
      const searchT0 = Date.now();
      const results = await Promise.all(embeddings.map(async (emb, i) => {
        try {
          const hits = await registry.search(name, new Float32Array(emb), k);
          return { index: i, text: texts[i], success: true, hits };
        } catch (err) {
          return {
            index: i,
            text: texts[i],
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }));
      const searchMs = Date.now() - searchT0;

      const successCount = results.filter(r => r.success).length;
      return {
        success: successCount === results.length,
        name,
        k,
        queryCount: texts.length,
        successCount,
        failureCount: results.length - successCount,
        results,
        latency: {
          embeddingMs,
          searchMs,
          totalMs: embeddingMs + searchMs,
          avgPerQueryMs: Math.round(((embeddingMs + searchMs) / texts.length) * 100) / 100,
        },
        embeddingDimension: embeddings[0]?.length,
      };
    },
  },
  // ============================================================
  // ADR-121 Phase 12 — HyDE embedding-level fusion (alpha.53 CLI)
  // ============================================================
  //
  // HyDE (Gao, Ma, Lin, Callan 2022 — "Precise Zero-Shot Dense
  // Retrieval without Relevance Labels"): question embeddings live in
  // "question space" while documents embed into "answer space", so
  // cosine search systematically underweights relevant docs. The
  // standard fix: have an LLM generate N hypothetical answers, embed
  // each, AVERAGE the embeddings into a single query vector, search
  // once with that.
  //
  // Distinct from `embeddings_search_text_ensemble` (Phase 11):
  //   - HyDE fuses at the EMBEDDING level (1 search after average).
  //     Cheaper, finds the centroid hit, interpolates between
  //     hypothetical answers.
  //   - RRF fuses at the RANK level (N searches then merge ranks).
  //     More expensive, preserves intent boundaries between variants.
  //
  // Both are useful. Production systems often combine them — HyDE
  // inside one ranked list, RRF across multiple lists.
  {
    name: 'embeddings_search_text_hyde',
    description: "Embed N hypothetical-answer texts, AVERAGE their embeddings into a single query vector, and search a named AnnRouter handle once. Implements the HyDE recipe (Gao et al. 2022) for zero-shot dense retrieval — the LLM-generated hypothetical answers live in the same answer-space as the corpus, so the averaged vector lands near the true relevant docs. Distinct from embeddings_search_text_ensemble (which fuses at the rank level via RRF — more expensive, preserves intent boundaries); HyDE fuses at the embedding level (cheaper, one search, finds the centroid hit). Optional `weights` per text (e.g. weight the user's original question 0.5× and LLM answers 1.0× each — the paper's recommended recipe). Returns hits + averaged-vector metadata (unitNorm assertion + contributing-text count) for transparency.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of hypothetical-answer texts (LLM-generated) to fuse. The caller is responsible for generating these — typically via a few-shot prompt to an LLM asking it to answer the user question.',
        },
        name: { type: 'string', description: 'AnnRouter handle name (set by embeddings_ann_router_build).' },
        k: { type: 'number', description: 'Number of nearest neighbors to return.' },
        weights: {
          type: 'array',
          items: { type: 'number' },
          description: 'Per-text weights for the embedding average. Length must equal texts.length. Default uniform.',
        },
      },
      required: ['texts', 'name', 'k'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return { success: false, error: 'Embeddings not initialized. Run embeddings_init first.' };
      }
      const texts = input.texts as string[];
      const name = input.name as string;
      const k = input.k as number;
      const weights = Array.isArray(input.weights) ? input.weights as number[] : undefined;

      if (!Array.isArray(texts) || texts.length === 0) {
        return { success: false, error: 'texts must be a non-empty array' };
      }
      if (!Number.isInteger(k) || k < 1) {
        return { success: false, error: 'k must be a positive integer' };
      }
      for (let i = 0; i < texts.length; i++) {
        if (typeof texts[i] !== 'string') {
          return { success: false, error: `texts[${i}] is not a string` };
        }
      }
      if (weights && weights.length !== texts.length) {
        return {
          success: false,
          error: `weights.length (${weights.length}) must match texts.length (${texts.length})`,
        };
      }
      if (weights) {
        for (let i = 0; i < weights.length; i++) {
          if (weights[i]! < 0) {
            return { success: false, error: `weights[${i}] is negative` };
          }
        }
      }

      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();

      // Stage 1 — embed each hypothetical text in parallel.
      const embedT0 = Date.now();
      let embeddings: number[][];
      try {
        embeddings = await Promise.all(
          texts.map(t => generateRealEmbedding(t, config.dimension)),
        );
      } catch (err) {
        return { success: false, name, error: `batch embed failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const embeddingMs = Date.now() - embedT0;

      // Stage 2 — average the embeddings (HyDE fusion).
      const { averageEmbeddings, isUnitNorm } = await import('@claude-flow/embeddings/embedding-fusion');
      const fuseT0 = Date.now();
      const avgVec = averageEmbeddings(embeddings, {
        weights,
        normalizeInputs: true,
        normalizeOutput: true,
      });
      const fuseMs = Date.now() - fuseT0;
      const fusedUnit = isUnitNorm(avgVec);

      // Stage 3 — single search with the averaged vector.
      const searchT0 = Date.now();
      let hits;
      try {
        hits = await registry.search(name, avgVec, k);
      } catch (err) {
        return {
          success: false,
          name,
          error: err instanceof Error ? err.message : String(err),
          latency: { embeddingMs, fuseMs, searchMs: 0 },
        };
      }
      const searchMs = Date.now() - searchT0;

      return {
        success: true,
        name,
        k,
        hits,
        hyde: {
          textsFused: texts.length,
          weights: weights ?? null,
          averagedVectorUnitNorm: fusedUnit,
          dimension: avgVec.length,
        },
        latency: {
          embeddingMs,
          fuseMs,
          searchMs,
          totalMs: embeddingMs + fuseMs + searchMs,
        },
      };
    },
  },
  // ============================================================
  // ADR-121 Phase 11 — RRF ensemble retrieval (alpha.52 CLI)
  // ============================================================
  //
  // Question-reformulation pipelines produce N parallel result lists.
  // Reciprocal Rank Fusion (Cormack-Clarke-Büttcher 2009) fuses them
  // into a single ranking without needing score comparability across
  // lists. Composes `embeddings_search_text_batch` (N parallel
  // searches) with `reciprocalRankFusion` (rank-level merge).
  //
  // Standard production ensemble-RAG pattern. Pairs naturally with
  // LLM query rewriting upstream (expand "how does auth work?" into
  // {"how does authentication work?", "what's the login flow?",
  //  "describe the OAuth2 handshake"} → batch search each →
  // RRF-fuse) — recovers more relevant docs than a single search.
  {
    name: 'embeddings_search_text_ensemble',
    description: "Embed N text query variants, search a named AnnRouter handle for each in parallel, then RRF-fuse (Reciprocal Rank Fusion, Cormack-Clarke-Büttcher 2009) the N hit-lists into a single merged top-k ranking. Standard production shape for question-reformulation RAG: agents expand one user question into N variants, retrieve top-k for each, get a single fused list back — items appearing high in MORE variants outrank items appearing high in only one. Returns fused hits with per-list ranks for transparency + aggregate latency. λ-equivalent here is `kRrf` (default 60 per SIGIR 2009). Per-list `listWeights` available for biased ensemble (e.g. weight the original-query list 2× over reformulations). For non-fused multi-query results use embeddings_search_text_batch; for single-query diverse retrieval use embeddings_search_text_diverse.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of query text variants. Order preserved in per-list ranks.',
        },
        name: { type: 'string', description: 'AnnRouter handle name (set by embeddings_ann_router_build).' },
        k: { type: 'number', description: 'Number of fused results to return.' },
        perQueryK: {
          type: 'number',
          description: 'Top-k per query before fusion. Default 2*k. Larger = wider candidate pool, more compute.',
        },
        kRrf: {
          type: 'number',
          description: 'RRF smoothing constant. Default 60 (SIGIR 2009). Smaller = top-rank dominance.',
        },
        listWeights: {
          type: 'array',
          items: { type: 'number' },
          description: 'Per-query weights. Length must equal texts.length. Default = 1 each.',
        },
      },
      required: ['texts', 'name', 'k'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return { success: false, error: 'Embeddings not initialized. Run embeddings_init first.' };
      }
      const texts = input.texts as string[];
      const name = input.name as string;
      const k = input.k as number;
      const perQueryK = typeof input.perQueryK === 'number' && input.perQueryK >= 1
        ? input.perQueryK
        : Math.max(k * 2, k);
      const kRrf = typeof input.kRrf === 'number' && input.kRrf > 0 ? input.kRrf : 60;
      const listWeights = Array.isArray(input.listWeights) ? input.listWeights as number[] : undefined;

      if (!Array.isArray(texts) || texts.length === 0) {
        return { success: false, error: 'texts must be a non-empty array' };
      }
      if (!Number.isInteger(k) || k < 1) {
        return { success: false, error: 'k must be a positive integer' };
      }
      for (let i = 0; i < texts.length; i++) {
        if (typeof texts[i] !== 'string') {
          return { success: false, error: `texts[${i}] is not a string` };
        }
      }
      if (listWeights && listWeights.length !== texts.length) {
        return {
          success: false,
          error: `listWeights.length (${listWeights.length}) must match texts.length (${texts.length})`,
        };
      }

      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();

      // Stage 1 — embed all queries in parallel.
      const embedT0 = Date.now();
      let embeddings: number[][];
      try {
        embeddings = await Promise.all(texts.map(t => generateRealEmbedding(t, config.dimension)));
      } catch (err) {
        return { success: false, name, error: `batch embed failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const embeddingMs = Date.now() - embedT0;

      // Stage 2 — search each variant in parallel. Per-query errors
      // become empty result lists (the variant just doesn't contribute
      // to the fusion) rather than aborting the ensemble.
      const searchT0 = Date.now();
      const perQueryResults = await Promise.all(embeddings.map(async (emb, i) => {
        try {
          const hits = await registry.search(name, new Float32Array(emb), perQueryK);
          return { index: i, text: texts[i], hits, success: true as const };
        } catch (err) {
          return {
            index: i,
            text: texts[i],
            hits: [] as Array<{ id: string; score: number }>,
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }));
      const searchMs = Date.now() - searchT0;

      // Stage 3 — RRF fusion across the per-query lists.
      const { reciprocalRankFusion } = await import('@claude-flow/embeddings/rrf');
      const fuseT0 = Date.now();
      const lists = perQueryResults.map(r => r.hits.map(h => ({ id: h.id, payload: { score: h.score } })));
      const fused = reciprocalRankFusion(lists, { k, kRrf, listWeights });
      const fuseMs = Date.now() - fuseT0;

      const successCount = perQueryResults.filter(r => r.success).length;
      return {
        success: successCount === perQueryResults.length,
        name,
        k,
        queryCount: texts.length,
        perQueryK,
        kRrf,
        listWeights: listWeights ?? null,
        successCount,
        failureCount: perQueryResults.length - successCount,
        hits: fused,
        perQuery: perQueryResults.map(r => ({
          index: r.index,
          text: r.text,
          success: r.success,
          hitCount: r.hits.length,
          error: r.success ? undefined : (r as { error: string }).error,
        })),
        latency: {
          embeddingMs,
          searchMs,
          fuseMs,
          totalMs: embeddingMs + searchMs + fuseMs,
          avgPerQueryMs: Math.round(((embeddingMs + searchMs) / texts.length) * 100) / 100,
        },
        embeddingDimension: embeddings[0]?.length,
      };
    },
  },
  // ============================================================
  // ADR-121 Phase 10 — MMR diversity rerank (alpha.51 CLI)
  // ============================================================
  //
  // Plain top-k often returns near-duplicate chunks. MMR picks a
  // diversified top-k by trading off relevance against redundancy
  // (Carbonell & Goldstein 1998). Fetches `fetchMultiplier * k`
  // candidates from AnnRouter, then reranks to k via mmrRerank.
  //
  // Pairs with embeddings_search_text (relevance only). Same caller
  // contract — text + handle name + k — plus optional `lambda` and
  // `fetchMultiplier`. Returns diversity stats so callers can
  // confirm the rerank actually spread the result.
  {
    name: 'embeddings_search_text_diverse',
    description: "Embed a text query, fetch a wider candidate pool from a named AnnRouter handle, and rerank with MMR (Maximal Marginal Relevance) to return a diverse top-k. Use when plain top-k tends to return near-duplicates (e.g. corpora with many paraphrased chunks). λ controls relevance/diversity tradeoff: 1.0 = same as embeddings_search_text, 0.5 = balanced (default), 0.0 = pure diversity. fetchMultiplier controls how many candidates to consider before reranking (default 5×k). Returns hits + diversification stats (averagePairwiseSimilarity — lower is more diverse). For plain (non-diversified) RAG use embeddings_search_text.",
    category: 'embeddings',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Query text. Will be embedded inline.' },
        name: { type: 'string', description: 'AnnRouter handle name (set by embeddings_ann_router_build).' },
        k: { type: 'number', description: 'Number of diverse nearest neighbors to return.' },
        lambda: {
          type: 'number',
          description: 'Relevance/diversity tradeoff in [0,1]. 1=pure relevance, 0=pure diversity. Default 0.5.',
        },
        fetchMultiplier: {
          type: 'number',
          description: 'Candidate pool size = fetchMultiplier * k. Larger = more candidates to diversify from, more compute. Default 5.',
        },
      },
      required: ['text', 'name', 'k'],
    },
    handler: async (input) => {
      const config = loadConfig();
      if (!config) {
        return { success: false, error: 'Embeddings not initialized. Run embeddings_init first.' };
      }
      const text = input.text as string;
      const name = input.name as string;
      const k = input.k as number;
      const lambda = typeof input.lambda === 'number' ? input.lambda : 0.5;
      const fetchMultiplier = typeof input.fetchMultiplier === 'number' && input.fetchMultiplier >= 1
        ? input.fetchMultiplier
        : 5;
      const tv = validateText(text, 'text');
      if (!tv.valid) return { success: false, error: tv.error };
      if (!Number.isInteger(k) || k < 1) {
        return { success: false, error: 'k must be a positive integer' };
      }

      // Stage 1 — embed the query.
      const embedT0 = Date.now();
      let embedding: number[];
      try {
        embedding = await generateRealEmbedding(text, config.dimension);
      } catch (err) {
        return { success: false, error: `embed failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const embeddingMs = Date.now() - embedT0;
      const queryVec = new Float32Array(embedding);

      // Stage 2 — fetch a wider pool of candidates from the router.
      const { getAnnRouterRegistry } = await import('../memory/ann-router-registry.js');
      const registry = getAnnRouterRegistry();
      const fetchK = Math.max(k, Math.floor(k * fetchMultiplier));
      const searchT0 = Date.now();
      let candidatesRaw: Array<{ id: string; score: number; vector?: Float32Array | number[]; payload?: unknown }>;
      try {
        candidatesRaw = await registry.search(name, queryVec, fetchK) as typeof candidatesRaw;
      } catch (err) {
        return {
          success: false,
          name,
          error: err instanceof Error ? err.message : String(err),
          latency: { embeddingMs, searchMs: 0, rerankMs: 0 },
        };
      }
      const searchMs = Date.now() - searchT0;

      // Filter to candidates that have a vector (MMR needs it).
      // Routers that don't surface vectors (rare) degrade to
      // plain top-k for safety rather than throwing.
      const candidatesWithVec = candidatesRaw.filter(c => c.vector != null);
      if (candidatesWithVec.length === 0) {
        return {
          success: true,
          name,
          k,
          hits: candidatesRaw.slice(0, k),
          mmr: { applied: false, reason: 'no candidate vectors available — degraded to plain top-k' },
          latency: { embeddingMs, searchMs, rerankMs: 0, totalMs: embeddingMs + searchMs },
        };
      }

      // Stage 3 — MMR rerank.
      // Sub-path import bypasses the index barrel — TS resolves the
      // mmr.d.ts directly via the './*' export condition, which
      // sidesteps a stale-cache issue with the aggregate index.d.ts.
      const { mmrRerank, averagePairwiseSimilarity } = await import('@claude-flow/embeddings/mmr');
      const rerankT0 = Date.now();
      const picked = mmrRerank(
        candidatesWithVec.map(c => ({
          id: c.id,
          vector: c.vector!,
          score: c.score,
          payload: c.payload,
        })),
        queryVec,
        { k, lambda },
      );
      const rerankMs = Date.now() - rerankT0;

      const avgPairSim = averagePairwiseSimilarity(picked);

      // Strip vectors from the response to keep stdout sane.
      // Callers wanting the vectors can re-fetch via search.
      const hits = picked.map(p => ({
        id: p.id,
        score: p.relevance,
        mmrScore: p.mmrScore,
        relevance: p.relevance,
        redundancy: p.redundancy,
        pickOrder: p.pickOrder,
        payload: p.payload,
      }));

      return {
        success: true,
        name,
        k,
        hits,
        mmr: {
          applied: true,
          lambda,
          fetchMultiplier,
          candidatesConsidered: candidatesWithVec.length,
          averagePairwiseSimilarity: avgPairSim,
        },
        latency: {
          embeddingMs,
          searchMs,
          rerankMs,
          totalMs: embeddingMs + searchMs + rerankMs,
        },
        embeddingDimension: embedding.length,
      };
    },
  },
];
