# PHASE_1_ROADMAP.md

**Ollama Coding Agent (CodeForge) — Kế hoạch Phase 1 (Runtime Kernel)**

Version: 1.0
Status: Working plan
Owner: agent-core / Runtime
Scope: Xây Runtime Kernel — chạy được với FakeModel, không cần LLM thật, không tool thật, không UI
Related:
`PHASE_0_ROADMAP.md`, `PHASE_0_SIGNOFF.md`, `INVARIANTS.md`, `invariants.yaml`,
`DOMAIN_CONTRACTS.md`, `STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`,
`VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`, `INFRASTRUCTURE_SPEC.md`

---

## 0. Nguyên tắc Phase 1

> **Phase 1 xây runtime chạy được với FakeModel. Không LLM thật. Không tool thật. Không UI.**

Ba luật:

1. **Vertical slice trước, breadth sau.** Session → Goal → Task → Graph → StateMachine chạy
   end-to-end trước khi tối ưu Scheduler/Budget/Checkpoint.
2. **Mỗi component kèm invariant tests ngay.** Không để nợ 69 invariant CRITICAL của Phase 1.
3. **FakeModel từ đầu.** Không có đường nào test runtime mà không có model double.

North Star: *Phase 1 xong khi runtime chạy một session end-to-end với FakeModel, không LLM/tool
thật, và toàn bộ 69 invariant CRITICAL của Phase 1 pass.*

---

## 1. Con số Phase 1 (đo thực tế từ `invariants.yaml`, không phải ước lượng)

Đếm bằng parse `invariants.yaml` (js-yaml), lọc `phase == 1`:

- **82 invariant** có `phase: 1`.
- Trong đó **69 CRITICAL** (13 HIGH còn lại).

Phân bố CRITICAL theo nhóm:

| Nhóm | # CRITICAL | IDs |
|---|---|---|
| Session (SS) | 6 | SS-001, SS-002, SS-003, SS-004, SS-006, SS-007 |
| Goal (GL) | 2 | GL-001, GL-002 |
| Task (TI) | 5 | TI-001, TI-002, TI-003, TI-004, TI-006 |
| Execution (EX) | 5 | EX-001, EX-002, EX-004, EX-005, EX-006 |
| Graph (GI) | 9 | GI-001 .. GI-009 |
| StateMachine (SM) | 6 | SM-001 .. SM-006 |
| Scheduler (SC) | 6 | SC-001 .. SC-006 |
| Workspace (WS) | 5 | WS-003, WS-004, WS-005, WS-006, WS-010 |
| Budget (BU) | 5 | BU-001, BU-002, BU-003, BU-005, BU-006 |
| Security (SE) | 2 | SE-007, SE-008 |
| Crash/Checkpoint (CP) | 11 | CP-001 .. CP-006, CP-008 .. CP-012 |
| Human (HI) | 1 | HI-005 |
| Provenance (PR) | 1 | PR-003 |
| Observability (OB) | 1 | OB-001 |
| Dependency (DC) | 4 | DC-001, DC-002, DC-003, DC-004 |
| **Tổng** | **69** | — |

> Chỉnh so với dự thảo trước (DeepSeek ước ~63): (a) **CP có 11 CRITICAL** (thiếu CP-010/011/012
> trong dự thảo); (b) **SE-007, SE-008 thuộc Phase 1**, không phải 1.5; (c) tổng đúng là **69**.

**KHÔNG thuộc Phase 1** (để Phase 1.5 / 2+): TI-005 (UNVERIFIED_COMPLETION), toàn bộ TG-* (tool
gateway), VR-* (verification), các SE-* còn lại (1.5); MG-*/CX-* (Phase 2); RC-* (Phase 5).

WS-003/004/005/006/010 đã có nền từ Phase 0 (path canonicalizer C3 + hash C1) — Phase 1 chỉ cần
nối vào runtime + thêm test invariant tương ứng.

---

## 2. Scope Phase 1

### 2.1 In-scope

| Component | Invariants chính |
|---|---|
| FakeModel (mở rộng từ Phase 0) | FM-1..FM-8 |
| SQLite adapter | CP-001 |
| Schema v1 + Migration | CP-001, CP-012 |
| EventLog adapter | CP-008, OB-001, PR-003 |
| Repository impl (6) | (nền cho SS/TI/EX/GI) |
| Session lifecycle + lock | SS-001..SS-004, SS-006, SS-007 |
| Goal | GL-001, GL-002 |
| Task | TI-001..TI-004, TI-006 |
| TaskExecution (projection) | EX-002, EX-003 |
| TaskRun | EX-001, EX-004, EX-005, EX-006 |
| TaskGraph | GI-001, GI-003 |
| GraphMutation + Validator + Commit | GI-002, GI-004..GI-009 |
| StateMachine (Session/Task/TaskRun) | SM-001..SM-006 |
| Scheduler | SC-001..SC-006 |
| Budget | BU-001..BU-003, BU-005, BU-006 |
| Checkpoint + Crash recovery | CP-002..CP-006, CP-009..CP-012 |
| Workspace integration | WS-003..WS-006, WS-010 |
| Security boundary (untrusted output) | SE-007, SE-008 |
| Dependency direction (giữ) | DC-001..DC-004 |

### 2.2 Out-of-scope (Phase 1.5 / 2+)

| Component | Phase | Ghi chú |
|---|---|---|
| VerificationEngine thật + CompletionGate | 1.5 | TI-005, VR-* |
| ToolGateway thật + tool policy | 1.5 / 3 | TG-*, SE-* còn lại |
| Planner / PlanValidator / PlanCritic | 2 | |
| ModelGateway thật + Ollama adapter | 2 | dùng salvage `ollamaClient.ts` |
| ContextBuilder / Retriever | 2 | CX-* |
| Recovery engine thật | 5 | RC-* |
| Tree-sitter / LSP / Memory / RAG | 6-7 | |
| VS Code UI | xuyên suốt | |

---

## 3. Stack bổ sung Phase 1

| Hạng mục | Lựa chọn | Lý do |
|---|---|---|
| SQLite driver | `better-sqlite3` | Sync API, nhanh, WAL tốt. **Native addon → test cross-platform tuần 1.** |
| Fallback 1 | `node:sqlite` (Node 22+, experimental) | Nếu native addon lệch nền tảng. |
| Fallback 2 | `sql.js` (WASM) | Cross-platform tuyệt đối nhưng chậm/không WAL. Chỉ khi cả 2 trên fail. |
| Migration | Tự impl (không ORM) | Kiểm soát; forward + rollback; `schema_versions` table. |
| Test isolation | tmp dir per test | Không share DB, xóa sau test. |

> **Cổng rủi ro:** `better-sqlite3` phải chạy được trên **Windows native + WSL2 Ubuntu** ngay
> tuần 1 (P1-F2). Nếu fail → chuyển `node:sqlite`. Đây là lý do làm SQLite adapter TRƯỚC các
> component agent-core.

---

## 4. Component breakdown

### 4.1 Foundation (Tuần 1)

**P1-F1 — FakeModel** (`packages/testing/src/fake-model`, đã có skeleton Phase 0)
- Mở rộng: `setDelay(ms)` (logical, không wall-clock), history phong phú cho UX events.
- Giữ `ModelGateway` shape sao cho `ollamaClient.ts` (salvage) drop-in ở Phase 2.
- Tests: FM-1..FM-8 (đã có, thêm cho phần mở rộng).

**P1-F2 — SQLite adapter** (`packages/infrastructure/src/sqlite`) — **LÀM ĐẦU TIÊN**
- `DatabaseAdapter` interface + impl: WAL mode, `busy_timeout`, `foreign_keys=ON`.
- `transaction(fn)` atomic, không nested; `query`/`execute` **parameterized only** (SE-008).
- `backup(path)`, `restore(path)`, `integrityCheck()`.
- File permission 0600 (best-effort trên Windows).
- **Cross-platform smoke test NGAY** (Windows + WSL2).
- Invariants: CP-001; SE-008 (no string interpolation SQL).

**P1-F3 — Schema v1 + Migration** (`packages/infrastructure/src/sqlite/migrations`)
- Tables: sessions, goals, tasks, task_executions, task_runs, task_graph_versions,
  task_graph_nodes, task_graph_edges, graph_mutations, events, provenance, budgets, checkpoints,
  locks, schema_versions.
- **Salvage hook (UX gap):** cột `tool_calls.before_content` / `after_content` (nullable, cho diff
  view Phase 3+); cột `capability_set` trên sessions/tasks (nullable, Phase 1 luôn full).
- Forward + rollback, idempotent.
- Invariants: CP-001, CP-012 (schema versioned).

**P1-F4 — EventLog adapter** (`packages/infrastructure/src/event-log`)
- Append-only; `sequenceNumber` per session monotonic, no gap.
- Query by session/type/aggregate/fromSequence; replay deterministic.
- Redaction trước persist (PR-003 — no unredacted secrets).
- **Salvage hook:** event payload đủ giàu cho UX (`{aggregateId, from, to, reason, evidence}`),
  không chỉ `TASK_STATE_CHANGED`.
- Invariants: CP-008, OB-001, PR-003.

**P1-F5 — Repository implementations** (`packages/infrastructure/src/repositories`)
- Impl 6 interface Phase 0 trên SQLite: Session, Task (no update, supersede), TaskGraph, TaskRun
  (finalize), Verification (stub Phase 1), EventLog. + Goal, Budget, Checkpoint repos.
- Immutable entities: no `update()`. Optimistic locking qua `version`.
- Tests: create/get, immutable enforcement, version conflict.

### 4.2 Session + Goal (Tuần 1-2)

**P1-S1 — Session** (`packages/agent-core/src/session`)
- SessionStateMachine (CREATED→INITIALIZING→RUNNING→...→COMPLETED/ABORTED).
- SessionService: create, transition, complete. WorkspaceLock (acquire/release/recover).
- Checkpoint on state change.
- Invariants: SS-001, SS-002, SS-003, SS-004, SS-006, SS-007.

**P1-S2 — Goal** (`packages/agent-core/src/goal`)
- Goal immutable + versioned; supersede flow.
- Invariants: GL-001, GL-002.

### 4.3 Task + Execution (Tuần 2)

**P1-T1 — Task** (`packages/agent-core/src/task`)
- Immutable; no dependency fields (TI-003); supersede via new task (TI-004).
- Invariants: TI-001, TI-002, TI-003, TI-004, TI-006.

**P1-T2 — TaskExecution projection** (`packages/agent-core/src/execution`)
- Projection từ Task + TaskRun; `currentState`, `currentRunId`, `attempts`; cập nhật qua event.
- Không dùng làm authority (EX-003).
- Invariants: EX-002, EX-003.

**P1-T3 — TaskRun** (`packages/agent-core/src/task-run`)
- Immutable sau finalize; TaskRunStateMachine; ghi `graphVersionAtStart` + `workspaceRevisionAtStart`.
- Process reconciliation trước finalize (EX-005).
- Invariants: EX-001, EX-004, EX-005, EX-006.

### 4.4 Graph (Tuần 3)

**P1-G1 — TaskGraph** (`packages/agent-core/src/graph`) — versioned, canonical hash, versioned store.
Invariants: GI-001, GI-003.

**P1-G2 — GraphMutation + Validator** — 7 stage (SCHEMA, REFERENCE, OPERATION_SEMANTICS, STRUCTURAL
[cycle=Tarjan SCC], REACHABILITY, SUPERSESSION, POLICY). Reject on any failure.
Invariants: GI-002, GI-004, GI-005, GI-006, GI-007, GI-009.

**P1-G3 — GraphCommit** — atomic: version bump + mutation record + event append (1 transaction).
Optimistic lock trên `baseVersion`. Post-commit effects không transactional.
Invariants: GI-008, GI-010 (HIGH).

### 4.5 StateMachine + Scheduler (Tuần 3-4)

**P1-SM1 — TaskStateMachine** — full transition table; guards (all deps passed / report valid /
fresh); terminal enforcement; **không RUNNING→PASSED shortcut** (SM-002).
Invariants: SM-001..SM-006.

**P1-SC1 — Scheduler** — hàm thuần deterministic của (graph, states, deps, policy, budget, session).
Property test: same input → same output.
Invariants: SC-001..SC-006.

### 4.6 Budget + Checkpoint + Crash (Tuần 4)

**P1-B1 — Budget** — hierarchy session→task→task_run→recovery; child ≤ parent remaining; atomic
decrement; exhausted → stop.
Invariants: BU-001, BU-002, BU-003, BU-005, BU-006.

**P1-C1 — Checkpoint** — atomic write 5 thành phần (graphVersion, workspaceRevision, changeSet,
sessionState, budgetState); load + reconcile; no partial.
Invariants: CP-002, CP-003, CP-009, CP-010, CP-011, CP-012.

**P1-CR1 — Crash recovery** — detect unfinished TaskRun on restart; reconcile process tree +
workspace; mark INTERRUPTED (không FAILED); recovery policy quyết định bước kế.
Salvage pattern: cross-platform `shellQuote` + rollback discipline từ `gitCheckpoint.ts` cũ.
Invariants: CP-004, CP-005, CP-006.

### 4.7 Integration (Tuần 5)

**P1-I1 — Session lifecycle E2E (FakeModel):** create session → Goal → TaskGraph v1 (2-3 task) →
Scheduler picks → FakeModel tool call (no-op) → TaskRun done → Verification stub PASS → Task PASSED
→ Session COMPLETED. Verify: mọi invariant hold, event log đầy đủ, checkpoint nhất quán.

**P1-I2 — Crash recovery E2E:** setup mid-execution → inject crash (CrashInjector từ Phase 0) →
restart → load checkpoint → reconcile → continue/escalate. Verify: no orphan, no corruption.

**P1-I3 — Adversarial E2E:** MaliciousPlanner→graph invalid→validator reject; MaliciousReplanner→
cycle→reject; MaliciousFailureAnalyzer→retry forever→budget block; injection trong FakeModel
output→policy block (SE-007).

---

## 5. Timeline (~5 tuần, 1 người full-time)

```
Tuần 1 — Foundation
  P1-F2  SQLite adapter + cross-platform test   [2 ngày]  ← RỦI RO CAO NHẤT, làm trước
  P1-F1  FakeModel (mở rộng)                     [1 ngày]
  P1-F3  Schema v1 + Migration                   [1 ngày]
  P1-F4  EventLog adapter                         [1 ngày]

Tuần 2 — Session + Goal + Task
  P1-F5  Repository impl                          [1 ngày]
  P1-S1  Session lifecycle + lock                 [2 ngày]
  P1-S2  Goal                                     [0.5 ngày]
  P1-T1  Task                                     [1 ngày]
  P1-T2  TaskExecution projection                 [0.5 ngày]

Tuần 3 — TaskRun + Graph
  P1-T3  TaskRun                                  [1 ngày]
  P1-G1  TaskGraph                                [1 ngày]
  P1-G2  GraphMutation + Validator                [2 ngày]
  P1-G3  GraphCommit                              [1 ngày]

Tuần 4 — StateMachine + Scheduler + Budget + Checkpoint
  P1-SM1 TaskStateMachine                         [1 ngày]
  P1-SC1 Scheduler                                [1.5 ngày]
  P1-B1  Budget                                   [1 ngày]
  P1-C1  Checkpoint                               [1 ngày]
  P1-CR1 Crash recovery                           [1.5 ngày]

Tuần 5 — Integration + Sign-off
  P1-I1  Session lifecycle E2E                    [2 ngày]
  P1-I2  Crash recovery E2E                        [1 ngày]
  P1-I3  Adversarial E2E                           [1 ngày]
  —      PHASE_1_SIGNOFF.md                        [1 ngày]
```

**Critical path:** `SQLite adapter → Repository → Session → Task → TaskRun → Graph → StateMachine →
Scheduler → Integration`.

---

## 6. Salvage từ `ollama-code-chat` (v0.0.78)

Dự án cũ (cùng tác giả, cùng tên "CodeForge", đã có `core/` thuần verified 0 import vscode/LangChain).
Nguyên liệu tái sử dụng, phân loại theo mức độ.

> **Quy trình salvage:** copy file gốc vào `reference/ollama-code-chat/` (chỉ để đối chiếu, KHÔNG
> import vào build), rồi port từng phần vào package v2 với: strict ESM + `exactOptionalPropertyTypes`,
> inject time/random (no wall-clock/no Math.random), giữ agent-core không import infrastructure
> (DC-001..004), viết vitest trước khi coi là "đã port".

### 6.1 Lift-and-adapt (giá trị cao, khớp contract)

| File cũ | → Component v2 | Phase | Ghi chú |
|---|---|---|---|
| `ollamaClient.ts` | ModelGateway → Ollama adapter | 2 | streaming, chatWithTools, capabilities, **JSON tool-call recovery từ text**, 0 dep (node:http). Giữ shape `ChatMessage`/`OllamaTool`/`ChatWithToolsResult`. |
| `verify/errorParsers.ts` | VerificationEngine error parsing | 1.5 | pure string→ErrorLocation[] cho tsc/dart/gcc/eslint. Lift gần nguyên. |
| `verify/layeredVerifier.ts`, `runStep.ts`, `presets.ts` | VerificationEngine | 1.5 | verify theo tầng + preset ngôn ngữ. |
| `safeCommands.ts` | ToolPolicy | 3 / 1.5 | `isSafeReadCommand` (default-deny, reject chaining) + `detectBlockingCommand` (chặn dev-server treo). Khớp SE-*/TG-*. |
| `runtime/completionGuard.ts` | CompletionGate | 1.5 | "LLM không tự tuyên bố done" — pure decision, anti-fabrication + verify-reminder. |

### 6.2 Học pattern, viết lại (ý tưởng đúng, model khác v2)

| File cũ | Học gì | Vì sao viết lại |
|---|---|---|
| `runtime/gitCheckpoint.ts` | cross-platform `shellQuote` (PowerShell+sh), rollback (`reset --hard`+`clean -fd`) | v2 checkpoint atomic 5-thành-phần, git chỉ là 1 adapter (Phase 3+). |
| `core/tool.ts` | `AgentTool`/`ToolRegistry`/`ToolResult`/`WorkspaceGate`/`RiskLevel` | v2 riskClass 8 cấp vs 4; cần `argumentsHash` + Approval binding. |
| `core/types.ts` | Task-DAG, TaskExecutionRecord, Checkpoint, StateTransition-as-data | v2 tách Task≠TaskExecution≠TaskRun nghiêm (TI-001..003); cũ nhét `dependencies` vào Task (v2 cấm). |
| `runtime/stateMachine` + test chống drift | test transition table khớp runtime | mẫu cho SM tests v2 (10 machine). |

### 6.3 Không lấy
UI (chatHtml, dashboardPanel, webview), LangChain tàn dư, `workspaceTools.ts` (audit đánh dấu drift),
JSON persistence (v2 dùng SQLite).

### 6.4 Ba điều chỉnh thiết kế do salvage (áp vào Phase 1)
1. **ModelGateway interface** thiết kế để `ollamaClient.ts` drop-in ở Phase 2 (giữ message/tool shape).
2. **Schema v1** thêm sẵn `before_content`/`after_content` (diff UX) + `capability_set` (scoped
   permission hook), nullable, dù Phase 1 luôn full.
3. **EventLog payload** đủ giàu cho UX (from/to/reason/evidence), không chỉ state-changed.

---

## 7. Exit criteria Phase 1

1. Tất cả component §4 implemented.
2. **69 invariant CRITICAL Phase 1** (§1) pass.
3. E2E P1-I1 (session lifecycle, FakeModel) pass.
4. E2E P1-I2 (crash recovery) pass.
5. E2E P1-I3 (adversarial) pass.
6. SQLite adapter chạy trên Windows + WSL2.
7. CI green trên 2 OS.
8. Không TypeScript error / ESLint error / dependency-cruiser violation.
9. `PHASE_1_SIGNOFF.md` được tạo.

---

## 8. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| `better-sqlite3` cross-platform | Trung bình | Cao | Test tuần 1 (P1-F2 trước tiên); fallback `node:sqlite` |
| Cycle detection bug (Tarjan) | Thấp | Cao | property-based test với random graphs |
| Checkpoint atomicity bug | Trung bình | Cao | CrashInjector (Phase 0) inject 7 điểm |
| FakeModel non-determinism | Thấp | Trung bình | no random, no wall-clock |
| Process orphan trên Windows | Trung bình | Trung bình | Job Objects; test tuần 4 |
| Salvage port kéo theo dep vscode | Thấp | Trung bình | reference/ tách biệt, port có kiểm depcruise |

---

## 9. Những gì Phase 1 KHÔNG làm
LLM thật · tool thật (fs/shell) · verify thật · UI · planner thật · recovery engine thật.
Phase 1 bàn giao **runtime kernel**, không bàn giao **intelligence**.

Câu hỏi nghiệm thu cuối: *Nếu Phase 2 thêm LLM thật, runtime có bị phá không?* Nếu **không**
(vì FakeModel đã test hết boundary) → Phase 1 đúng.

---

## 10. Bước tiếp theo
1. **P1-F2 SQLite adapter** — làm trước, test cross-platform ngay (rủi ro cao nhất). ← ĐANG LÀM
2. P1-F1 FakeModel (mở rộng skeleton Phase 0).
3. P1-F3 Schema + Migration.
4. P1-F4 EventLog.
5. P1-F5 Repository impl → sang Session.
