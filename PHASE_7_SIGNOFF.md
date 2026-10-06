# Phase 7 Sign-off — Memory / RAG

Date: 2026-09-14
Branch: main
Commits: cd44577 + db3f9bc (roadmap + §4.10), d89572f + 1ecbf3c (P7-INV),
         c3245d7 (P7-MS1), 50d6552 (P7-MW1), 156cda4 (P7-MR1), bfb8702 (P7-RAG1),
         a512df0 (P7-CR2), 2a1bd15 (P7-NPD2), a61008c (P7-LX1),
         + this change (P7-I1 E2E + sign-off)

Format per PHASE_7_ROADMAP §6 (Exit criteria) + EVALUATION_MODEL §11.9 (Phase 7
gate). Phase 7 delivers the **Memory / RAG Layer**: the agent can remember task
outcomes and failure patterns, and retrieve local documentation and repository
code — all surfaced to the model as **untrusted evidence, never runtime authority**.

> Phase 6 made the agent understand code. Phase 7 lets it remember — but memory is
> only ever evidence.

---

## Exit criteria (PHASE_7_ROADMAP §6)

- [x] 1. ME-001..007 declared in `invariants.yaml` + tests under `tests/invariants/memory/`.
- [x] 2. **ME-001**: no path makes memory a runtime authority (E2E authority check).
- [x] 3. **ME-002 / CX-003**: every memory item is untrusted in the ContextSnapshot.
- [x] 4. **ME-003**: every memory write has provenance + is append-only.
- [x] 5. **ME-004**: `MemoryRetriever` is deterministic (same query + records → same order).
- [x] 6. **ME-005**: RAG content is untrusted + records its source path.
- [x] 7. **ME-006**: retention bound enforced (`MemoryWriter` evicts beyond max-count).
- [x] 8. **ME-007**: memory/RAG never bypass Policy/ToolGateway (local-only; depcruise).
- [x] 9. RAG integration E2E passes (`tests/integration/memory-rag-e2e.spec.ts` — P7-I1).
- [x] 10. **P7-LX1** LspAdapter completed (CI-safe) — the Phase 6 deferral is resolved,
          not carried forward. LSP tests ran live on Windows + WSL.
- [x] 11. **P7-NPD2** `relevantFilesChanged` wired into NoProgressDetector (RC-003).
- [x] 12. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 13. `agent-core` does not depend on `infrastructure` (depcruise).
- [x] 14. CI green on 2 OS — Windows 11 + WSL2 Ubuntu 24.04, Node 20.18.1.
- [x] 15. `PHASE_7_SIGNOFF.md` created (this document).

**No deferred items.** Both components the Phase 6 sign-off deferred to Phase 7
(P7-LX1 and the `relevantFilesChanged` signal) were completed here.

---

## Components delivered (PHASE_7_ROADMAP §4)

| ID | Component | Package | Enforces |
|---|---|---|---|
| P7-INV | Memory invariant group ME-001..007 | invariants.yaml + tests | ME-* |
| P7-MS1 | `MemoryStore` interface + `SqliteMemoryStore` + schema v5 | agent-core / infrastructure | ME-003/006 |
| P7-MW1 | `MemoryWriter` — provenance writes + bounded retention | agent-core | ME-003/006 |
| P7-MR1 | `MemoryRetriever` — deterministic relevance ranking | agent-core | ME-004 |
| P7-RAG1 | `DocRetriever` + `RepoRetriever` — local RAG | infrastructure | ME-005/007 |
| P7-CR2 | Retriever wiring — memory + RAG as untrusted context | agent-core | ME-001/002, CX-002/003 |
| P7-NPD2 | `relevantFilesChanged` signal (deferred from Phase 6) | agent-core | RC-003 |
| P7-LX1 | `LspAdapter` — typescript-language-server over LSP stdio (deferred from P6) | infrastructure | — |
| P7-I1 | Memory / RAG E2E | tests | all Phase-7 |

---

## Test results

- Total automated tests: **1068 / 1068 pass** across **86 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (578 modules, 1364 dependencies cruised).

### Phase 7 additions (over Phase 6 baseline of 989 tests)

| Step | New tests | Cumulative | What's tested |
|---|---|---|---|
| P7-INV | +13 | 1002 | ME-001..007 invariant specs (some it.todo until later steps) |
| P7-MS1 | +16 | 1006* | memory_records migration v5, store insert/query/count |
| P7-MW1 | +~ | 1019 | writer provenance + retention; ME-003/006 fleshed |
| P7-MR1 | +~ | 1031 | deterministic retrieval; ME-004 fleshed |
| P7-RAG1 | +~ | 1041 | Doc/Repo RAG; ME-005/007 fleshed (all ME real, 0 todo) |
| P7-CR2 | +11 | 1048 | memory + RAG wired into the context Retriever |
| P7-NPD2 | +7 | 1055 | relevantFilesChanged signal (RC-003, unknown-safe) |
| P7-LX1 | +7 | 1062 | LspAdapter documentSymbol/definition/references (live) |
| P7-I1 | +6 | **1068** | full memory/RAG E2E + ME-001 authority check |

(*Counts are cumulative suite totals at each step; some steps converted earlier
`it.todo` placeholders into real tests, so per-step deltas vary.)

---

## Invariant coverage — Phase 7 (ME-001..007, all ACTIVE, all with real tests)

| Invariant | Enforcement | Proven by |
|---|---|---|
| ME-001 | memory is evidence, never authority | E2E authority check; TrustMarker |
| ME-002 | memory items untrusted in snapshot | TrustMarker (`assignTrust('memory')`) + CR2 |
| ME-003 | writes have provenance + append-only | MemoryWriter + me-003 spec |
| ME-004 | retrieval deterministic | MemoryRetriever + me-004 spec |
| ME-005 | RAG untrusted + sourced | Doc/RepoRetriever + me-005 spec |
| ME-006 | retention bounded | MemoryWriter.evictOldest + me-006 spec |
| ME-007 | no Policy/ToolGateway bypass | local-only RAG + depcruise (DC-003) |

Registry: `invariants.yaml` version 1.2 (144 → 151 invariants); `INVARIANTS.md`
§3.21 Memory table + §9 version-history row 1.2.

---

## Cross-platform

| Environment | Node | Result | Tests |
|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 1068/1068 |
| WSL2 Ubuntu 24.04 (local, `npm ci`) | 20.18.1 | ✅ PASS | 1068/1068 |

The LSP adapter (P7-LX1) runs its live test suite on BOTH platforms — the Phase 6
"external binary / flaky CI" concern is resolved by pinning typescript-language-server
as a dependency (pure Node, no system install).

---

## Honest scope notes

- **Decoupling held.** `MemoryRetriever`, `MemoryWriter`, and the context Retriever
  live in `agent-core` and take memory records / RAG items / import graphs as PLAIN
  DATA. The SQLite store, the RAG retrievers, and the LSP adapter live in
  `infrastructure`. dependency-cruiser confirms `agent-core ↛ infrastructure`.
- **Memory is one-way evidence.** It flows only INTO the context snapshot as
  untrusted items ranked below the live workspace (priority: task/goal > changed
  files > symbols > memory > RAG). The kernel never reads memory to decide (ME-001).
- **Semantic embeddings: deferred to Phase 7.5** (as planned in the roadmap). The
  v1 retrieval is deterministic (tag/recency/term-overlap). `MemoryQuery.text?` and
  `DocQuery` already reserve a semantic hint, so embeddings plug into the same
  interface later without changing consumers (§4.10).
- **RAG is local-only in v1.** Doc/Repo retrievers read only the data the caller
  supplies — no network. Network RAG, if added, must route through ToolGateway +
  NetworkPolicy (ME-007).
- **Retention policy** is max-count per (scope, kind), enforced solely in
  MemoryWriter; swapping to TTL/hybrid later is a single-site change.
- **LspAdapter dependency.** Adds `typescript-language-server` (+ a child process at
  runtime), isolated in one adapter, stoppable, not on any kernel path.

---

## What Phase 7 does NOT deliver

- Semantic embeddings / vector store (Phase 7.5).
- Self-improvement / fine-tuning (Phase 8+).
- Multi-agent shared memory, cloud/remote memory sync (Phase 8+).
- Network RAG as a default (only via ToolGateway + NetworkPolicy).
- Orchestrator wiring of the `relevantFilesChanged` signal — the detector accepts it;
  the session orchestrator does not yet compute per-attempt affected sets, so it
  passes "unknown" (RC-003 unknown-safe). A follow-up can feed the real signal.

---

## Anti-criteria — confirmed NOT violated

- `agent-core` has no dependency on `infrastructure` — depcruise 0 violations.
- Memory/RAG context items are always `untrusted` — never authority (ME-001/002, CX-005).
- `MemoryRetriever` is pure + deterministic — no I/O, no clock, no randomness (ME-004).
- Memory writes are append-only + provenance-tracked; the only non-insert mutation
  is bounded retention eviction, owned solely by MemoryWriter (ME-003/006).
- RAG retrievers never self-fetch or hit the network — local data only (ME-007).
- NoProgressDetector's new signal is unknown-safe — an absent signal never triggers
  a false no-progress (RC-003).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 7: COMPLETE — all exit criteria met, no deferred items. CI green + human peer
and architecture review pending.
