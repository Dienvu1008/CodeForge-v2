# PHASE_1_5_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 1.5 (Verification, ToolGateway, Security Boundary)**

Version: 1.0
Status: Working plan
Owner: agent-core / Runtime
Scope: Hoàn thiện execution loop thực: task không thể PASSED nếu không có verification evidence hợp lệ (TI-005), tool calls phải qua ToolGateway (TG-*), prompt injection phải bị block (SE-001..003).
Related:
`PHASE_1_SIGNOFF.md`, `PHASE_1_ROADMAP.md`, `INVARIANTS.md`, `invariants.yaml`,
`VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`, `DOMAIN_CONTRACTS.md`,
`STATE_MACHINE_SPEC.md`

---

## 0. Nguyên tắc Phase 1.5

> **Phase 1 bàn giao runtime kernel chạy được. Phase 1.5 bàn giao runtime SAFE: task không thể PASSED
> mà không có evidence, tool không thể execute mà không qua gateway, model output không được là authority.**

Ba luật:

1. **Completion = evidence.** TI-005 là northstar: VERIFYING → PASSED chỉ khi có VerificationReport
   PASS, fresh, đúng scope. Không có shortcut.
2. **Execution = gated.** Mọi tool call qua ToolGateway + risk classification + approval binding.
   Không có direct exec.
3. **Model output = untrusted input.** Structured output validation bắt buộc. Không có LLM authority.

North Star: *Phase 1.5 xong khi một task chỉ PASSED sau khi VerificationEngine chạy checks thật
và report fresh, tool calls đi qua ToolGateway với approval binding, và prompt injection content
không tạo được state change.*

---

## 1. Con số Phase 1.5 (đo từ `invariants.yaml`, lọc `phase == 1.5`)

**37 invariant** có `phase: 1.5`, trong đó **29 CRITICAL** + **8 HIGH**.

Phân bố CRITICAL theo nhóm:

| Nhóm | # CRITICAL | IDs |
|---|---|---|
| Verification (VR) | 9 | VR-001, VR-002, VR-003, VR-004, VR-005, VR-006, VR-007, VR-008, VR-011 |
| ToolGateway (TG) | 8 | TG-001, TG-002, TG-003, TG-004, TG-005, TG-007, TG-009, TG-010 |
| Security (SE) | 6 | SE-001, SE-002, SE-003, SE-005, SE-009, SE-010 |
| HumanInteraction (HI) | 4 | HI-001, HI-002, HI-003, HI-004 |
| Task completion (TI) | 1 | TI-005 |
| Provenance (PR) | 1 | PR-004 |
| **Tổng** | **29** | — |

HIGH (8): TG-006, TG-008, VR-009, VR-010, SE-004, SE-006, OB-002, OB-003.

**KHÔNG thuộc Phase 1.5** (để Phase 2+):
- MG-*/CX-* — model gateway structured output, context snapshot (Phase 2, cần Ollama adapter thật)
- RC-* — recovery engine (Phase 5)
- WS-* còn lại — đã đủ ở Phase 0/1
- SE-007/008 — ProcessSupervisor timeout/tree (Phase 1.5 builds ProcessSupervisor, SE-007/008
  trở thành applicable lần đầu; xem §4.3)

---

## 2. Scope Phase 1.5

### 2.1 In-scope

| Component | Invariants chính |
|---|---|
| VerificationEngine (core + pipeline) | VR-001..008, VR-011, TI-005 |
| CompletionGate (enhanced task SM) | TI-005, VR-002, VR-004 |
| ProcessSupervisor | SE-007, SE-008, TG-010 |
| ToolGateway + ToolPolicy | TG-001..005, TG-007, TG-009, TG-010 |
| ApprovalEngine | HI-001..004, TG-003, TG-004 |
| StructuredOutputValidator | SE-010, SE-003 |
| PromptBoundary (context marking) | SE-001, SE-002 |
| SecretRedactor (extend existing) | SE-005, PR-004 |
| EnvGuard | SE-004 |
| Schema migration v2 (new tables) | CP-001, CP-007 |
| Integration E2E P1.5-I1..I3 | all of above |

### 2.2 Out-of-scope (Phase 1.5)

- Ollama adapter thật (Phase 2)
- ContextSnapshot builder (Phase 2) — MG-*/CX-*
- RecoveryEngine (Phase 5) — RC-*
- NetworkPolicy enforcement (HIGH, Phase 2)
- ArtifactStore thật (Phase 1.5 dùng in-memory stub)
- VS Code UI integration (Phase 3)
- Planner/Replanner/FailureAnalyzer LLM calls (Phase 2)

---

## 3. Kiến trúc những gì đã có (Phase 1 baseline)

### 3.1 Đã có — dùng ngay

| Thứ | Location |
|---|---|
| Domain types: `VerificationReport`, `VerificationCheck`, `VerificationScope` | `agent-core/src/domain/verification.ts` |
| Domain types: `ToolCall`, `Approval`, `RiskClass` | `agent-core/src/domain/tool-call.ts` |
| Domain types: `Failure`, `FailureEvidence`, `FailureClass` | `agent-core/src/domain/failure.ts` |
| Domain types: `Artifact` | `agent-core/src/domain/artifact.ts` |
| `SqliteVerificationRepository` (append-only CRUD) | `infrastructure/src/repositories/verification-repository.ts` |
| `Redactor` + `REDACTION_RULES` | `infrastructure/src/redaction/redactor.ts` |
| `SCOPE_LATTICE` const | `agent-core/src/domain/verification.ts` |
| State types `ToolCallState`, `VerificationState` | `agent-core/src/state-machine/states.ts` |
| `isFresh` / `CANONICAL_FORM_VERSION` | `agent-core/src/domain/workspace-revision.ts` |
| Task state machine `transitionTask` | `agent-core/src/task/task-machine.ts` |
| `ExecutionCoordinator.setState` | `agent-core/src/execution/execution-coordinator.ts` |
| `BudgetRepository.consume` (atomic) | infrastructure |
| `EventLog` (append-only, sequence authority) | infrastructure |

### 3.2 Cần tạo mới (Phase 1.5)

| Component | Package | Phần cốt lõi cần xây |
|---|---|---|
| `ProcessSupervisor` | agent-core (contract) + infrastructure (impl) | spawn subprocess, timeout, kill tree, orphan cleanup |
| `ToolGateway` | agent-core | ToolCall lifecycle FSM, risk gate, execute dispatch |
| `ToolPolicy` | agent-core | risk→action table (auto/approval/deny), policy struct |
| `ApprovalEngine` | agent-core | create approval, verify binding, forge-proof |
| `VerificationEngine` | agent-core | pipeline orchestration, scope compute, affected set, freshness |
| `VerificationPolicy` | agent-core | scope rules, check definitions, deterministic resolve |
| `CompletionGate` | agent-core | enforce TI-005: completion only with valid evidence |
| `StructuredOutputValidator` | agent-core | JSON schema validation of model output (SE-010) |
| `PromptBoundary` | agent-core | context item trust marking (SE-001/002) |
| `EnvGuard` | agent-core | env allowlist/denylist filter (SE-004) |
| SQLite migration v2 | infrastructure | `tool_calls`, `approvals`, `failures`, `recovery_actions` tables |
| `SqliteToolCallRepository` | infrastructure | ToolCall CRUD + finalize |
| `SqliteApprovalRepository` | infrastructure | Approval insert + bind-check |
| `SqliteFailureRepository` | infrastructure | Failure insert |
| `FakeProcessSupervisor` | packages/testing | deterministic test double |
| `FakeVerificationEngine` | packages/testing | stub PASS/FAIL sequence |

### 3.3 Cần extend (Phase 1)

| Cái cần extend | Extension |
|---|---|
| `task-machine.ts` | Tăng cường VERIFYING→PASSED guard: đọc `reportValid` + `fresh` từ `CompletionGate` (đã có ctx field, chỉ cần wire thực) |
| `domain/event.ts` EventType | Thêm: `TOOL_CALL_REQUESTED`, `TOOL_CALL_APPROVED/DENIED/STARTED/ENDED`, `VERIFICATION_STARTED/ENDED`, `FAILURE_DETECTED`, `HUMAN_APPROVAL_REQUESTED/GRANTED/DENIED`, `HUMAN_OVERRIDE_COMPLETED` |
| Schema migration v1 | Không sửa v1 (GI nguyên tắc additive-only); tạo migration v2 với tables mới |
| `repositories/index.ts` | Thêm interfaces: `ToolCallRepository`, `ApprovalRepository`, `FailureRepository` |

---

## 4. Component breakdown

### 4.1 P1.5-PS1 — ProcessSupervisor *(tiên quyết cho TG + VR)*

**Mục tiêu:** spawn subprocess với timeout bắt buộc, kill tree (SIGTERM→SIGKILL), orphan cleanup.
Enforces: SE-007 (process timeout), SE-008 (process tree bound+cleanup), TG-010 (timeout→TIMEOUT state).

```
agent-core/src/process/
  process-supervisor.ts   ← contract (interface ProcessSupervisor + SpawnOptions + SpawnResult)
  index.ts

infrastructure/src/process/
  node-process-supervisor.ts  ← impl dùng node:child_process + tree-kill
  index.ts
```

FakeProcessSupervisor ở `packages/testing/src/process/`.

**Key design:** `spawn(cmd, args, opts): Promise<SpawnResult>` — timeout → kills tree và trả về exitCode=null + timedOut=true. Không dùng `shell:true`. Arguments là array (SE-009 §9.4 SECURITY_MODEL). Working dir phải nằm trong workspace root.

### 4.2 P1.5-TG1 — ToolGateway + ToolPolicy

**Mục tiêu:** ToolCall lifecycle (REQUESTED→APPROVAL_PENDING/APPROVED/DENIED→RUNNING→SUCCEEDED/FAILED/TIMEOUT),
risk classification, policy enforcement. Enforces: TG-001..005, TG-007, TG-009, TG-010.

```
agent-core/src/tool/
  tool-policy.ts       ← ToolPolicy struct + risk→action table + determineAction()
  tool-gateway.ts      ← ToolGateway service (request, approve/deny, execute)
  tool-call-machine.ts ← pure FSM transitionToolCall()
  index.ts
```

**Key design:**
- `ToolGateway.request(call)`: validate schema (TG-009) → classify risk → apply policy → REQUESTED/APPROVAL_PENDING/DENIED.
- `ToolGateway.execute(toolCallId, executor)`: chỉ chấp nhận APPROVED state (TG-001, TG-005) → spawn qua ProcessSupervisor.
- Policy là pure function: `determineAction(toolName, riskClass, policy) → 'allow'|'require_approval'|'deny'`.
- DESTRUCTIVE/PRIVILEGED không bao giờ auto-approve (TG-007/SE-009).

### 4.3 P1.5-TG2 — ApprovalEngine

**Mục tiêu:** tạo + verify Approval với binding (toolCallId, argumentsHash, toolPolicyVersion) —
forge-proof (HI-001..004, TG-003/004).

```
agent-core/src/tool/
  approval-engine.ts   ← ApprovalEngine service
```

**Key design:**
- `approve(toolCallId, decision, decidedBy)`: kiểm tra binding chính xác trước khi ghi.
- Approval chỉ valid cho đúng `argumentsHash` — reuse cho call khác bị reject (HI-002).
- Model output không bao giờ tạo được Approval record (HI-001) vì ApprovalEngine là T0/T1 authority.

### 4.4 P1.5-VR1 — VerificationEngine core

**Mục tiêu:** scope computation, affected set, freshness check, pipeline orchestration.
Enforces: VR-001/002/004/007/009/010/011, TI-005.

```
agent-core/src/verification/
  verification-policy.ts    ← VerificationPolicy + resolvePolicy() deterministic
  affected-set.ts           ← computeAffectedDirect() + computeAffectedClosure() (Phase 1.5: heuristic)
  freshness.ts              ← isFresh() + isUsableForCompletion() (di chuyển từ domain)
  scope-computer.ts         ← computeScope() deterministic, lattice-aware
  verification-engine.ts    ← VerificationEngine service (orchestrate pipeline)
  completion-gate.ts        ← canComplete() enforces TI-005 fully
  index.ts
```

**Key design (Phase 1.5 scope):**
- Affected set: diff-based (Phase 1.5 baseline per VERIFICATION_PROTOCOL §4.3) — không cần LSP/Tree-sitter.
- Check runner: qua ProcessSupervisor (subprocess timeout, không shell:true).
- `VerificationEngine.verify(request)`: capture R_before → run checks → capture R_after → compare non-scratch → build report → commit append-only.
- Scratch zone enforcement: VR-003/008 — mutation ngoài scratch → INVALID.
- `CompletionGate.canComplete(taskId, currentRevision)`: đọc latest report → kiểm tra PASS + fresh + scope ≥ required. TI-005: không có shortcut.

### 4.5 P1.5-SE1 — StructuredOutputValidator + PromptBoundary

**Mục tiêu:** model output phải qua schema validation trước khi thành proposal (SE-010/003).
Untrusted content phải được marked (SE-001/002).

```
agent-core/src/security/
  structured-output-validator.ts   ← validateModelOutput(raw, schema) → ValidatedOutput | ValidationFailure
  prompt-boundary.ts               ← markUntrusted(content) + buildPrompt(system, task, untrustedItems)
  env-guard.ts                     ← filterEnv(env, policy) → SafeEnv (SE-004)
  index.ts
```

**Key design:**
- `validateModelOutput`: JSON parse → JSON Schema validate → semantic checks → typed output or failure code.
- `markUntrusted`: wrap content với trust marker; untrusted block không bao giờ vào system prompt.
- `filterEnv`: allowlist + denylist prefixes; returns filtered env safe to pass to subprocess.

### 4.6 P1.5-DB2 — Schema migration v2

**Mục tiêu:** persistent tables cho `tool_calls`, `approvals`, `failures`, `recovery_actions`.

```
infrastructure/src/sqlite/migrations/
  0002-tool-gateway.ts   ← tool_calls + approvals + failures + recovery_actions
```

Nguyên tắc: additive-only. Migration v1 không bị sửa. Foreign keys đến `sessions(session_id)` và `tasks(task_id)`.

### 4.7 P1.5-I1 — VerificationEngine E2E

Task lifecycle với verification thật: TaskRun SUCCEEDED → VerificationEngine chạy checks qua FakeProcessSupervisor → report PASS fresh → CompletionGate passes → Task PASSED. Verify TI-005 bị enforce: nếu không có report → PASSED bị block.

### 4.8 P1.5-I2 — ToolGateway E2E

Tool call lifecycle: model proposes call → ToolGateway classify risk → policy auto-approve READ_ONLY / require_approval MODIFY_WORKSPACE → ApprovalEngine approve/deny → execute qua FakeProcessSupervisor → SUCCEEDED/DENIED. Verify TG-001/005: DENIED không execute, forge-proof (HI-001/002).

### 4.9 P1.5-I3 — Adversarial Security E2E

- MaliciousVerifier: claim PASS without running checks → CompletionGate reject (TI-005).
- PromptInjection: instruction trong README được marked untrusted → không tạo được state change (SE-001/002).
- MaliciousToolProposal: `rm -rf /` → DENIED (TG-007/SE-009); path traversal → PATH_ESCAPE (WS-003).
- Structured output invalid: parse fail → `MODEL_OUTPUT_INVALID`, không retry vô hạn.

---

## 5. Timeline (5 tuần)

```
Tuần 1 — Foundation
  P1.5-PS1  ProcessSupervisor (contract + Node impl + FakeProcessSupervisor)  [2 ngày]
  P1.5-DB2  Schema migration v2 (tool_calls, approvals, failures)              [1 ngày]
  P1.5-SE1  StructuredOutputValidator + PromptBoundary + EnvGuard              [2 ngày]

Tuần 2 — ToolGateway
  P1.5-TG1  ToolGateway + ToolPolicy + ToolCallStateMachine                    [3 ngày]
  P1.5-TG2  ApprovalEngine (binding, forge-proof)                              [2 ngày]

Tuần 3 — VerificationEngine
  P1.5-VR1  VerificationEngine core (pipeline, scope, affected set, freshness) [3 ngày]
  P1.5-VR2  CompletionGate + extend TaskStateMachine (TI-005 fully wired)      [2 ngày]

Tuần 4 — Integration E2E
  P1.5-I1   VerificationEngine E2E                                             [1 ngày]
  P1.5-I2   ToolGateway E2E                                                    [1 ngày]
  P1.5-I3   Adversarial Security E2E                                           [2 ngày]
  —         Buffer / fix                                                        [1 ngày]

Tuần 5 — Sign-off
  —         PHASE_1_5_SIGNOFF.md                                               [1 ngày]
  —         CI xanh + docs update                                               [1 ngày]
```

---

## 6. Salvage từ `ollama-code-chat` (PHASE_1_ROADMAP §6.1)

| File cũ | → Component 1.5 | Ghi chú |
|---|---|---|
| `verify/errorParsers.ts` | `VerificationEngine` error parsing | Lift: pure string→ErrorLocation[]. Pattern cho tsc/dart/gcc/eslint. |
| `verify/layeredVerifier.ts` + `runStep.ts` + `presets.ts` | `VerificationEngine` pipeline | Học: layer approach + preset. Viết lại để match VR-* invariants + ProcessSupervisor. |
| `runtime/completionGuard.ts` | `CompletionGate` | Học: anti-fabrication + verify-reminder. Viết lại để enforce TI-005 thật (cần real VR report). |
| `safeCommands.ts` | `ToolPolicy` | Lift `isSafeReadCommand` + `detectBlockingCommand`. Bổ sung RiskClass mapping + 8-tier system. |

---

## 7. Exit criteria Phase 1.5

1. Tất cả component §4 implemented.
2. **29 invariant CRITICAL Phase 1.5** pass.
3. TI-005 được enforce thật: task CANNOT transition VERIFYING→PASSED không có VerificationReport PASS fresh.
4. E2E P1.5-I1 (VerificationEngine lifecycle) pass.
5. E2E P1.5-I2 (ToolGateway lifecycle) pass.
6. E2E P1.5-I3 (adversarial security) pass.
7. ProcessSupervisor timeout và tree-kill hoạt động trên Windows + WSL2.
8. Không TypeScript error / ESLint error / dependency-cruiser violation.
9. CI green trên 2 OS.
10. `PHASE_1_5_SIGNOFF.md` được tạo.

---

## 8. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Process kill trên Windows (job objects) | Cao | Cao | Test P1.5-PS1 trên Windows trước; fallback taskkill |
| Affected set heuristic (regex import) | Trung bình | Trung bình | Phase 1.5 dùng AFFECTED_DIRECT làm baseline; closure là bonus |
| ApprovalEngine binding race (concurrent) | Thấp | Cao | Atomic SQLite insert; test với concurrent requests |
| StructuredOutputValidator quá strict | Trung bình | Trung bình | Bắt đầu với JSON parse + required fields; add schema sau |
| FakeProcessSupervisor không cover edge cases | Thấp | Trung bình | E2E dùng cả real NodeProcessSupervisor với timeout ngắn |

---

## 9. Những gì Phase 1.5 KHÔNG làm

- Không có Ollama adapter thật (Phase 2).
- Không có ContextSnapshot builder (Phase 2).
- Không có NetworkPolicy enforcement (LOW priority, Phase 2).
- Không có ArtifactStore trên disk (Phase 1.5 dùng in-memory stub; Phase 3).
- Không có VS Code UI cho approval (Phase 3).
- Không có Planner / Replanner / FailureAnalyzer với LLM thật (Phase 2/5).
- Không có RecoveryEngine (Phase 5).
- Affected set closure với Tree-sitter / LSP (Phase 6).
