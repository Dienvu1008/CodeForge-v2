# PHASE_4_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 4 (First Autonomous Vertical Slice)**

Version: 1.0
Status: Working plan
Owner: Execution Plane / Observability + Wiring + E2E Autonomy
Scope: Khép kín vòng lặp agent: từ Goal đến PASS hoàn toàn tự động,
       không cần human intervention trong trường hợp bình thường.
Related:
`PHASE_3_SIGNOFF.md`, `INVARIANTS.md`, `SECURITY_MODEL.md`,
`DOMAIN_CONTRACTS.md`, `Coding Agent Architecture Target §54`

---

## 0. Nguyên tắc Phase 4

> **Phase 3 đặt nền móng thực thi. Phase 4 khép kín vòng lặp: Goal → Plan → Execute → Verify → PASS.**

Ba luật:

1. **Không có tính năng mới về mặt security** — mọi security invariant đã được phân bổ
   ở Phase 1/1.5. Phase 4 là wiring và observability.
2. **Agent không được can thiệp human trong happy path** — nếu cần human,
   đó là `APPROVAL_PENDING` rõ ràng, không phải crash hay timeout.
3. **Artifact pipeline hoàn chỉnh** — mọi stdout/stderr từ tool calls phải được
   lưu vào ArtifactStore; `ToolResult` phải có `stdoutArtifactId`/`stderrArtifactId`.

North Star: *Cho agent một Flutter hoặc TypeScript project nhỏ, một Goal đơn giản
("Add X feature") — agent hoàn thành task, test pass, verification PASS, không
cần human trong happy path.*

---

## 1. Con số Phase 4

Phase 4 **không có invariants mới** trong `invariants.yaml` (phase==4 = 0).
Các invariants liên quan đã được phân bổ vào:
- Phase 1 (EX-001..006, WS-003..010, SS-001..007, SC-001..006)
- Phase 1.5 (TG-001..010, VR-001..011, SE-001..010, HI-001..006)
- Phase 2 (MG-001..006, CX-001..006)

**HIGH còn dở từ Phase 3** (cần xong trong Phase 4):
- **TG-006** — idempotency key: content-hash deduplication cho `MODIFY_WORKSPACE` tools.
- **TG-008** — provenance recording: `ToolCall.provenance` must trace model + context + reason.
- **OB-002** — event: tool call started/ended emitted to EventLog.
- **OB-003** — event: verification check started/ended emitted to EventLog.
- **PR-003** — provenance append-only: ArtifactStore provenance never mutated.

Phase 4 là **wiring + observability milestone** — mọi contracts đã có,
giờ là nối chúng thành một vòng lặp tự động hoàn chỉnh.

---

## 2. Scope Phase 4

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `ArtifactPipeline` | Wire stdout/stderr → ArtifactStore sau mỗi tool call | PR-001, PR-003, OB-002 |
| `IdempotencyEngine` | TG-006: content-hash key, detect + skip duplicate MODIFY calls | TG-006 |
| `ToolCallProvenance` | TG-008: record model+context+reason trên mỗi ToolCall | TG-008 |
| `ApprovalHandoff` | APPROVAL_PENDING → async surface to caller; resume flow | HI-001..004, TG-003 |
| `BudgetIntegration` | Wire BudgetEngine vào TaskExecutor: decrement per tool call | BU-001..006 |
| `VerificationWiring` | Wire VerificationEngine vào TaskExecutor post-run | VR-001..011, TI-005 |
| `SessionOrchestrator` | Glue: Session → Scheduler → TaskExecutor → Verify → PASS loop | SS-001..007, SC-001..006 |
| `ObservabilityEvents` | OB-002/003: emit domain events cho tool calls + verification | OB-002, OB-003 |
| P4-I1 Full E2E | Goal → Plan → Execute → Verify → PASSED (real project, FakeModel) | All Phase-4 |

### 2.2 Out-of-scope (Phase 4)

- RecoveryEngine / Replanner (Phase 5) — RC-001..008
- Tree-sitter / LSP code intelligence (Phase 6)
- Streaming LLM (Phase 4.5)
- Multi-workspace (Phase 8+)
- VS Code UI rendering (Phase 4+ — VS Code bridge in separate stream)

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location | Status |
|---|---|---|
| `TaskExecutor` — tool-call loop | `agent-core/src/execution/task-executor.ts` | ✅ Phase 3 |
| `NodeToolExecutor` — FS/Git/Shell routing | `infrastructure/src/tools/node-tool-executor.ts` | ✅ Phase 3 |
| `ArtifactStore` — disk + SQLite metadata | `infrastructure/src/artifacts/artifact-store.ts` | ✅ Phase 3 (not wired) |
| `ToolGateway` — execute → ExecutorResult | `agent-core/src/tool/tool-gateway.ts` | ✅ Phase 1.5 |
| `VerificationEngine` + `CompletionGate` | `agent-core/src/verification/` | ✅ Phase 1.5 |
| `BudgetEngine` | `agent-core/src/budget/` | ✅ Phase 1 |
| `Scheduler` (`computeSchedule`) | `agent-core/src/scheduler/` | ✅ Phase 1 |
| `SessionService` | `agent-core/src/session/` | ✅ Phase 1 |
| `Planner` + `GraphCommitService` | `agent-core/src/planning/` | ✅ Phase 2 |
| `ExecutionCoordinator` | `agent-core/src/execution/execution-coordinator.ts` | ✅ Phase 1 |
| `TaskRunService` | `agent-core/src/task/task-run-service.ts` | ✅ Phase 1 |
| `ApprovalEngine` | `agent-core/src/tool/approval-engine.ts` | ✅ Phase 1.5 |
| `CrashRecoveryService` | `agent-core/src/recovery/crash-recovery-service.ts` | ✅ Phase 1 |
| `CheckpointService` | `agent-core/src/checkpoint/checkpoint-service.ts` | ✅ Phase 1 |
| `EventLog` | `infrastructure/src/event-log/` | ✅ Phase 1 |

### 3.2 Gaps cần lấp (Phase 4)

| Gap | Mô tả | Priority |
|---|---|---|
| ArtifactStore không được gọi sau tool call | `TaskExecutor` / `ToolGateway.execute()` không lưu stdout/stderr | HIGH |
| TG-006 idempotency key | `idempotencyKey` field trên ToolCall chưa được set | HIGH |
| TG-008 provenance trên ToolCall | `provenance` đã có nhưng chưa ghi model identity + contextSnapshotId đầy đủ | HIGH |
| BudgetEngine chưa gắn vào TaskExecutor | `budgetConsumed` trên TaskRun không được update khi tool call xong | MEDIUM |
| VerificationEngine chưa được gọi sau TaskRun | TaskExecutor finalize xong → projection = VERIFYING, nhưng verification không chạy | HIGH |
| SessionOrchestrator chưa tồn tại | Không có class nào loop Scheduler → TaskExecutor → Verify → PASS | HIGH |
| APPROVAL_PENDING flow | TaskExecutor hiện tại finalize FAILED khi gặp APPROVAL_PENDING | MEDIUM |
| ObservabilityEvents | `TOOL_CALL_STARTED`/`TOOL_CALL_ENDED` events chưa consistently emitted | LOW |

---

## 4. Component breakdown

### 4.1 P4-AP1 — ArtifactPipeline wiring

Sau khi `ToolGateway.execute()` trả về `ExecutorResult`, ghi stdout/stderr vào
`ArtifactStore` và trả về `stdoutArtifactId`/`stderrArtifactId` để set vào `ToolResult`.

```
agent-core/src/execution/
  artifact-recorder.ts   ← ArtifactRecorder: ExecutorResult → ArtifactStore → ArtifactIds
infrastructure/src/artifacts/
  artifact-store.ts      ← (đã có từ P3-AS1, chỉ cần gọi)
```

`TaskExecutor` inject `ArtifactRecorder` và gọi sau mỗi `ToolGateway.execute()`.
Kết quả: `ToolResult.stdoutArtifactId` + `.stderrArtifactId` luôn được set
(trừ khi content rỗng thì có thể bỏ qua).

### 4.2 P4-IK1 — IdempotencyEngine (TG-006)

```
agent-core/src/tool/
  idempotency-engine.ts  ← compute key, check duplicate, mark as deduped
```

Strategy per ToolDefinition:
- `'none'` → không check (read-only tools).
- `'content-hash'` → sha256(toolName + canonical JSON args) → idempotencyKey.
- `'custom'` → caller supplies explicitly.

`TaskExecutor` gọi `IdempotencyEngine.check(toolName, args)` trước `ToolGateway.request()`.
Nếu duplicate MODIFY call → skip + trả về cached result (TG-006 deduplication).

### 4.3 P4-VW1 — VerificationWiring

Sau khi `TaskRunService.finalize()` xong, `TaskExecutor` gọi `VerificationEngine.verify()`.
Nếu verification PASS → `ExecutionCoordinator.setState(taskId, 'PASSED')`.

```
agent-core/src/execution/task-executor.ts   ← thêm verification step sau finalize
agent-core/src/verification/               ← (đã có từ P1.5-VR1)
```

`VerificationEngine` cần `WorkspaceRevision` (end revision) + `TaskRun` để verify.
`CompletionGate.canComplete()` cần `VerificationReport` + revisionAtEnd.

### 4.4 P4-SO1 — SessionOrchestrator

```
agent-core/src/session/
  session-orchestrator.ts  ← full session loop: Planner → Scheduler → TaskExecutor → PASS
```

Loop:

```
1. Session RUNNING
2. Goal → Planner.plan() → GraphMutation
3. GraphCommitService.commit(mutation) → Graph v2
4. loop:
   a. computeSchedule(graph, executions) → ready tasks
   b. if empty: break (all done or blocked)
   c. TaskExecutor.execute(task) → TaskExecutorResult
   d. VerificationEngine.verify() → report
   e. CompletionGate.canComplete() → PASS | FAIL
   f. ExecutionCoordinator.setState(PASSED | FAILED)
   g. CheckpointService.capture() → checkpoint
5. All tasks terminal → SessionService.complete()
```

`SessionOrchestrator` injects all services; it is the single entry point for
an autonomous session run.

### 4.5 P4-BW1 — BudgetWiring

Wire `BudgetEngine` vào `TaskExecutor`:
- Trước khi start run: `BudgetEngine.canAfford(session, task_run)`.
- Sau mỗi tool call: `BudgetEngine.debit(taskRunId, { toolCalls: 1, ... })`.
- Khi run finalize: `BudgetEngine.debit(sessionId, wallClockMs + modelTokens)`.

Enforces **BU-001/003/005** (child <= parent, atomic decrement, exhaust = stop).

### 4.6 P4-AH1 — ApprovalHandoff (async)

`TaskExecutor` khi gặp `APPROVAL_PENDING` không còn finalize FAILED.
Thay vào đó:
- Emit `APPROVAL_REQUESTED` event.
- Suspend loop, return `{ finalState: 'SUSPENDED', pendingApprovalId }`.
- Caller (SessionOrchestrator) chuyển session sang `AWAITING_HUMAN`.
- Khi human approve/deny → resume loop.

Enforces **HI-001..004, SM-005**.

### 4.7 P4-I1 — Full Autonomous E2E

```
tests/integration/autonomous-e2e.spec.ts
```

Scenario: small TypeScript project, FakeModel returns realistic tool calls:
1. Goal: "Add a greeting function".
2. Planner → graph with 1 task.
3. Scheduler → picks task.
4. TaskExecutor → write_file + read_file.
5. VerificationEngine → PASS (stub).
6. Session COMPLETED.

No human intervention in this path.

---

## 5. Timeline (4 tuần)

```
Tuần 1 — Core wiring
  P4-AP1   ArtifactPipeline wiring (stdout/stderr → ArtifactStore)  [2 ngày]
  P4-IK1   IdempotencyEngine (TG-006 content-hash deduplication)     [1 ngày]
  P4-VW1   VerificationWiring (verify after finalize)                [2 ngày]

Tuần 2 — Orchestration
  P4-SO1   SessionOrchestrator (full session loop)                   [3 ngày]
  P4-BW1   BudgetWiring (tool call + run debit)                      [2 ngày]

Tuần 3 — Integration
  P4-AH1   ApprovalHandoff (APPROVAL_PENDING → AWAITING_HUMAN)       [2 ngày]
  P4-I1    Full Autonomous E2E (Goal → PASS, no human)               [3 ngày]

Tuần 4 — Sign-off
  —        PHASE_4_SIGNOFF.md                                        [1 ngày]
  —        Buffer / fix                                              [4 ngày]
```

---

## 6. Exit criteria Phase 4

1. Tất cả components §4 implemented.
2. TG-006 (HIGH): idempotency key set + duplicate MODIFY call deduplicated.
3. TG-008 (HIGH): `ToolCall.provenance` ghi đầy đủ model identity + contextSnapshotId.
4. ArtifactStore: stdout/stderr của mọi tool call được lưu vào disk.
5. VerificationEngine chạy sau mỗi TaskRun; PASS → `TaskExecution.currentState = 'PASSED'`.
6. `SessionOrchestrator.run()` hoàn thành một goal nhỏ end-to-end không cần human.
7. BudgetEngine: `budgetConsumed` trên TaskRun được update per tool call.
8. Không TypeScript error / ESLint error / dependency-cruiser violation.
9. CI green trên 2 OS.
10. `PHASE_4_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| SessionOrchestrator phức tạp hơn dự kiến | Trung bình | Cao | Bắt đầu với single-task happy path, không multi-task |
| VerificationEngine cần real test runner | Cao | Trung bình | Dùng stub verification (VR-stub) giống Phase 1.5 |
| BudgetEngine FK constraints trong SQLite | Thấp | Thấp | Seed budget row trước khi start run |
| ApprovalHandoff state machine phức tạp | Trung bình | Trung bình | Implement suspend/resume pattern đơn giản trước |

---

## 8. Những gì Phase 4 KHÔNG làm

- Không có RecoveryEngine / Replanner (Phase 5 — RC-001..008).
- Không có Tree-sitter / LSP (Phase 6).
- Không có streaming LLM (Phase 4.5).
- Không có multi-workspace (Phase 8+).
- Không có real VS Code UI (ngoài scope, VS Code bridge stream riêng).
- Không có multi-agent (Phase 8+).

---

## Phụ lục: Mapping HIGH invariants cần xong Phase 4

| Invariant | Statement (ngắn) | Component |
|---|---|---|
| TG-006 | ToolCall phải có idempotency key | `IdempotencyEngine` |
| TG-008 | ToolCall phải ghi provenance | `TaskExecutor` (already partial) |
| OB-002 | Events cho tool calls | `ToolGateway` + `EventLog` (already partial) |
| OB-003 | Events cho verification checks | `VerificationEngine` |
| PR-001 | Mọi artifact phải có provenance | `ArtifactStore` + `ArtifactRecorder` |
| PR-003 | Provenance append-only | `ArtifactStore` (đã có, cần enforce) |
| BU-003 | Budget decrement atomic với action | `BudgetEngine` + `TaskExecutor` |
| BU-005 | Budget exhausted → dừng task | `TaskExecutor` pre-check |
