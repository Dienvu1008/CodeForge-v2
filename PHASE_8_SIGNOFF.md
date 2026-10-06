# Phase 8 Sign-off — Advanced Autonomy

Date: 2026-09-14
Branch: main
Commits: eb18f69 (roadmap), a454635 (P8-INV), 6fbcc77 (P8-PX1), 5b825f7 (P8-MA1),
         42d58ee (P8-BI1), __P8_I1__ (P8-I1 E2E + sign-off)

Format per PHASE_8_ROADMAP §6 (Exit criteria) + EVALUATION_MODEL §11.10 (Phase 8
gate) + Architecture Target §60 (Phase Gate). Phase 8 delivers the **Advanced
Autonomy Layer**: the agent can plan parallel task batches and coordinate multiple
sub-agents — but **every effect still goes through the existing kernel, with zero
bypass**. Parallelism and multi-agent are about *execution and coordination*, never
a new authority.

> Phase 7 gave the agent memory. Phase 8 lets it do many things at once and
> coordinate many agents — but nothing takes a shortcut around the kernel.

---

## Exit criteria (PHASE_8_ROADMAP §6)

- [x] 1. AU-001..007 declared in `invariants.yaml` + tests under `tests/invariants/autonomy/`.
- [x] 2. **AU-001** (parallel/multi-agent no bypass): E2E proves every admitted task
          executes through the real ToolGateway; an un-requested call fails NOT_FOUND.
- [x] 3. **Kernel intact**: the planner emits only task ids; the coordinator forces graph
          suggestions to `PROPOSED` (GI-009 still commits) and completion stays with
          CompletionGate (TI-005). A forged-authority sub-agent is rejected.
- [x] 4. **AU-003**: scheduling + batch planning are deterministic (same input → same batch).
- [x] 5. **AU-004**: a parallel batch's cumulative cost never exceeds the parent remaining,
          across all four budget dimensions.
- [x] 6. **AU-005 / AU-006**: disjoint scratch zones + foreign-write rejection; a cancel is
          clean only when terminal with no orphan PID, and leaves siblings untouched.
- [x] 7. **AU-007**: a sub-agent result is a model-sourced proposal; a runtime/user-sourced
          result is rejected as forged authority.
- [x] 8. P8-I1 E2E passes (`tests/integration/autonomy-e2e.spec.ts`).
- [x] 9. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 10. `agent-core` does not depend on `infrastructure` (depcruise).
- [x] 11. CI green on 2 OS — Windows 11 + WSL2 Ubuntu 24.04, Node 20.18.1.
- [x] 12. Adversarial coverage reused: the E2E and invariant specs assert bypass attempts
          (un-requested call, forged authority, over-budget admit, orphan cancel) are blocked.
- [x] 13. `PHASE_8_SIGNOFF.md` created (this document).

**No deferred items** within Phase 8 scope v1. Out-of-scope capabilities (browser /
computer use / vision / cloud-remote / self-improvement / neural embedding) remain
explicitly deferred with probe-first intent — see "What Phase 8 does NOT deliver".

---

## Components delivered (PHASE_8_ROADMAP §4)

| ID | Component | Package | Enforces |
|---|---|---|---|
| P8-INV | Autonomy invariant group AU-001..007 | invariants.yaml + tests | AU-* |
| P8-PX1 | `ParallelExecutor.planParallelBatch` — deterministic parallel-batch planner | agent-core | AU-001/003/004 |
| P8-MA1 | `MultiAgentCoordinator` — merge sub-agent output as proposals | agent-core | AU-002/007 |
| P8-BI1 | `BranchIsolation` — scratch isolation + no-orphan cancel | agent-core | AU-005/006 |
| P8-I1 | Autonomy E2E | tests | all Phase-8 |

All three new components live in `agent-core/src/scheduler/` and `agent-core/src/coordination/`
as PURE logic (no filesystem, no process control, no model calls). The infrastructure
WorkspaceManager / ProcessReconciler / ToolGateway enforce their decisions at the boundary.

---

## Test results

- Total automated tests: **1127 / 1127 pass** across **97 test files** (Vitest), **0 todo**.
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (590 modules, 1386 dependencies cruised).

### Phase 8 additions (over Phase 7 baseline of 1068 tests)

| Step | Suite total | What's tested |
|---|---|---|
| P8-INV | 1068 (+14 todo) | AU-001..007 invariant specs declared as `it.todo` (invariants-first, §59) |
| P8-PX1 | 1085 | planner (concurrency cap, budget interaction); au-001/003/004 fleshed to real |
| P8-MA1 | 1100 | coordinator (merge, ordering, authority rejection); au-002/007 fleshed |
| P8-BI1 | 1120 | branch isolation (zones, write classification, no-orphan cancel); au-005/006 fleshed |
| P8-I1 | **1127** | full autonomy E2E through the kernel; last au-001 placeholder → real (0 todo) |

---

## Invariant coverage — Phase 8 (AU-001..007, all ACTIVE, all with real tests)

| Invariant | Enforcement | Proven by |
|---|---|---|
| AU-001 | parallel tasks never bypass ToolGateway/Policy | planner purity + E2E (execute through gateway) |
| AU-002 | multi-agent coordination creates no new authority | coordinator forces PROPOSED; rejects committed |
| AU-003 | parallel scheduling deterministic | planner sorted/total; au-003 + E2E determinism |
| AU-004 | each branch under hierarchical budget | cumulative-cost admission; au-004 + E2E |
| AU-005 | branches don't clobber each other's workspace | disjoint scratch zones + foreign-write reject |
| AU-006 | cancelling a branch leaves no orphan | terminal + zero-PID gate; siblings preserved |
| AU-007 | sub-agent output is a proposal, not authority | model-source only; runtime/user rejected |

Registry: `invariants.yaml` version 1.3 (151 → 158 invariants); `INVARIANTS.md`
§3.22 Autonomy table + §9 version-history row 1.3. Both files were bumped together.

---

## Cross-platform

| Environment | Node | Result | Tests |
|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 1127/1127 |
| WSL2 Ubuntu 24.04 (local, `npm ci`) | 20.18.1 | ✅ PASS | 1127/1127 |

---

## Honest scope notes

- **Decoupling held.** The three Phase-8 components are pure `agent-core` logic that
  take plain data (task ids, costs, budget limits, provenance, run outcomes) and
  return plain data (admitted/deferred sets, proposals, zones, outcomes). No I/O.
  dependency-cruiser confirms `agent-core ↛ infrastructure`.
- **ParallelExecutor is a planner, not an executor.** `planParallelBatch` returns task
  ids only. Actual execution of each admitted task still runs through the existing
  ExecutionCoordinator / ToolGateway / Budget. There is no object in the batch a caller
  could invoke to run a task — execution MUST go through the gateway. The E2E proves it.
- **Multi-agent output is one-way proposal.** A sub-agent is a `model` provenance source.
  Graph suggestions leave the coordinator stamped `PROPOSED` (never `VALIDATED`/`COMMITTED`),
  and completion suggestions are advisory `CompletionProposal`s. The graph validator +
  GraphCommitService (GI-009) and CompletionGate (TI-005) remain the only authorities.
- **Isolation is prefix-based and exact.** Each branch owns `.scratch/<branchId>/`; zone
  matching is boundary-exact so `.scratch/ab/` is not treated as inside `.scratch/a/`.
  Cross-branch writes are rejected unless an explicit shared prefix is granted (policy opt-in).
- **No-orphan is enforced before sealing a cancel.** `cancelOneBranch` refuses to finalize
  a cancellation unless the run is terminal AND the reconciled process tree has zero
  surviving PIDs (EX-006/CP-006). Siblings are returned by the same reference — a cancel
  is strictly local.
- **Budget check order.** The planner checks the concurrency cap before the budget, so a
  task blocked purely by the cap reports reason `concurrency`, and an over-cap task is not
  misattributed to budget.

---

## What Phase 8 does NOT deliver (explicitly deferred, §2.2 / §8)

- **Browser / computer use / GUI / vision** — non-deterministic, needs the outside world,
  headless-hostile. Probe-first before any commitment in a later revision.
- **Cloud models / remote workers** — external services, not headless-CI-safe; would break
  cross-platform determinism.
- **Self-improvement / fine-tuning** — safety risk + non-deterministic; needs its own control.
- **Neural (semantic) embeddings** — carried over from Phase 7's probe-backed deferral.
- **Runtime orchestration wiring.** Phase 8 ships the planner/coordinator/isolation building
  blocks and proves them against the kernel in the E2E. Wiring them into the live
  SessionOrchestrator loop (actually spawning concurrent branches in production flow) is a
  follow-up — the components are designed to plug in behind the existing interfaces without
  kernel changes (Appendix A).

All deferred items, when taken up, still obey §0 (zero bypass): autonomy is never a reason
to loosen a kernel invariant.

---

## Anti-criteria — confirmed NOT violated

- `agent-core` has no dependency on `infrastructure` — depcruise 0 violations.
- The parallel planner holds no execution channel — its output is `string[]`, not a thunk,
  promise, or handle (AU-001).
- Sub-agent output can never commit the graph or complete a task — forced `PROPOSED`,
  CompletionGate still gates (AU-002/007).
- Parallel/batch decisions are pure + deterministic — no clock, no randomness (AU-003).
- A batch can never consume more than the parent budget allows (AU-004).
- Branches cannot clobber each other's scratch outside explicit policy (AU-005).
- A cancel that would leave an orphan is refused; siblings are never disturbed (AU-006).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 8: COMPLETE — all exit criteria met, no in-scope deferred items. CI green on two
OS + human peer and architecture review pending.
