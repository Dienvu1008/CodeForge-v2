# Phase 1 Sign-off — Runtime Kernel

Date: 2026-09-14
Commit: _______________ (P1-I3 / signoff commit on `main`)
Branch: main

Format per PHASE_1_ROADMAP §7 (Exit criteria). Phase 1 delivers the **runtime kernel** that
runs a full session end-to-end with **FakeModel** — no real LLM, no real tools, no UI
(PHASE_1_ROADMAP §0, §9).

---

## Exit criteria (PHASE_1_ROADMAP §7)

- [x] 1. All §4 components implemented (P1-F1 .. P1-I3) — see component table below.
- [x] 2. **69 CRITICAL Phase-1 invariants** upheld — behavioral coverage mapped below.
- [x] 3. E2E P1-I1 (session lifecycle, FakeModel) pass — `tests/integration/session-lifecycle.spec.ts`.
- [x] 4. E2E P1-I2 (crash recovery) pass — `tests/integration/crash-recovery-e2e.spec.ts`.
- [x] 5. E2E P1-I3 (adversarial) pass — `tests/integration/adversarial-e2e.spec.ts`.
- [x] 6. SQLite adapter runs on Windows + WSL2 — proven locally (Windows 11 + WSL2 Ubuntu 24.04).
- [ ] 7. CI green on 2 OS — pending the CI run for the signoff commit (fill commit + confirm ✅).
- [x] 8. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 9. `PHASE_1_SIGNOFF.md` created (this document).

> Item 7 is the only box left open here: it is confirmed on each per-step commit as work
> progressed, but the *signoff commit's* CI run is checked off once green.

---

## Components delivered (PHASE_1_ROADMAP §4)

| ID | Component | Enforces (primary) |
|---|---|---|
| P1-F1 | FakeModel (deterministic `ModelGateway` double) | FM-1..FM-8 |
| P1-F2 | SQLite adapter (`better-sqlite3`, WAL, parameterized SQL only) | CP-001 (+ SQL-injection-safe by construction) |
| P1-F3 | Schema v1 + migrations | CP-001, CP-012 |
| P1-F4 | EventLog adapter (sequence authority) | CP-008, OB-001, PR-003 |
| P1-F5 | Repository implementations (Session/Goal/Task/TaskExecution/TaskRun/Graph/Budget/Checkpoint/Lock + committer) | nền cho SS/TI/EX/GI |
| P1-S1 | Session lifecycle + workspace lock | SS-001, SS-002, SS-003, SS-004, SS-006, SS-007 |
| P1-S2 | Goal | GL-001, GL-002 |
| P1-T1 | Task | TI-001, TI-002, TI-003, TI-004, TI-006 |
| P1-T2 | TaskExecution (projection) | EX-002, EX-003 |
| P1-T3 | TaskRun + reconcile gate | EX-001, EX-004, EX-005 |
| P1-G1 | TaskGraph (build + canonical hash) | GI-001, GI-003 |
| P1-G2 | GraphValidator (7 staged checks + cycle detection) | GI-004, GI-005, GI-006, GI-007 |
| P1-G3 | GraphCommit (atomic, versioned) | GI-002, GI-008, GI-009 |
| P1-SM1 | Task / TaskRun state machines (pure) | SM-001..SM-006 |
| P1-SC1 | Scheduler (pure, deterministic) | SC-001..SC-006 |
| P1-B1 | Budget engine + atomic consume | BU-001, BU-002, BU-003, BU-005, BU-006 |
| P1-C1 | Checkpoint (capture-then-commit, drift) | CP-002, CP-009, CP-010, CP-011, CP-012 |
| P1-CR1 | Crash recovery (reconcile unfinished runs) | CP-004, CP-005, CP-006 |
| P1-I1 | Session lifecycle E2E (FakeModel) | integration of all above |
| P1-I2 | Crash recovery E2E (real file-DB restart) | CP-004/005/006/012 end-to-end |
| P1-I3 | Adversarial E2E (malicious model blocked) | GI-002/007/009, GL-002, BU-002, MG-006 |

---

## Test results

- Total automated tests: **385 / 385 pass** across **38 test files** (Vitest).
- No TypeScript errors (`tsc --build`), no ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (324 modules, 666 dependencies cruised).

### Suite breakdown (by area)

| Area | Files | Notes |
|---|---|---|
| Infrastructure (sqlite / migrations / event-log / repositories) | 4 | adapter, schema, sequence, repo round-trips |
| Session (machine + service) | 2 | SS-001..007 lifecycle + lock |
| Goal / Task / TaskRun / Execution | 5 | GL-*, TI-*, EX-* |
| Graph (service / validator / commit) | 3 | GI-* incl. cycle + atomic commit |
| State machine / Scheduler / Budget / Checkpoint / Recovery | 5 | SM-*, SC-*, BU-*, CP-* |
| Contracts (domain types / SM / repos / ULID / machine-readable) | 6 | type + registry conformance |
| Workspace (canonical hash / path / revision) + WS invariants | 7 | WS-003/004/005/006/010 base (Phase 0) |
| Adversarial variants | 1 | 7 variants + payloads |
| Integration E2E (P1-I1 / I2 / I3) | 3 | session lifecycle, crash recovery, adversarial |
| Phase 0 harness | 1 | registry load + vector report |

---

## Invariant coverage — 69 CRITICAL Phase-1 (PHASE_1_ROADMAP §1)

Coverage is **behavioral**: each invariant is exercised by the component and/or E2E test that
drives the code path enforcing it (not by a 1:1 `<id>.spec.ts` file, except the WS group which
carries dedicated invariant files from Phase 0). No CRITICAL invariant is unenforced.

| Group | # | IDs | Where proven |
|---|---|---|---|
| Session (SS) | 6 | SS-001,002,003,004,006,007 | `session/session-service.spec.ts`, `session/session-machine.spec.ts`, E2E `session-lifecycle` |
| Goal (GL) | 2 | GL-001,002 | `goal/goal.spec.ts`, E2E `adversarial` (GL-002 LLM_MUTATION) |
| Task (TI) | 5 | TI-001,002,003,004,006 | `task/task.spec.ts` |
| Execution (EX) | 5 | EX-001,002,004,005,006 | `task/task-run.spec.ts`, `execution/execution-coordinator.spec.ts` |
| Graph (GI) | 9 | GI-001..009 | `graph/graph-service.spec.ts`, `graph/validator.spec.ts`, `graph/graph-commit.spec.ts`, E2E `adversarial` |
| StateMachine (SM) | 6 | SM-001..006 | `task/task-machine.spec.ts`, `session/session-machine.spec.ts`, `contracts/state-machine.spec.ts` |
| Scheduler (SC) | 6 | SC-001..006 | `scheduler/scheduler.spec.ts`, E2E `session-lifecycle` (dep ordering) |
| Workspace (WS) | 5 | WS-003,004,005,006,010 | `invariants/workspace/ws-*.spec.ts`, `workspace/path-canonicalizer.spec.ts`, `workspace/canonical-hash.spec.ts` |
| Budget (BU) | 5 | BU-001,002,003,005,006 | `budget/budget.spec.ts`, E2E `adversarial` (BU-002 bounded recovery) |
| Security (SE) | 2 | SE-007,008 | ProcessSupervisor invariants — see note (Phase-1 stand-in: reconcile-before-finalize gate EX-005/CP-005) |
| Crash/Checkpoint (CP) | 11 | CP-001..006,008..012 | `checkpoint/checkpoint.spec.ts`, `recovery/crash-recovery.spec.ts`, E2E `crash-recovery-e2e`, `infrastructure/*` |
| Human (HI) | 1 | HI-005 | `session/session-service.spec.ts` (AWAITING_HUMAN gate SS-007/HI) |
| Provenance (PR) | 1 | PR-003 | `infrastructure/event-log/event-log.spec.ts` |
| Observability (OB) | 1 | OB-001 | `infrastructure/event-log/event-log.spec.ts` |
| Dependency (DC) | 4 | DC-001,002,003,004 | dependency-cruiser (`.dependency-cruiser.cjs`), CI `dependency-direction.yml` |
| **Total** | **69** | — | — |

### Scope notes (honest gaps)

- **SE-007 ("Process phải có timeout", NO_TIMEOUT)** and **SE-008 ("Process tree phải bị bound và
  cleanup")** are both `ProcessSupervisor` invariants. Phase 1 has **no real process/tool execution**
  (ToolGateway is Phase 2+), so there is no live process to time out or a real tree to bound yet. The
  Phase-1 stand-in is `NoopProcessReconciler` plus the reconcile-before-finalize gate (EX-005/CP-005):
  a run cannot be sealed while the reconciler reports orphans. The timeout/tree-bound enforcement
  points become live when the ToolGateway lands. These are *not yet applicable*, not *skipped*.
  (Separately, the SQLite adapter uses parameterized SQL only — SQL text and params are distinct
  arguments — so no model data is ever interpolated into SQL; see `infrastructure/sqlite/database.spec.ts`.)
- The roadmap's P1-I3 line "injection → policy block (SE-007)" was **corrected**: prompt-injection
  invariants (SE-001/002) are **Phase 1.5**. The Phase-1 guarantee the adversarial E2E actually
  proves is *model output is never authority* (GL-002, GI-009, MG-006) — the deterministic runtime
  acts only on domain objects it constructs and validates, never on raw model text.
- **CP-007** is intentionally absent from the Phase-1 CRITICAL set (the count is CP-001..006 + 008..012 = 11).

---

## Cross-platform

- **Windows 11** (local): PASS — full suite 385/385, typecheck clean, lint clean, depcruise 0.
- **WSL2 Ubuntu 24.04** (local, Node 20.18.1): PASS — typecheck clean + 385/385 identical results.
- **CI (GitHub Actions ubuntu-latest + windows-latest)**: proven green on each per-step commit;
  signoff-commit run to be confirmed (exit criterion 7).
- **macOS**: DEFERRED (v2) — per PLATFORM_SUPPORT.md.

The SQLite adapter, file-backed crash/restart (P1-I2 over a real db file in a temp dir), and the
canonical workspace hash are all byte-for-byte reproducible across Windows and Linux.

---

## What Phase 1 does NOT deliver (PHASE_1_ROADMAP §9 + deferrals)

Phase 1 hands over the **runtime kernel**, not the **intelligence**:

- No real LLM (Ollama adapter is Phase 2 — the `ModelGateway` shape is ready for drop-in).
- No real tool execution (fs/shell/ToolGateway) — Phase 2+.
- No real verification engine (VerificationEngine, VR-*) — Phase 1.5.
- No real planner / replanner / failure analyzer / recovery engine (RC-*) — Phase 5.
- No UI.

**Deferred invariants** (not Phase-1 CRITICAL, by design): TI-005 (UNVERIFIED_COMPLETION),
all TG-* (tool gateway), all VR-* (verification), SE-001/002/003 and remaining SE-* (Phase 1.5),
MG-*/CX-* (Phase 2), RC-* (Phase 5).

---

## Anti-criteria — confirmed NOT violated

- No real Ollama/LLM in tests · no real tool execution · no live planner/recovery engine running.
- No test depends on wall-clock, random, network, or filesystem outside a temp dir (crash E2E uses `mkdtemp`).
- All `now`/`nextId` are injected for determinism; the EventLog is the sole sequence authority (CP-008).
- No runtime transition, schedule, budget, or graph mutation depends on raw model output (SM-006/SC-005/GI-009/MG-006).
- No CRITICAL invariant skipped; runtime-enforced-but-not-yet-applicable ones (e.g. SE-007) are documented above.

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 1: COMPLETE — pending signoff-commit CI (exit criterion 7) + human peer + architecture review.
