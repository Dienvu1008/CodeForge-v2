# PHASE_5_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 5 (Recovery & Autonomy)**

Version: 1.0
Status: Working plan
Owner: Execution Plane / Recovery + Human Interaction
Scope: Khép kín vòng lặp thất bại: khi task FAIL hoặc TIMEOUT, agent phân loại
       lỗi, chọn recovery action, thực thi — tất cả bounded và deterministic.
       Bổ sung P4-AH1 (ApprovalHandoff) được defer từ Phase 4.
Related:
`PHASE_4_SIGNOFF.md`, `INVARIANTS.md` (RC-001..RC-008), `SECURITY_MODEL.md`,
`DOMAIN_CONTRACTS.md`, `Coding Agent Architecture Target §55`

---

## 0. Nguyên tắc Phase 5

> **Phase 4 làm agent hoàn thành task thành công. Phase 5 làm agent phục hồi khi thất bại.**

Ba luật:

1. **Recovery là bounded** (RC-002): không retry vô hạn. Mỗi failure class có
   `maxAttempts`. Khi hết → ESCALATE, không tiếp tục.
2. **Recovery không thay thế authority** (RC-004/RC-005): ROLLBACK và REPLAN đều
   yêu cầu policy cho phép; Replanner trả về `GraphMutation`, không overwrite graph trực tiếp.
3. **ESCALATE → AWAITING_HUMAN** (RC-007): mọi path không tự phục hồi được phải
   chuyển session về human, không để agent tự quyết định vô thời hạn.

North Star: *Khi agent viết code sai, test fail — agent tự phân loại lỗi, thử FIX,
re-verify. Nếu vẫn fail sau N lần → ESCALATE. Human quyết định tiếp.*

---

## 1. Con số Phase 5

Phase 5 có **8 CRITICAL + 1 HIGH** invariants mới trong `invariants.yaml` (phase==5):

| Group | # | IDs | Severity |
|---|---|---|---|
| Recovery (RC) | 7 CRITICAL + 1 HIGH | RC-001..RC-008 | CRITICAL/HIGH |

Ngoài ra Phase 5 implement P4-AH1 (deferred):
- **HI-001..HI-006** — Human Interaction (đã có từ Phase 1.5, nay enforce thực)

---

## 2. Scope Phase 5

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `FailureAnalyzer` | Phân loại failure từ VerificationReport + tool stderr | RC-001, RC-006 |
| `FailureClassifier` | Map failure → FailureClass (BUILD_ERROR, TEST_FAIL, LINT, UNKNOWN, ...) | RC-001 |
| `RecoveryPolicy` | Quyết định action (RETRY/FIX/REPLAN/ROLLBACK/ESCALATE); check budget | RC-001..004, RC-008 |
| `NoProgressDetector` | Detect nếu N attempts liên tiếp không cải thiện — bounded (RC-002/003) | RC-002, RC-003 |
| `RecoveryEngine` | Thực thi recovery action; ghi provenance; emit events | RC-004..007 |
| `Replanner` | LLM-based replan khi FIX fails; trả về GraphMutation (RC-005) | RC-005, GI-009 |
| `ApprovalHandoff` (P4-AH1) | APPROVAL_PENDING → suspend TaskExecutor → session AWAITING_HUMAN → resume | HI-001..006, SM-005 |
| `SessionOrchestrator` update | Integrate recovery loop sau mỗi failed TaskRun | RC-001..008 |
| P5-I1 Recovery E2E | Task FAIL → FailureAnalyzer → RecoveryPolicy → FIX → re-run → PASS | All RC-* |

### 2.2 Out-of-scope (Phase 5)

- Tree-sitter / LSP (Phase 6)
- Memory / RAG (Phase 7)
- Multi-agent (Phase 8+)
- Streaming LLM (Phase 4.5)

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location | Status |
|---|---|---|
| `VerificationEngine` + `VerificationReport` | `agent-core/src/verification/` | ✅ Phase 1.5 |
| `FailureAnalyzer` contract (stub) | `agent-core/src/recovery/` | ✅ Phase 1 (stub) |
| `CrashRecoveryService` | `agent-core/src/recovery/crash-recovery-service.ts` | ✅ Phase 1 |
| `SessionOrchestrator` | `agent-core/src/session/session-orchestrator.ts` | ✅ Phase 4 |
| `TaskExecutor` | `agent-core/src/execution/task-executor.ts` | ✅ Phase 3/4 |
| `BudgetEngine` + `BudgetRepository` | `agent-core/src/budget/` | ✅ Phase 1/4 |
| `ApprovalEngine` + `HumanOverride` | `agent-core/src/tool/approval-engine.ts` | ✅ Phase 1.5 |
| `EventLog` | `infrastructure/src/event-log/` | ✅ Phase 1 |
| `Planner` (for Replanner base) | `agent-core/src/planning/planner.ts` | ✅ Phase 2 |
| `GraphCommitService` | `agent-core/src/graph/graph-commit-service.ts` | ✅ Phase 2 |

### 3.2 Cần tạo mới (Phase 5)

| Component | Package | Phần cốt lõi |
|---|---|---|
| `FailureClassifier` | agent-core | Map VerificationReport → FailureClass enum |
| `RecoveryPolicy` (real) | agent-core | Allowed actions per class; maxAttempts; budget check |
| `NoProgressDetector` | agent-core | N consecutive same-status attempts = no progress |
| `RecoveryEngine` | agent-core | Execute action; write provenance; emit RECOVERY_ACTION_TAKEN |
| `Replanner` (LLM) | agent-core | Wrap Planner with failure context → delta GraphMutation |
| `ApprovalHandoff` | agent-core | suspend/resume TaskExecutor on APPROVAL_PENDING |
| `FailureRepository` | agent-core/infra | Persist FailureRecord (already has schema migration v2) |
| SessionOrchestrator integration | agent-core | Add recovery loop after failed task |
| Tests + E2E | tests/ | RC-001..008 invariant tests + P5-I1 E2E |

---

## 4. Component breakdown

### 4.1 P5-FA1 — FailureAnalyzer + FailureClassifier

```
agent-core/src/recovery/
  failure-classifier.ts   ← FailureClass enum + classify(report) → FailureClass
  failure-analyzer.ts     ← FailureAnalyzer: analyze(report, stderr) → FailureRecord
```

`FailureClass`:
```
BUILD_ERROR    — tsc/build failed (exit != 0, stderr contains "error TS")
TEST_FAIL      — test runner failed (exit != 0, stderr contains "FAIL")
LINT_ERROR     — eslint failed
TIMEOUT        — TaskRun.state == TIMEOUT
VERIFICATION_FAIL — VerificationReport.status == FAIL or INVALID
UNKNOWN        — none of the above
```

`FailureRecord` (already in `agent-core/src/domain/failure.ts`):
```
failureId, sessionId, taskId, taskRunId, class, description,
stackTrace?, exitCode?, stderrArtifactId?, contextSnapshotId?
```

### 4.2 P5-RP1 — RecoveryPolicy

```
agent-core/src/recovery/
  recovery-policy.ts   ← RecoveryPolicy: allowed actions + maxAttempts per class
```

`RecoveryAction` (enum): `RETRY | FIX | REPLAN | ROLLBACK | ESCALATE | ABORT`

Default policy (per FailureClass):
```
BUILD_ERROR    → [FIX, REPLAN, ESCALATE]  maxAttempts=3
TEST_FAIL      → [FIX, RETRY, ESCALATE]   maxAttempts=3
LINT_ERROR     → [FIX, ESCALATE]          maxAttempts=2
TIMEOUT        → [RETRY, ESCALATE]        maxAttempts=2
UNKNOWN        → [ESCALATE]               maxAttempts=1  (RC-002: no unbounded retry)
VERIFICATION_FAIL → [FIX, REPLAN, ESCALATE] maxAttempts=3
```

RC-008: `RecoveryPolicy` checks `BudgetEngine.recoveryExhausted()` before allowing RETRY/FIX.

### 4.3 P5-NPD1 — NoProgressDetector

```
agent-core/src/recovery/
  no-progress-detector.ts   ← detect N consecutive same-failure-class attempts
```

RC-003: deterministic on available signals. Phase 5 signals: consecutive failure classes from `FailureRecord[]`.
If last N records all have the same class AND no state improvement → `noProgress=true` → force ESCALATE.

### 4.4 P5-RE1 — RecoveryEngine

```
agent-core/src/recovery/
  recovery-engine.ts   ← RecoveryEngine: execute action, write provenance, emit events
```

Flow for FIX action:
1. Build `FixContext` (failure evidence + workspace state) → inject into `TaskExecutor`.
2. `TaskExecutor.execute()` with `buildReason='failure_analysis'` context.
3. Emit `RECOVERY_ACTION_TAKEN` event (RC-006: provenance required).

Flow for ESCALATE:
1. `SessionService.transition(sessionId, 'HUMAN_REQUIRED')` → `AWAITING_HUMAN` (RC-007).
2. Emit `SESSION_ESCALATED` event.

Flow for ROLLBACK:
1. Check `RecoveryPolicy.isAllowed(ROLLBACK, class)` (RC-004).
2. Revert workspace to last checkpoint revision via `WorkspaceManager`.

Flow for REPLAN:
1. `Replanner.replan(sessionId, failureContext, graph)` → `GraphMutation` (RC-005: no direct overwrite).
2. `GraphCommitService.commit(mutation)`.

### 4.5 P5-AH1 — ApprovalHandoff (deferred from P4)

```
agent-core/src/execution/
  approval-handoff.ts   ← ApprovalHandoffService: suspend, await, resume
```

When `ToolGateway.request()` returns `APPROVAL_PENDING`:
1. `TaskExecutor` emits `APPROVAL_REQUESTED` event.
2. Returns `{ finalState: 'SUSPENDED', pendingApprovalId }` (new state).
3. `SessionOrchestrator` transitions session → `AWAITING_HUMAN`.
4. When human approves/denies → `ApprovalEngine.approve/deny()`.
5. `SessionOrchestrator.resume()` → TaskExecutor continues.

HI-001..006 fully enforced.

### 4.6 P5-SO2 — SessionOrchestrator with recovery loop

Update `SessionOrchestrator.run()`:

```
after TaskExecutor.execute():
  if finalState == FAILED or TIMEOUT:
    FailureAnalyzer.analyze() → FailureRecord
    NoProgressDetector.check(history) → noProgress?
    if noProgress → RecoveryEngine.execute(ESCALATE)
    else:
      RecoveryPolicy.decide(class, attempts) → action
      RecoveryEngine.execute(action)
      if action == FIX: re-run TaskExecutor
      if action == REPLAN: Replanner → commit → reschedule
      if action == ESCALATE: session → AWAITING_HUMAN
```

### 4.7 P5-I1 — Recovery E2E

```
tests/integration/recovery-e2e.spec.ts
```

Scenarios:
1. Task FAIL (FakeModel returns bad output) → FailureAnalyzer → FIX → re-run → PASS.
2. Task TIMEOUT → RETRY → PASS.
3. Repeated FAIL (maxAttempts exhausted) → ESCALATE → session AWAITING_HUMAN.
4. NoProgressDetector fires after N same-class failures → ESCALATE.

---

## 5. Timeline (5 tuần)

```
Tuần 1 — Failure analysis
  P5-FA1   FailureClassifier + FailureAnalyzer                      [2 ngày]
  P5-RP1   RecoveryPolicy (allowed actions, maxAttempts, budget)    [2 ngày]
  P5-NPD1  NoProgressDetector                                       [1 ngày]

Tuần 2 — RecoveryEngine
  P5-RE1   RecoveryEngine (RETRY/FIX/REPLAN/ROLLBACK/ESCALATE)      [3 ngày]
  RC-001..008 invariant tests                                        [2 ngày]

Tuần 3 — ApprovalHandoff + SO integration
  P5-AH1   ApprovalHandoff (suspend/resume)                         [2 ngày]
  P5-SO2   SessionOrchestrator recovery loop                        [3 ngày]

Tuần 4 — Integration + E2E
  P5-I1    Recovery E2E (FAIL → FIX → PASS, ESCALATE)              [3 ngày]
  —        Buffer / fix                                             [2 ngày]

Tuần 5 — Sign-off
  —        PHASE_5_SIGNOFF.md                                       [1 ngày]
  —        Buffer                                                    [4 ngày]
```

---

## 6. Exit criteria Phase 5

1. Tất cả components §4 implemented.
2. **8 CRITICAL RC-001..008** invariants pass (có test file).
3. RC-001: Recovery action nằm trong allowed set của failure class — `RecoveryPolicy` enforce.
4. RC-002: UNKNOWN failure không retry vô hạn — `maxAttempts=1` cho UNKNOWN.
5. RC-003: `NoProgressDetector` deterministic — same input → same output.
6. RC-004: ROLLBACK chỉ khi policy cho phép.
7. RC-005: `Replanner` trả về `GraphMutation`, không overwrite graph.
8. RC-006: Mỗi recovery action ghi `provenance` và `reason`.
9. RC-007: ESCALATE → session `AWAITING_HUMAN`.
10. RC-008: Recovery không vượt parent budget.
11. P5-AH1: `APPROVAL_PENDING` → session `AWAITING_HUMAN` (không còn `FAILED`).
12. Không TypeScript error / ESLint error / dependency-cruiser violation.
13. CI green trên 2 OS.
14. `PHASE_5_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| RecoveryEngine state machine phức tạp | Cao | Cao | Bắt đầu với ESCALATE-only, thêm FIX/REPLAN sau |
| ApprovalHandoff cần async pause | Trung bình | Cao | Implement suspend/resume đơn giản trước |
| NoProgressDetector false positive | Thấp | Trung bình | Conservative threshold (N=3 default) |
| Replanner gọi thêm LLM — CI cost | Thấp | Thấp | FakeModel trong test |

---

## 8. Những gì Phase 5 KHÔNG làm

- Không có Tree-sitter / LSP (Phase 6).
- Không có Memory / RAG (Phase 7).
- Không có multi-agent (Phase 8+).
- Không có streaming LLM.
- Không có VS Code UI cho recovery decisions.

---

## Phụ lục: Mapping RC-* invariants → Components

| Invariant | Component |
|---|---|
| RC-001 | `RecoveryPolicy.decide()` — check allowed set |
| RC-002 | `RecoveryPolicy.decide()` — `maxAttempts` cap; `NoProgressDetector` |
| RC-003 | `NoProgressDetector.check()` — deterministic on available signals |
| RC-004 | `RecoveryEngine.execute(ROLLBACK)` — policy gate |
| RC-005 | `Replanner.replan()` — returns `GraphMutation`, never direct overwrite |
| RC-006 | `RecoveryEngine.execute()` — writes `Provenance` + emits event |
| RC-007 | `RecoveryEngine.execute(ESCALATE)` → `SessionService.transition('HUMAN_REQUIRED')` |
| RC-008 | `RecoveryPolicy.decide()` — check `BudgetEngine.recoveryExhausted()` |