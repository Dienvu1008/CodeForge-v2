# Phase 2 Sign-off — ModelGateway + ContextBuilder + Planning

Date: 2026-09-14
Commit: _______________ (P2-I1/signoff commit on `main`)
Branch: main

Format per PHASE_2_ROADMAP §8 (Exit criteria). Phase 2 delivers the
**Intelligence Layer**: LLM connected for the first time via OllamaModelGateway,
context built with trust marking and provenance, and a Planner that proposes
real task graphs. The runtime remains authority — LLM proposes, GraphValidator
decides (GI-009).

---

## Exit criteria (PHASE_2_ROADMAP §8)

- [x] 1. All §4 components implemented (P2-MG1, P2-MG2, P2-DB3, P2-CX1, P2-PL1, P2-I1).
- [x] 2. **6 CRITICAL Phase-2 invariants** upheld — coverage mapped below.
- [x] 3. MG-001: all LLM calls go through `ModelGateway` — no component imports Ollama HTTP directly (depcruise enforced).
- [x] 4. MG-002/003: structured output validated + bounded retry (MAX_OUTPUT_RETRIES=2) tested.
- [x] 5. CX-003: all workspace content in context snapshots is marked `trust: 'untrusted'`.
- [x] 6. CX-005: `ContextSnapshot` is data only — no state-changing authority.
- [x] 7. GI-009: Planner returns `GraphMutation`; caller commits via `GraphCommitService` — LLM never commits directly.
- [x] 8. E2E P2-I1 (planning lifecycle with FakeModel) pass.
- [x] 9. No TypeScript error / ESLint error / dependency-cruiser violation.
- [ ] 10. CI green on 2 OS — pending signoff-commit CI run (check off once green).
- [x] 11. `PHASE_2_SIGNOFF.md` created (this document).

---

## Components delivered (PHASE_2_ROADMAP §4)

| ID | Component | Primary invariants |
|---|---|---|
| P2-MG1 | `OllamaModelGateway` (infrastructure HTTP adapter) | MG-001, MG-004, MG-005 |
| P2-MG2 | `StructuredOutputParser` (bounded retry, schema+semantic validation) | MG-002, MG-003, MG-006 |
| P2-DB3 | Schema migration v3 — `context_snapshots`, `context_items`, `context_provenance` | CP-001, CP-007 |
| P2-CX1 | `TokenCounter`, `TrustMarker`, `ProvenanceTracker`, `Retriever`, `TokenBudgeter`, `ContextBuilder` | CX-001..006, PR-002 |
| P2-PL1 | `Planner` + `PlanValidator` + `PlanCritic` + `plan-schema.ts` | MG-001/002/006, GI-009, TI-003 |
| P2-I1 | Planning E2E (FakeModel: Goal→Planner→Validate→Commit→Graph v2) | All Phase-2 invariants end-to-end |

---

## Test results

- Total automated tests: **667 / 667 pass** across **51 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (455 modules, 1003 dependencies cruised).

### Phase 2 additions

| Area | Files | Notes |
|---|---|---|
| OllamaModelGateway + StructuredOutputParser | 2 | fetch mock tests — no real network; MG-001/002/003/006 |
| Schema migration v3 | 1 (updated migrations.spec) | context tables + trust CHECK constraint |
| ContextBuilder pipeline | 1 | 32 tests: token counting, trust marking, budget enforcement, provenance |
| Planner + PlanValidator + PlanCritic | 1 | 19 tests: MG-001/003/006, GI-009, TI-003, cycle detection |
| Planning E2E (P2-I1) | 1 | 3 tests: full Goal→Graph v2 lifecycle + retry + advisory critic |

---

## Invariant coverage — 6 CRITICAL Phase-2

| Group | # | IDs | Where proven |
|---|---|---|---|
| ModelGateway (MG) | 4 | MG-001, MG-002, MG-003, MG-006 | `OllamaModelGateway` + `StructuredOutputParser` + `Planner` + all tests |
| Context (CX) | 2 | CX-003, CX-005 | `TrustMarker` (`workspace_file`→untrusted) + `ContextBuilder` (snapshot is data only) |
| **Total** | **6** | — | — |

### HIGH (7): MG-004, MG-005, CX-001..002, CX-004, CX-006, PR-002

- **MG-004**: model identity recorded in `ModelResponse.model` — tested in `ollama-gateway.spec.ts`.
- **MG-005**: timeout→`MODEL_TIMEOUT`, unavailable→`MODEL_UNAVAILABLE` — tested with fetch mock.
- **CX-001**: snapshot immutable (plain value object, no mutating methods) — asserted in `context-builder.spec.ts`.
- **CX-002**: every item has `provenance` — asserted in `context-builder.spec.ts`.
- **CX-004**: `tokenUsed ≤ tokenBudget` (hard limit, BUDGET_EXCEEDED on pinned overflow) — tested in `context-builder.spec.ts`.
- **CX-006**: snapshot bound to `workspaceRevision` — asserted in `context-builder.spec.ts`.
- **PR-002**: chain model→context→revision traceable via `provenance.source` on each item — structural enforcement in `ProvenanceTracker`.

### Honest scope notes

- **Real Ollama not required in CI**: `OllamaModelGateway` is tested with `vi.stubGlobal('fetch', ...)` — no real network. The Phase-2 contract is the interface + error mapping; real Ollama is an optional runtime concern tested manually.
- **Affected-set closure (CX-002 full)**: Phase 2 `Retriever` uses diff-based (changed paths + direct-inject). Import-graph closure with Tree-sitter/LSP is Phase 6 — documented in PHASE_2_ROADMAP §9.
- **LLM summarization in Compactor**: deferred to Phase 3 — Phase 2 Compactor does truncation only.
- **Replanner / FailureAnalyzer**: deferred to Phase 5 — PHASE_2_ROADMAP §9.

---

## Cross-platform

- **Windows 11** (local): PASS — 667/667 tests, build + typecheck sạch, lint sạch, depcruise 0.
- **WSL2 Ubuntu 24.04** (local, Node 20.18.1): PASS — build + typecheck sạch, 667/667 identical.
- **CI (GitHub Actions)**: green per-step; signoff-commit pending (exit criterion 10).

---

## What Phase 2 does NOT deliver

- No Replanner / FailureAnalyzer with LLM (Phase 5).
- No RecoveryEngine (Phase 5).
- No real tool execution (Phase 3) — `ToolExecutor` interface exists.
- No LLM summarization in Compactor (Phase 3).
- No Tree-sitter/LSP affected-set closure (Phase 6).
- No VS Code UI for planning (Phase 3).
- No streaming LLM responses (Phase 3).
- No ArtifactStore on disk (Phase 3).

---

## Anti-criteria — confirmed NOT violated

- No component imports Ollama HTTP directly — all LLM calls through `ModelGateway` (MG-001, depcruise confirms).
- No state transition depends on raw model output (MG-006 / GI-009 / SE-003).
- No context item enters prompt without trust marking (CX-003).
- `ContextSnapshot` has no methods that mutate runtime state (CX-005).
- All model output passes `StructuredOutputParser` before becoming a `GraphMutation` (MG-002).
- Retry bounded at `MAX_OUTPUT_RETRIES=2` — no infinite loop (MG-003).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 2: COMPLETE — pending signoff-commit CI (exit criterion 10) + human peer + architecture review.
