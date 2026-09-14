# GRAPH_PROTOCOL.md

**Ollama Coding Agent — TaskGraph Protocol, Mutation Semantics & Validation**

Version: 1.0
Status: Architecture Baseline
Owner: agent-core / GraphStore + GraphValidator + GraphCommit
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (GI-*, TI-*, RC-*, CP-*), `DOMAIN_CONTRACTS.md`,
`STATE_MACHINE_SPEC.md`, `VERIFICATION_PROTOCOL.md`, `MIGRATION_SPEC.md`

---

## 0. Mục đích

TaskGraph là **authority duy nhất về dependency** giữa các Task.

Nguyên tắc:

> **Task là ý định. Graph là cấu trúc. Dependency chỉ tồn tại trong Graph.**

File này định nghĩa:

- mô hình graph;
- GraphMutation protocol;
- GraphValidator rules;
- GraphCommit transaction;
- supersession semantics;
- conflict resolution;
- reconciliation với execution;
- invariant mapping;
- test matrix;
- adversarial cases.

LLM **được phép propose** graph mutation. LLM **không được phép commit**.

Tham chiếu: `INVARIANTS.md` → **GI-001..GI-010, TI-003, TI-004, RC-005**.

---

## 1. Nguyên tắc nền tảng

### 1.1 Single source of dependency truth

- Không field nào trong Task biểu diễn dependency.
- Không side-channel (không lưu trong metadata, không lưu trong strategy hint).
- Mọi dependency phải nằm trong `TaskGraph.edges`.

### 1.2 Immutability

- Task identity immutable.
- Task content immutable sau commit.
- Graph version immutable sau commit.
- Chỉ có **commit mới** được tạo; không sửa version cũ.

### 1.3 Versioning

- Graph có `version` đơn điệu tăng.
- Mỗi commit tạo version mới.
- Version cũ vẫn queryable.
- Không xóa version.

### 1.4 Mutation, không overwrite

- Replanner tạo `GraphMutation`.
- Không có API `setGraph(newGraph)`.
- Chỉ có API `commitMutation(mutation)`.

### 1.5 Validation before commit

- Mọi mutation phải qua `GraphValidator`.
- Nếu fail → reject, không tạo version mới.
- Không có override trừ phi có human approval ghi nhận.

### 1.6 Atomic commit

- Commit phải atomic: version bump + mutation record + event append trong cùng transaction.
- Crash giữa commit không để state inconsistent.

Tham chiếu: `INVARIANTS.md` → **GI-001, GI-002, GI-003, GI-008, GI-009, TI-003, TI-004**.

---

## 2. Graph Model

### 2.1 Schema

```typescript
interface TaskGraph {
  graphId: string;              // ULID, stable across versions
  sessionId: string;
  version: number;              // 1-indexed, monotonic
  parentVersion?: number;       // version trước đó

  nodes: GraphNode[];
  edges: GraphEdge[];

  createdAt: string;
  createdBy: 'planner' | 'replanner' | 'user';
  mutationId?: string;          // mutation tạo version này
  canonicalHash: string;        // hash của graph structure

  schemaVersion: number;
  canonicalFormVersion: string;
}

interface GraphNode {
  taskId: string;               // reference tới Task
  addedInVersion: number;
  state?: never;                // KHÔNG lưu state ở đây
}

interface GraphEdge {
  edgeId: string;               // ULID
  fromTaskId: string;
  toTaskId: string;
  kind: EdgeKind;
  addedInVersion: number;
}

type EdgeKind =
  | 'depends_on'                // (from) depends_on (to): to phải PASSED trước khi from READY
  | 'blocks'                    // (from) blocks (to): from phải PASSED trước khi to READY ≡ (to) depends_on (from). Xem §3.2
  | 'supersedes';               // from thay thế to
```

Lưu ý hướng cạnh (tránh nhầm lẫn):
- `A --depends_on--> B`: **B** phải PASSED trước khi **A** READY (A phụ thuộc B).
- `A --blocks--> B`: **A** phải PASSED trước khi **B** READY (A chặn B). Validator normalize
  `A --blocks--> B` thành `B --depends_on--> A`.

### 2.2 Graph không chứa gì

- ❌ Không chứa Task state.
- ❌ Không chứa Task content.
- ❌ Không chứa verification.
- ❌ Không chứa budget.
- ❌ Không chứa execution.

Graph chỉ chứa **cấu trúc**: node (reference) + edge (quan hệ).

### 2.3 Graph hash

`canonicalHash` được tính từ:

```
hash(
  sort(nodes by taskId),
  sort(edges by (fromTaskId, toTaskId, kind))
)
```

Dùng để:

- detect graph drift;
- audit;
- reproducibility.

Không dùng để thay thế `version`.

---

## 3. Dependency Semantics

### 3.1 depends_on

```
A ──depends_on──► B
```

Nghĩa: **B phải PASSED trước khi A READY**.

- A ở PENDING cho tới khi mọi predecessor PASSED.
- Nếu B ABORTED → A không bao giờ READY (trừ khi có recovery).
- Nếu B SUPERSEDED → A phụ thuộc vào B' (task mới).

### 3.2 blocks

Alias ngược của `depends_on`:

```
A ──blocks──► B    ≡    B ──depends_on──► A
```

Nghĩa: **A phải PASSED trước khi B READY** ("A chặn B"). Từ §3.1, `B --depends_on--> A` nghĩa
là A phải PASSED trước B — nhất quán với trực giác "A blocks B".

Dùng cho readability. Validator normalize `A --blocks--> B` về `B --depends_on--> A` internally.

### 3.3 supersedes

```
A ──supersedes──► B
```

Nghĩa: **A thay thế B**.

- B chuyển `SUPERSEDED` khi mutation commit.
- Mọi edge depends_on B được **rewire** sang A (xem §6.3).
- Không tạo cycle qua `supersedes`.

### 3.4 Transitive dependency

`depends_on` là **transitive**:

```
A → B → C   ⇒   A phụ thuộc C (gián tiếp)
```

READY computation dùng transitive closure.

### 3.5 Không có negative dependency

Không có "A phải chạy trước khi B bị block". Mọi dependency đều positive.

Nếu cần điều kiện phức tạp → encode trong task acceptance criteria, không trong graph.

---

## 4. GraphMutation

### 4.1 Schema

```typescript
interface GraphMutation {
  mutationId: string;           // ULID
  sessionId: string;
  baseVersion: number;          // version mutation áp dụng lên

  operations: GraphOperation[];

  proposedBy: 'planner' | 'replanner' | 'user';
  reason: string;
  provenance: Provenance;

  createdAt: string;

  status: MutationStatus;
  validationErrors?: ValidationError[];
  committedVersion?: number;
  committedAt?: string;
}

type MutationStatus =
  | 'PROPOSED'
  | 'VALIDATED'
  | 'REJECTED'
  | 'COMMITTED';
```

### 4.2 Operations

```typescript
type GraphOperation =
  | AddTaskOp
  | RemoveTaskOp
  | AddEdgeOp
  | RemoveEdgeOp
  | SupersedeTaskOp
  | ChangeDependencyOp
  | RewireOp;

interface AddTaskOp {
  kind: 'ADD_TASK';
  task: Task;                   // Task entity mới
}

interface RemoveTaskOp {
  kind: 'REMOVE_TASK';
  taskId: string;
  cascade?: 'reject_if_edges' | 'cascade_edges';
}

interface AddEdgeOp {
  kind: 'ADD_EDGE';
  fromTaskId: string;
  toTaskId: string;
  edgeKind: EdgeKind;
}

interface RemoveEdgeOp {
  kind: 'REMOVE_EDGE';
  fromTaskId: string;
  toTaskId: string;
}

interface SupersedeTaskOp {
  kind: 'SUPERSEDE_TASK';
  oldTaskId: string;
  newTask: Task;
  rewire: boolean;              // default true
}

interface ChangeDependencyOp {
  kind: 'CHANGE_DEPENDENCY';
  fromTaskId: string;
  toTaskId: string;
  newKind: EdgeKind;
}

interface RewireOp {
  kind: 'REWIRE';
  fromTaskId: string;           // edge cũ
  toTaskId: string;             // edge mới
  targetTaskId: string;         // task mà edge trỏ tới
}
```

### 4.3 Operation ordering

- Operations được áp dụng **theo thứ tự khai báo**.
- Không có implicit reordering.
- Validator kiểm tra sau khi áp dụng toàn bộ.

### 4.4 Idempotency

- Mutation không idempotent theo nghĩa "chạy hai lần = chạy một lần".
- Chạy hai lần sẽ fail vì `baseVersion` không khớp.
- Đây là **optimistic concurrency**, không phải idempotency.

### 4.5 Base version check

```
if (mutation.baseVersion != currentGraph.version):
  reject with VERSION_CONFLICT
```

Không có auto-rebase. Replanner phải propose lại với `baseVersion` mới.

Tham chiếu: `INVARIANTS.md` → **GI-002, GI-L8**.

---

## 5. GraphValidator

### 5.1 Mục tiêu

Đảm bảo mọi mutation commit tạo ra graph **well-formed**.

### 5.2 Validation stages

```
Mutation
   │
   ▼
1. Schema Validation
   │
   ▼
2. Reference Validation
   │
   ▼
3. Operation Semantics
   │
   ▼
4. Structural Validation (cycle, etc.)
   │
   ▼
5. Reachability Validation
   │
   ▼
6. Supersession Validation
   │
   ▼
7. Policy Validation
   │
   ▼
Result: VALIDATED | REJECTED
```

### 5.3 Stage 1 — Schema Validation

Kiểm tra:

- `mutationId` unique.
- `baseVersion` là số nguyên dương.
- `operations` không rỗng.
- Mỗi operation khớp schema tương ứng.
- `Task` trong `ADD_TASK`/`SUPERSEDE_TASK` khớp `Task` schema.
- `Task.taskId` unique toàn cục (không chỉ trong mutation).

Errors:

- `SCHEMA_INVALID`
- `TASK_ID_DUPLICATE`

### 5.4 Stage 2 — Reference Validation

Kiểm tra:

- Mọi `taskId` được tham chiếu tồn tại (trong graph hoặc trong `ADD_TASK` cùng mutation).
- `REMOVE_TASK`/`SUPERSEDE_TASK` tham chiếu task tồn tại.
- `ADD_EDGE`/`REMOVE_EDGE` tham chiếu task tồn tại.
- Không tham chiếu task đã `REMOVE_TASK` trong cùng mutation.

Errors:

- `MISSING_REFERENCE`
- `REFERENCE_REMOVED`

### 5.5 Stage 3 — Operation Semantics

Kiểm tra:

- `ADD_TASK` với `taskId` đã tồn tại → reject.
- `REMOVE_TASK` task không có edge → OK.
- `REMOVE_TASK` với `cascade: reject_if_edges` và task có edge → reject.
- `REMOVE_TASK` với `cascade: cascade_edges` → edges liên quan bị remove.
- `ADD_EDGE` trùng edge (same from/to/kind) → idempotent (no-op) hoặc reject theo policy.
- `REMOVE_EDGE` edge không tồn tại → reject.
- `SUPERSEDE_TASK` old task đã SUPERSEDED → reject.
- `CHANGE_DEPENDENCY` từ kind này sang kind khác → OK nếu edge tồn tại.

Errors:

- `TASK_ALREADY_EXISTS`
- `EDGE_ALREADY_EXISTS`
- `EDGE_NOT_FOUND`
- `TASK_ALREADY_SUPERSEDED`
- `CASCADE_VIOLATION`

### 5.6 Stage 4 — Structural Validation

Kiểm tra:

- Không có cycle trong `depends_on`.
- Không có cycle trong `supersedes`.
- Không có self-loop.
- `supersedes` không tạo cycle với `depends_on`.

Cycle detection dùng **Tarjan's SCC** hoặc **DFS coloring**.

Errors:

- `CYCLE_DETECTED`
- `SELF_LOOP`
- `SUPERSEDES_CYCLE`

### 5.7 Stage 5 — Reachability Validation

Kiểm tra:

- Không có task orphan (không reachable từ root).
- Root = task không có predecessor.
- Nếu graph được declare có single root → check.
- Nếu graph cho phép multi-root → chỉ warn.

Errors:

- `ORPHAN_TASK` (warning hoặc error theo policy)

### 5.8 Stage 6 — Supersession Validation

Kiểm tra:

- `SUPERSEDE_TASK` không tạo chain quá dài (max depth).
- Task bị supersede không có execution đang RUNNING.
- Nếu có → reject.

Errors:

- `SUPERSEDE_WITH_RUNNING_EXECUTION`
- `SUPERSEDE_DEPTH_EXCEEDED`

### 5.9 Stage 7 — Policy Validation

Kiểm tra:

- Mutation size ≤ policy limit.
- Không xóa task đã PASSED (trừ khi policy cho phép).
- Không xóa task có verification.
- Không thay đổi acceptance criteria của task đã RUNNING.
- Budget cho replanning không vượt.

Errors:

- `POLICY_VIOLATION`
- `MUTATION_TOO_LARGE`
- `REMOVE_PASSED_TASK`

### 5.10 Validation result

```typescript
interface ValidationResult {
  status: 'VALIDATED' | 'REJECTED';
  errors: ValidationError[];
  warnings: ValidationWarning[];
  appliedOps: number;
  graphAfter?: TaskGraph;       // preview
}

interface ValidationError {
  stage: number;
  code: string;
  message: string;
  operationIndex?: number;
  taskId?: string;
  edgeId?: string;
}
```

Tham chiếu: `INVARIANTS.md` → **GI-002, GI-L2, GI-L3, GI-L9**.

---

## 6. Supersession Semantics

### 6.1 Supersede flow

```
oldTask (RUNNING hoặc PENDING)
     │
     │ SUPERSEDE_TASK
     ▼
newTask (PENDING)
     │
     │ rewire: true
     ▼
Mọi edge depends_on oldTask → depends_on newTask
Mọi edge oldTask depends_on X → newTask depends_on X
     │
     ▼
oldTask.state = SUPERSEDED
```

### 6.2 Rewire rules

Khi `rewire: true`:

1. Với mọi edge `(X, oldTask, depends_on)`: thay `oldTask` bằng `newTask`.
2. Với mọi edge `(oldTask, Y, depends_on)`: thay `oldTask` bằng `newTask`.
3. Với mọi edge `(oldTask, Y, supersedes)`: giữ nguyên (supersede chain).
4. Thêm edge `(newTask, oldTask, supersedes)`.

Khi `rewire: false`:

- Chỉ thêm edge `(newTask, oldTask, supersedes)`.
- Edges cũ giữ nguyên.
- Có thể tạo orphan → validator check.

### 6.3 Supersede chain

```
T1 ──supersedes──► T2 ──supersedes──► T3
```

- T1 là task mới nhất.
- Task state: T1 PENDING, T2 SUPERSEDED, T3 SUPERSEDED.
- Max depth theo policy (default 5).

### 6.4 Supersede với running execution

Nếu `oldTask` có TaskExecution đang RUNNING:

- Reject mutation.
- Replanner phải cancel trước.

Lý do: không được thay đổi identity của task đang chạy.

### 6.5 Supersede task đã PASSED

- Policy mặc định: **reject**.
- Lý do: đã có verification evidence.
- Nếu cần sửa → tạo task mới độc lập, không supersede.

Tham chiếu: `INVARIANTS.md` → **TI-004, GI-007, RC-005**.

---

## 7. GraphCommit

### 7.1 Transaction

```
BEGIN TRANSACTION
  1. Load current graph.
  2. Check mutation.baseVersion == current.version.
  3. Run GraphValidator.
  4. If REJECTED:
       - insert GraphMutation(status=REJECTED)
       - append event GRAPH_MUTATION_REJECTED
       - COMMIT
       - return rejected
  5. If VALIDATED:
       - create graph vN+1 (immutable)
       - update Tasks (SUPERSEDED)
       - insert GraphMutation(status=COMMITTED)
       - append event GRAPH_VERSION_CREATED
       - append event GRAPH_MUTATION_COMMITTED
       - COMMIT
       - return committed
COMMIT
```

### 7.2 Atomicity

- Nếu bất kỳ bước nào fail → rollback toàn bộ.
- Không có partial commit.
- Không có version bump mà không có mutation record.

Tham chiếu: `INVARIANTS.md` → **GI-008, CP-001**.

### 7.3 Concurrency

- Optimistic lock trên `graph.version`.
- Nếu hai mutation cùng `baseVersion` → một commit, một reject.
- Rejected mutation phải propose lại.

### 7.4 Post-commit effects

Sau khi commit:

1. Emit event (đã trong transaction).
2. Notify Scheduler để re-evaluate READY set.
3. Notify TaskExecution cho task mới (PENDING).
4. Không tự động schedule.

Effects ngoài transaction. Failure của effect không rollback commit.

---

## 8. Planner → Graph flow

### 8.1 Initial planning

```
Goal
 │
 ▼
Planner
 │
 ▼
Plan {
  tasks: Task[];
  edges: EdgeProposal[];   // { fromTaskId, toTaskId, kind } — KHÔNG có edgeId/addedInVersion
  assumptions: Assumption[];
}
 │
 ▼
PlanValidator (deterministic)
 │
 ▼
PlanCritic (optional LLM critique)
 │
 ▼
Build GraphMutation {
  baseVersion: 0,   // empty graph
  operations: [ADD_TASK × N, ADD_EDGE × M],
}
 │
 ▼
GraphCommit
 │
 ▼
Graph v1
```

Ghi chú: Planner chỉ đề xuất quan hệ cạnh (`fromTaskId`, `toTaskId`, `kind`). `edgeId` (ULID)
và `addedInVersion` do **runtime gán tại GraphCommit**, không phải do planner/LLM sinh. Điều này
giữ `edgeId` unique và version-anchored một cách deterministic.

### 8.2 Replanning

```
Failure
 │
 ▼
FailureAnalyzer
 │
 ▼
Replanner
 │
 ▼
GraphMutation {
  baseVersion: currentVersion,
  operations: [...]
}
 │
 ▼
GraphValidator
 │
 ▼
GraphCommit
 │
 ▼
Graph vN+1
```

Replanner **không** tạo graph mới. Nó tạo **mutation**.

Tham chiếu: `INVARIANTS.md` → **RC-005, GI-009**.

---

## 9. Scheduler Integration

### 9.1 READY computation

```
READY(t) =
     t.state == PENDING
  ∧ ∀ p ∈ predecessors(t): p.state == PASSED
  ∧ t ∉ SUPERSEDED
  ∧ budget_available(t)
```

Scheduler dùng graph để compute predecessors.

### 9.2 Dependency invalidation

Khi graph commit:

- Invalidate READY cache.
- Recompute READY set.
- Không tự động schedule.

### 9.3 Superseded task

Task SUPERSEDED:

- Không xuất hiện trong READY.
- Không được schedule.
- Vẫn queryable.

### 9.4 Orphan task

Nếu task mất hết predecessor do supersession:

- Nếu là root → OK.
- Nếu không phải root và policy yêu cầu → reject.

---

## 10. Conflict Resolution

### 10.1 Base version conflict

```
Mutation M1 { baseVersion: 5 }
Mutation M2 { baseVersion: 5 }
Current graph version = 5
```

- M1 commit → v6.
- M2 commit → reject `VERSION_CONFLICT`.

Resolution:

- Replanner propose lại với `baseVersion: 6`.
- Không auto-rebase.

### 10.2 Task already superseded

Mutation A supersede T1 → T2.
Mutation B supersede T1 → T3 (proposed sau khi A commit).

- B reject `TASK_ALREADY_SUPERSEDED`.

Resolution:

- Replanner phải supersede T2, không phải T1.

### 10.3 Edge conflict

Mutation A add edge T1 → T2.
Mutation B add edge T1 → T2 (cùng kind).

- B reject `EDGE_ALREADY_EXISTS` (hoặc no-op nếu policy).

### 10.4 Removing task có edges

`REMOVE_TASK T1` với `cascade: reject_if_edges`.

- Nếu T1 có edge → reject `CASCADE_VIOLATION`.
- Resolution: dùng `cascade_edges`.

### 10.5 Cycle conflict

Mutation tạo cycle.

- Reject `CYCLE_DETECTED`.
- Resolution: replanner propose lại không có cycle.

Tham chiếu: `INVARIANTS.md` → **GI-004, GI-005, GI-006**.

---

## 11. Graph Versioning

### 11.1 Version record

Mỗi version là **immutable snapshot**:

```typescript
interface GraphVersionRecord {
  graphId: string;
  version: number;
  parentVersion?: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  canonicalHash: string;
  mutationId: string;
  createdAt: string;
}
```

### 11.2 Query API

```typescript
interface GraphStore {
  getCurrent(sessionId: string): Promise<TaskGraph>;
  getVersion(sessionId: string, version: number): Promise<GraphVersionRecord | null>;
  listVersions(sessionId: string): Promise<GraphVersionRecord[]>;
  getDiff(sessionId: string, from: number, to: number): Promise<GraphDiff>;
  commit(mutation: GraphMutation): Promise<GraphCommitResult>;
}
```

### 11.3 GraphDiff

```typescript
interface GraphDiff {
  fromVersion: number;
  toVersion: number;
  tasksAdded: string[];
  tasksRemoved: string[];
  tasksSuperseded: string[];
  edgesAdded: GraphEdge[];
  edgesRemoved: GraphEdge[];
}
```

Diff dùng cho audit và UI.

---

## 12. Persistence Schema

### 12.1 Tables

```sql
CREATE TABLE task_graph_versions (
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  session_id TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  PRIMARY KEY (graph_id, version)
);

CREATE TABLE task_graph_nodes (
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  added_in_version INTEGER NOT NULL,
  PRIMARY KEY (graph_id, version, task_id),
  FOREIGN KEY (graph_id, version) REFERENCES task_graph_versions(graph_id, version)
);

CREATE TABLE task_graph_edges (
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  edge_id TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  added_in_version INTEGER NOT NULL,
  PRIMARY KEY (graph_id, version, edge_id),
  FOREIGN KEY (graph_id, version) REFERENCES task_graph_versions(graph_id, version)
);

CREATE TABLE graph_mutations (
  mutation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  validation_errors_json TEXT,
  committed_version INTEGER,
  proposed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE INDEX idx_graph_mutations_session ON graph_mutations(session_id);
```

### 12.2 Indexes

- `task_graph_edges(from_task_id)` — predecessor lookup.
- `task_graph_edges(to_task_id)` — successor lookup.
- `graph_mutations(session_id, created_at)` — audit.

### 12.3 Transaction boundary

- Commit = insert version + nodes + edges + mutation + event trong cùng transaction.

---

## 13. Invariant Mapping

| Invariant | Enforcement trong Graph Protocol |
|---|---|
| GI-001 | §1.1 single source of dependency |
| GI-002 | §5 GraphValidator |
| GI-003 | §7.1 version monotonic |
| GI-004 | §5.6 cycle detection |
| GI-005 | §5.4 reference validation |
| GI-006 | §5.5 cascade validation |
| GI-007 | §6 supersession |
| GI-008 | §7.2 atomic commit |
| GI-009 | §8 planner → mutation only |
| GI-010 | §7.1 provenance |
| TI-003 | §1.1, §2.2 |
| TI-004 | §6 supersession |
| RC-005 | §8.2 replanning |

---

## 14. Test Matrix

### 14.1 Validator tests

| Test | Target |
|---|---|
| `schema-invalid-op` | reject |
| `task-id-duplicate` | reject |
| `missing-reference` | reject |
| `add-edge-to-removed-task` | reject |
| `add-duplicate-edge` | reject / no-op |
| `remove-nonexistent-edge` | reject |
| `self-loop` | reject |
| `simple-cycle` | reject |
| `long-cycle` | reject |
| `supersedes-cycle` | reject |
| `orphan-task-warning` | warn |
| `remove-task-with-edges-reject` | reject |
| `remove-task-with-edges-cascade` | OK |
| `supersede-running-task` | reject |
| `supersede-passed-task` | reject |
| `supersede-depth-exceeded` | reject |
| `mutation-too-large` | reject |

### 14.2 Commit tests

| Test | Target |
|---|---|
| `commit-valid-mutation` | version bump |
| `commit-rejected-no-bump` | no version change |
| `commit-atomic-rollback` | rollback on failure |
| `commit-version-conflict` | reject |
| `commit-concurrent` | one wins, one rejects |
| `commit-emits-event` | event in same transaction |

### 14.3 Supersession tests

| Test | Target |
|---|---|
| `supersede-rewire-predecessors` | edges rewired |
| `supersede-rewire-successors` | edges rewired |
| `supersede-no-rewire` | edges unchanged |
| `supersede-chain` | chain depth |
| `supersede-running` | reject |
| `supersede-passed` | reject |

### 14.4 Scheduler integration tests

| Test | Target |
|---|---|
| `ready-after-dep-passed` | READY |
| `ready-blocked-by-dep` | not READY |
| `ready-after-supersede` | recompute |
| `superseded-not-scheduled` | not READY |
| `orphan-not-ready` | not READY (if policy) |

### 14.5 Persistence tests

| Test | Target |
|---|---|
| `graph-version-query` | correct version |
| `graph-diff` | correct diff |
| `graph-history` | all versions queryable |
| `graph-hash-stable` | same structure same hash |

---

## 15. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| MaliciousPlanner | `setGraph(newGraph)` | API không tồn tại |
| MaliciousPlanner | ADD_TASK trùng ID | reject |
| MaliciousReplanner | mutate immutable task | reject |
| MaliciousReplanner | baseVersion spoof | reject |
| MaliciousReplanner | cycle | reject |
| MaliciousReplanner | supersede running task | reject |
| MaliciousReplanner | remove passed task | reject |
| MaliciousReplanner | massive mutation (DoS) | reject (`MUTATION_TOO_LARGE`) |
| PromptInjection | "delete all tasks" | reject (policy) |
| Concurrent mutations | race | optimistic lock |

---

## 16. Recovery Integration

### 16.1 Replanning trigger

Failure → FailureAnalyzer → Replanner → GraphMutation.

Replanner không tự commit. Nó propose.

### 16.2 Replanning constraints

- `baseVersion` = current graph version.
- Không xóa task đã PASSED (trừ policy).
- Không thay đổi acceptance criteria của task đang RUNNING.
- Không vượt budget replanning.

### 16.3 Replanning outcome

- Mutation commit → graph vN+1.
- Task bị supersede → state SUPERSEDED.
- Task mới → PENDING.
- Scheduler re-evaluate.

Tham chiếu: `INVARIANTS.md` → **RC-005, RC-008**.

---

## 17. UI Integration (VS Code)

### 17.1 Graph view

- Hiển thị task nodes theo dependency.
- Highlight READY, RUNNING, PASSED, FAILED, SUPERSEDED.
- Hiển thị version.

### 17.2 Mutation review

- User có thể xem mutation proposal trước commit.
- User có thể approve/reject mutation (nếu policy).
- Mutation rejection → emit event, không commit.

### 17.3 Diff view

- Xem diff giữa hai version.
- Audit trail.

---

## 18. Performance

### 18.1 Cycle detection

- Tarjan SCC: O(V + E).
- Với V ≤ 10,000, E ≤ 50,000 → < 100ms.

### 18.2 READY computation

- Cache predecessor list.
- Recompute chỉ khi graph commit.
- Incremental khi có thể.

### 18.3 Storage

- Mỗi version lưu full snapshot (không delta) trong v1.
- Với 100 version × 10k task → có thể lớn; chấp nhận trong v1.
- v2 có thể dùng delta encoding.

---

## 19. Migration & Versioning

### 19.1 Schema version

- `schemaVersion` trong `TaskGraph`.
- Migration phải versioned.
- Không xóa version cũ.

### 19.2 Canonical form

- `canonicalFormVersion` cho hash.
- Bump khi format hash thay đổi.
- Version cũ vẫn queryable.

---

## 20. North Star

> **Graph là authority cấu trúc. Mutation là cách duy nhất để thay đổi. Validator là cửa. Commit là atomic.**

Không có đường vòng. Không có overwrite. Không có LLM authority.

---
