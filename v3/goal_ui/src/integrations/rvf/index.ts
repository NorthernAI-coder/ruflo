/**
 * RVF — RuFlo Vector Format browser backend.
 *
 * Public API surface for `src/integrations/rvf/`. Imported as:
 *
 *   import { getRvfClient, embedText } from '@/integrations/rvf';
 *
 * Per ADR-093, this is the IndexedDB-backed replacement for the
 * Supabase data plane. Format-compatible with `@claude-flow/memory`'s
 * Node `RvfBackend` so blobs round-trip between server and browser.
 */

export { getRvfClient, RvfClient } from './client';
export type { PutOptions, GetOptions, ListOptions } from './client';

export { getEmbedder, embedText } from './embed';

export {
  searchByVector,
  normalizeL2,
} from './search';
export type { SearchHit, SearchOptions } from './search';

export {
  encodeRvf,
  decodeRvf,
  MAGIC,
  VERSION,
  DEFAULT_DIMENSIONS,
} from './format';
export type {
  RvfHeader,
  RvfEntry,
  RvfFile,
  Metric,
  Quantization,
} from './format';
