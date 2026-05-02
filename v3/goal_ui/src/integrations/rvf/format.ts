/**
 * RVF (RuFlo Vector Format) v1 — browser-side header constants.
 *
 * These constants match `v3/@claude-flow/memory/src/rvf-backend.ts` (Node)
 * so blobs exported from one side can be imported on the other. We keep
 * the same magic / version / default dimensions / metric / quantization
 * vocabulary; the binary encode/decode is a thin wrapper.
 *
 * Browser blobs land in IndexedDB as JS objects (faster than re-encoding
 * binary on every write). The binary format is only used on export/import
 * — primarily for syncing with the Node RvfBackend.
 */

/** ASCII "RVF\0". 4-byte file/stream magic. */
export const MAGIC = 'RVF\0';
/** Format version. Bump on breaking layout changes. */
export const VERSION = 1;

/** Default vector dimensionality. MiniLM-L6 default; 1536 in Node default. */
export const DEFAULT_DIMENSIONS = 384;

/** Step 22e hardening — refuse to load entries larger than this. */
export const MAX_ENTRY_SIZE_BYTES = 256 * 1024;
/** Hard upper bound on dimensions; matches Node side's 1..10000 sanity. */
export const MAX_DIMENSIONS = 10_000;

export type Metric = 'cosine' | 'euclidean' | 'dot';
export type Quantization = 'fp32' | 'fp16' | 'int8';

export interface RvfHeader {
  magic: string;
  version: number;
  dimensions: number;
  metric: Metric;
  quantization: Quantization;
  entryCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Single entry as stored. Mirrors `MemoryEntry` in @claude-flow/memory. */
export interface RvfEntry {
  /** Stable internal id (UUID-ish). */
  id: string;
  /** Caller-supplied lookup key. */
  key: string;
  /** Logical namespace. Default: 'default'. */
  namespace: string;
  /** Free-form payload. JSON-serializable. */
  value: unknown;
  /** Optional vector, length must equal header.dimensions. */
  vector?: Float32Array;
  /** Optional metadata bag. */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RvfFile {
  header: RvfHeader;
  entries: RvfEntry[];
}

/**
 * Encode an in-memory RVF to a portable binary buffer.
 *
 * Layout (v1):
 *   magic   4 bytes ("RVF\0")
 *   header  JSON header length-prefixed: u32 LE length + UTF-8 JSON bytes
 *   entries JSON entries length-prefixed: u32 LE length + UTF-8 JSON bytes
 *           (vectors are base64'd inside the JSON entries object)
 *
 * This is deliberately simple — Node's RvfBackend already serializes
 * via JSON-with-base64 for portability. A future v2 can swap to a tighter
 * binary layout if profiling shows it matters.
 */
export function encodeRvf(file: RvfFile): Uint8Array {
  const enc = new TextEncoder();
  const headerJson = enc.encode(JSON.stringify(file.header));
  const entriesJson = enc.encode(JSON.stringify(file.entries.map(serializeEntry)));

  const total = 4 + 4 + headerJson.length + 4 + entriesJson.length;
  const out = new Uint8Array(total);
  let offset = 0;

  // Magic
  out[0] = MAGIC.charCodeAt(0);
  out[1] = MAGIC.charCodeAt(1);
  out[2] = MAGIC.charCodeAt(2);
  out[3] = 0;
  offset = 4;

  // Header length + bytes
  writeU32LE(out, offset, headerJson.length);
  offset += 4;
  out.set(headerJson, offset);
  offset += headerJson.length;

  // Entries length + bytes
  writeU32LE(out, offset, entriesJson.length);
  offset += 4;
  out.set(entriesJson, offset);

  return out;
}

export function decodeRvf(buf: Uint8Array): RvfFile {
  if (buf.length < 8) throw new Error('RVF: too short to contain header');
  if (
    buf[0] !== MAGIC.charCodeAt(0) ||
    buf[1] !== MAGIC.charCodeAt(1) ||
    buf[2] !== MAGIC.charCodeAt(2) ||
    buf[3] !== 0
  ) {
    throw new Error('RVF: bad magic');
  }
  const dec = new TextDecoder();
  let offset = 4;
  const headerLen = readU32LE(buf, offset);
  offset += 4;
  if (headerLen === 0) throw new Error('RVF: header length is zero');
  if (headerLen > 1024 * 1024) throw new Error('RVF: header length implausible');
  if (offset + headerLen > buf.length) {
    throw new Error('RVF: header truncated (declared length exceeds buffer)');
  }
  const header = JSON.parse(dec.decode(buf.subarray(offset, offset + headerLen))) as RvfHeader;
  offset += headerLen;

  if (header.version > VERSION) {
    throw new Error(`RVF: version ${header.version} not supported (max ${VERSION})`);
  }
  if (
    !Number.isInteger(header.dimensions) ||
    header.dimensions < 1 ||
    header.dimensions > MAX_DIMENSIONS
  ) {
    throw new Error(`RVF: invalid header.dimensions ${header.dimensions} (must be 1..${MAX_DIMENSIONS})`);
  }

  if (offset + 4 > buf.length) throw new Error('RVF: missing entries-length prefix');
  const entriesLen = readU32LE(buf, offset);
  offset += 4;
  if (offset + entriesLen > buf.length) {
    throw new Error('RVF: entries section truncated (declared length exceeds buffer)');
  }
  const rawEntries = JSON.parse(dec.decode(buf.subarray(offset, offset + entriesLen))) as Array<ReturnType<typeof serializeEntry>>;
  if (!Array.isArray(rawEntries)) {
    throw new Error('RVF: entries section did not parse as an array');
  }

  const entries = rawEntries.map((raw, i) => {
    // Step 22e — per-entry size cap (defends against IndexedDB
    // quota exhaustion via a malicious export).
    const serialized = JSON.stringify(raw);
    if (serialized.length > MAX_ENTRY_SIZE_BYTES) {
      throw new Error(
        `RVF: entry ${i} exceeds MAX_ENTRY_SIZE_BYTES (${serialized.length} > ${MAX_ENTRY_SIZE_BYTES})`,
      );
    }
    const entry = deserializeEntry(raw);
    // Step 22e — vector dim must match header.dimensions when present
    if (entry.vector && entry.vector.length !== header.dimensions) {
      throw new Error(
        `RVF: entry ${i} vector length ${entry.vector.length} does not match header.dimensions ${header.dimensions}`,
      );
    }
    return entry;
  });

  return { header, entries };
}

function writeU32LE(out: Uint8Array, offset: number, val: number): void {
  out[offset] = val & 0xff;
  out[offset + 1] = (val >>> 8) & 0xff;
  out[offset + 2] = (val >>> 16) & 0xff;
  out[offset + 3] = (val >>> 24) & 0xff;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  ) >>> 0;
}

function serializeEntry(e: RvfEntry) {
  return {
    id: e.id,
    key: e.key,
    namespace: e.namespace,
    value: e.value,
    vector: e.vector ? float32ToBase64(e.vector) : undefined,
    metadata: e.metadata,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function deserializeEntry(raw: ReturnType<typeof serializeEntry>): RvfEntry {
  return {
    id: raw.id,
    key: raw.key,
    namespace: raw.namespace,
    value: raw.value,
    vector: raw.vector ? base64ToFloat32(raw.vector) : undefined,
    metadata: raw.metadata,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Copy because Float32Array view requires aligned offset; safest to copy.
  const out = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  return out;
}
