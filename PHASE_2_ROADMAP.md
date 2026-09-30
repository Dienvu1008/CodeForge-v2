# PHASE_2_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 2 (ModelGateway + ContextBuilder + Planning)**

Version: 1.0
Status: Working plan
Owner: Intelligence Plane / Model + Context + Planning
Scope: Kết nối LLM thật lần đầu. Ollama adapter, ContextBuilder với provenance,
       và Planning pipeline (Planner → PlanValidator → PlanCritic → GraphCommit).
Related:
`PHASE_1_5_SIGNOFF.md`, `PHASE_1_5_ROADMAP.md`, `INVARIANTS.md`, `invariants.yaml`,
`CONTEXT_SPEC.md`, `Coding Agent Architecture Target.md`, `DOMAIN_CONTRACTS.md`,
`SECURITY_MODEL.md`

---

## 0. Nguyên tắc Phase 2

> **Phase 1.5 bàn giao runtime SAFE. Phase 2 bàn giao Intelligence Layer đầu tiên:
> LLM thật, context có provenance, planning thật — nhưng runtime vẫn là authority.**

Ba luật:

1. **Mọi LLM call qua ModelGateway** (MG-001). Không component nào gọi Ollama trực tiếp.
2. **Context có provenance** (CX-002/CX-003). Mỗi item biết nguồn gốc và trust level.
3. **Model proposes, runtime decides** — Planner đề xuất plan nhưng GraphValidator + GraphCommit quyết định.

North Star: *Phase 2 xong khi một session thật chạy với Ollama, ContextBuilder tạo snapshot có
provenance đúng, Planner tạo plan qua ModelGateway và plan được committed qua GraphCommit.
Output LLM được validate trước khi thành proposal.*

---

## 1. Con số Phase 2 (đo từ `invariants.yaml`, lọc `phase == 2`)

**13 invariant** có `phase: 2`, trong đó **6 CRITICAL** + **7 HIGH**.

Phân bố CRITICAL:

| Nhóm | # CRITICAL | IDs |
|---|---|---|
| ModelGateway (MG) | 4 | MG-001, MG-002, MG-003, MG-006 |
| Context (CX) | 2 | CX-003, CX-005 |
| **Tổng** | **6** | — |

HIGH (7): MG-004, MG-005, CX-001, CX-002, CX-004, CX-006, PR-002.

**KHÔNG thuộc Phase 2** (để Phase 3+):
- TG-006/008 (tool idempotency/provenance) — Phase 3 khi real tool execution
- RC-* (RecoveryEngine) — Phase 5
- Symbol/LSP retrieval (CX-002 full) — Phase 6
- SE-006 (NetworkPolicy) — Phase 3

---

## 2. Scope Phase 2

### 2.1 In-scope

| Component | Invariants chính |
|---|---|
| OllamaModelGateway (infra adapter) | MG-001 |
| StructuredOutputParser (model output pipeline) | MG-002, MG-003, MG-006 |
| Schema migration v3 (context tables) | CP-001, CP-007 |
| ContextBuilder + pipeline | CX-001..006, PR-002 |
| Retriever (diff-based baseline, §4.2 CONTEXT_SPEC) | CX-002, CX-006 |
| TokenBudgeter | CX-004 |
| TrustMarker | CX-003 |
| ProvenanceTracker | CX-002, PR-002 |
| SqliteContextRepository | CP-001 |
| Planner (LLM → GraphMutation via ModelGateway) | MG-001/002 + GI-001..009 |
| PlanValidator (deterministic, reuse GraphValidator) | GI-002..007 |
| PlanCritic (LLM, advisory only) | MG-001/002 |
| Integration E2E P2-I1 (planning lifecycle) | all of above |

### 2.2 Out-of-scope (Phase 2)

- Replanner (Phase 5 — dùng sau RecoveryEngine thành thục)
- FailureAnalyzer (Phase 5)
- RecoveryEngine (Phase 5)
- Tree-sitter / LSP retrieval (Phase 6)
- ArtifactStore on disk (Phase 3)
- VS Code UI (Phase 3)
- NetworkPolicy enforcement (Phase 3)
- LLM summarization via Compactor (Phase 2 scope: basic truncation only)

---

## 3. Kiến trúc những gì đã có (Phase 1.5 baseline)

### 3.1 Đã có — dùng ngay

| Thứ | Location |
|---|---|
| `ModelGateway` interface + `ModelRequest/Response` | `agent-core/src/model/gateway.ts` |
| `FakeModel` (test double) | `packages/testing/src/fake-model/` |
| `StructuredOutputValidator` (SE-010/003) | `agent-core/src/security/structured-output-validator.ts` |
| `PromptBoundary` (SE-001/002) | `agent-core/src/security/prompt-boundary.ts` |
| `EnvGuard` | `agent-core/src/security/env-guard.ts` |
| `GraphCommitService` + `GraphValidator` | `agent-core/src/graph/` |
| `TaskService` + `GraphService` | `agent-core/src/task/`, `agent-core/src/graph/` |
| `EventLog`, `VerificationRepository`, `SqliteVerificationRepository` | infra |
| `WorkspaceRevision` + `isFresh` | `agent-core/src/domain/workspace-revision.ts` |
| `ContextSnapshot`, `ContextItem`, `ContextSource` types | `agent-core/src/domain/context.ts` |
| `Provenance` type | `agent-core/src/domain/provenance.ts` |
| `Redactor` | `infrastructure/src/redaction/` |
| `ProcessSupervisor` (NodeProcessSupervisor) | `infrastructure/src/process/` |

### 3.2 Cần tạo mới (Phase 2)

| Component | Package | Phần cốt lõi |
|---|---|---|
| `OllamaModelGateway` | infrastructure | HTTP client → Ollama `/api/generate`, streaming, retry |
| `StructuredOutputParser` | agent-core | wrap validateModelOutput + retry loop + ModelError mapping |
| Schema migration v3 | infrastructure | `context_snapshots`, `context_items`, `context_provenance` tables |
| `SqliteContextRepository` | infrastructure | ContextSnapshot CRUD + ContextItem insert |
| `TokenCounter` | agent-core | heuristic token count (4 char ≈ 1 token; pure function) |
| `TrustMarker` | agent-core | assign TrustLevel per ContextSource kind |
| `ProvenanceTracker` | agent-core | build Provenance for each context item |
| `Retriever` (baseline) | agent-core | diff-based + task/goal/graph inject |
| `TokenBudgeter` | agent-core | fit items to budget, truncate, no silent drop (CX-004) |
| `ContextBuilder` | agent-core | orchestrate full pipeline → ContextSnapshot |
| `Planner` | agent-core | ModelGateway.generate → parse → GraphMutation proposal |
| `PlanValidator` | agent-core | thin wrapper over existing GraphValidator |
| `PlanCritic` | agent-core | ModelGateway.generate → critique (advisory, no commit authority) |
| `FakeOllamaGateway` | packages/testing | FakeModel-based, same interface as OllamaModelGateway |

---

## 4. Component breakdown

### 4.1 P2-MG1 — OllamaModelGateway (infra)

**Mục tiêu:** HTTP adapter gọi Ollama `/api/generate` (non-streaming) + `/api/chat` (streaming Phase 3).
Enforces: MG-001 (mọi call qua gateway), MG-004 (model identity/version vào provenance), MG-005 (timeout → ModelError).

```
infrastructure/src/model/
  ollama-gateway.ts    ← OllamaModelGateway implements ModelGateway
  index.ts
```

**Key design:**
- Dùng Node `fetch` (built-in Node 18+/20).
- Timeout bắt buộc (SE-007 spirit): throw `ModelError('MODEL_TIMEOUT')` khi vượt.
- Trả về `ModelResponse.raw` — raw string, chưa parse. Caller phải validate.
- Không bao giờ trả về structured result trực tiếp (MG-006: model output không phải authority).
- Model identity (name/version/endpoint) ghi vào response.

### 4.2 P2-MG2 — StructuredOutputParser (agent-core)

**Mục tiêu:** wrap `validateModelOutput` + bounded retry loop (MG-003: max 2 retries).
Enforces: MG-002 (structured validation), MG-003 (bounded retry), MG-006 (output không authority).

```
agent-core/src/model/
  structured-output-parser.ts
  index.ts  (re-export)
```

**Key design:**
- `parseModelOutput<T>(raw, schema, semanticCheck?)`: validate → T or throw `ModelError('MODEL_OUTPUT_INVALID')`.
- Retry loop: `MAX_OUTPUT_RETRIES = 2`, retry chỉ khi `error.retryable = true`.
- Non-retryable (INJECTION_ATTEMPT) → throw ngay.
- TIMEOUT/UNAVAILABLE → throw, không retry.

### 4.3 P2-DB3 — Schema migration v3

**Mục tiêu:** tables cho `context_snapshots`, `context_items`, `context_provenance`.
Schema đã được thiết kế ở `CONTEXT_SPEC §12.1`.

```
infrastructure/src/sqlite/migrations/
  0003-context-tables.ts
```

Additive-only. Migration v1/v2 không bị sửa.

### 4.4 P2-CX1 — ContextBuilder pipeline

**Mục tiêu:** orchestrate full context pipeline → ContextSnapshot. Enforces: CX-001..006, PR-002.

```
agent-core/src/context/
  token-counter.ts         ← pure: countTokens(text) heuristic
  trust-marker.ts          ← pure: assignTrust(source) → TrustLevel
  provenance-tracker.ts    ← build Provenance per item
  retriever.ts             ← baseline: diff + task/goal inject
  token-budgeter.ts        ← fit items, truncate non-pinned (CX-004)
  context-builder.ts       ← orchestrate pipeline → ContextSnapshot
  index.ts
```

**Key design:**
- `Retriever.retrieve(request)`: task/goal/graph items direct-inject (pinned); workspace files từ revision diff.
- `TrustMarker`: workspace_file/artifact/log → `untrusted`; task/goal/policy → `trusted`.
- `TokenBudgeter`: sort by (pinned desc, priority desc) → fill → truncate nếu cần → throw `CONTEXT_BUDGET_EXCEEDED` nếu pinned overflow.
- `ContextBuilder.build(request)`: Retriever → TrustMarker → TokenBudgeter → ProvenanceTracker → ContextSnapshot. Snapshot immutable sau commit (CX-001).
- Mỗi item có `provenance` bắt buộc (CX-002). No anonymous context.
- Untrusted items wrapped với `<untrusted>` khi render sang prompt (CX-003, dùng PromptBoundary).

### 4.5 P2-PL1 — Planner

**Mục tiêu:** Goal + Graph → GraphMutation via ModelGateway. Enforces: MG-001/002/006, GI-002/009.

```
agent-core/src/planning/
  planner.ts        ← Planner service
  plan-validator.ts ← thin wrapper over GraphValidator
  plan-critic.ts    ← PlanCritic (advisory, no commit)
  index.ts
```

**Key design:**
- `Planner.plan(session, goal, graph)`:
  1. `ContextBuilder.build(...)` → ContextSnapshot
  2. Build prompt với snapshot (PromptBoundary)
  3. `ModelGateway.generate(request)` → raw
  4. `StructuredOutputParser.parseModelOutput(raw, PLAN_SCHEMA)` → parsed plan
  5. Translate parsed plan → `GraphMutation[]` (runtime builds the mutation, not LLM directly — GI-009)
  6. Return mutations (caller then calls `GraphCommitService.commit`)
- `PlanValidator`: reuse `validateMutation` từ `graph/validator.ts`. Deterministic.
- `PlanCritic`: optional advisory call to model. Returns critique text only — no commit authority.
- LLM **không tự commit graph** (GI-009). Runtime translates output → mutation → GraphCommit.

### 4.6 P2-I1 — Integration E2E

Session thật với Ollama: Goal → ContextBuilder → Planner → GraphCommit → Scheduler picks task.
Chạy với real Ollama (nếu có) hoặc FakeModel (CI). Verify MG-001 (mọi call qua gateway), CX-003 (trust marking), GI-009 (LLM không mutate graph trực tiếp).

---

## 5. Timeline (4 tuần)

```
Tuần 1 — ModelGateway + StructuredOutputParser
  P2-MG1  OllamaModelGateway (Ollama HTTP adapter)            [2 ngày]
  P2-MG2  StructuredOutputParser (bounded retry + mapping)    [1 ngày]
  P2-DB3  Schema migration v3 (context tables)                [1 ngày]

Tuần 2 — ContextBuilder pipeline
  P2-CX1  TokenCounter + TrustMarker + ProvenanceTracker      [2 ngày]
  P2-CX1  Retriever (baseline) + TokenBudgeter                [2 ngày]
  P2-CX1  ContextBuilder orchestrator                         [1 ngày]

Tuần 3 — Planning
  P2-PL1  Planner + PlanValidator + PlanCritic                [3 ngày]
  P2-PL1  PLAN_SCHEMA + output translation (mutation builder) [2 ngày]

Tuần 4 — Integration + Sign-off
  P2-I1   Planning E2E (FakeModel + real Ollama optional)     [2 ngày]
  —       Buffer / fix                                        [1 ngày]
  —       PHASE_2_SIGNOFF.md                                  [1 ngày]
```

---

## 6. Salvage từ `ollama-code-chat` (PHASE_1_ROADMAP §6.1)

| File cũ | → Component Phase 2 | Ghi chú |
|---|---|---|
| `ollamaClient.ts` | `OllamaModelGateway` | Giữ shape message/tool. HTTP client logic. |
| `runtime/completionGuard.ts` | `PlanValidator` / `StructuredOutputParser` | Pattern "never trust raw LLM output". |

---

## 7. Dependency từ Phase 1.5 (đã sẵn sàng)

- `StructuredOutputValidator` → dùng trong `StructuredOutputParser` (đã có SE1)
- `PromptBoundary.buildPrompt()` → dùng trong `Planner` (đã có SE1)
- `GraphCommitService.commit()` → dùng sau `Planner.plan()` (đã có P1-G3)
- `GraphValidator.validateMutation()` → dùng trong `PlanValidator` (đã có P1-G2)
- `FakeProcessSupervisor`, `FakeRevisionProvider` → testing infra (đã có)
- `ProcessSupervisor` → `OllamaModelGateway` dùng timeout pattern tương tự (đã có PS1)

---

## 8. Exit criteria Phase 2

1. Tất cả component §4 implemented.
2. **6 invariant CRITICAL Phase 2** pass.
3. MG-001: mọi LLM call qua `ModelGateway` — không component nào import Ollama HTTP trực tiếp (depcruise enforce).
4. MG-002/003: structured output + bounded retry đã test.
5. CX-003: mọi workspace content trong context được đánh dấu untrusted.
6. CX-005: ContextSnapshot không phải runtime authority (plan cần qua GraphValidator).
7. E2E P2-I1 (planning lifecycle với FakeModel) pass.
8. Không TypeScript error / ESLint error / dependency-cruiser violation.
9. CI green trên 2 OS.
10. `PHASE_2_SIGNOFF.md` được tạo.

---

## 9. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Ollama API thay đổi | Thấp | Trung bình | Pin version; interface isolation tốt |
| PLAN_SCHEMA quá cứng | Trung bình | Cao | Schema đủ loose, semantic check xử lý phần còn lại |
| Token count heuristic sai | Trung bình | Thấp | Conservative estimate; truncation rõ ràng |
| ContextBuilder phức tạp | Trung bình | Trung bình | Phase 2 chỉ cần baseline (diff-based, no LSP) |
| Planner output unpredictable | Cao | Trung bình | FakeModel luôn deterministic cho CI; real Ollama test optional |

---

## 10. Những gì Phase 2 KHÔNG làm

- Không có Replanner (Phase 5 — dùng sau khi RecoveryEngine ổn).
- Không có FailureAnalyzer LLM (Phase 5).
- Không có RecoveryEngine (Phase 5).
- Không có Tree-sitter / symbol-level retrieval (Phase 6).
- Không có streaming LLM responses (Phase 3).
- Không có VS Code UI (Phase 3).
- Không có ArtifactStore on disk (Phase 3).
- Không có LLM summarization trong Compactor (Phase 3).
