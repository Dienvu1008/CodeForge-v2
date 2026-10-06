# PHASE_8_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 8 (Advanced Autonomy)**

Version: 1.0
Status: Working plan
Owner: Control Plane / Autonomy Layer
Scope: Parallel task execution + multi-agent coordination — **chỉ qua kernel hiện
       tại, tuyệt đối không bypass**. Các năng lực "thế giới ngoài" (browser,
       computer use, vision, cloud/remote, self-improvement) được hoãn tường minh.
Related:
`PHASE_7_SIGNOFF.md`, `Coding Agent Architecture Target §58, §59, §60`,
`EVALUATION_MODEL §11.10`, `STATE_MACHINE_SPEC`, `GRAPH_PROTOCOL`,
`INFRASTRUCTURE_SPEC`, `INVARIANTS.md`

---

## 0. Nguyên tắc Phase 8

> **Phase 7 cho agent trí nhớ. Phase 8 cho agent làm nhiều việc cùng lúc và phối
> hợp nhiều agent — nhưng mọi thứ phải đi qua kernel đã có, không một đường tắt nào.**

Luật tối cao (Architecture Target §58):

> Tất cả autonomy nâng cao PHẢI dùng kernel hiện tại. KHÔNG bypass:
> `Policy`, `ToolGateway`, `TaskGraph`, `Verification`, `WorkspaceRevision`, `Budget`.

Bốn luật Phase 8:

1. **Zero bypass.** Parallel/multi-agent không mở đường mới tới filesystem, model,
   hay tool. Mọi tác động vẫn qua `ToolGateway` + `Policy`; mọi task vẫn sống trong
   `TaskGraph`; mọi hoàn thành vẫn qua `Verification` + `CompletionGate` (TI-005).
2. **Determinism của điều phối.** Quyết định lập lịch/song song phải tất định trên
   cùng input (giống SC-006). Song song là về *thực thi*, không về *quyết định* —
   quyết định vẫn deterministic, auditable.
3. **Budget là trần cứng.** Nhiều task/agent chạy song song vẫn chịu `Budget` phân
   cấp (BU-001: child ≤ parent.remaining). Song song không được dùng để lách trần.
4. **Isolation + no-orphan.** Mỗi nhánh song song có workspace/scratch isolation rõ
   ràng; hủy một nhánh không để orphan (EX-006/CP-006). Hai agent không ghi đè nhau
   ngoài policy tường minh (WS-006 spirit).

North Star: *Agent có thể chạy nhiều task độc lập song song và điều phối nhiều
sub-agent, nhanh hơn tuyến tính, mà không một invariant nào của Phase 0–7 bị nới.*

---

## 1. Con số Phase 8

`invariants.yaml` hiện **chưa có** invariant phase 8 (grep `phase: 8` = 0). Phase 8
thêm một nhóm invariant Autonomy và khai báo vào `invariants.yaml` như task đầu phase
(P8-INV), đúng thứ tự Architecture Target §59 (Invariants trước code).

> **Lưu ý đặt tên:** schema yêu cầu prefix 2 chữ (`^[A-Z]{2}-[0-9]{3}$`). Nhóm đề xuất
> dùng prefix **`AU`** (Autonomy).

Nhóm invariant đề xuất (chốt khi thêm vào `invariants.yaml`):

| ID (đề xuất) | Statement | Severity |
|---|---|---|
| AU-001 | Task song song không bypass ToolGateway/Policy — mọi tác động vẫn qua kernel. | CRITICAL |
| AU-002 | Multi-agent coordination không tạo authority mới; vẫn chịu TaskGraph + Verification. | CRITICAL |
| AU-003 | Lập lịch song song deterministic trên cùng input (SC-006 mở rộng). | HIGH |
| AU-004 | Mỗi nhánh song song chịu Budget phân cấp (child ≤ parent.remaining, BU-001). | CRITICAL |
| AU-005 | Hai nhánh/agent không ghi đè workspace của nhau ngoài policy (isolation). | CRITICAL |
| AU-006 | Hủy một nhánh song song không để lại orphan (EX-006/CP-006). | CRITICAL |
| AU-007 | Sub-agent output là proposal, không phải authority (TI-007/MG-006 spirit). | CRITICAL |

Các invariant đã có được Phase 8 làm giàu (không thêm mới): SC-006 (deterministic
scheduling), BU-001 (budget phân cấp), TG-001 (mọi tool qua gateway), GI-001
(TaskGraph là authority dependency), TI-005 (không PASSED thiếu verification),
EX-006/CP-006 (no orphan).

---

## 2. Scope Phase 8

### 2.1 In-scope (v1 — deterministic, kernel-safe)

| Component | Mục tiêu | Enforces |
|---|---|---|
| P8-INV | Nhóm AU-001..007 vào `invariants.yaml` + test | AU-* |
| `ParallelExecutor` | Chạy nhiều task độc lập song song qua Scheduler/TaskGraph | AU-001/003/004 |
| `MultiAgentCoordinator` | Điều phối sub-agent qua kernel; gộp kết quả như proposal | AU-002/007 |
| `BranchIsolation` | Workspace/scratch isolation cho nhánh song song | AU-005/006 |
| Budget/Policy wiring | Mỗi nhánh debit budget phân cấp; mọi tool qua gateway | AU-004, TG-001 |
| P8-I1 Integration E2E | Nhiều task song song + multi-agent, kernel intact, no bypass | tất cả Phase-8 |

### 2.2 Out-of-scope (hoãn tường minh, kèm lý do)

| Năng lực (§58) | Vì sao hoãn |
|---|---|
| Browser / computer use / GUI interaction | Phi tất định, cần thế giới ngoài, headless-hostile; không verify được đúng kỷ luật. |
| Vision | Model đa phương thức nặng, phi tất định; như embedding (xem Phase 7.5 probe). |
| Cloud models / remote workers | Service ngoài, không headless-CI-safe; vi phạm determinism cross-platform. |
| Self-improvement / fine-tuning | Rủi ro an toàn + phi tất định; cần cơ chế kiểm soát riêng. |

Các mục này sẽ được probe-trước-quyết-sau (như LSP/embedding) ở phase/revision sau,
không âm thầm bỏ. Khi làm, chúng vẫn phải tuân luật §0 (zero bypass).

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location | Status |
|---|---|---|
| `Scheduler` (deterministic, SC-006) | `agent-core/src/scheduler/*` | ✅ Phase 1 |
| `TaskGraph` + GraphCommit (GI-*) | `agent-core/src/graph/*` | ✅ Phase 1 |
| `Budget` phân cấp (BU-001) | `agent-core/src/domain/budget.ts` + repo | ✅ Phase 1 |
| `ToolGateway` + `Policy` (TG-*) | `agent-core/src/tool/*` | ✅ Phase 1.5 |
| `ExecutionCoordinator` / `TaskRunService` | `agent-core/src/execution/*` | ✅ Phase 1.5/3 |
| `VerificationEngine` + `CompletionGate` (TI-005) | `agent-core/src/verification/*` | ✅ Phase 1.5 |
| `WorkspaceManager` + scratch isolation | `agent-core` + `infrastructure/src/workspace/*` | ✅ Phase 3 |
| `SessionOrchestrator` (recovery loop) | `agent-core/src/session/*` | ✅ Phase 5 |

### 3.2 Cần tạo mới (Phase 8)

| Component | Package | Phần cốt lõi |
|---|---|---|
| AU-* invariants | invariants.yaml + tests | nhóm mới |
| `ParallelExecutor` | agent-core | chạy N task sẵn sàng song song, mỗi task vẫn qua coordinator hiện có |
| `MultiAgentCoordinator` | agent-core | fan-out sub-agent, gộp kết quả như proposal (không authority) |
| `BranchIsolation` helper | agent-core (logic) + infra (fs) | tách scratch/workspace cho nhánh |
| P8-I1 E2E | tests | nhiều task song song + multi-agent, assert no-bypass |

Nguyên tắc decoupling giữ như Phase 6/7: `agent-core` không phụ thuộc
`infrastructure`; phần chạm filesystem nằm sau interface, feed plain data.

---

## 4. Component breakdown

### 4.1 P8-INV — Autonomy invariants
Thêm AU-001..007 (§1) vào `invariants.yaml` (`phase: 8`) + test
`tests/invariants/autonomy/au-00x.spec.ts`. Làm **đầu tiên**.

### 4.2 P8-PX1 — ParallelExecutor
Chạy song song các task **độc lập** (không có cạnh phụ thuộc trong TaskGraph —
GI-001 là nguồn chân lý về độc lập). Mỗi task vẫn đi qua `ExecutionCoordinator` +
`TaskRunService` + `Budget` + `ToolGateway` hiện có — ParallelExecutor **chỉ điều
phối**, không thực thi tắt. Quyết định "task nào chạy song song" là tất định
(dựa trên Scheduler, SC-006 / AU-003). Chịu một trần song song (maxConcurrency) và
Budget phân cấp (AU-004).

### 4.3 P8-MA1 — MultiAgentCoordinator
Fan-out nhiều sub-agent (ví dụ planner + critic + executor, hoặc nhiều executor cho
nhánh độc lập). Mỗi sub-agent chạy qua kernel; kết quả gộp lại là **proposal** cho
runtime deterministic quyết định (AU-002/007) — không sub-agent nào tự commit graph
hay tự hoàn thành task (TI-005 vẫn chặn).

### 4.4 P8-BI1 — BranchIsolation
Mỗi nhánh song song có scratch zone riêng (WS/VR scratch spirit); hai nhánh không
ghi đè nhau ngoài policy (AU-005). Hủy nhánh → cleanup, no orphan (AU-006).

### 4.5 P8-I1 — Integration E2E
```
tests/integration/autonomy-e2e.spec.ts
```
Scenarios:
1. N task độc lập chạy song song → tất cả qua ToolGateway/Budget; kết quả đúng.
2. Multi-agent: fan-out sub-agent, gộp proposal; không bypass TaskGraph/Verification.
3. Budget phân cấp: tổng tiêu thụ song song không vượt parent (AU-004).
4. Hủy giữa chừng → no orphan (AU-006). Isolation: nhánh không giẫm nhau (AU-005).
5. Determinism: cùng input → cùng quyết định lập lịch (AU-003).

---

## 5. Timeline (ước lượng)

```
Tuần 1 — Invariants + Parallel
  P8-INV   AU-* vào invariants.yaml + test                      [1 ngày]
  P8-PX1   ParallelExecutor (deterministic, budget-aware)       [3 ngày]

Tuần 2 — Multi-agent + Isolation
  P8-MA1   MultiAgentCoordinator (proposals, no authority)      [3 ngày]
  P8-BI1   BranchIsolation                                      [2 ngày]

Tuần 3 — Integration + Sign-off
  P8-I1    Integration E2E                                      [2 ngày]
  —        PHASE_8_SIGNOFF.md                                   [1 ngày]
  —        Buffer                                               [phần còn lại]
```

---

## 6. Exit criteria Phase 8

Map theo `EVALUATION_MODEL §11.10` (Phase 8 gate) + `Architecture Target §60`
(Phase Gate: impl + unit + invariant + adversarial + crash/recovery + docs + exit).

1. AU-001..007 khai báo trong `invariants.yaml` + test `tests/invariants/autonomy/`.
2. **AU-001 (Multi-agent/Parallel không bypass):** test chứng minh mọi tác động
   song song/multi-agent vẫn qua ToolGateway + Policy; không đường tắt.
3. **Kernel intact:** TaskGraph/Verification/Budget/WorkspaceRevision vẫn là authority
   (adversarial test: sub-agent cố bypass → bị chặn).
4. **AU-003:** lập lịch song song deterministic (same input → same decision).
5. **AU-004:** budget phân cấp giữ trần khi chạy song song (test tổng ≤ parent).
6. **AU-005/006:** isolation + no-orphan khi hủy (crash/recovery test).
7. **AU-007:** sub-agent output là proposal, không tự commit/hoàn thành.
8. P8-I1 E2E pass.
9. Không TypeScript error / ESLint error / dependency-cruiser violation.
10. `agent-core` vẫn không phụ thuộc `infrastructure` (depcruise).
11. CI green trên 2 OS (Windows + WSL Ubuntu).
12. Adversarial coverage: tái dùng harness Phase 0 (các adversary biến thể) để thử
    bypass qua đường song song/multi-agent (Architecture Target §60).
13. `PHASE_8_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Song song mở đường bypass ToolGateway | Thấp | Rất cao | ParallelExecutor chỉ điều phối; mọi task qua coordinator hiện có; adversarial test |
| Phi tất định do race giữa nhánh | Trung bình | Cao | Quyết định lập lịch tất định (AU-003); song song chỉ ở thực thi, không ở quyết định |
| Budget bị lách qua song song | Thấp | Cao | Debit budget phân cấp trước khi spawn nhánh (AU-004) |
| Orphan khi hủy giữa song song | Trung bình | Cao | Isolation + cancellation propagate (AU-006, EX-006/CP-006) |
| Sub-agent tự coi mình là authority | Thấp | Rất cao | Gộp kết quả như proposal; TI-005/GI-009 vẫn chặn (AU-002/007) |
| `agent-core` lỡ phụ thuộc infra | Thấp | Cao | Giữ pattern plain-data; depcruise canh |

---

## 8. Những gì Phase 8 KHÔNG làm (và vì sao)

- **Browser / computer use / GUI / vision** — phi tất định, cần thế giới ngoài,
  headless-hostile. Probe-trước-quyết-sau ở revision sau.
- **Cloud models / remote workers** — service ngoài, không headless-CI-safe.
- **Self-improvement / fine-tuning** — rủi ro an toàn + phi tất định.
- **Neural embedding** — đã hoãn từ Phase 7 (xem PHASE_7 §8), có thể gộp xem xét ở đây.

Tất cả, khi làm, vẫn phải tuân luật §0 (zero bypass) — autonomy không bao giờ là lý
do để nới một invariant của kernel.

---

## Phụ lục A — Forward-compatible + nguyên tắc an toàn

- **Không authority mới.** Mọi năng lực Phase 8 là *điều phối* trên kernel hiện có.
  Thêm năng lực = thêm một orchestrator sau các interface đã có (Scheduler, TaskGraph,
  ToolGateway, Budget, Verification), không sửa kernel — cùng tinh thần §4.10 (Phase 7).
- **Determinism trước, song song sau.** Giống "deterministic trước, embedding sau":
  quyết định phải tất định; song song chỉ tăng tốc thực thi, không làm mờ audit trail.
- **Thứ tự thực hiện:** P8-INV trước tiên (invariants trước code, §59).
