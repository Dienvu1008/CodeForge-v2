# Phase 11 Sign-off — Intelligence Plane / Self-Model / Learning

Date: 2026-09-14
Branch: main
Commits: a11b8f1 (PHASE_11_ROADMAP), 7fb2849 (P11.1 SelfModel), 7e95a62 (P11.2 LearningStore +
         LessonWriter), 6fe50e6 (P11.3 AdviceGate), eda0d8e (P11.4 RecoveryAdvisor),
         9b4b4bb (P11.5 ContextReranker + NoProgressAdvisor), <this> (P11.6 E2E + sign-off)

Format per `PHASE_11_ROADMAP.md §5` (Phase gate) + the master prompt. Phase 11 adds an
**Intelligence Plane** — a self-model + learning layer that observes run history and emits
advisory proposals — while proving the project's hardest claim: *an adaptive learning layer
can be added without conceding a gram of decision authority to it.*

> Phase 7 gave the agent memory. Phase 11 gives it the ability to observe and learn from its
> own history — but learning only ever produces a PROPOSAL, never a decision. Turn the whole
> plane off and the runtime behaves exactly as Phase 10. Learning advises; the kernel decides.

---

## Phase gate (PHASE_11_ROADMAP §5)

- [x] 1. **All 8 `LE-*` invariants have tests and pass (CRITICAL = 100%).** LE-001 (zero
         authority), LE-002 (flag-off parity), LE-003 (clamp in allowed-set), LE-004 (deterministic
         self-model), LE-005 (lesson provenance + append-only), LE-006 (bounded store), LE-007 (no
         bypass), LE-008 (no secret leak). Each has `tests/invariants/learning/le-00N.spec.ts`;
         all ACTIVE in `invariants.yaml` (v1.7) + `INVARIANTS.md §3.23`.
- [x] 2. **Flag-off parity (LE-002) — the zero-authority proof.** `tests/integration/learning-e2e.spec.ts`
         runs recovery decisions (6 classes × 4 attempts), context ordering, and the no-progress
         verdict with the learning plane **wired-but-empty** and asserts each result is
         **byte-identical** to the no-learning path. An empty SelfModel → every advisor returns
         null → every gated advice is null → consumers keep their Phase 10 defaults. Reinforced by
         `le-002.spec.ts` (gate null-cases) + `decide()` parity (undefined advice ≡ absent advice).
- [x] 3. **Adversarial: a `MaliciousAdvisor` cannot widen the decision surface — 0 escapes.**
         `tests/adversarial/malicious-advisor.spec.ts` drives the `AdviceGate` with 8 attacks:
         inject `ROLLBACK`/`ABORT`/`REPLACE` outside the allowed-set, smuggle a forbidden action
         behind an allowed one, blow past the score bound (`MAX_SAFE_INTEGER`), point rerank at
         `/etc/passwd` + `../../secret.env`, `NaN`/`Infinity` deltas, an unknown advice kind, and a
         no-op "lock-in". Every attack is clamped or dropped; nothing reaches a decision.
- [x] 4. **Self-model reproducibility (LE-004).** `SelfModelBuilder.build()` is a pure total
         function: `le-004.spec.ts` proves equal inputs (in any order) serialize byte-identically
         and repeated calls match. No I/O, no clock, no randomness; every output array stably sorted.
- [x] 5. **Redaction (LE-008).** `le-008.spec.ts` plants a secret in event payloads, failure
         evidence (message + stackTrace), and recovery reasons; the serialized SelfModel contains
         none of it, yet still carries the classification signal (class/outcome counts) — proving
         the builder reads only classification fields.
- [x] 6. **No Phase 0–10 regression; new tests pass.** Full suite **1403 / 1403** across **147
         files** (WSL authoritative count), +76 over the P10 sign-off baseline of 1327. The pre-
         existing full-suite flake (`http-transport` SSE poll racing a DB close → unhandled
         `DB_NOT_OPEN`) was fixed in P11.2 and the suite ran clean (0 unhandled) across 3 consecutive
         Windows runs.
- [x] 7. **Cross-platform: Windows + WSL(Linux).** Both: build / typecheck / lint / depcruise
         clean, 1403 pass. depcruise **0 violations** (724 modules on Linux).
- [x] 8. **Dependency direction (DC-*): `learning/` in agent-core is pure; the store adapter is in
         infrastructure.** `agent-core/src/learning/*` (SelfModelBuilder, LessonWriter, AdviceGate,
         the three advisors) imports only domain types; `SqliteLearningStore` lives in
         `infrastructure/src/learning/`. depcruise confirms `agent-core ↛ infrastructure`.
- [x] 9. `PHASE_11_SIGNOFF.md` created (this document).

**No in-scope deferred items.** The §2.2 out-of-scope set (online fine-tuning / model-weight
learning; automatic mutation of a deterministic policy matrix; semantic/vector self-model;
cross-workspace or cloud learning sync; multi-agent shared self-model; learning self-submitting
goals) remains explicitly deferred.

---

## Components delivered (PHASE_11_ROADMAP §2.1)

| ID | Component | Package | Role / enforces |
|----|-----------|---------|-----------------|
| P11.1 | `SelfModelBuilder` + `SelfModel` types | agent-core `domain/self-model.ts`, `learning/self-model-builder.ts` | Read-only, deterministic projection of run history (LE-004, LE-008, LE-001). |
| P11.2 | `LearningStore` + `Lesson` types; `LessonWriter` + `distill` | agent-core `domain/learning.ts`, `learning/lesson-writer.ts` | Distill + persist lessons with provenance, bounded (LE-005, LE-006). |
| P11.2 | `SqliteLearningStore` (schema v6, migration 0006) | infrastructure `learning/learning-store.ts`, `sqlite/migrations/0006-learning-tables.ts` | Append-only `learning_lessons`; deterministic order; additive + reversible migration. |
| P11.3 | `AdviceGate` + `Advice` types | agent-core `domain/advice.ts`, `learning/advice-gate.ts` | The single deterministic chokepoint: clamp raw advice into the allowed-set/ranking or null (LE-001, LE-002, LE-003, LE-007). |
| P11.4 | `RecoveryAdvisor`; `decide()` optional `advice` | agent-core `learning/recovery-advisor.ts`, `recovery/recovery-policy.ts` | Propose a recovery try-order from history; `decide()` reorders within its allowed-set only (set/count/maxAttempts/budget unchanged). |
| P11.5 | `ContextReranker` | agent-core `learning/context-reranker.ts` | Advisory re-rank within the existing candidate list; pinned items never move (CX-005). |
| P11.5 | `NoProgressAdvisor` + `combineNoProgress` | agent-core `learning/no-progress-advisor.ts` | Early "likely stuck" nudge attached to the detector result WITHOUT changing its deterministic verdict (RC-003). |
| P11.6 | `learning-e2e` + `malicious-advisor` | tests `integration/`, `adversarial/` | Flag-off parity (zero-authority) + adversarial clamp coverage. |

---

## The one architectural claim this phase exists to prove

Every advisor is pure and emits only a PROPOSAL. Every proposal passes through **one**
deterministic gate (`AdviceGate.sanitize`) that can only reorder/score within bounds the
runtime already owns — it takes no store, gateway, engine, or model, so there is no I/O path
to a side effect. The consumers (`decide()`, `ContextReranker`, `combineNoProgress`) treat a
null result as "no advice" and fall back to their exact Phase 10 behavior. The flag-off parity
test makes this measurable rather than asserted: **learning wired-but-empty is byte-identical
to no learning at all.**

The learning layer lives entirely outside the kernel; deleting it would not touch a single
kernel decision path. That is the whole point.

> Smart model. Strict runtime. Verifiable outcome. — and now: Learning advises, kernel decides.

---

## Test progression

| Milestone | Files | Tests |
|-----------|-------|-------|
| Phase 10 sign-off | 131 | 1327 |
| P11.1 SelfModel | +1 | +15 |
| P11.2 LearningStore | — | +~15 |
| P11.3 AdviceGate | — | +27 |
| P11.4 RecoveryAdvisor | — | +9 |
| P11.5 ContextReranker + NoProgressAdvisor | — | +12 |
| P11.6 learning E2E (flag-off parity) | +1 | +2 |
| **Phase 11 total** | **147** | **1403** |

(Counts are the WSL authoritative figures; the Windows PowerShell host garbles vitest's
summary line via the worker-title spinner, so Windows runs are confirmed by exit code 0 and
cross-checked against WSL for the exact numbers.)
