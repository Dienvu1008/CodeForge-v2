# STATE_MACHINE_SPEC.md

**Ollama Coding Agent — State Machines, Transitions, Guards & Effects**

Version: 1.0
Status: Architecture Baseline
Owner: agent-core / StateMachine
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md`, `DOMAIN_CONTRACTS.md`, `WORKSPACE_SPEC_v1.0`,
`GRAPH_PROTOCOL.md`, `VERIFICATION_PROTOCOL.md`, `MIGRATION_SPEC.md`

---

## 0. Mục đích

State machine là **authority duy nhất** quyết định entity được phép chuyển trạng thái như thế nào.

Nguyên tắc:

> **State transition = deterministic function of (state, event, context, policy).**

LLM **không** có authority chuyển state. LLM chỉ **propose**. Runtime **decide**.

Tham chiếu: `INVARIANTS.md` → **SM-001, SM-002, SM-003, SM-004, SM-005, SM-006**.

File này định nghĩa:

- các state machine trong hệ thống;
- transition table đầy đủ;
- guard (điều kiện cho phép transition);
- effect (side effect khi transition);
- invariant cục bộ;
- test matrix;
- adversarial cases.

---

## 1. Nguyên tắc chung

### 1.1 Determinism

Với cùng input `(currentState, event, context, policy)`, transition phải cho cùng output.

- Không random.
- Không phụ thuộc wall-clock ngoài guard rõ ràng.
- Không phụ thuộc LLM output thô.
- Không phụ thuộc filesystem state ngoài context đã được nạp.

### 1.2 Purity of transition function

```
transition: (State, Event, Context) -> Result<State, TransitionError>
```

- Không side effect trong transition function.
- Effect được thực thi **sau** khi transition committed.
- Nếu effect fail → transition vẫn đã commit; effect failure được ghi event riêng.

### 1.3 Transaction

Mọi transition commit phải atomic:

```
BEGIN
  validate transition
  check guards
  write new state
  append event
  (optional) apply effect marker
COMMIT
```

Nếu bất kỳ bước nào fail → rollback toàn bộ.

Tham chiếu: `INVARIANTS.md` → **CP-001, SM-004**.

### 1.4 Terminal states

Terminal state:

- không có outgoing transition;
- mọi attempt transition → `INVALID_TRANSITION`.

### 1.5 Illegal transitions

Illegal transition **không** bị ignore. Nó phải:

1. reject;
2. emit `TRANSITION_REJECTED` event;
3. trả error có code cụ thể.

---

## 2. State Machine Registry

Hệ thống có các state machine sau:

| ID | Machine | Aggregate | Phase |
|---|---|---|---|
| `SM-SESSION` | Session lifecycle | Session | 1 |
| `SM-TASK` | Task execution lifecycle | TaskExecution | 1 |
| `SM-TASK-RUN` | TaskRun lifecycle | TaskRun | 1 |
| `SM-GRAPH` | Graph version lifecycle | TaskGraph | 1 |
| `SM-TOOLCALL` | Tool call lifecycle | ToolCall | 1.5 |
| `SM-APPROVAL` | Approval lifecycle | Approval | 1.5 |
| `SM-VERIFICATION` | Verification lifecycle | VerificationReport | 1.5 |
| `SM-RECOVERY` | Recovery action lifecycle | RecoveryAction | 5 |
| `SM-BUDGET` | Budget lifecycle | Budget | 1 |
| `SM-LOCK` | Workspace lock lifecycle | WorkspaceLock | 1 |

Mỗi machine có file riêng trong `agent-core/state-machines/`.

---

## 3. SM-SESSION — Session Lifecycle

### 3.1 States

```typescript
type SessionState =
  | 'CREATED'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'AWAITING_HUMAN'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'ABORTED';
```

### 3.2 Diagram

```
CREATED
   │
   │ SESSION_INITIALIZED
   ▼
INITIALIZING
   │
   │ SESSION_READY
   ▼
RUNNING ◄──────────────┐
   │  │                │
   │  │ HUMAN_REQUIRED  │ HUMAN_DECIDED
   │  ▼                │
   │ AWAITING_HUMAN ───┘
   │  │
   │  │ CANCEL_REQUESTED
   │  ▼
   │ CANCELLING ◄───────┐
   │                    │
   │ CANCEL_REQUESTED ──┘
   ▼
CANCELLING
   │
   │ CANCEL_COMPLETED
   ▼
ABORTED

RUNNING
   │
   │ ALL_TASKS_TERMINAL
   ▼
COMPLETED
```

Ghi chú: `CANCEL_REQUESTED` hợp lệ từ **cả** `RUNNING` và `AWAITING_HUMAN`.
Không có đường nào phải quay lại `RUNNING` để cancel.

### 3.3 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| CREATED | SESSION_INITIALIZED | lock acquired ∧ goal set | INITIALIZING | compute baseline revision |
| INITIALIZING | SESSION_READY | workspace ready ∧ graph committed | RUNNING | start heartbeat |
| INITIALIZING | SESSION_FAILED | any | ABORTED | release lock |
| RUNNING | HUMAN_REQUIRED | escalation approved | AWAITING_HUMAN | emit HUMAN_APPROVAL_REQUESTED |
| AWAITING_HUMAN | HUMAN_DECIDED | decision recorded | RUNNING | emit HUMAN_APPROVAL_* |
| RUNNING | CANCEL_REQUESTED | user or policy | CANCELLING | propagate cancel to TaskRuns |
| AWAITING_HUMAN | CANCEL_REQUESTED | user or policy | CANCELLING | propagate cancel to TaskRuns |
| CANCELLING | CANCEL_COMPLETED | all TaskRuns reconciled | ABORTED | release lock, checkpoint |
| RUNNING | ALL_TASKS_TERMINAL | all tasks in terminal state | COMPLETED | release lock, final checkpoint |
| RUNNING | SESSION_FAILED | fatal error | ABORTED | release lock, checkpoint |
| any | SESSION_CRASHED | process died | (via recovery) | mark interrupted |

### 3.4 Guards

| Guard | Điều kiện |
|---|---|
| `lock acquired` | WorkspaceLock đang giữ bởi session này |
| `goal set` | Goal entity đã commit |
| `workspace ready` | baseline revision computed |
| `graph committed` | graph version ≥ 1 |
| `escalation approved` | escalation record đã tồn tại |
| `decision recorded` | approval hoặc clarification đã ghi |
| `all TaskRuns reconciled` | không có TaskRun RUNNING |
| `all tasks in terminal state` | mọi TaskExecution.state ∈ terminal set |

### 3.5 Local invariants

| ID | Statement |
|---|---|
| SS-L6 | RUNNING → COMPLETED chỉ khi mọi task terminal. |
| SS-L7 | Không có transition nào bỏ qua INITIALIZING. |
| SS-L8 | ABORTED và COMPLETED là terminal. |
| SS-L9 | AWAITING_HUMAN chỉ thoát sang RUNNING khi có human decision; ngoại lệ duy nhất là CANCEL_REQUESTED → CANCELLING. |
| SS-L10 | CANCELLING không được chuyển sang COMPLETED. |
| SS-L11 | CANCEL_REQUESTED hợp lệ từ cả RUNNING và AWAITING_HUMAN; không có state non-terminal nào bị kẹt khi cancel. |

Tham chiếu: `INVARIANTS.md` → **SS-002, SS-003, SS-004, SS-007**.

### 3.6 Effects

| Effect | Khi nào | Side effect |
|---|---|---|
| `compute baseline revision` | INITIALIZING | `WorkspaceManager.computeRevision()` |
| `start heartbeat` | RUNNING | heartbeat loop |
| `propagate cancel` | CANCELLING | emit CANCEL_REQUESTED cho mọi TaskRun |
| `release lock` | terminal | `WorkspaceManager.releaseLock()` |
| `final checkpoint` | terminal | `CheckpointManager.create()` |

---

## 4. SM-TASK — Task Execution Lifecycle

### 4.1 States

```typescript
type TaskState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'PASSED'
  | 'FAILED'
  | 'FAILURE_ANALYZED'
  | 'RECOVERY'
  | 'AWAITING_HUMAN'
  | 'SUPERSEDED'
  | 'ABORTED';
```

### 4.2 Diagram

```
PENDING
   │ DEPS_SATISFIED
   ▼
READY
   │ SCHEDULED
   ▼
RUNNING
   │
   │ RUN_ENDED_OK      (TaskRun SUCCEEDED/FAILED)
   ▼
VERIFYING
   ├── VERIFICATION_PASSED ──► PASSED (terminal)
   │
   └── VERIFICATION_FAILED ──► FAILED
                                 │ FAILURE_ANALYZED
                                 ▼
                           FAILURE_ANALYZED
                                 │ RECOVERY_CHOSEN
                                 ▼
                              RECOVERY
                                 │ RECOVERY_ENDED
                                 ▼
                              RUNNING (loop)

RUNNING ── RUN_ENDED_ABNORMAL ──► FAILED   (TaskRun TIMEOUT/INTERRUPTED)
RUNNING ── EXTERNAL_MUTATION_DETECTED ──► FAILED
VERIFYING ── EXTERNAL_MUTATION_DETECTED ──► FAILED

PENDING ── DEP_UNREACHABLE ──► ABORTED (terminal, blocked)

AWAITING_HUMAN ── HUMAN_OVERRIDE_PASSED ──► PASSED (terminal, marked)

any (non-terminal) ── SUPERSEDE ──► SUPERSEDED (terminal)
any (non-terminal) ── ABORT ──────► ABORTED (terminal)
any (non-terminal) ── HUMAN_REQUIRED ──► AWAITING_HUMAN
AWAITING_HUMAN ── CANCEL_REQUESTED ──► ABORTED (terminal)
```

### 4.3 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| PENDING | DEPS_SATISFIED | all deps PASSED | READY | — |
| PENDING | DEP_UNREACHABLE | ∃ predecessor terminal-non-PASSED ∧ no path to PASSED | ABORTED | emit TASK_BLOCKED, reconcile |
| READY | SCHEDULED | scheduler picked ∧ budget ok | RUNNING | start TaskRun |
| RUNNING | RUN_ENDED_OK | TaskRun ∈ {SUCCEEDED, FAILED} | VERIFYING | run verification |
| RUNNING | RUN_ENDED_ABNORMAL | TaskRun ∈ {TIMEOUT, INTERRUPTED} | FAILED | emit FAILURE_DETECTED (class TIMEOUT/ENVIRONMENT) |
| RUNNING | EXTERNAL_MUTATION_DETECTED | non-scratch mutation not agent-owned | FAILED | emit FAILURE_DETECTED (class ENVIRONMENT) |
| VERIFYING | EXTERNAL_MUTATION_DETECTED | revision drift during verify | FAILED | emit FAILURE_DETECTED (class ENVIRONMENT) |
| VERIFYING | VERIFICATION_PASSED | report valid ∧ fresh | PASSED | emit TASK_STATE_CHANGED |
| VERIFYING | VERIFICATION_FAILED | report valid ∧ fresh | FAILED | emit FAILURE_DETECTED |
| FAILED | FAILURE_ANALYZED | Failure record committed | FAILURE_ANALYZED | — |
| FAILURE_ANALYZED | RECOVERY_CHOSEN | RecoveryAction committed | RECOVERY | execute recovery |
| RECOVERY | RECOVERY_ENDED | action terminal | RUNNING | start new TaskRun |
| any (non-terminal) | SUPERSEDE | new task valid ∧ no RUNNING TaskRun | SUPERSEDED | update graph |
| any (non-terminal) | ABORT | policy | ABORTED | cleanup |
| RUNNING | HUMAN_REQUIRED | escalation | AWAITING_HUMAN | emit HUMAN_APPROVAL_REQUESTED |
| FAILURE_ANALYZED | HUMAN_REQUIRED | escalation | AWAITING_HUMAN | emit HUMAN_APPROVAL_REQUESTED |
| AWAITING_HUMAN | HUMAN_DECIDED | decision recorded | RUNNING / ABORTED | — |
| AWAITING_HUMAN | HUMAN_OVERRIDE_PASSED | override committed ∧ HUMAN_OVERRIDE_COMPLETED linked | PASSED | emit HUMAN_OVERRIDE_COMPLETED |
| AWAITING_HUMAN | CANCEL_REQUESTED | session cancelling | ABORTED | reconcile |
| RUNNING | CANCEL_REQUESTED | session cancelling | ABORTED | reconcile |
| VERIFYING | CANCEL_REQUESTED | session cancelling | ABORTED | reconcile |

### 4.4 Guards

| Guard | Điều kiện |
|---|---|
| `all deps PASSED` | mọi predecessor trong graph có state = PASSED |
| `dep unreachable` | ∃ predecessor ở terminal-non-PASSED (ABORTED, hoặc SUPERSEDED không rewire) ∧ không còn path nào để mọi predecessor đạt PASSED. Deterministic function trên graph. |
| `scheduler picked` | Scheduler quyết định task này là next |
| `budget ok` | parent remaining budget > 0 |
| `TaskRun ∈ {SUCCEEDED, FAILED}` | run kết thúc bình thường, verification có nghĩa |
| `TaskRun ∈ {TIMEOUT, INTERRUPTED}` | run kết thúc bất thường, bỏ qua verify, vào failure analysis |
| `TaskRun CANCELLED` | xử lý bởi CANCEL_REQUESTED, không qua VERIFYING |
| `report valid` | VerificationReport.status ∈ {PASS, FAIL} ∧ targetWorkspaceRevision khớp |
| `fresh` | revision hiện tại == report.targetWorkspaceRevision |
| `override committed` | HumanOverride record đã commit ∧ marker HUMAN_OVERRIDE_COMPLETED linked tới VerificationReport gốc (report không bị sửa) |
| `new task valid` | Task schema valid ∧ graph validator pass ∧ không có TaskRun RUNNING |

### 4.5 Local invariants

| ID | Statement |
|---|---|
| SM-L1 | RUNNING → PASSED **không** được phép trực tiếp; phải qua VERIFYING. |
| SM-L2 | VERIFYING → PASSED chỉ khi có report hợp lệ. Đường vào PASSED không qua verification **duy nhất** là AWAITING_HUMAN → PASSED qua HUMAN_OVERRIDE_PASSED, và đường này không sửa report gốc. |
| SM-L3 | Terminal state không có outgoing transition. |
| SM-L4 | Mọi transition phải emit event. |
| SM-L5 | AWAITING_HUMAN không tự động thoát; chỉ thoát qua HUMAN_DECIDED, HUMAN_OVERRIDE_PASSED, hoặc CANCEL_REQUESTED. |
| SM-L6 | RECOVERY → RUNNING chỉ khi action terminal. |
| SM-L7 | Task trong SUPERSEDED không được schedule. |
| SM-L8 | Task PENDING với predecessor terminal-non-PASSED và không còn path đạt PASSED phải chuyển ABORTED (không kẹt vô hạn ở PENDING). |
| SM-L9 | TaskRun kết thúc TIMEOUT/INTERRUPTED không đi qua VERIFYING; đi thẳng FAILED. |
| SM-L10 | HUMAN_OVERRIDE_PASSED bắt buộc có marker HUMAN_OVERRIDE_COMPLETED; VerificationReport gốc immutable (VR-005, HI-004). |

Tham chiếu: `INVARIANTS.md` → **SM-001, SM-002, SM-003, SM-005, TI-005, TI-006, EX-006, VR-005, HI-003, HI-004**.

### 4.6 Terminal states

- `PASSED`
- `SUPERSEDED`
- `ABORTED`

### 4.7 Illegal transitions

| Attempt | Kết quả |
|---|---|
| RUNNING → PASSED | reject (`INVALID_TRANSITION`) |
| PENDING → RUNNING | reject (bỏ qua READY) |
| PASSED → anything | reject (terminal) |
| ABORTED → anything | reject (terminal) |
| SUPERSEDED → anything | reject (terminal) |
| AWAITING_HUMAN → VERIFYING | reject |
| AWAITING_HUMAN → PASSED (không có override record) | reject (`GUARD_FAILED`) |
| FAILED → PASSED | reject |
| VERIFYING → RUNNING | reject (phải qua PASSED/FAILED) |
| PENDING → ABORTED khi dep vẫn còn path đạt PASSED | reject (`GUARD_FAILED`) |
| SUPERSEDE khi có TaskRun RUNNING | reject (`GUARD_FAILED`) — phải cancel run trước |

---

## 5. SM-TASK-RUN — TaskRun Lifecycle

### 5.1 States

```typescript
type TaskRunState =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED';
```

### 5.2 Diagram

```
RUNNING
   ├── SUCCEEDED (terminal)
   ├── FAILED (terminal)
   ├── TIMEOUT (terminal)
   ├── CANCELLED (terminal)
   └── INTERRUPTED (terminal, via crash recovery)
```

### 5.3 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| RUNNING | RUN_SUCCEEDED | execution completed | SUCCEEDED | finalize run |
| RUNNING | RUN_FAILED | execution failed | FAILED | finalize run |
| RUNNING | RUN_TIMEOUT | timeout | TIMEOUT | kill process tree |
| RUNNING | RUN_CANCELLED | session cancelling | CANCELLED | kill process tree |
| RUNNING | RUN_INTERRUPTED | crash recovery | INTERRUPTED | reconcile workspace |

### 5.4 Local invariants

| ID | Statement |
|---|---|
| EX-L10 | RUNNING là state duy nhất không terminal. |
| EX-L11 | Sau finalize, mọi field immutable. |
| EX-L12 | Không có transition từ terminal ra ngoài. |
| EX-L13 | INTERRUPTED chỉ được tạo bởi crash recovery. |
| EX-L14 | Finalize phải ghi `workspaceRevisionAtEnd`. |

Tham chiếu: `INVARIANTS.md` → **EX-001, EX-005, CP-004**.

### 5.5 Effects

| Effect | Khi nào | Side effect |
|---|---|---|
| `finalize run` | terminal | ghi `endedAt`, `workspaceRevisionAtEnd`, update TaskExecution |
| `kill process tree` | TIMEOUT, CANCELLED | ProcessSupervisor.killTree() |
| `reconcile workspace` | INTERRUPTED | WorkspaceManager.reconcile() |

---

## 6. SM-GRAPH — Graph Version Lifecycle

### 6.1 States

```typescript
type GraphState =
  | 'CURRENT'
  | 'SUPERSEDED'
  | 'REJECTED';
```

### 6.2 Diagram

```
CURRENT ── COMMIT_MUTATION ──► SUPERSEDED
        └── no direct transition
```

Graph version không phải là state machine theo nghĩa truyền thống. Nó là **versioned store**:

- Mỗi commit tạo version mới.
- Version cũ chuyển `SUPERSEDED`.
- Không có version nào bị xóa.

### 6.3 Local invariants

| ID | Statement |
|---|---|
| GI-L10 | Version tăng đơn điệu. |
| GI-L11 | Commit atomic (state + event + version bump). |
| GI-L12 | Version cũ immutable. |
| GI-L13 | Không commit nếu validator fail. |

Tham chiếu: `INVARIANTS.md` → **GI-002, GI-003, GI-008**.

---

## 7. SM-TOOLCALL — Tool Call Lifecycle

### 7.1 States

```typescript
type ToolCallState =
  | 'REQUESTED'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';
```

### 7.2 Diagram

```
REQUESTED
   │ SCHEMA_VALIDATED
   ▼
APPROVAL_PENDING
   ├── APPROVAL_GRANTED ──► APPROVED
   │                          │
   │                          │ EXECUTION_STARTED
   │                          ▼
   │                       RUNNING
   │                          ├── SUCCEEDED (terminal)
   │                          ├── FAILED (terminal)
   │                          ├── TIMEOUT (terminal)
   │                          └── CANCELLED (terminal)
   │
   └── APPROVAL_DENIED ──► DENIED (terminal)

REQUESTED
   │ AUTO_APPROVED (policy)
   ▼
APPROVED
```

### 7.3 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| REQUESTED | SCHEMA_VALIDATED | schema valid | APPROVAL_PENDING | create Approval |
| REQUESTED | AUTO_APPROVED | policy allows | APPROVED | create Approval(auto) |
| REQUESTED | SCHEMA_INVALID | — | DENIED | reject |
| APPROVAL_PENDING | APPROVAL_GRANTED | human or policy | APPROVED | bind approval |
| APPROVAL_PENDING | APPROVAL_DENIED | human or policy | DENIED | — |
| APPROVED | EXECUTION_STARTED | — | RUNNING | spawn process |
| RUNNING | EXECUTION_SUCCEEDED | exit 0 | SUCCEEDED | record result |
| RUNNING | EXECUTION_FAILED | exit ≠ 0 | FAILED | record result |
| RUNNING | EXECUTION_TIMEOUT | timeout | TIMEOUT | kill process tree |
| RUNNING | EXECUTION_CANCELLED | session cancelling | CANCELLED | kill process tree |

### 7.4 Guards

| Guard | Điều kiện |
|---|---|
| `schema valid` | arguments khớp tool schema |
| `policy allows` | risk class + policy cho phép auto-approve |
| `human or policy` | approval.decision được ghi |
| `exit 0` | process exit code == 0 |
| `exit ≠ 0` | process exit code != 0 |
| `timeout` | wall-clock > limit |

### 7.5 Local invariants

| ID | Statement |
|---|---|
| TG-L5 | Không execute nếu state ≠ APPROVED. |
| TG-L6 | DENIED là terminal. |
| TG-L7 | Timeout phải dẫn tới TIMEOUT, không treo RUNNING. |
| TG-L8 | Approval phải bind với (toolCallId, argumentsHash, policyVersion). |
| TG-L9 | DESTRUCTIVE/PRIVILEGED không đi qua AUTO_APPROVED. |

Tham chiếu: `INVARIANTS.md` → **TG-001..TG-010, HI-001, HI-002**.

### 7.6 Terminal states

- `SUCCEEDED`
- `FAILED`
- `TIMEOUT`
- `CANCELLED`
- `DENIED`

---

## 8. SM-APPROVAL — Approval Lifecycle

### 8.1 States

```typescript
type ApprovalState =
  | 'PENDING'
  | 'GRANTED'
  | 'DENIED'
  | 'EXPIRED';
```

### 8.2 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| PENDING | USER_GRANTED | user action | GRANTED | record decision |
| PENDING | USER_DENIED | user action | DENIED | record decision |
| PENDING | POLICY_GRANTED | policy auto-approve | GRANTED | record decision |
| PENDING | POLICY_DENIED | policy reject | DENIED | record decision |
| PENDING | APPROVAL_TIMEOUT | wall-clock > expiresAt | EXPIRED | emit event |

### 8.3 Local invariants

| ID | Statement |
|---|---|
| HI-L4 | Approval là terminal sau decision. |
| HI-L5 | EXPIRED approval không dùng được. |
| HI-L6 | Approval binding không đổi. |

---

## 9. SM-VERIFICATION — Verification Lifecycle

### 9.1 States

```typescript
type VerificationState =
  | 'PENDING'
  | 'RUNNING'
  | 'PASS'
  | 'FAIL'
  | 'INVALID'
  | 'ERROR';
```

### 9.2 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| PENDING | CHECKS_STARTED | revision bound | RUNNING | start checks |
| RUNNING | CHECKS_PASSED | all checks PASS | PASS | write report |
| RUNNING | CHECKS_FAILED | any check FAIL | FAIL | write report |
| RUNNING | SCRATCH_VIOLATION | mutation outside scratch | INVALID | write report |
| RUNNING | EXECUTION_ERROR | tool error | ERROR | write report |

### 9.3 Local invariants

| ID | Statement |
|---|---|
| VR-L5 | Report immutable sau terminal. |
| VR-L6 | PASS/FAIL chỉ với revision bound. |
| VR-L7 | INVALID khi scratch violation. |
| VR-L8 | Verification không mutate source. |

Tham chiếu: `INVARIANTS.md` → **VR-001..VR-011**.

---

## 10. SM-RECOVERY — Recovery Action Lifecycle

### 10.1 States

```typescript
type RecoveryState =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ABORTED';
```

### 10.2 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| PENDING | ACTION_STARTED | policy allows ∧ budget ok | RUNNING | consume budget |
| RUNNING | ACTION_SUCCEEDED | outcome ok | SUCCEEDED | update task |
| RUNNING | ACTION_FAILED | outcome fail | FAILED | record next failure |
| RUNNING | ACTION_ABORTED | policy | ABORTED | — |

### 10.3 Local invariants

| ID | Statement |
|---|---|
| RC-L7 | Action nằm trong allowed set. |
| RC-L8 | Budget respected. |
| RC-L9 | Retry bounded. |
| RC-L10 | UNKNOWN không retry vô hạn. |

Tham chiếu: `INVARIANTS.md` → **RC-001..RC-008**.

---

## 11. SM-BUDGET — Budget Lifecycle

### 11.1 States

```typescript
type BudgetState =
  | 'ACTIVE'
  | 'EXHAUSTED'
  | 'CLOSED';
```

### 11.2 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| ACTIVE | BUDGET_CONSUMED | consumption < limit | ACTIVE | update consumed |
| ACTIVE | BUDGET_EXHAUSTED | consumption ≥ limit | EXHAUSTED | emit BUDGET_EXHAUSTED |
| ACTIVE | PARENT_CLOSED | parent terminal | CLOSED | — |
| EXHAUSTED | PARENT_CLOSED | parent terminal | CLOSED | — |

### 11.3 Local invariants

| ID | Statement |
|---|---|
| BU-L5 | Child ≤ parent remaining. |
| BU-L6 | Consumption đơn điệu tăng. |
| BU-L7 | EXHAUSTED không tự hồi. |
| BU-L8 | CLOSED là terminal. |

Tham chiếu: `INVARIANTS.md` → **BU-001..BU-006**.

---

## 12. SM-LOCK — Workspace Lock Lifecycle

### 12.1 States

```typescript
type LockState =
  | 'ACQUIRING'
  | 'HELD'
  | 'STALE'
  | 'RELEASED';
```

### 12.2 Transition Table

| From | Event | Guard | To | Effect |
|---|---|---|---|---|
| ACQUIRING | LOCK_ACQUIRED | no existing lock | HELD | start heartbeat |
| ACQUIRING | LOCK_CONTENDED | existing live lock | (reject) | — |
| HELD | HEARTBEAT_MISSED | 3 × interval | STALE | mark stale |
| HELD | LOCK_RELEASED | session terminal | RELEASED | delete lock file |
| STALE | LOCK_RECOVERED | validation pass | HELD | new lock record |
| STALE | LOCK_CONTENDED | validation fail | (reject) | — |

### 12.3 Local invariants

| ID | Statement |
|---|---|
| WS-L4 | 1 workspace = 1 HELD lock. |
| WS-L5 | STALE phải validate trước khi recover. |
| WS-L6 | RELEASED là terminal. |

Tham chiếu: `INVARIANTS.md` → **SS-001, SS-005, WS-010**.

---

## 13. Cross-Machine Coordination

### 13.1 Session ↔ Task

- Session RUNNING chỉ khi có ≥ 1 task non-terminal.
- Session COMPLETED chỉ khi mọi task terminal.
- Session CANCELLING → propagate cancel → mọi task ABORTED.

### 13.2 Task ↔ TaskRun

- Task RUNNING ↔ đúng 1 TaskRun RUNNING.
- Task chỉ chuyển khỏi RUNNING khi TaskRun đạt terminal; kết cục TaskRun ánh xạ tới event của Task:

| TaskRun terminal | Task event | Task đích |
|---|---|---|
| SUCCEEDED | RUN_ENDED_OK | VERIFYING |
| FAILED | RUN_ENDED_OK | VERIFYING |
| TIMEOUT | RUN_ENDED_ABNORMAL | FAILED |
| INTERRUPTED | RUN_ENDED_ABNORMAL | FAILED |
| CANCELLED | CANCEL_REQUESTED | ABORTED |

- Task RECOVERY khi RecoveryAction RUNNING.

Lưu ý: TaskRun `FAILED` (process fail) vẫn đi VERIFYING vì verification là authority quyết định
PASS/FAIL của task, không phải exit code của một run đơn lẻ. Chỉ kết cục **bất thường**
(TIMEOUT/INTERRUPTED) mới bỏ qua verify.

### 13.3 Task ↔ Verification

- Verification bound với TaskRun.
- Task PASSED chỉ khi verification PASS ∧ fresh.

### 13.4 ToolCall ↔ Approval

- ToolCall APPROVAL_PENDING ↔ Approval PENDING.
- ToolCall APPROVED khi Approval GRANTED.

### 13.5 Graph ↔ Task

- Task SUPERSEDED khi graph mutation SUPERSEDE_TASK committed.
- Task không được thêm vào graph nếu schema invalid.

### 13.6 Budget ↔ Task

- Task RUNNING consume task budget.
- TaskRun consume task budget.
- Recovery consume task budget.

---

## 14. Determinism Rules

### 14.1 Pure transition

Transition function không được:

- gọi model;
- gọi tool;
- đọc filesystem ngoài context;
- dùng random;
- dùng wall-clock ngoài guard timeout.

### 14.2 Reproducibility

Với cùng event log, replay phải cho cùng state sequence.

Test: property-based replay từ event log → state = state gốc.

### 14.3 Ordering

- Events trong cùng session có `sequenceNumber` đơn điệu.
- Không gap.
- Nếu gap → corruption, phải fail fast.

Tham chiếu: `INVARIANTS.md` → **OB-L2, CP-008**.

---

## 15. Effects — Execution Model

### 15.1 Effect sau commit

Effect được thực thi **sau** khi transition committed:

```
1. validate transition
2. check guards
3. write state (transaction)
4. append event (same transaction)
5. COMMIT
6. execute effect (ngoài transaction)
7. nếu effect fail → emit EFFECT_FAILED event
```

### 15.2 Effect idempotency

Mỗi effect có `effectId` để tránh double-execute khi retry.

### 15.3 Effect failure

Effect failure **không** rollback state transition. Nó:

- emit event;
- mark task/session cần reconcile;
- nếu critical → escalate.

---

## 16. Guards — Implementation

### 16.1 Guard interface

```typescript
interface Guard {
  name: string;
  evaluate(ctx: TransitionContext): Promise<boolean>;
  reasonIfFalse(): string;
}
```

### 16.2 Guard types

| Type | Ví dụ |
|---|---|
| **State guard** | `all deps PASSED` |
| **Budget guard** | `budget ok` |
| **Freshness guard** | `report fresh` |
| **Policy guard** | `policy allows` |
| **Resource guard** | `lock acquired` |
| **Human guard** | `decision recorded` |

### 16.3 Guard evaluation order

- Guards evaluated theo thứ tự khai báo.
- Fail fast: guard đầu tiên fail → transition reject.
- Lý do reject phải rõ.

---

## 17. Events — Emitted per Transition

Mỗi transition emit **đúng một** event chính. Event phụ (ví dụ EFFECT_FAILED) có thể emit sau.

### 17.1 Event naming

```
<AGGREGATE>_<VERB>
```

Ví dụ:

- `SESSION_STATE_CHANGED`
- `TASK_STATE_CHANGED`
- `TASK_RUN_STARTED`
- `TOOL_CALL_APPROVED`
- `VERIFICATION_ENDED`

### 17.1.1 Transition triggers (SM-TASK)

Các **event trigger** dưới đây khởi động transition của SM-TASK. Chúng khác với event
được ghi vào EventLog (thường là `TASK_STATE_CHANGED` kèm `trigger`):

| Trigger | Ý nghĩa | Nguồn phát |
|---|---|---|
| `DEPS_SATISFIED` | mọi predecessor PASSED | Scheduler (deterministic) |
| `DEP_UNREACHABLE` | predecessor terminal-non-PASSED, không còn path đạt PASSED | GraphEvaluator (deterministic) |
| `RUN_ENDED_OK` | TaskRun SUCCEEDED/FAILED | ExecutionCoordinator |
| `RUN_ENDED_ABNORMAL` | TaskRun TIMEOUT/INTERRUPTED | ExecutionCoordinator |
| `EXTERNAL_MUTATION_DETECTED` | drift non-scratch không do agent | WorkspaceManager reconcile |
| `HUMAN_OVERRIDE_PASSED` | human override hoàn tất completion | CompletionGate |

Trigger `EXECUTION_ENDED` (v1.0 cũ) được **thay thế** bằng cặp `RUN_ENDED_OK` /
`RUN_ENDED_ABNORMAL` để phân biệt kết cục bình thường và bất thường của TaskRun.

### 17.2 Event payload

Mọi event payload phải chứa:

- `previousState`;
- `newState`;
- `trigger` (event name);
- `timestamp`;
- `provenance` (nếu có);
- `correlationId` (nếu có).

---

## 18. Error Model

### 18.1 Errors

```typescript
class TransitionError extends DomainError {
  constructor(
    public code: TransitionErrorCode,
    public machineId: string,
    public aggregateId: string,
    public from: string,
    public event: string,
    message: string,
  ) { super(code, machineId, aggregateId, message); }
}

type TransitionErrorCode =
  | 'INVALID_TRANSITION'
  | 'GUARD_FAILED'
  | 'TERMINAL_STATE'
  | 'CONCURRENT_TRANSITION'
  | 'TRANSACTION_FAILED'
  | 'EFFECT_FAILED';
```

### 18.2 Handling

- Illegal transition → reject + event `TRANSITION_REJECTED`.
- Guard fail → reject + event `TRANSITION_REJECTED` với reason.
- Concurrent → optimistic lock fail → retry theo policy.

---

## 19. Concurrency

### 19.1 Optimistic locking

Mỗi entity có `version` field. Update check:

```
UPDATE ... WHERE id = ? AND version = ?
```

Nếu 0 row → version conflict → retry.

### 19.2 Single-writer per aggregate

- Mỗi aggregate chỉ có 1 writer tại một thời điểm.
- Trong v1 (sequential), điều này tự nhiên.
- Trong tương lai (parallel), dùng optimistic locking + retry.

### 19.3 Cross-aggregate

- Không cross-aggregate transaction.
- Dùng event để propagate.

---

## 20. Test Matrix

### 20.1 Session

| Test | Target |
|---|---|
| `session-happy-path` | CREATED → RUNNING → COMPLETED |
| `session-cancel` | RUNNING → CANCELLING → ABORTED |
| `session-cancel-from-awaiting-human` | AWAITING_HUMAN → CANCELLING → ABORTED |
| `session-human-escalation` | RUNNING → AWAITING_HUMAN → RUNNING |
| `session-invalid-transition` | CREATED → COMPLETED reject |
| `session-complete-with-pending-task` | reject |
| `session-crash-recovery` | INTERRUPTED |

### 20.2 Task

| Test | Target |
|---|---|
| `task-happy-path` | PENDING → READY → RUNNING → VERIFYING → PASSED |
| `task-fail-recovery` | FAILED → FAILURE_ANALYZED → RECOVERY → RUNNING |
| `task-invalid-running-to-passed` | reject |
| `task-invalid-pending-to-running` | reject |
| `task-terminal-immutable` | PASSED → anything reject |
| `task-supersede` | any → SUPERSEDED |
| `task-supersede-running-reject` | SUPERSEDE khi có TaskRun RUNNING → reject |
| `task-stale-verification` | VERIFYING → PASSED reject |
| `task-awaiting-human` | RUNNING → AWAITING_HUMAN → RUNNING |
| `task-dep-unreachable-abort` | PENDING → ABORTED khi predecessor ABORTED |
| `task-dep-still-reachable-no-abort` | PENDING giữ nguyên khi dep còn path đạt PASSED |
| `task-run-timeout-to-failed` | RUNNING → FAILED (không qua VERIFYING) |
| `task-run-interrupted-to-failed` | RUNNING → FAILED (không qua VERIFYING) |
| `task-external-mutation-to-failed` | RUNNING/VERIFYING → FAILED |
| `task-human-override-passed` | AWAITING_HUMAN → PASSED với marker |
| `task-human-override-no-record-reject` | AWAITING_HUMAN → PASSED không record → reject |
| `task-cancel-from-awaiting-human` | AWAITING_HUMAN → ABORTED |

### 20.3 TaskRun

| Test | Target |
|---|---|
| `run-succeeded` | RUNNING → SUCCEEDED |
| `run-timeout` | RUNNING → TIMEOUT |
| `run-cancelled` | RUNNING → CANCELLED |
| `run-interrupted` | RUNNING → INTERRUPTED (crash) |
| `run-immutable-after-finalize` | reject mutate |

### 20.4 Graph

| Test | Target |
|---|---|
| `graph-commit` | version bump |
| `graph-reject-invalid` | no version bump |
| `graph-cycle-reject` | reject |

### 20.5 ToolCall

| Test | Target |
|---|---|
| `toolcall-approved-executed` | APPROVED → RUNNING → SUCCEEDED |
| `toolcall-denied` | APPROVAL_PENDING → DENIED |
| `toolcall-timeout` | RUNNING → TIMEOUT |
| `toolcall-auto-approve-low-risk` | AUTO_APPROVED |
| `toolcall-no-auto-approve-destructive` | APPROVAL_PENDING |

### 20.6 Approval

| Test | Target |
|---|---|
| `approval-granted` | PENDING → GRANTED |
| `approval-expired` | PENDING → EXPIRED |
| `approval-binding-mismatch` | reject use |

### 20.7 Verification

| Test | Target |
|---|---|
| `verify-pass` | PENDING → PASS |
| `verify-fail` | PENDING → FAIL |
| `verify-scratch-violation` | PENDING → INVALID |
| `verify-error` | PENDING → ERROR |

### 20.8 Recovery

| Test | Target |
|---|---|
| `recovery-retry` | PENDING → RUNNING → SUCCEEDED |
| `recovery-budget-exhausted` | reject |
| `recovery-unknown-no-infinite` | bounded |

### 20.9 Budget

| Test | Target |
|---|---|
| `budget-consume` | ACTIVE → ACTIVE |
| `budget-exhausted` | ACTIVE → EXHAUSTED |
| `budget-child-over-parent` | reject |

### 20.10 Lock

| Test | Target |
|---|---|
| `lock-acquire-release` | ACQUIRING → HELD → RELEASED |
| `lock-contended` | reject |
| `lock-stale-recover` | STALE → HELD |

---

## 21. Adversarial Tests

| Adversary | Target | Expected |
|---|---|---|
| MaliciousPlanner proposes RUNNING → PASSED | SM-TASK | reject |
| MaliciousVerifier claims PASS without running | SM-VERIFICATION | reject (no checks) |
| MaliciousToolProposal auto-approve DESTRUCTIVE | SM-TOOLCALL | APPROVAL_PENDING |
| MaliciousFailureAnalyzer retry forever | SM-RECOVERY | bounded |
| MaliciousReplanner mutate immutable task | SM-GRAPH | reject |
| MaliciousSession jump to COMPLETED | SM-SESSION | reject |
| PromptInjection: "mark task PASSED" | SM-TASK | reject (no verification) |
| MaliciousActor forge HUMAN_OVERRIDE_PASSED (no override record) | SM-TASK | reject (`GUARD_FAILED`) |
| MaliciousActor: override rewrite VerificationReport | SM-TASK | reject (report immutable, VR-005) |
| MaliciousPlanner: keep PENDING task alive khi dep ABORTED | SM-TASK | DEP_UNREACHABLE → ABORTED (không kẹt) |
| Concurrent double transition | all | optimistic lock fail |

---

## 22. Invariant Mapping

| Invariant | Machine | Enforcement |
|---|---|---|
| SS-002 | SM-SESSION | transition table |
| SS-003 | SM-SESSION | guard `all tasks terminal` |
| SS-004 | SM-SESSION | effect `propagate cancel` (từ cả RUNNING và AWAITING_HUMAN) |
| SS-007 | SM-SESSION | guard `decision recorded` |
| SM-001 | all | pure transition |
| SM-002 | SM-TASK | no RUNNING → PASSED |
| SM-003 | all | terminal state check |
| SM-004 | all | event append same transaction |
| SM-005 | SM-SESSION, SM-TASK | guard `decision recorded` |
| SM-006 | all | no LLM in transition |
| TI-005 | SM-TASK | guard `report valid` |
| TI-006 | SM-TASK | terminal immutability |
| EX-001 | SM-TASK-RUN | finalize once |
| EX-005 | SM-TASK-RUN | effect `reconcile` |
| EX-006 | SM-TASK | CANCEL → ABORTED (từ RUNNING, VERIFYING, AWAITING_HUMAN); DEP_UNREACHABLE → ABORTED không để lại orphan |
| VR-005 | SM-TASK | HUMAN_OVERRIDE_PASSED không sửa report gốc |
| HI-003 | SM-TASK | guard `override committed` (marker tường minh) |
| HI-004 | SM-TASK | report immutable khi override |
| GI-002 | SM-GRAPH | validator before commit |
| GI-003 | SM-GRAPH | version monotonic |
| GI-008 | SM-GRAPH | atomic commit |
| TG-001 | SM-TOOLCALL | no bypass |
| TG-003 | SM-APPROVAL | binding |
| TG-004 | SM-APPROVAL | no forge |
| TG-005 | SM-TOOLCALL | DENIED terminal |
| TG-007 | SM-TOOLCALL | no auto-approve destructive |
| TG-010 | SM-TOOLCALL | TIMEOUT state |
| VR-001 | SM-VERIFICATION | revision bound |
| VR-002 | SM-TASK | guard `fresh` |
| VR-005 | SM-VERIFICATION | append-only |
| BU-001 | SM-BUDGET | child guard |
| BU-002 | SM-RECOVERY | bounded |
| RC-001 | SM-RECOVERY | allowed set |
| RC-002 | SM-RECOVERY | UNKNOWN bounded |
| WS-010 | SM-LOCK | stale recover |
| CP-001 | all | transaction |
| CP-004 | SM-TASK-RUN | INTERRUPTED |

---

## 23. State Serialization

### 23.1 Persisted representation

Mỗi state là string enum. Không dùng số.

Lý do: đọc được, log được, migration dễ.

### 23.2 Event log format

```json
{
  "eventId": "01H...",
  "sessionId": "01H...",
  "sequenceNumber": 42,
  "type": "TASK_STATE_CHANGED",
  "aggregate": { "kind": "task", "id": "01H..." },
  "payload": {
    "previousState": "VERIFYING",
    "newState": "PASSED",
    "trigger": "VERIFICATION_PASSED",
    "verificationId": "01H..."
  },
  "at": "2026-09-13T10:00:00Z"
}
```

---

## 24. Recovery from Crash

### 24.1 Replay

Khi crash, runtime:

1. Load checkpoint gần nhất.
2. Replay events từ `checkpoint.lastEventId` tới hiện tại.
3. Reconcile workspace.
4. Mark incomplete TaskRuns là INTERRUPTED.
5. Recovery policy quyết định.

### 24.2 Deterministic replay

Replay phải cho cùng state. Nếu không:

- event log corruption;
- fail fast;
- escalate.

---

## 25. North Star

> **State transition là authority. LLM proposal không phải authority.**

Mọi transition trong hệ thống phải:

- deterministic;
- auditable;
- bounded;
- reproducible;
- không thể bypass bởi model output.

---
