# ADR-093: goal_ui Optimization for RuVector WASM + AgentDB

**Status**: Proposed
**Date**: 2026-05-02
**Author**: ruflo team
**Branch**: `feat/goal_ui-ruvector-wasm`
**Relates to**: ADR-033 (RuVector WASM-MCP), ADR-076 (Memory Bridge), ADR-077 (DiskANN), ADR-088 (LongMemEval benchmark)

## Context

`v3/goal_ui/` (`@ruflo/research`, live at [goal.ruv.io](https://goal.ruv.io)) is a Vite/React app that turns plain-English research goals into GOAP-planned agent workflows. Today the data plane is Supabase-only:

- `src/integrations/supabase/` — typed client + DB schema
- `supabase/functions/*` — edge functions: `research-step`, `generate-research-goal`, `generate-action-items`, `optimize-research-config`, `research-api`
- `example.env` exposes `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`

The rest of Ruflo has standardized on **AgentDB + RuVector HNSW** for memory, vector search, and semantic routing. ADR-033 wired the RuVector WASM-MCP layer into ruvocal. The same primitives are available in-browser for goal_ui:

- `ruvector` (npm) — HNSW search, hybrid retrieval, Graph RAG
- `ruvector-onnx-embeddings-wasm` — ONNX MiniLM-L6 (384d) running in-browser
- `ruvector-attention-wasm` — Flash Attention WASM kernel

Today none of these are wired into goal_ui. Some workflows that should be local (semantic plan caching, similar-goal lookup, action-item embedding) round-trip to Supabase Edge Functions instead.

### Why this matters

1. **Latency.** GOAP plan reuse is a perfect cache target — same goal text, same plan. A semantic cache hit (cosine ≥ 0.92) returns in <5ms vs ~800ms edge-function call.
2. **Offline / degraded-network.** The widget embed (`<script src="widget.js">`) should keep working when Supabase is unreachable for read-only paths.
3. **Privacy.** Goal-text embeddings can stay client-side instead of being sent to a third-party LLM service.
4. **Stack alignment.** Ruflo's other surfaces (claude-flow CLI, ruvocal, agentdb tools) use the same primitives; goal_ui is the outlier.

## Decision

Migrate `v3/goal_ui/` to a **hybrid** data plane: keep Supabase for auth + persistent state, add RuVector WASM for vector search, embedding, and semantic caching. Validate every UI element and every agent workflow via Playwright e2e tests. Brand and terminology cleanup across the app.

### Migration matrix (preliminary — Step 04 finalizes)

| Workflow | Classification | Rationale |
|----------|---------------|-----------|
| Auth / sessions | `KEEP_SUPABASE` | Persistence + RLS — not a Ruflo concern |
| Plan persistence | `KEEP_SUPABASE` | Cross-device sync needed |
| GOAP plan cache | `WASM_LOCAL` | Pure read; semantic dedup works offline |
| `generate-research-goal` | `HYBRID` | Local goal-text embedding + Supabase write-through for analytics |
| `research-step` | `HYBRID` | Cache prior steps locally; mutations still server-side |
| Similar-goal suggestion | `WASM_LOCAL` | Read-only nearest-neighbor over IndexedDB-stored embeddings |
| Widget embed | `WASM_LOCAL` (best-effort) | Cross-origin iframe may not load WASM — fallback to Supabase |

### Out of scope

- Replacing Supabase auth, billing, or RLS.
- Mobile / native packaging.
- Modifying server-side edge function code (only swapping client callsites).
- `v3/@claude-flow/*` packages.

### Success criteria

| Criterion | Target |
|-----------|--------|
| ADR + plan + inventories committed | Phase 0 done |
| ruvector deps land cleanly | `npm install` succeeds, no peer warnings |
| `npm run build` + `npm run build:widget` both pass | Throughout |
| GOAP plan cache hit | ≥30% latency reduction on identical goals |
| Playwright UI element coverage | ≥30 assertions, all pass |
| Playwright workflow coverage | Every entry in workflow-inventory.md has happy + error path |
| Branding consistency | Audit pass — RuFlo terminology throughout |
| WASM bundle behind feature flag | `VITE_RUVECTOR_ENABLED` defaults false in prod |
| ADR-093 status | Accepted before merge |

## Implementation Plan

Detailed step-by-step plan lives in `v3/goal_ui/.optimization-plan.md` (26 steps across 6 phases, with checkboxes the autonomous /loop reads). High-level phases:

| Phase | Steps | Theme |
|-------|-------|-------|
| 0 | 01–04 | Spec, UI inventory, workflow inventory, migration matrix |
| 1 | 05–09 | Add deps, Vite WASM config, feature flag, ruvector client |
| 2 | 10–12 | POC: GOAP plan cache + measurement |
| 3 | 13–17 | Playwright e2e harness, smoke, element + workflow tests |
| 4 | 18–20 | Iterative workflow migration |
| 5 | 21–26 | Branding, security audit, docs, accessibility, final verification |

### Resumption protocol

A 5-minute /loop fires `continue` and:

1. Reads `v3/goal_ui/.optimization-plan.md`
2. Finds the first `- [ ]` step
3. Executes it (one step per fire)
4. Marks `- [x]`, commits, schedules the next fire

Honesty checkpoints at steps 5, 10, 15, 20: full build + Playwright smoke + screenshot diff before continuing.

## Consequences

### Positive
- goal_ui aligns with the rest of the Ruflo stack (AgentDB, RuVector, ONNX-WASM)
- Semantic plan caching makes repeat goals near-instant
- Playwright coverage catches regressions before they hit goal.ruv.io
- Documentation (UI inventory, workflow inventory, migration matrix) is itself reusable for other Ruflo surfaces

### Negative
- ~25 MB ONNX model + WASM kernels added to the bundle (mitigated by dynamic import + feature flag)
- Two retrieval paths to maintain (Supabase + ruvector) — write-through complexity in HYBRID workflows
- Browser cross-origin restrictions may prevent widget from loading WASM — fallback to Supabase path

### Risks
- ruvector WASM may have parity issues with the Node version (different ONNX runtime)
- IndexedDB quota on long-lived users could fill; needs an LRU eviction story (planned for Step 22)
- If Supabase auth tokens leak via `VITE_*` env exposure, the migration doesn't help — orthogonal concern

## References
- ADR-033 — RuVector WASM-MCP integration in ruvocal
- ADR-076 — Memory Bridge (Claude Code → AgentDB ONNX)
- ADR-077 — DiskANN persistent index
- ADR-088 — LongMemEval benchmark for AgentDB
- Plan file: `v3/goal_ui/.optimization-plan.md`
- App: `v3/goal_ui/`
- Live: https://goal.ruv.io
