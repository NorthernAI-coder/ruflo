/**
 * Midstream-aware federation transport loader (ADR-120, Step 2).
 *
 * Extends the agentic-flow `loadQuicTransport` loader pattern with a
 * preferred branch that probes `midstreamer` first. When `midstreamer`
 * ships real QUIC (currently the WASM build is a counter-tracking
 * stub per ADR-119), this loader picks it up automatically without
 * any change to consumer plugins.
 *
 * Resolution order:
 *
 *   1. If `MIDSTREAMER_QUIC_NATIVE=1` AND the `midstreamer` module
 *      exposes a real `QuicMultistream`-derived `AgentTransport`,
 *      use it. (Today: probes fail closed and we fall through.)
 *
 *   2. Otherwise: defer to agentic-flow's existing loader, which
 *      itself respects `AGENTIC_FLOW_QUIC_NATIVE=1` (ADR-108) and
 *      falls back to WebSocket (ADR-104) otherwise.
 *
 * The loader is opt-in: callers must explicitly invoke
 * `loadFederationTransport()` instead of `loadQuicTransport()`.
 * Behavior is identical to `loadQuicTransport()` until upstream
 * `midstreamer` ships its real QUIC build AND the operator sets the
 * env flag — so this change is safe to land before any of that
 * happens.
 *
 * Re-exports the `AgentTransport` / `AgentMessage` / `QuicTransportConfig`
 * surface from agentic-flow so consumers only import from one place.
 */

import {
  loadQuicTransport,
  type AgentTransport,
  type AgentMessage,
  type QuicTransportConfig,
} from 'agentic-flow/transport/loader';

export type { AgentTransport, AgentMessage, QuicTransportConfig };

/** Result envelope describing which backend the loader picked. */
export interface LoadedFederationTransport {
  /** The live transport. Send/receive against this. */
  transport: AgentTransport;
  /** Which loader branch resolved. Useful for logs/metrics. */
  source: 'midstreamer-native' | 'agentic-flow-loader';
  /** Free-form note when a probe failed (helps explain a fallback). */
  fallbackReason?: string;
}

/**
 * Probe the `midstreamer` npm package for a real QUIC transport.
 * Returns `null` when the env flag is off, when the package isn't
 * installed, when the import surface doesn't match expectations, or
 * when the loaded module is detectably the WASM stub (per ADR-119
 * the current shipped build is a counter-tracking stub — `isNative()`
 * or `isStub()` probes are checked when available).
 *
 * The function never throws — any failure becomes `null` so the
 * outer `loadFederationTransport` can transparently fall back.
 */
async function probeMidstreamerTransport(
  config?: QuicTransportConfig,
): Promise<{ transport: AgentTransport; reason?: string } | null> {
  if (process.env.MIDSTREAMER_QUIC_NATIVE !== '1') {
    return null;
  }

  let mod: unknown;
  try {
    // Lazy + indirect so bundlers don't try to resolve at compile time.
    // Prefer the `midstreamer/quic` sub-path (added in midstreamer@0.3.1
    // per upstream ruvnet/midstream#81) which exposes
    // `loadQuicTransport` directly without WASM init. Fall back to the
    // root `midstreamer` package for older versions that put the QUIC
    // surface on the default export.
    const dynamicImport: (s: string) => Promise<unknown> = new Function(
      's',
      'return import(s)',
    ) as (s: string) => Promise<unknown>;
    try {
      mod = await dynamicImport('midstreamer/quic');
    } catch {
      mod = await dynamicImport('midstreamer');
    }
  } catch {
    return null;
  }

  const candidate = mod as {
    loadQuicTransport?: (c?: QuicTransportConfig) => Promise<AgentTransport>;
    isNative?: () => boolean;
    isStub?: () => boolean;
    default?: {
      loadQuicTransport?: (c?: QuicTransportConfig) => Promise<AgentTransport>;
      isNative?: () => boolean;
      isStub?: () => boolean;
    };
  };

  // CommonJS sub-path exposes its API via `module.exports = {...};
  // module.exports.default = module.exports;` — so we also accept the
  // `.default` form. ESM imports flatten the named exports directly.
  const surface = (typeof candidate.loadQuicTransport === 'function'
    ? candidate
    : candidate.default) as {
    loadQuicTransport?: (c?: QuicTransportConfig) => Promise<AgentTransport>;
    isNative?: () => boolean;
    isStub?: () => boolean;
  } | undefined;
  if (!surface) {
    return null;
  }

  // Refuse to use the WASM stub. ADR-119 documented the previous
  // QuicMultistream as a counter-tracking stub with no real UDP, TLS,
  // or protocol — using it would silently downgrade the federation
  // path. midstreamer@0.3.1+ ships a real QUIC transport via
  // `midstreamer/quic` (ADR-120, Step 1 — upstream PR ruvnet/midstream#81)
  // and reports `isNative() === true`. Older versions either expose
  // `isStub()` returning true or omit both probes.
  if (typeof surface.isStub === 'function' && surface.isStub()) {
    return { transport: null as unknown as AgentTransport, reason: 'midstreamer module reports isStub() === true; refusing to bind a stub QUIC backend (ADR-119)' };
  }

  if (typeof surface.loadQuicTransport !== 'function') {
    return null;
  }

  if (typeof surface.isNative === 'function' && !surface.isNative()) {
    return null;
  }

  try {
    const transport = await surface.loadQuicTransport(config);
    return { transport };
  } catch (err) {
    return {
      transport: null as unknown as AgentTransport,
      reason: `midstreamer.loadQuicTransport failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Top-level loader for federation transport. Identical signature to
 * agentic-flow's `loadQuicTransport`, but with the midstreamer-first
 * preference. Use this from `plugins/ruflo-federation` in place of
 * the bare `loadQuicTransport`.
 *
 * Failure mode: if midstreamer is requested but rejects (stub, init
 * error, missing package), this function falls through to the
 * agentic-flow loader silently — the federation peer always gets a
 * transport (WebSocket fallback in the worst case, per ADR-104).
 */
export async function loadFederationTransport(
  config?: QuicTransportConfig,
): Promise<LoadedFederationTransport> {
  const probe = await probeMidstreamerTransport(config);
  if (probe && probe.transport) {
    return { transport: probe.transport, source: 'midstreamer-native' };
  }

  const transport = await loadQuicTransport(config);
  return {
    transport,
    source: 'agentic-flow-loader',
    fallbackReason: probe?.reason,
  };
}
