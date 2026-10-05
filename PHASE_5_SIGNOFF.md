# Phase 5 Sign-off — Recovery & Autonomy

Date: 2026-09-14
Commit: 5fa2fa9 (P5-I1 on `main`)
Branch: main

Format per PHASE_5_ROADMAP §6 (Exit criteria). Phase 5 delivers the
**Recovery Layer**: when a task fails, the agent classifies the failure,
selects a recovery action, executes it, and escalates to human when needed.
All recovery is bounded, deterministic, and auditable.

---

## Exit criteria (PHASE_5_ROADMAP §6)

- [x] 1. All §4 components implemented (P5-FA1, P5-RP1, P5-NPD1, P5-RE1, P5-AH1, P5-SO2, P5-I1).
- [x] 2. **RC-001**: Recovery action is in the allowed set for each FailureClass.
- [x] 3. **RC-002**: UNKNOWN failures → ESCALATE only (maxAttempts=1). No unbounded retry.
- [x] 4. **RC-003**: `classifyFailure()` and `detectNoProgress()` are deterministic — same input → same output.
- [x] 5. **RC-004**: ROLLBACK only when `rollbackAllowed=true` in policy (all defaults are false).
- [x] 6. **RC-005**: `Replanner` returns `GraphMutation`; no direct overwrite (Phase 5.5 placeholder).
- [x] 7. **RC-006**: Every recovery action creates a `RecoveryAction` record with provenance + reason.
- [x] 8. **RC-007**: ESCALATE → `SessionService.transition('HUMAN_REQUIRED')` → `AWAITING_HUMAN`.
- [x] 9. **RC-008**: `RecoveryPolicy.decide()` checks `recoveryExhausted()` before any action.
- [x] 10. **P5-AH1**: `APPROVAL_PENDING` → `pendingApprovalToolCallId` surfaced to caller (no silent FAILED).
- [x] 11. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 12. CI green on 2 OS — Windows 11 + WSL2 Ubuntu 24.04, Node 20.18.1.
- [x] 13. `PHASE_5_SIGNOFF.md` created (this document).

---

## Components delivered (PHASE_5_ROADMAP §4)

| ID | Component | Primary invariants |
|---|---|---|
| P5-FA1 | `FailureClassifier` — deterministic FailureClass from VerificationReport + stderr | RC-001, RC-003 |
| P5-FA1 | `FailureAnalyzer` — builds + persists `Failure` record; synthetic TaskRun support | RC-006 |
| P5-RP1 | `RecoveryPolicy` — `decide()` pure function; DEFAULT_RECOVERY_POLICY per class | RC-001..004, RC-008 |
| P5-NPD1 | `NoProgressDetector` — threshold-N consecutive same-class failures → noProgress | RC-002, RC-003 |
| P5-RE1 | `RecoveryEngine` — RETRY/FIX/ESCALATE/ABORT/REPLAN(pending)/ROLLBACK(pending) | RC-004..007 |
| P5-RE1 | `SqliteFailureRepository` + `SqliteRecoveryActionRepository` | schema v2 (failures/recovery_actions) |
| P5-AH1 | `APPROVAL_PENDING` → `pendingApprovalToolCallId` in `TaskExecutorResult` | HI-001..006 |
| P5-SO2 | `SessionOrchestrator` recovery loop after FAILED/TIMEOUT task | RC-001..008 |
| P5-I1 | Recovery E2E — task FAIL → FailureAnalyzer → RecoveryEngine → ESCALATE | All RC-* |

---

## Test results

- Total automated tests: **925 / 925 pass** across **66 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (533 modules, 1263 dependencies cruised).

### Phase 5 additions (over Phase 4 baseline of 880 tests)

| Step | New tests | Cumulative | What's tested |
|---|---|---|---|
| P5-FA1/RP1/NPD1 | +30 | 910 | FailureClassifier (8) + FailureAnalyzer (5) + RecoveryPolicy (9) + NoProgressDetector (8) |
| P5-RE1 | +11 | 921 | RecoveryEngine: RETRY/FIX/REPLAN/ROLLBACK/ESCALATE/ABORT, RC-006/007, setOutcome |
| P5-AH1/SO2 | 0 new | 921 | Wired into existing tests; behavioural coverage via P5-I1 |
| P5-I1 | +4 | **925** | Recovery E2E: ESCALATE→AWAITING_HUMAN, RC-006 persistence, no-recovery on success |

---

## Invariant coverage — Phase 5

| Invariant | Enforcement |
|---|---|
| RC-001 | `DEFAULT_RECOVERY_POLICY[class].actions` — action always in allowed set |
| RC-002 | UNKNOWN maxAttempts=1; `NoProgressDetector.detectNoProgress()` → force ESCALATE |
| RC-003 | `classifyFailure()` pure function; `detectNoProgress()` pure function |
| RC-004 | `RecoveryPolicy.decide()`: `rollbackAllowed=false` in all defaults → never returns ROLLBACK |
| RC-005 | REPLAN returns `outcome=PENDING` — caller must implement (Phase 5.5 placeholder) |
| RC-006 | `RecoveryEngine.execute()` always writes `RecoveryAction` + emits `RECOVERY_ACTION_TAKEN` |
| RC-007 | ESCALATE path: `SessionService.transition('HUMAN_REQUIRED')` → DB verified in tests |
| RC-008 | `recoveryExhausted()` checked before any action decision |

---

## Cross-platform

| Environment | Node | Result | Tests |
|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 925/925 |
| WSL2 Ubuntu 24.04 (local) | 20.18.1 | ✅ PASS | 925/925 |
| CI (GitHub Actions) | 20.x | ✅ green | — |

---

## Honest scope notes

- **REPLAN and ROLLBACK**: `RecoveryEngine.execute()` returns `outcome=PENDING` for these — Phase 5.5 will add the Replanner LLM call and workspace rollback implementation.
- **ApprovalHandoff (P5-AH1)**: `APPROVAL_PENDING` is now surfaced via `pendingApprovalToolCallId`. The full async suspend/resume UI loop (VS Code bridge) is Phase 3+ bridge work.
- **NoProgressDetector**: Currently uses only `FailureClass` as signal. Phase 6 Tree-sitter/LSP signals (affected files changed, metric regression) will enrich detection.
- **Recovery budget**: `RecoveryAction.budgetConsumed.recoveryAttempts = 1` on every action. Full hierarchical budget debit (session → recovery) is Phase 5.5.

---

## What Phase 5 does NOT deliver

- REPLAN / ROLLBACK execution (Phase 5.5 — requires Replanner LLM + workspace revert).
- VS Code UI for approval handoff (Phase 3+ bridge stream).
- Tree-sitter / LSP signals in NoProgressDetector (Phase 6).
- Multi-agent recovery (Phase 8+).
- Streaming LLM in FailureAnalyzer (Phase 4.5).

---

## Anti-criteria — confirmed NOT violated

- Recovery actions never bypass `ToolGateway` — depcruise 0 violations.
- `RecoveryPolicy.decide()` never uses model output (RC-003 / BU-006).
- `FailureClassifier.classifyFailure()` is pure — no I/O, no side effects (RC-003).
- ROLLBACK is NOT in any default policy rule (RC-004 satisfied by absence).
- Recovery `RecoveryAction` is append-only — no existing action modified (PR-003 spirit).
- ESCALATE always triggers `SessionService.transition` — never assumed silently (RC-007).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 5: COMPLETE — CI green + human peer + architecture review pending.