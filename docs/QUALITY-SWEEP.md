# Ruflo Project-Wide Quality Sweep

**Branch**: `chore/project-wide-quality-sweep`  
**Cut from**: `cdd5308d8` (main @ ruflo@3.10.2 / @claude-flow/cli@3.10.1)  
**Test baseline**: 1999 passing | 46 skipped  
**Do not regress**: ruflo@3.10.2, @claude-flow/cli@3.10.1, claude-flow@3.10.1  
**Target release**: 3.11.0 (unpublished until explicit user approval)

---

## Session Log

### Session 1 — 2026-05-25

**Baseline established.** Created tracking infrastructure.  
**Commits this session**: (pending first territory work)  
**Next session resumes**: T1 — Dead-code sweep on cli/src (knip pass + targeted removals)

---

## Territory Status

| # | Territory | Status | Violation Count (baseline) | Done Criteria |
|---|---|---|---|---|
| T1 | Dead-code sweep — `v3/@claude-flow/cli/src/**` | **in_progress** | TBD (knip pass needed) | knip clean, no unused exports, no unreachable branches |
| T2 | Dead-code sweep — `plugins/**` | pending | TBD | knip clean per plugin |
| T3 | Stale scripts | pending | 6 unreferenced in CI | Each script either wired to CI or deleted with justification |
| T4 | Slop hunt — `any` types, magic numbers, TODOs | pending | 229 `any` usages (95 in optional-modules.d.ts), 5 TODOs, 373 magic-number candidates | `any` reduced to legitimate ambient decls only; TODOs linked to issues |
| T5 | Mocked / placeholder claims | pending | 2 placeholder impls in hooks-tools.ts (SONA fallback), 1 honest stub in coordination-tools.ts | All "placeholder" labels either wired to real impl or removed from public API surface |
| T6 | Perf hotspots | pending | TBD (profiling needed) | No obvious O(n²) in hot paths, no redundant sync IO |
| T7 | Test honesty | pending | 5 trivial assertions, 46 skipped | Zero `expect(true).toBe(true)`; each skip has documented reason or re-enabled |
| T8 | ADR ↔ implementation drift | pending | ADR-120 through ADR-130 reference check needed | Every cited file path exists; stale ADRs flagged |
| T9 | Docs ↔ reality | pending | STATUS.md references 300 MCP tools, 49 CLI commands — needs re-count | Every listed command/tool/agent actually exists in source |
| T10 | Dependency hygiene | pending | 45 npm audit vulnerabilities (1 critical: protobufjs, 25 high) | No critical vulns; high vulns triaged with action/defer note; no truly unused deps |
| T11 | Witness pass | pending | Depends on T1-T10 changes | regen-witness passes, smoke-witness-marker-drift passes |

---

## T1 — Dead-code sweep: `v3/@claude-flow/cli/src/**`

**Status**: in_progress  
**Baseline snapshot** (2026-05-25):
- 194 TypeScript files in cli/src
- 1314 exported symbols
- `log-filters.ts` at root level — 0 import refs in src (but imported via side-effect in index.ts — keep)
- `config-adapter.ts` — used (lazy import + 2 test files)
- `mcp-client.ts` — 20+ references across src
- `optional-modules.d.ts` — 438 lines, 95 `any` declarations for ambient optional modules (legitimate pattern for unhoisted dynamic imports — keep as-is)
- Commented-out code blocks: 98 candidates (needs manual review)
- 229 total `: any` / `as any` usages

**Acceptance criteria**:
- [ ] knip run showing 0 unused exports (or all remaining justified)
- [ ] No files with 0 callers that aren't intentional side-effects
- [ ] No unreachable code blocks (tsc --strictNullChecks catches most)
- [ ] Commented-out blocks reviewed; scaffolding removed

**Blockers**: need to run `npx knip` — will install as devDep or run via npx

---

## T2 — Dead-code sweep: `plugins/**`

**Status**: pending  
**Baseline snapshot**:
- 6862 source files across plugins/
- No package-level dep overlap found (0 packages with multiple version specs)

**Acceptance criteria**:
- [ ] Each plugin's exported API used by at least one caller or marked `@internal`
- [ ] No plugin shipping identical logic to another plugin (duplicated utilities)

---

## T3 — Stale scripts

**Status**: pending  
**Baseline snapshot** (2026-05-25):
- 52 total `.mjs` scripts
- 55 referenced in CI workflows
- 6 NOT referenced in any CI workflow:
  - `scripts/bulk-fix-tool-descriptions.mjs` — one-shot tool, keep or delete
  - `scripts/inventory-capabilities.mjs` — referenced in STATUS.md doc, not CI
  - `scripts/regen-witness.mjs` — thin wrapper around plugin regen, not in CI (uses `regenerate-witness.mjs` instead)
  - `scripts/regenerate-witness.mjs` — the canonical regen script (also not in CI!)
  - `scripts/sign-witness-from-inventory.mjs` — one-shot signing tool
  - `scripts/smoke-memory-no-stray-db.mjs` — smoke test not wired to CI
- **DUPLICATE**: `regen-witness.mjs` vs `regenerate-witness.mjs` — both exist, different implementations (70 vs 102 lines), former is a "thin wrapper" per its header. Needs consolidation.

**Acceptance criteria**:
- [ ] Each unreferenced script either (a) added to a CI job, or (b) deleted with justification commit
- [ ] `regen-witness.mjs` and `regenerate-witness.mjs` consolidated to one canonical file
- [ ] `smoke-memory-no-stray-db.mjs` wired to CI smoke job or deleted

---

## T4 — Slop hunt: `any` types, magic numbers, TODOs

**Status**: pending  
**Baseline snapshot** (2026-05-25):
- 229 `: any` / `as any` usages in cli/src
  - 95 in `types/optional-modules.d.ts` (ambient decls — LEGITIMATE, keep)
  - 31 in `memory/memory-bridge.ts` — highest priority for real types
  - 9 in `memory/memory-initializer.ts`
  - 6 in `ruvector/diskann-backend.ts`
  - 6 in `mcp-tools/agentdb-tools.ts`
  - remaining 82 across 46 other files
- 5 TODO/FIXME/XXX in cli/src (low count, needs full grep)
- 373 magic-number candidates (many false positives — port numbers, timeouts, etc.)

**Acceptance criteria**:
- [ ] `any` in non-ambient code reduced by 50%+ (target: <70 non-ambient usages)
- [ ] All TODOs link to a GitHub issue or are removed
- [ ] Magic numbers with no comment named as constants (top 20 by frequency)

---

## T5 — Mocked / placeholder claims

**Status**: pending  
**Baseline snapshot** (2026-05-25):
- `hooks-tools.ts:3115/3141` — `implementation: 'placeholder'` when SONA unavailable. The code has a real fallback path (ReasoningBank) — honest about it via the `_stub` flag in response
- `coordination-tools.ts:730/762` — `coordination_orchestrate` records but does not execute. Has `_note` explaining this honestly
- `commands/analyze.ts:304` — "Code subcommand (placeholder for future code analysis)" — dead code comment, check if command is wired
- `memory-tools.ts:1085` — doc string says "placeholder perf metrics" — honest in the description
- `appliance/rvfa-builder.ts:298` — stub verify script fallback when appliance-specific script not found (legitimate fallback)
- `gguf-engine.ts:285` — "metadata-only stub" when node-llama-cpp not installed (legitimate optional)

**Acceptance criteria**:
- [ ] No public MCP tool returns `_stub: true` without a companion issue tracking real implementation
- [ ] `analyze code` subcommand either implemented or removed from CLI
- [ ] "placeholder perf metrics" in memory-tools doc string updated to match reality

---

## T6 — Performance hotspots

**Status**: pending  
**Deferred scope note**: Requires profiling data to identify real hotspots. Priority files:
- `memory/memory-bridge.ts` (2300+ lines, complex dispatch)
- `memory/memory-initializer.ts`
- MCP tool dispatch loop
- WASM agent composition

**Will not defer**: obvious O(n²) patterns can be found by static analysis. Profile-guided work is a 3.12.0 candidate if it requires instrumentation infrastructure not currently present.

---

## T7 — Test honesty

**Status**: pending  
**Baseline snapshot** (2026-05-25):
- 5 trivial assertion candidates (`expect(true)`, `expect(false)`, placeholder pattern)
- 46 skipped tests (vitest reporter confirms this matches the official count)
- Per IMPROVEMENT-ROADMAP.md Item 1: 4 skipped integration tests in `v3/__tests__/integration/` covering real production bugs

**Acceptance criteria**:
- [ ] Zero `expect(true).toBe(true)` style assertions
- [ ] All 46 skips documented with `// skip: reason` comment or re-enabled
- [ ] Integration tests from Item 1 (#1872) evaluated — re-enable if fixable within sweep scope

---

## T8 — ADR ↔ implementation drift

**Status**: pending  
**Scope**: ADR-120 through ADR-130 (the 11 most recent ADRs)  
**Initial findings**:
- ADR-120: no file paths cited
- ADR-122: references `v3/@claude-flow/browser/package.json` — browser package exists?
- ADR-124: same browser package references
- ADR-126: cites `v3/@claude-flow/memory/src/agentdb-adapter.ts`
- ADR-127: cites `v3/@claude-flow/cli/.claude/helpers/github-safe.js` — known to exist
- ADR-128: cites `.claude/commands/` and `.claude/skills/`
- ADR-129: cites `v3/@claude-flow/cli/src/ruvector/agent-wasm.ts`

**Acceptance criteria**:
- [ ] Every file path cited in ADR-120 through ADR-130 verified to exist
- [ ] Stale paths documented in ADR with correction note or ADR superseded

---

## T9 — Docs ↔ reality

**Status**: pending  
**Claims to verify** (from STATUS.md, now stale since STATUS.md references 3.6.x):
- STATUS.md: 300 MCP tools, 49 CLI commands, 32 plugins, 43 agents
- IMPROVEMENT-ROADMAP.md: references specific issue numbers (#1872, #2030, #2032, etc.)
- USERGUIDE.md: lists every CLI command

**Note**: STATUS.md is outdated (references "branch fix/issues-may-1-3", ruflo@3.6.24) — needs update to reflect 3.10.x reality.

**Acceptance criteria**:
- [ ] MCP tool count verified against actual registered tools
- [ ] CLI command count verified
- [ ] STATUS.md updated to reflect 3.10.x state

---

## T10 — Dependency hygiene

**Status**: pending  
**Baseline snapshot** (2026-05-25):
- `npm audit` on cli: 45 vulnerabilities
  - 1 critical: `protobufjs`
  - 25 high: includes `@xenova/transformers`, `agentdb`, `agentic-flow`, `axios`, `cacache`, `@hono/node-server`, `@opentelemetry/*`
  - 17 moderate, 2 low
- 0 packages with conflicting semver ranges across workspace (clean)
- CLI has 11 direct deps, 17 optional deps, 2 devDeps

**Triage approach**: Many vulns likely inherited via optional deps (xenova, agentdb). Check if any are production code paths vs. truly optional/dev.

**Acceptance criteria**:
- [ ] All vulns triaged: either fixed, pinned with override, or documented as "deferred + reason"
- [ ] `protobufjs` critical addressed (update or override)
- [ ] No truly unused direct deps

---

## T11 — Witness pass

**Status**: pending (depends on T1-T10 changes landing)  
**Current state**: Per IMPROVEMENT-ROADMAP.md Item 2, last scheduled run showed `missing=95 drift=2`  
**Note**: `regen-witness.mjs` (wrapper) and `regenerate-witness.mjs` (canonical) — T3 consolidates this

**Acceptance criteria**:
- [ ] `node scripts/regen-witness.mjs` exits 0
- [ ] `scripts/smoke-witness-marker-drift.mjs` exits 0 (if it exists)
- [ ] New witness entries added for all changed files in T1-T10

---

## Blockers (current)

None — first iteration, starting clean.

---

## Hard constraints (reference)

- Test baseline: ≥1999 passing at every push
- No `--no-verify` on commits
- No mass deletion without cited callers + commit justification
- Mac/Linux behavior unchanged
- No auto-publish
- Commits stay on `chore/project-wide-quality-sweep`

---

## Next iteration checklist

- [ ] T1: Run knip; review output; plan targeted removals
- [ ] T3: Consolidate regen-witness scripts; wire smoke-memory-no-stray-db to CI
- [ ] T4: Fix `any` types in memory-bridge.ts (highest count after ambient decls)
- [ ] T5: Evaluate `analyze code` subcommand placeholder
- [ ] T7: Document or fix each of the 46 skipped tests
- [ ] T10: Triage protobufjs critical vuln
- [ ] Push branch; open draft PR
