# DOMAIN_CONTRACTS.md

**Ollama Coding Agent — Domain Entities, Schemas & Transaction Boundaries**

Version: 1.0
Status: Architecture Baseline
Owner: agent-core (domain)
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md`, `WORKSPACE_SPEC_v1.0`, `STATE_MACHINE_SPEC.md`,
`GRAPH_PROTOCOL.md`, `VERIFICATION_PROTOCOL.md`, `MIGRATION_SPEC.md`

---

## 0. Mục đích

File này định nghĩa **domain model** của Ollama Coding Agent — entity, value object, invariant cục bộ, và **transaction boundary**.

Đây là **contract** giữa:

- Control Plane (authority)
- Intelligence Plane (proposal)
- Execution Plane (action)
- Verification Plane (evidence)
- Evidence Plane (persistence)

Nguyên tắc xuyên suốt:

> **Domain là authority. Adapter chỉ là cơ chế.**

Không entity nào phụ thuộc SQLite, Ollama, VS Code, hay filesystem. Chúng chỉ phụ thuộc **contract**.

Tham chiếu `INVARIANTS.md` → **DC-001, DC-002, DC-003**.

---

## 1. Nguyên tắc chung

### 1.1 Ba loại entity

| Loại | Đặc điểm | Ví dụ |
|---|---|---|
| **Immutable Entity** | Identity + value bất biến sau commit | `Goal`, `Task`, `TaskRun`, `WorkspaceRevision` |
| **Mutable Projection** | Derived từ immutable; cập nhật theo state | `TaskExecution`, `SessionView` |
| **Event/Record** | Append-only, ghi nhận sự kiện | `Event`, `GraphMutation`, `ChangeRecord` |

### 1.2 Identity rules

- Mọi entity có ID **ổn định, unique, không tái sử dụng**.
- ID format: **ULID** (sortable, timestamp-prefixed).
- Task ID là **opaque**; không encode ngữ nghĩa.
- Version đơn điệu tăng, không giảm.

### 1.3 Transaction boundary

Mỗi transaction có:

- **Aggregate root** — entity chịu trách nhiệm nhất quán.
- **Invariant** — điều phải đúng sau commit.
- **Event** — ghi nhận sự kiện.

Nguyên tắc:

> **Một transaction, một aggregate root, một event append.**

State mutation + event append **luôn cùng transaction** (CP-001).

### 1.4 Aggregate boundaries

```
Session (root)
 ├── Goal
 ├── TaskGraph (root)
 │    └── Task (entity, immutable)
 ├── TaskExecution (projection)
 ├── TaskRun (immutable record)
 ├── Checkpoint
 ├── Budget
 └── Event[] (append-only)

Workspace (root)
 ├── WorkspaceRevision
 ├── ChangeRecord[]
 └── WorkspaceLock

Verification (root)
 └── VerificationReport (append-only)

ToolCall (root)
 └── Approval
```

Không có cross-aggregate transaction. Liên kết giữa các aggregate dùng **reference by ID**, không dùng foreign key trực tiếp.

---

## 2. Session

### 2.1 Định nghĩa

Session là **runtime lifecycle** — một phiên làm việc của agent với một workspace.

### 2.2 Schema

```typescript
interface Session {
  sessionId: string;            // ULID
  workspaceId: string;          // hash of canonical root
  workspaceRoot: string;        // canonical absolute path

  goalId: string;               // reference
  graphVersion: number;         // current

  state: SessionState;
  createdAt: string;            // ISO 8601
  updatedAt: string;

  runtimeVersion: string;
  schemaVersion: number;

  budgetId: string;             // reference
  lockId: string;               // reference

  metadata: {
    hostname: string;
    processId: number;
    ollamaEndpoint: string;
    ollamaModels: {
      planner: string;
      critic: string;
      executor: string;
      analyzer: string;
    };
  };
}
```

### 2.3 SessionState

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

### 2.4 Local invariants

| ID | Statement |
|---|---|
| SS-L1 | `sessionId` immutable. |
| SS-L2 | `workspaceRoot` không đổi sau `INITIALIZING`. |
| SS-L3 | Một `workspaceId` chỉ có 1 session ở state non-terminal. |
| SS-L4 | `graphVersion` đơn điệu tăng. |
| SS-L5 | Transition chỉ theo `SessionStateMachine`. |

Tham chiếu: `INVARIANTS.md` → **SS-001, SS-002, SS-003, SS-004**.

### 2.5 Transaction boundary

- **Create**: `session.create` → insert session + emit `SESSION_CREATED`.
- **Transition**: `session.transition` → update state + emit `SESSION_STATE_CHANGED`.
- **Complete**: `session.complete` → check all tasks terminal + emit `SESSION_COMPLETED`.

---

## 3. Goal

### 3.1 Định nghĩa

Goal là **ý định người dùng**. Immutable/versioned.

### 3.2 Schema

```typescript
interface Goal {
  goalId: string;               // ULID
  version: number;              // starts at 1
  description: string;          // user input

  constraints: Constraint[];
  acceptanceCriteria: AcceptanceCriterion[];

  createdAt: string;
  createdBy: 'user' | 'import';

  supersededBy?: string;        // goalId of newer version
}

interface Constraint {
  kind: 'performance' | 'compatibility' | 'scope' | 'style' | 'other';
  description: string;
  enforceable: boolean;
}

interface AcceptanceCriterion {
  criterionId: string;
  description: string;
  verificationHint?: string;    // suggestion, not authority
  mandatory: boolean;
}
```

### 3.3 Local invariants

| ID | Statement |
|---|---|
| GL-L1 | `goalId` + `version` là composite key. |
| GL-L2 | Nội dung goal là immutable sau commit. |
| GL-L3 | Version tăng đơn điệu. |
| GL-L4 | `supersededBy` chỉ trỏ tới version cao hơn. |
| GL-L5 | ≥ 1 `acceptanceCriteria` với `mandatory: true`. |

Tham chiếu: `INVARIANTS.md` → **GL-001, GL-002, GL-003, GL-004**.

---

## 4. Task

### 4.1 Định nghĩa

Task là **ý định công việc**, không phải execution.

### 4.2 Schema

```typescript
interface Task {
  taskId: string;               // ULID, immutable
  description: string;

  acceptanceCriteria: AcceptanceCriterion[];
  constraints: Constraint[];

  priority: number;             // LLM proposal, not authority
  strategy: TaskStrategy;       // hint, not authority

  createdAt: string;
  createdBy: 'planner' | 'replanner' | 'user';

  supersededBy?: string;        // taskId
}
```

### 4.3 Task không chứa gì

- ❌ **Không** chứa dependency (thuộc Graph).
- ❌ **Không** chứa state (thuộc TaskExecution).
- ❌ **Không** chứa run history (thuộc TaskRun).
- ❌ **Không** chứa verification result.

Tham chiếu: `INVARIANTS.md` → **TI-001, TI-002, TI-003**.

### 4.4 TaskStrategy

```typescript
interface TaskStrategy {
  kind: 'generate' | 'refactor' | 'fix' | 'test' | 'migrate' | 'custom';
  notes?: string;
  preferredTools?: string[];    // hint only
}
```

Strategy **không** bắt buộc execution; chỉ là gợi ý.

---

## 5. TaskExecution (projection)

### 5.1 Định nghĩa

Mutable projection đại diện trạng thái **hiện tại** của Task.

### 5.2 Schema

```typescript
interface TaskExecution {
  taskId: string;
  currentState: TaskState;
  currentRunId?: string;

  attempts: number;             // số TaskRun
  createdAt: string;
  updatedAt: string;

  // Denormalized references
  latestVerificationId?: string;
  latestFailureId?: string;
}
```

### 5.3 TaskState

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

### 5.4 Local invariants

| ID | Statement |
|---|---|
| EX-L1 | `currentState` chỉ đổi theo `TaskStateMachine`. |
| EX-L2 | `attempts` đơn điệu tăng. |
| EX-L3 | `currentRunId` chỉ trỏ tới run chưa finalize nếu state=RUNNING. |
| EX-L4 | Không mutate `currentState` trực tiếp ngoài StateMachine. |

Tham chiếu: `INVARIANTS.md` → **EX-002, EX-003, SM-001**.

---

## 6. TaskRun (immutable record)

### 6.1 Định nghĩa

Một lần thực thi cụ thể của Task. Immutable sau finalize.

### 6.2 Schema

```typescript
interface TaskRun {
  taskRunId: string;            // ULID
  taskId: string;
  sessionId: string;
  attemptNumber: number;        // 1-indexed

  state: TaskRunState;

  graphVersionAtStart: number;
  workspaceRevisionAtStart: WorkspaceRevision;
  workspaceRevisionAtEnd?: WorkspaceRevision;

  strategyUsed: TaskStrategy;
  contextSnapshotId?: string;

  startedAt: string;
  endedAt?: string;

  toolCalls: string[];          // toolCallIds, ordered
  failures: string[];           // failureIds
  verificationId?: string;

  budgetConsumed: BudgetConsumption;
}

type TaskRunState =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED';              // crash
```

### 6.3 Local invariants

| ID | Statement |
|---|---|
| EX-L5 | `taskRunId` immutable. |
| EX-L6 | Sau `endedAt`, mọi field immutable. |
| EX-L7 | `state` terminal không đổi. |
| EX-L8 | `attemptNumber` tăng đơn điệu trong task. |
| EX-L9 | `workspaceRevisionAtStart` ≠ null. |

Tham chiếu: `INVARIANTS.md` → **EX-001, EX-004, EX-005**.

---

## 7. TaskGraph

### 7.1 Định nghĩa

Authority duy nhất về dependency giữa các Task.

### 7.2 Schema

```typescript
interface TaskGraph {
  graphId: string;
  version: number;              // starts at 1
  sessionId: string;

  nodes: GraphNode[];
  edges: GraphEdge[];

  createdAt: string;
  createdBy: 'planner' | 'replanner' | 'user';
  mutationId?: string;          // reference to GraphMutation
}

interface GraphNode {
  taskId: string;
}

interface GraphEdge {
  fromTaskId: string;
  toTaskId: string;
  kind: 'depends_on' | 'blocks' | 'supersedes';
}
```

### 7.3 Local invariants

| ID | Statement |
|---|---|
| GI-L1 | `version` đơn điệu tăng. |
| GI-L2 | Không có cycle. |
| GI-L3 | Mọi edge tham chiếu node tồn tại. |
| GI-L4 | `supersedes` không tạo cycle. |
| GI-L5 | Graph là immutable sau commit; mutation tạo version mới. |

Tham chiếu: `INVARIANTS.md` → **GI-001..GI-010**.

---

## 8. GraphMutation

### 8.1 Định nghĩa

Immutable proposal/record của một thay đổi graph.

### 8.2 Schema

```typescript
interface GraphMutation {
  mutationId: string;           // ULID
  sessionId: string;
  baseVersion: number;

  operations: GraphOperation[];

  proposedBy: 'planner' | 'replanner' | 'user';
  reason: string;
  provenance: Provenance;

  createdAt: string;

  status: 'PROPOSED' | 'VALIDATED' | 'REJECTED' | 'COMMITTED';
  validationErrors?: string[];
  committedVersion?: number;
}

type GraphOperation =
  | { kind: 'ADD_TASK'; task: Task }
  | { kind: 'REMOVE_TASK'; taskId: string }
  | { kind: 'ADD_EDGE'; fromTaskId: string; toTaskId: string; edgeKind: GraphEdge['kind'] }
  | { kind: 'REMOVE_EDGE'; fromTaskId: string; toTaskId: string }
  | { kind: 'SUPERSEDE_TASK'; oldTaskId: string; newTask: Task }
  | { kind: 'CHANGE_DEPENDENCY'; fromTaskId: string; toTaskId: string; newKind: GraphEdge['kind'] };
```

### 8.3 Local invariants

| ID | Statement |
|---|---|
| GI-L6 | Mutation immutable sau khi `COMMITTED` hoặc `REJECTED`. |
| GI-L7 | `baseVersion` khớp với graph version tại thời điểm propose. |
| GI-L8 | Không commit nếu `baseVersion` ≠ current version. |
| GI-L9 | Mọi operation qua `GraphValidator` trước commit. |

Tham chiếu: `INVARIANTS.md` → **GI-002, GI-007, GI-008, GI-009**.

---

## 9. Verification

### 9.1 VerificationReport

```typescript
interface VerificationReport {
  verificationId: string;       // ULID
  taskId: string;
  taskRunId: string;

  targetWorkspaceRevision: WorkspaceRevision;
  canonicalFormVersion: string;

  scope: VerificationScope;
  checks: VerificationCheck[];

  status: 'PASS' | 'FAIL' | 'INVALID' | 'ERROR';

  startedAt: string;
  endedAt: string;

  toolVersions: Record<string, string>;
  artifacts: string[];          // artifactIds
}

interface VerificationCheck {
  checkId: string;
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'custom';
  command: string;
  exitCode: number;
  durationMs: number;
  outputArtifactId?: string;
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
}

type VerificationScope =
  | 'FULL'
  | 'AFFECTED_CLOSURE'
  | 'AFFECTED_DIRECT'
  | 'SMOKE';
```

### 9.2 Local invariants

| ID | Statement |
|---|---|
| VR-L1 | Report append-only. |
| VR-L2 | `targetWorkspaceRevision` không đổi sau commit. |
| VR-L3 | `status` chỉ đổi từ PENDING → terminal. |
| VR-L4 | Report immutable sau `endedAt`. |

Tham chiếu: `INVARIANTS.md` → **VR-001, VR-005, VR-006, VR-009**.

---

## 10. Failure

### 10.1 Schema

```typescript
interface Failure {
  failureId: string;            // ULID
  sessionId: string;
  taskId: string;
  taskRunId: string;

  stage: 'plan' | 'execute' | 'verify' | 'recover';
  class: FailureClass;
  signature: string;            // normalized hash

  evidence: FailureEvidence;
  detectedAt: string;

  classifiedBy: 'deterministic' | 'analyzer';

  recoveryActionIds: string[];  // link to RecoveryAction
}

type FailureClass =
  | 'TRANSIENT'
  | 'DEPENDENCY'
  | 'SYNTAX'
  | 'LOGIC'
  | 'ENVIRONMENT'
  | 'TOOL'
  | 'PERMISSION'
  | 'TIMEOUT'
  | 'CONTEXT'
  | 'BUDGET_EXHAUSTED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_TOOL_CALL_INVALID'
  | 'UNKNOWN';

interface FailureEvidence {
  message: string;
  stackTrace?: string;
  exitCode?: number;
  stderrArtifactId?: string;
  contextSnapshotId?: string;
}
```

### 10.2 Local invariants

| ID | Statement |
|---|---|
| RC-L1 | `failureId` immutable. |
| RC-L2 | `signature` deterministic từ (class, stage, normalized message). |
| RC-L3 | UNKNOWN không tự động retry vô hạn. |

Tham chiếu: `INVARIANTS.md` → **RC-002**.

---

## 11. RecoveryAction

### 11.1 Schema

```typescript
interface RecoveryAction {
  actionId: string;             // ULID
  failureId: string;

  action: RecoveryKind;
  reason: string;

  policyVersion: number;
  budgetConsumed: BudgetConsumption;

  startedAt: string;
  endedAt?: string;

  outcome: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';
  nextFailureId?: string;
}

type RecoveryKind =
  | 'RETRY'
  | 'FIX'
  | 'SPLIT'
  | 'REPLACE'
  | 'ROLLBACK'
  | 'REPLAN'
  | 'ESCALATE'
  | 'ABORT';
```

### 11.2 Local invariants

| ID | Statement |
|---|---|
| RC-L4 | Action nằm trong allowed set của failure class. |
| RC-L5 | Budget respected. |
| RC-L6 | Không vượt session remaining budget. |

Tham chiếu: `INVARIANTS.md` → **RC-001, RC-004, RC-008**.

---

## 12. ToolCall

### 12.1 Schema

```typescript
interface ToolCall {
  toolCallId: string;           // ULID
  sessionId: string;
  taskId?: string;
  taskRunId?: string;

  toolName: string;
  toolVersion: string;
  riskClass: RiskClass;

  arguments: unknown;
  argumentsHash: string;        // canonical hash

  idempotencyKey?: string;

  state: ToolCallState;

  approval?: Approval;

  result?: ToolResult;

  proposedBy: 'model' | 'runtime';
  provenance: Provenance;

  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
}

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

type RiskClass =
  | 'READ_ONLY'
  | 'LOW_RISK'
  | 'MODIFY_WORKSPACE'
  | 'NETWORK'
  | 'PACKAGE_INSTALL'
  | 'SYSTEM'
  | 'DESTRUCTIVE'
  | 'PRIVILEGED';
```

### 12.2 Local invariants

| ID | Statement |
|---|---|
| TG-L1 | Không execute nếu state ≠ APPROVED. |
| TG-L2 | `argumentsHash` immutable sau REQUESTED. |
| TG-L3 | DESTRUCTIVE/PRIVILEGED không auto-approve. |
| TG-L4 | Provenance bắt buộc. |

Tham chiếu: `INVARIANTS.md` → **TG-001..TG-010**.

---

## 13. Approval

### 13.1 Schema

```typescript
interface Approval {
  approvalId: string;           // ULID
  toolCallId: string;

  binding: {
    argumentsHash: string;
    toolPolicyVersion: number;
  };

  decision: 'APPROVED' | 'DENIED';
  decidedBy: 'user' | 'policy';

  reason?: string;
  decidedAt: string;

  expiresAt?: string;
}
```

### 13.2 Local invariants

| ID | Statement |
|---|---|
| HI-L1 | Approval binding với (toolCallId, argumentsHash, policyVersion). |
| HI-L2 | Không dùng approval cho tool call khác argumentsHash. |
| HI-L3 | Approval không thể forge qua model output. |

Tham chiếu: `INVARIANTS.md` → **HI-001, HI-002, TG-003, TG-004**.

---

## 14. ContextSnapshot

### 14.1 Schema

```typescript
interface ContextSnapshot {
  snapshotId: string;           // ULID
  sessionId: string;
  taskId?: string;
  taskRunId?: string;

  workspaceRevision: WorkspaceRevision;

  items: ContextItem[];

  tokenBudget: number;
  tokenUsed: number;

  builtBy: 'planner' | 'executor' | 'critic' | 'analyzer';
  builtAt: string;

  canonicalFormVersion: string;
}

interface ContextItem {
  itemId: string;
  kind: 'file' | 'symbol' | 'diff' | 'log' | 'note' | 'memory';

  source: {
    path?: string;
    range?: { start: number; end: number };
    revisionId?: string;
  };

  content: string;
  tokenCount: number;

  trust: 'trusted' | 'untrusted';
  reason: string;

  provenance: Provenance;
}
```

### 14.2 Local invariants

| ID | Statement |
|---|---|
| CX-L1 | Snapshot immutable. |
| CX-L2 | Mọi item có provenance. |
| CX-L3 | Untrusted content marked. |
| CX-L4 | `tokenUsed` ≤ `tokenBudget`. |
| CX-L5 | Snapshot trỏ tới workspaceRevision. |

Tham chiếu: `INVARIANTS.md` → **CX-001..CX-006**.

---

## 15. Budget

### 15.1 Schema

```typescript
interface Budget {
  budgetId: string;             // ULID
  scope: 'session' | 'task' | 'task_run' | 'recovery' | 'verification';
  scopeId: string;              // sessionId, taskId, etc.

  parentBudgetId?: string;

  limits: BudgetLimits;
  consumed: BudgetConsumption;

  createdAt: string;
  updatedAt: string;
}

interface BudgetLimits {
  wallClockMs: number;
  modelTokens: number;
  toolCalls: number;
  recoveryAttempts: number;
}

interface BudgetConsumption {
  wallClockMs: number;
  modelTokens: number;
  toolCalls: number;
  recoveryAttempts: number;
}
```

### 15.2 Local invariants

| ID | Statement |
|---|---|
| BU-L1 | Child budget ≤ parent remaining. |
| BU-L2 | Consumption đơn điệu tăng. |
| BU-L3 | Không consume vượt limit. |
| BU-L4 | Budget immutable sau khi session terminal. |

Tham chiếu: `INVARIANTS.md` → **BU-001..BU-006**.

---

## 16. Checkpoint

### 16.1 Schema

```typescript
interface Checkpoint {
  checkpointId: string;         // ULID
  sessionId: string;

  graphVersion: number;
  workspaceRevision: WorkspaceRevision;
  agentChangeSet: ChangeRecord[];

  sessionState: SessionState;
  taskStates: Record<string, TaskState>;
  budgetState: BudgetState;

  lastEventId: string;

  createdAt: string;
  schemaVersion: number;
}
```

### 16.2 Local invariants

| ID | Statement |
|---|---|
| CP-L1 | Atomic write. |
| CP-L2 | Chứa đủ 5 thành phần (graph, workspace, changeset, session, budget). |
| CP-L3 | Immutable sau commit. |
| CP-L4 | Không load checkpoint partial. |

Tham chiếu: `INVARIANTS.md` → **CP-002, CP-003, CP-009**.

---

## 17. ChangeRecord

### 17.1 Schema

```typescript
interface ChangeRecord {
  changeId: string;             // ULID
  sessionId: string;
  taskRunId?: string;
  toolCallId?: string;

  kind: 'create' | 'modify' | 'delete' | 'rename';

  relpath: string;              // canonical
  beforeHash?: string;
  afterHash?: string;

  ownedBy: 'agent' | 'verification' | 'user';
  inScratchZone: boolean;

  at: string;
}
```

### 17.2 Local invariants

| ID | Statement |
|---|---|
| WS-L1 | ChangeRecord append-only. |
| WS-L2 | `relpath` canonical. |
| WS-L3 | Verification mutation ngoài scratch → INVALID. |

Tham chiếu: `INVARIANTS.md` → **WS-008, VR-003, VR-008**.

---

## 18. Event

### 18.1 Schema

```typescript
interface DomainEvent {
  eventId: string;              // ULID
  sessionId: string;

  type: EventType;
  aggregate: {
    kind: 'session' | 'task' | 'task_run' | 'graph' | 'tool_call'
        | 'verification' | 'budget' | 'workspace' | 'failure' | 'recovery';
    id: string;
  };

  payload: unknown;
  provenance?: Provenance;

  at: string;
  sequenceNumber: number;       // per-session monotonic
}
```

### 18.2 EventTypes (không đầy đủ)

```
SESSION_CREATED
SESSION_STATE_CHANGED
SESSION_COMPLETED
SESSION_ABORTED

GOAL_CREATED
GOAL_SUPERSEDED

TASK_CREATED
TASK_STATE_CHANGED
TASK_SUPERSEDED

GRAPH_VERSION_CREATED
GRAPH_MUTATION_PROPOSED
GRAPH_MUTATION_COMMITTED
GRAPH_MUTATION_REJECTED

TASK_RUN_STARTED
TASK_RUN_ENDED

TOOL_CALL_REQUESTED
TOOL_CALL_APPROVED
TOOL_CALL_DENIED
TOOL_CALL_STARTED
TOOL_CALL_ENDED

VERIFICATION_STARTED
VERIFICATION_ENDED

FAILURE_DETECTED
RECOVERY_ACTION_CHOSEN
RECOVERY_ACTION_ENDED

BUDGET_ALLOCATED
BUDGET_CONSUMED
BUDGET_EXHAUSTED

CHECKPOINT_CREATED
CHECKPOINT_LOADED

WORKSPACE_REVISION_COMPUTED
WORKSPACE_CHANGE_RECORDED

HUMAN_APPROVAL_REQUESTED
HUMAN_APPROVAL_GRANTED
HUMAN_APPROVAL_DENIED
HUMAN_OVERRIDE_COMPLETED
```

### 18.3 Local invariants

| ID | Statement |
|---|---|
| OB-L1 | Append-only. |
| OB-L2 | `sequenceNumber` per-session monotonic, không gap. |
| OB-L3 | Ghi cùng transaction với state mutation. |

Tham chiếu: `INVARIANTS.md` → **CP-001, CP-008, OB-001**.

---

## 19. Provenance

### 19.1 Schema

```typescript
interface Provenance {
  provenanceId: string;

  source: {
    kind: 'model' | 'user' | 'runtime' | 'tool' | 'workspace';
    id: string;
  };

  model?: {
    name: string;
    version: string;
    endpoint: string;
  };

  contextSnapshotId?: string;

  inputs: string[];             // reference IDs
  reason: string;

  at: string;
}
```

### 19.2 Local invariants

| ID | Statement |
|---|---|
| PR-L1 | Append-only. |
| PR-L2 | Không chứa secret chưa redact. |
| PR-L3 | Mọi artifact/model output traceable. |

Tham chiếu: `INVARIANTS.md` → **PR-001..PR-004**.

---

## 20. Artifact

### 20.1 Schema

```typescript
interface Artifact {
  artifactId: string;           // ULID
  sessionId: string;

  kind: 'log' | 'patch' | 'test_result' | 'screenshot'
      | 'report' | 'compiler_output' | 'other';

  contentType: string;          // MIME
  sizeBytes: number;
  sha256: string;

  storagePath: string;          // relative to ArtifactStore
  provenance: Provenance;

  createdAt: string;
  expiresAt?: string;
}
```

### 20.2 Local invariants

| ID | Statement |
|---|---|
| PR-L4 | Artifact immutable. |
| PR-L5 | Provenance bắt buộc. |
| PR-L6 | Không chứa secret chưa redact. |

---

## 21. Transaction Boundaries — Chi tiết

### 21.1 Session lifecycle

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `createSession` | Session | Session, Budget, WorkspaceLock | SESSION_CREATED |
| `transition` | Session | Session | SESSION_STATE_CHANGED |
| `complete` | Session | Session, Budget | SESSION_COMPLETED |

### 21.2 Planning

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `proposePlan` | TaskGraph | Plan, GraphMutation(PROPOSED) | GRAPH_MUTATION_PROPOSED |
| `commitPlan` | TaskGraph | TaskGraph(v+1), Tasks, GraphMutation(COMMITTED) | GRAPH_VERSION_CREATED |
| `rejectPlan` | TaskGraph | GraphMutation(REJECTED) | GRAPH_MUTATION_REJECTED |

### 21.3 Execution

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `startTaskRun` | TaskRun | TaskRun, TaskExecution | TASK_RUN_STARTED |
| `endTaskRun` | TaskRun | TaskRun, TaskExecution | TASK_RUN_ENDED |
| `recordToolCall` | ToolCall | ToolCall, Approval? | TOOL_CALL_* |

### 21.4 Verification

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `verify` | VerificationReport | VerificationReport, Artifacts | VERIFICATION_STARTED/ENDED |
| `completeTask` | TaskExecution | TaskExecution, Session? | TASK_STATE_CHANGED |

### 21.5 Failure & Recovery

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `recordFailure` | Failure | Failure, TaskExecution | FAILURE_DETECTED |
| `chooseRecovery` | RecoveryAction | RecoveryAction, Budget | RECOVERY_ACTION_CHOSEN |
| `endRecovery` | RecoveryAction | RecoveryAction | RECOVERY_ACTION_ENDED |

### 21.6 Checkpoint

| Operation | Aggregate Root | Writes | Events |
|---|---|---|---|
| `createCheckpoint` | Checkpoint | Checkpoint | CHECKPOINT_CREATED |
| `recover` | Session | Session, TaskExecution, TaskRun | SESSION_STATE_CHANGED |

---

## 22. Aggregate Boundaries — Rules

- **Không** cross-aggregate transaction.
- Liên kết giữa aggregate dùng **ID reference**, không dùng JOIN trong cùng transaction.
- Khi cần đọc chéo aggregate, dùng **read model** (view) riêng.
- Khi cần update nhiều aggregate, dùng **eventual consistency** với event.
- **Không** update aggregate B trực tiếp từ aggregate A; phải qua event hoặc qua orchestration layer.

---

## 23. Repository Interfaces

### 23.1 SessionRepository

```typescript
interface SessionRepository {
  create(session: Session): Promise<void>;
  getById(sessionId: string): Promise<Session | null>;
  getActiveByWorkspace(workspaceId: string): Promise<Session | null>;
  update(session: Session): Promise<void>;
}
```

### 23.2 TaskRepository

```typescript
interface TaskRepository {
  create(task: Task): Promise<void>;
  getById(taskId: string): Promise<Task | null>;
  supersede(oldTaskId: string, newTask: Task): Promise<void>;
  // Không có update() — task immutable
}
```

### 23.3 TaskGraphRepository

```typescript
interface TaskGraphRepository {
  getCurrent(sessionId: string): Promise<TaskGraph>;
  getVersion(sessionId: string, version: number): Promise<TaskGraph | null>;
  commit(graph: TaskGraph, mutation: GraphMutation): Promise<void>;
}
```

### 23.4 TaskRunRepository

```typescript
interface TaskRunRepository {
  create(run: TaskRun): Promise<void>;
  getById(runId: string): Promise<TaskRun | null>;
  finalize(runId: string, patch: TaskRunPatch): Promise<void>;
  // Không có update() sau finalize
}
```

### 23.5 VerificationRepository

```typescript
interface VerificationRepository {
  create(report: VerificationReport): Promise<void>;
  getById(id: string): Promise<VerificationReport | null>;
  getByTask(taskId: string): Promise<VerificationReport[]>;
  getLatestForRevision(revisionId: string): Promise<VerificationReport | null>;
}
```

### 23.6 EventLog

```typescript
interface EventLog {
  append(event: DomainEvent): Promise<void>;
  stream(sessionId: string, fromSequence?: number): AsyncIterable<DomainEvent>;
  query(filter: EventFilter): Promise<DomainEvent[]>;
}
```

---

## 24. Invariant Mapping

| Invariant | Domain Contract |
|---|---|
| SS-001 | Session §2.2 (workspaceId unique) |
| SS-002 | Session §2.3 SessionState |
| GL-001 | Goal §3.2 (version field) |
| TI-001 | Task §4.2 (taskId immutable) |
| TI-003 | Task §4.3 (no deps) |
| EX-001 | TaskRun §6.2 (immutable after endedAt) |
| GI-001 | TaskGraph §7 |
| GI-008 | GraphMutation §8.3 |
| VR-001 | VerificationReport §9.1 |
| VR-006 | VerificationReport §9.2 |
| CP-001 | §21 Transaction Boundaries |
| CP-002 | Checkpoint §16.2 |
| BU-001 | Budget §15.2 |
| TG-003 | Approval §13.2 |
| HI-001 | Approval §13.2 |
| CX-001 | ContextSnapshot §14.2 |
| PR-001 | Artifact §20.2 |

---

## 25. Domain Events → State Transitions

### 25.1 Session

```
CREATED      --SESSION_INITIALIZED-->     INITIALIZING
INITIALIZING --SESSION_READY-->           RUNNING
RUNNING      --HUMAN_REQUIRED-->          AWAITING_HUMAN
AWAITING_HUMAN --HUMAN_DECIDED-->         RUNNING
RUNNING      --CANCEL_REQUESTED-->        CANCELLING
CANCELLING   --CANCEL_COMPLETED-->        ABORTED
RUNNING      --ALL_TASKS_TERMINAL-->      COMPLETED
```

### 25.2 Task

```
PENDING  --DEPENDENCIES_SATISFIED-->  READY
READY    --SCHEDULED-->               RUNNING
RUNNING  --EXECUTION_ENDED-->         VERIFYING
VERIFYING --VERIFICATION_PASSED-->    PASSED
VERIFYING --VERIFICATION_FAILED-->    FAILED
FAILED   --FAILURE_ANALYZED-->        FAILURE_ANALYZED
FAILURE_ANALYZED --RECOVERY_CHOSEN--> RECOVERY
RECOVERY --RECOVERY_ENDED-->          RUNNING
any      --SUPERSEDE-->               SUPERSEDED
any      --ABORT-->                   ABORTED
```

Tham chiếu: `STATE_MACHINE_SPEC.md`.

---

## 26. Schema Versioning

### 26.1 Version policy

- `schemaVersion` trong mỗi entity.
- Migration phải versioned (`MIGRATION_SPEC.md`).
- Không xóa entity cũ; chỉ đánh dấu `legacy`.
- Backward-compatible change → minor bump.
- Breaking change → major bump + migration.

### 26.2 Compatibility

- Đọc entity với `schemaVersion` cũ → migrate on read.
- Không ghi entity với `schemaVersion` mới xuống DB cũ.
- Downgrade chỉ khi có migration ngược.

---

## 27. Cross-Aggregate Consistency

### 27.1 Rules

- **Không** dùng cross-aggregate transaction.
- Consistency giữa aggregate đạt qua **event**.
- Read model tổng hợp theo nhu cầu.
- Nếu cần strong consistency → gộp vào một aggregate root.

### 27.2 Ví dụ

- Task completion → update TaskExecution + ghi event TASK_STATE_CHANGED.
- Session completion check là **read model** dựa trên task states.
- Verification pass → ghi VerificationReport + emit event; TaskExecution cập nhật qua event handler.

---

## 28. Error Model

### 28.1 Domain errors

```typescript
class DomainError extends Error {
  constructor(
    public code: string,
    public aggregate: string,
    public aggregateId: string,
    message: string,
  ) { super(message); }
}
```

### 28.2 Error codes

| Code | Meaning |
|---|---|
| `INVALID_TRANSITION` | State transition không hợp lệ |
| `IMMUTABLE_VIOLATION` | Cố mutate entity immutable |
| `VERSION_CONFLICT` | Optimistic concurrency fail |
| `CYCLE_DETECTED` | Graph cycle |
| `MISSING_REFERENCE` | Reference tới entity không tồn tại |
| `BUDGET_EXCEEDED` | Vượt budget |
| `POLICY_VIOLATION` | Vi phạm policy |
| `STALE_REVISION` | Revision không khớp |
| `LOCK_HELD` | Lock đang giữ |

---

## 29. Read Models

### 29.1 Purpose

Read model là projection phục vụ query/UI, không phải authority.

### 29.2 Examples

```typescript
interface SessionView {
  sessionId: string;
  state: SessionState;
  goal: Goal;
  graphVersion: number;
  tasks: TaskView[];
  budget: BudgetView;
}

interface TaskView {
  taskId: string;
  state: TaskState;
  currentRunId?: string;
  latestVerification?: VerificationReport;
  latestFailure?: Failure;
}
```

### 29.3 Rules

- Read model **không** được dùng cho write decision.
- Read model có thể stale; không cần strong consistency.
- Read model phải tái tạo được từ event log.

---

## 30. Testing Strategy

### 30.1 Domain unit tests

- Mỗi entity có test cho local invariants.
- Mỗi state machine có test cho mọi transition.
- Mỗi aggregate có test cho transaction boundary.

### 30.2 Contract tests

- Repository interface phải có implementation (in-memory, SQLite) cùng pass test suite.
- Event log phải replay được ra read model.

### 30.3 Property-based tests

- Graph mutation không tạo cycle với random ops.
- Budget không âm với random consumption.
- Workspace revision hash deterministic với random content.

---

## 31. North Star

> **Domain là nơi sự thật được định nghĩa. Adapter chỉ là cơ chế.**

Mọi entity, mọi transaction, mọi event đều tồn tại để trả lời:

- **Cái gì** đang xảy ra?
- **Tại sao** nó xảy ra?
- **Có thể audit** không?
- **Có thể reproduce** không?

---
