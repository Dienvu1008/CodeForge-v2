# PHASE_9_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 9 (Observability / Control / Dogfood)**

Version: 1.0
Status: Working plan
Owner: Control Plane / Observability Layer
Scope: Làm cho agent hiện có **quan sát được, điều khiển được, debug được, vận hành
       từ xa được, và dùng được qua VS Code** — TRƯỚC khi mở rộng trí tuệ. Mọi thứ là
       **read-only projection + command adapter trên kernel hiện tại, tuyệt đối không
       tạo authority thứ hai, không bypass.** Các năng lực intelligence/memory/research/
       self-model được hoãn tường minh sang Phase 10+.
Related:
`PHASE_8_SIGNOFF.md`, `.agents/phase09-audit/phase09-readiness-findings.md`,
`Coding Agent Architecture Target`, `EVALUATION_MODEL`, `STATE_MACHINE_SPEC`,
`INFRASTRUCTURE_SPEC §14 (VscodeBridge)`, `DOMAIN_CONTRACTS §18 (DomainEvent)`,
`INVARIANTS.md §3.19 (OB)`.

---

## 0. Nguyên tắc Phase 9

> **Phase 7 cho agent trí nhớ. Phase 8 cho agent làm nhiều việc song song. Phase 9
> KHÔNG làm agent thông minh hơn — nó làm agent QUAN SÁT ĐƯỢC và ĐIỀU KHIỂN ĐƯỢC,
> để các cải tiến trí tuệ về sau có thể được đánh giá bằng chứng cứ.**

Luật tối cao (master prompt §2, §30):

> Dashboard / Telegram / VS Code / CLI / projection / event bus / context manager
> KHÔNG được trở thành authority chỉ vì chúng tiện hoặc "thông minh" hơn. Authority
> vẫn là: `Policy`, `ToolGateway`, `TaskGraph`, `GraphCommit`, `VerificationEngine`,
> `CompletionGate`, `WorkspaceRevision`, `Budget`, `Approval`, `StateMachine`,
> `Checkpoint`, `EventLog`, `Provenance`.

Năm luật Phase 9:

1. **Observe, don't own.** Mọi projection/trace/telemetry là **suy ra** từ state
   authoritative + EventLog. Dashboard KHÔNG phải nguồn chân lý; không có đường ghi
   nào từ UI vào bảng authoritative (OB-005).
2. **One control path.** `/pause` của Telegram và nút "Pause" của dashboard phải là
   **cùng một** `ControlRequest`, cùng đi qua `ControlPlane.admit()` → Policy →
   method kernel sẵn có. Không có authority riêng cho từng UI (OB-006).
3. **No chain-of-thought.** Activity trace phơi bày *hoạt động + chứng cứ có cấu trúc*
   (objective / action / decision-category / evidence / result), KHÔNG phải reasoning
   trace thô; không rò secret (dựa trên redaction PR-003/PR-004 đã có) (OB-007).
4. **Authoritative state is reconstructable.** Continuation/rollover summary là
   **non-authoritative**; session kế tiếp nạp lại state từ SQLite và validate, không
   bao giờ để summary ghi đè state (OB-008).
5. **Adapter chạm I/O, core thuần.** Server HTTP/SSE, Telegram, VS Code bridge nằm ở
   `infrastructure` (hoặc package adapter mới), phụ thuộc một chiều vào kernel; logic
   suy diễn (projection, telemetry, trace, control-admission) là **pure** trong
   `agent-core`. `agent-core ↛ infrastructure` (DC-001/002, depcruise canh).

North Star: *Có thể mở dashboard/Telegram/VS Code, thấy chính xác agent đang làm gì
và vì sao, can thiệp an toàn từ xa, và đo được hành vi tự chủ — mà không một invariant
nào của Phase 0–8 bị nới.*

---

## 1. Con số Phase 9

Baseline (sau Phase 8): `invariants.yaml` v1.3, **158 invariant**, nhóm `OB` có **4**
(OB-001..004). Phase 9 thêm một nhóm invariant Observability/Control mở rộng và khai
báo vào `invariants.yaml` như task đầu phase (**P9-INV**), đúng thứ tự "invariants
trước code" (Architecture Target §59).

> **Lưu ý đặt tên:** schema yêu cầu prefix 2 chữ (`^[A-Z]{2}-[0-9]{3}$`). Mở rộng
> **nhóm `OB` hiện có** (OB-005..OB-010) thay vì tạo prefix mới — đây là observability.

Nhóm invariant đề xuất (chốt khi thêm vào `invariants.yaml`):

| ID (đề xuất) | Statement | Severity |
|---|---|---|
| OB-005 | Runtime projection / read-model không phải authority; không có đường ghi vào state authoritative. | CRITICAL |
| OB-006 | Mọi control request (pause/resume/cancel/approve/deny/retry/checkpoint) phải qua ControlPlane admission + Policy; UI không có authority riêng. | CRITICAL |
| OB-007 | Activity trace / observability chỉ phơi bày hoạt động + chứng cứ có cấu trúc đã redact; không reasoning thô, không secret. | CRITICAL |
| OB-008 | ContinuationManifest là non-authoritative; không được ghi đè state authoritative; session kế tiếp phải nạp lại từ nguồn authoritative. | CRITICAL |
| OB-009 | Live event tailer chỉ đọc EventLog đã persist (tail theo sequenceNumber); không phải đường ghi thứ hai (giữ CP-001/CP-008/OB-001). | HIGH |
| OB-010 | Context telemetry là suy diễn từ ContextSnapshot/EventLog; không điều khiển việc chọn context (không authority context). | HIGH |

Các invariant đã có được Phase 9 làm giàu (không thêm mới): OB-001 (mọi transition
phát event), OB-002/003 (tool/verification event), OB-004 (EventLog queryable),
CP-001/CP-008 (event+state cùng transaction, sequence đơn điệu), PR-003/PR-004
(append-only + redaction), HI-001..003 (approval binding, override), SS-* / SM-*
(state machine là authority chuyển trạng thái), TG-001/005 (mọi tool qua gateway).

---

## 2. Scope Phase 9

### 2.1 In-scope (v1 — observe → control → dogfood)

| Component | Mục tiêu | Enforces |
|---|---|---|
| P9-INV | Nhóm OB-005..010 vào `invariants.yaml` + test | OB-* |
| P9.1 `ObservabilityEvent` | Mở rộng vocabulary event + trường quan sát (correlationId/parentEventId/severity/visibility ở mức payload) + *thực sự phát* các event lifecycle đang thiếu | OB-001..004 |
| P9.2 `RuntimeProjection` + `ContextTelemetry` | Pure reducer: repos + EventLog → read-model DTO; rollup context theo kind + pressure | OB-005/010 |
| P9.7 `ControlPlane` + `ControlRequest` + `PAUSED` | Admission thống nhất cho control; thêm state PAUSED + control-poll hợp tác trong orchestrator loop | OB-006 |
| P9.4 `ActivityTrace` | View suy diễn (objective/action/decision-category/evidence) — không CoT | OB-007 |
| P9.5 Context observability | Bề mặt đọc telemetry context (per-category %, pressure, discarded) | OB-010 |
| P9.9 `InterventionRecord` | Bản ghi can thiệp thống nhất (control + approval): who/what/when/why/target/result | OB-006 |
| P9.3 `ObservabilityServer` + Dashboard | HTTP + SSE read server (infra) + web client; đọc projection, control qua ControlPlane | OB-005/006/009 |
| P9.10 Replay / Audit | Timeline/audit builder trên EventLog | OB-004/007 |
| P9.8 Telegram adapter | Remote control + notification; chỉ phát ControlRequest | OB-006 |
| P9.6 `ContinuationManifest` | Manifest non-authoritative + bootstrap nạp lại từ authoritative | OB-008 |
| P9.11 VS Code extension + `.vsix` | Thin client qua VscodeBridge (INFRASTRUCTURE_SPEC §14); approval UI qua runtime | OB-006 |
| P9.12 Dogfood mode | Dùng CodeForge làm việc thật + thu metrics | tất cả Phase-9 |

### 2.2 Out-of-scope (hoãn tường minh, kèm lý do)

| Năng lực | Vì sao hoãn |
|---|---|
| Intelligence Plane (DecisionKernel/ModelRouter/WorkerRegistry) | Phase 10; cần observability trước để đánh giá empiric (§18). |
| Engineering Memory / External Knowledge / Solution Discovery | Phase 11+; là evidence, không authority — chưa đo được giá trị (§19–21). |
| Self Model / Self-Gap / Self-Benchmark / Continuous Learning | Phase 12+; chỉ an toàn khi hành vi đã quan sát + benchmark độc lập được (§24–29). |
| Context **compaction engine** (thuật toán nén thật) | Phase 9 chỉ *đo* pressure + chuẩn bị `ContinuationManifest`; engine nén để sau khi đã có telemetry (§33: không tối ưu cái chưa đo được). Data field `compactionMethod`/`compaction_method` đã có sẵn hook. |
| Neural embedding | Đã hoãn từ Phase 7 (probe-backed). |

Mọi mục hoãn, khi làm, vẫn tuân §0 (observe/own tách bạch, không authority thứ hai).

---

## 3. Kiến trúc những gì đã có (từ audit)

### 3.1 Đã có — dùng ngay (IMPLEMENTED)

| Thứ | Location | Ghi chú |
|---|---|---|
| `DomainEvent` + `EventLog` contract | `agent-core/src/domain/event.ts`, `repositories/index.ts` | eventId/sessionId/type/aggregate/payload/provenance/at/sequenceNumber; append/stream/query |
| `SqliteEventLog` | `infrastructure/src/event-log/sqlite-event-log.ts` | append-only, sequence do adapter cấp (CP-008), redact trước persist (PR-003), order tất định |
| Redactor | `infrastructure/src/redaction/redactor.ts` | `redactJson` — nền cho "no secret" của trace |
| Repos đọc được | `repositories/index.ts` | Session/TaskExecution/TaskRun(`findRunning`)/TaskGraph(`getCurrent`)/Budget/Verification/Failure/Recovery |
| Control services (direct) | `session/session-service.ts` (`transition`), `tool/tool-gateway.ts` (`approve/deny`), `tool/approval-engine.ts` (`createApproval`) | authority đã có + gated bởi state machine |
| Context token accounting | `context/token-counter.ts`, `context/token-budgeter.ts`, `domain/context.ts` | `countTokens`, `fitToBudget` → `tokenUsed/dropped`; `ContextSnapshot.tokenBudget/tokenUsed/items[]` |
| Migration framework | `infrastructure/src/sqlite/migrations/*` (0001–0005, v5) | additive-only; `events` table từ 0001 |
| OB-001..004 | `INVARIANTS.md §3.19`, test ở `tests/infrastructure/event-log/event-log.spec.ts` | observability nền |
| `VscodeBridge` contract (spec) | `INFRASTRUCTURE_SPEC §14` | ROADMAP_ONLY — tái dùng shape cho P9.11 |

### 3.2 Cần tạo mới (Phase 9)

| Component | Package | Phần cốt lõi |
|---|---|---|
| OB-005..010 | invariants.yaml + tests | nhóm mở rộng |
| Event vocabulary + emit lifecycle thiếu | agent-core | thêm type + phát `CONTEXT_*`/`FILE_*`/`TEST_*`/`BUDGET_WARNING`/`GRAPH_MUTATION_*` v.v. đang khai báo-mà-chưa-emit |
| `RuntimeProjection` / `ContextTelemetry` / `ActivityTrace` / `ControlPlane` | agent-core (pure) | reducer/rollup/admission — không I/O |
| `PAUSED` state + control-poll | agent-core | state machine row mới + hook poll trong orchestrator loop |
| `ContinuationManifest` builder | agent-core (pure) | manifest + validate references |
| Event tailer, `ObservabilityServer` (HTTP+SSE), Telegram, VS Code bridge | infrastructure / adapter package mới | chạm I/O; đọc projection + phát ControlRequest |
| Migration 0006 `control_requests` | infrastructure | audit admission (additive) |

Nguyên tắc decoupling giữ như Phase 6/7/8: `agent-core` không phụ thuộc
`infrastructure`; phần chạm I/O nằm sau interface, feed plain data.

---

## 4. Component breakdown

### 4.1 P9-INV — Observability/Control invariants
Thêm OB-005..010 (§1) vào `invariants.yaml` (`phase: 9`) + test
`tests/invariants/observability/ob-00x.spec.ts` (folder MỚI). Làm **đầu tiên**.
Bump `invariants.yaml` **và** `INVARIANTS.md` cùng lúc (header + §3.19 bảng + §9 history)
— quy tắc đồng bộ version từ Phase 7.

### 4.2 P9.1 — ObservabilityEvent
Mở rộng `KnownEventType` với vocabulary vòng đời đang vô hình (context build/pressure,
file read/change/patch, test start/end, budget warning, graph mutation, session
rollover). Thêm trường quan sát ở mức **payload** (correlationId, parentEventId,
severity, visibility) — KHÔNG đổi shape `DomainEvent` cốt lõi (tránh breaking). *Thực
sự phát* các event đã khai báo mà chưa emit (ví dụ `GRAPH_MUTATION_COMMITTED`).

### 4.3 P9.2 — RuntimeProjection + ContextTelemetry
`RuntimeProjection`: pure reducer (repos DTO + events) → read-model trả lời Dashboard
A–E (§5 master prompt). Non-authoritative (OB-005). `ContextTelemetry`: pure rollup
`ContextSnapshot.items[]` theo `kind`/`source`, pressure = tokenUsed/tokenBudget,
discarded = dropped (OB-010).

### 4.4 P9.7 — ControlPlane + PAUSED + control-poll
`ControlRequest` (intent + target ids + stateVersion/argumentsHash khi áp dụng) →
`ControlPlane.admit()` → Policy → method kernel (`SessionService.transition`,
`ToolGateway.approve/deny`, `CheckpointService.capture`, recovery retry). Thêm state
`PAUSED` + transitions `RUNNING --PAUSE_REQUESTED--> PAUSED --RESUME_REQUESTED-->
RUNNING`. Thêm **control-poll hợp tác** trong `SessionOrchestrator.run()` (inject
`controlGate`, mặc định no-op → hành vi cũ không đổi, test cũ vẫn xanh).

### 4.5 P9.4 — ActivityTrace
View suy diễn từ event đã redact: objective / current action / decision category /
evidence refs / result / verification / next. Không CoT thô (OB-007).

### 4.6 P9.5 — Context observability
Bề mặt đọc `ContextTelemetry` (per-category %, pressure, largest contributors,
discarded, retrieval sources). Context là evidence, không authority.

### 4.7 P9.9 — InterventionRecord
Bản ghi thống nhất control + approval: who/what/when/why/target/state/policyVersion/
requestIdentity/result. Mọi can thiệp UI phải có record qua admission (OB-006).

### 4.8 P9.3 — ObservabilityServer + Dashboard
Infra: HTTP (`GET /state` projection, `GET /events` replay) + SSE (`/stream` live qua
event tailer). Web client render A–E (Agent State / Live Activity / Task Graph /
Evidence / Control). Control gửi ControlRequest, không ghi state trực tiếp.

### 4.9 P9.10 — Replay / Audit
Builder trên `EventLog.stream` → timeline Goal→…→Completion; trả lời "vì sao" bằng
Decision/ReasonCategory/Evidence/AuthorityPath/Expected↔Actual/Verification (OB-007).

### 4.10 P9.8 — Telegram adapter
Lệnh `/status /task /graph /log /pause /resume /cancel /approve /deny /retry
/checkpoint` → ControlRequest (OB-006). KHÔNG chạm SQLite/tool/Policy/Approval/Budget
trực tiếp. Giữ `taskRunId/sessionId/toolCallId/approvalRequestId/argumentsHash/
policyVersion/stateVersion` khi áp dụng.

### 4.11 P9.11 — VS Code extension + `.vsix`
Thin client qua `VscodeBridge` (INFRASTRUCTURE_SPEC §14): submit task, observe state/
activity/graph, approval request + approve/deny, pause/resume/cancel, verification,
changed files, errors, session history. CSP strict, không trust webview, approval UI
đầy đủ thông tin. `.vsix` là delivery, không phải kiến trúc mới. Runtime KHÔNG nhân bản
trong extension.

### 4.12 P9.12 — Dogfood mode + metrics
Dùng CodeForge làm việc thật (docs, bug fix nhỏ, refactor, test-gen, repo analysis).
Thu: task success/duration/model/provider/tokens/tool calls/context usage/compaction/
rollover/verification/failures/retries/recovery/human interventions/approval freq/
regressions. Nền empiric cho Phase 10+.

### 4.13 P9-I1 — Integration E2E
```
tests/integration/observability-control-e2e.spec.ts
```
Scenarios: (1) event → projection → dashboard-shaped read khớp authoritative; (2)
ControlRequest dạng dashboard & telegram → ControlPlane → pause/resume/cancel session
đang chạy (ngữ nghĩa như nhau); (3) approve/deny tool call thật từ xa; (4) replay dựng
lại timeline giống hệt; (5) projection consumer KHÔNG ghi được state (adversarial).

---

## 5. Timeline (ước lượng)

```
Tuần 1 — Invariants + đọc + điều khiển
  P9-INV   OB-005..010 vào invariants.yaml + test                 [1 ngày]
  P9.1     Event vocabulary + emit lifecycle thiếu                [2 ngày]
  P9.2     RuntimeProjection + ContextTelemetry (pure)            [2 ngày]
  P9.7     ControlPlane + PAUSED + control-poll                   [3 ngày]

Tuần 2 — Bề mặt + từ xa
  P9.4/9.5/9.9  ActivityTrace / Context surface / Intervention    [3 ngày]
  P9.3     ObservabilityServer + Dashboard                        [3 ngày]
  P9.10    Replay / Audit                                         [1 ngày]

Tuần 3 — Remote + continuation + dogfood
  P9.8     Telegram adapter                                       [2 ngày]
  P9.6     ContinuationManifest + bootstrap                       [1 ngày]
  P9.11    VS Code extension + .vsix                              [3 ngày]
  P9-I1    Integration E2E                                        [1 ngày]
  P9.12    Dogfood + metrics                                      [liên tục]
  —        PHASE_9_SIGNOFF.md                                     [1 ngày]
```

---

## 6. Exit criteria Phase 9 (map theo master prompt §16)

1. OB-005..010 khai báo trong `invariants.yaml` + test `tests/invariants/observability/`.
2. Runtime events quan sát được (live qua SSE + lịch sử qua `EventLog.query`).
3. Dashboard phản ánh đúng state authoritative qua `RuntimeProjection`.
4. **Dashboard KHÔNG trở thành authority** (test adversarial: consumer không ghi được).
5. Telegram quan sát được runtime.
6. Control của Telegram đi qua ControlPlane (dashboard `Pause` ≡ telegram `/pause`).
7. Approval flow hoạt động từ xa (approve/deny tool call thật).
8. State task/session/task-run quan sát được.
9. Activity trace có sẵn (không CoT).
10. Chứng cứ verification hiển thị được.
11. Context usage đo được (per-category %, pressure).
12. Failure/recovery quan sát được.
13. Replay/audit đủ dùng.
14. ≥ vài task dogfood thật đã hoàn thành.
15. Metrics đã thu.
16. Toàn bộ test Phase 0–8 vẫn xanh.
17. Test invariant/adversarial mới pass.
18. Không ranh giới governance nào bị nới (depcruise `agent-core ↛ infrastructure`;
    OB-005/006 giữ projection/control không thành authority).
19. `PHASE_9_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Dashboard/UI âm thầm thành nguồn chân lý | Trung bình | Rất cao | Projection read-only (OB-005); không export đường ghi; adversarial test |
| UI tạo authority riêng (telegram bypass Policy) | Trung bình | Rất cao | Mọi mutation là ControlRequest qua `ControlPlane.admit` → Policy (OB-006) |
| Event bus thành đường ghi thứ hai | Thấp | Cao | Tailer chỉ đọc log đã persist theo sequenceNumber (OB-009); không ghi |
| Rò CoT/secret qua trace | Thấp | Cao | Trace suy từ event đã redact; không log reasoning thô (OB-007) |
| Pause/cancel không phản hồi giữa run | Cao (hiện trạng) | Cao | Thêm PAUSED + control-poll hợp tác trong loop (P9.7) |
| Continuation summary ghi đè state | Thấp | Rất cao | Manifest non-authoritative; nạp lại từ SQLite + validate (OB-008) |
| `agent-core` lỡ phụ thuộc infra/adapter | Thấp | Cao | Pure-data pattern; depcruise canh; adapter ở package riêng |

---

## 8. Những gì Phase 9 KHÔNG làm (và vì sao)

- **Không tăng trí tuệ.** Không DecisionKernel/ModelRouter/Worker/memory mới — Phase 10+.
- **Không engine nén context thật** — chỉ đo pressure + chuẩn bị ContinuationManifest.
- **Không self-model/benchmark/training** — cần observability + benchmark độc lập trước.
- **Không authority mới cho bất kỳ UI nào** — observe/command-only, luôn qua kernel.

Tất cả, khi làm ở phase sau, vẫn phải tuân §0 — observability không bao giờ là lý do
để một UI tự quyết thay kernel.

---

## Phụ lục A — Forward-compatible + nguyên tắc an toàn

- **Observe/Own tách bạch.** Mọi năng lực Phase 9 hoặc là *đọc* (projection/trace/
  telemetry/replay) hoặc là *đề nghị lệnh* (ControlRequest). Không component nào vừa
  quan sát vừa nắm authority.
- **Một control path.** Thêm UI = thêm adapter phát ControlRequest, không thêm đường
  tới kernel. Dashboard/Telegram/VS Code/CLI hội tụ ở `ControlPlane`.
- **Observability là tiền đề của evolution.** Phase 9 tạo substrate đo lường để Phase
  10+ (intelligence/self-improvement) có thể đánh giá bằng chứng cứ, không phải bằng
  lời LLM tự nhận (master prompt §24, §33).
- **Thứ tự thực hiện:** P9-INV trước tiên (invariants trước code, §59); rồi
  observe → control → surface → remote → dogfood.
