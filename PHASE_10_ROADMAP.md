# PHASE_10_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 10 (Road to Autonomous Agent)**

Version: 1.0
Status: Working plan
Owner: Runtime / Agent Loop
Scope: Đưa CodeForge v2 từ "agent chạy được task đơn giản" (hiện tại) tới "autonomous
       coding agent giao được việc thật, tự biết khi nào sai và tự sửa". Tập trung vào
       **chất lượng vận hành** (verification thật, recovery, context, planning, policy),
       KHÔNG phải kiến trúc mới. Mọi thứ vẫn qua kernel Phase 0–9, không bypass. UI đến
       sau cùng, khi agent đã đủ tốt để đáng quan sát.
Related:
`PHASE_9_SIGNOFF.md`, `Coding Agent Architecture Target`, `EVALUATION_MODEL`,
`VERIFICATION_PROTOCOL`, `STATE_MACHINE_SPEC`, `SECURITY_MODEL`, `INVARIANTS.md`,
`packages/infrastructure/src/cli/runtime-cli.ts` (entrypoint hiện có)

---

## 0. Nguyên tắc Phase 10

> **Phase 9 làm agent quan sát + điều khiển được. Phase 10 làm agent ĐÁNG TIN —
> tự biết khi nào nó sai và tự sửa — rồi mới làm nó dễ dùng.**

Luật nền (giữ nguyên Phase 0–9):

> LLM đề xuất → kernel quyết định authority → verification xác nhận hoàn thành.
> Deterministic, observable, governed. Không authority thứ hai, không bypass.

Năm luật Phase 10:

1. **Verification là sự thật, không phải lời tự nhận.** Task chỉ PASSED khi build/test/
   lint thật xanh (TI-005). Agent không bao giờ tự tuyên bố hoàn thành.
2. **Tự sửa là bắt buộc.** Khi verification đỏ, agent nhận lỗi, phân tích, retry — tới
   khi xanh hoặc escalate. Tự chủ = tự sửa lỗi của chính mình.
3. **Thấy trước khi làm.** Agent lập kế hoạch + viết code dựa trên codebase thật (context
   phong phú), không đoán mù.
4. **An toàn khi tự chủ.** Hành động an toàn tự quyết; hành động nguy hiểm cần người
   (AWAITING_HUMAN + Approval). Không auto-approve mọi thứ.
5. **Đo được mới tối ưu.** Mọi tiến bộ đo bằng metrics thật trên bộ dogfood, không bằng
   cảm nhận.

North Star: *Giao cho agent một goal thật ("thêm X", "sửa bug Y"), nó phân rã, viết code,
chạy test, tự sửa khi đỏ, hỏi khi gặp việc nguy hiểm, và trả về kết quả đã verify — tất
cả observable và interruptible.*

---

## 1. Hiện trạng (từ audit, đã verify trong code)

| Khả năng | Trạng thái | Bằng chứng |
|---|---|---|
| Agent loop multi-turn ReAct | ✅ CHẠY | CLI tạo `hello.ts` thật, 4 tool calls qua kernel |
| Governance kernel (Policy/TaskGraph/Verification/...) | ✅ VỮNG | 1277 test, 164 invariant |
| Observability + Control + 3 UI transport | ✅ XONG | Phase 9 |
| Verification policy | ⚠️ RỖNG | `DEFAULT_VERIFICATION_POLICY.checks = []` — task PASS mà không chạy test |
| Recovery loop với model thật | ⚠️ CHỦ YẾU FAKE | Phase 5 engine có, chưa e2e với Ollama |
| Context wiring vào agent loop | ⚠️ SƠ KHAI | `buildTaskPrompt` chỉ có task desc + transcript; codebase "mù" |
| Planning phân rã goal phức tạp | ⚠️ CƠ BẢN | Planner prompt đơn giản, thường ra 1 task |
| Policy & approval thật | ⚠️ AUTO-APPROVE | `PERMISSIVE_TEST_POLICY`; AWAITING_HUMAN chưa nối vào loop |
| Goal ingress lúc runtime | ❌ CHỈ CLI ARG | Phải restart CLI với `--goal`; chưa có `POST /goal` |
| Streaming/progress | ❌ BLOCKING | Model call im lặng 15–48s |

Khoảng cách tới autonomous agent là **chất lượng vận hành**, không phải kiến trúc.

---

## 2. Scope Phase 10

### 2.1 In-scope

| ID | Component | Mục tiêu |
|---|---|---|
| P10.1 | Verification policy thật | Task PASSED chỉ khi build/test/lint xanh |
| P10.2 | Recovery loop e2e | Agent tự sửa lỗi của mình với model thật |
| P10.3 | Context wiring | Bơm codebase (symbols/imports/RAG) vào agent loop |
| P10.4 | Planning chất lượng | Phân rã goal phức tạp thành TaskGraph nhiều task |
| P10.5 | Policy & approval + human-in-the-loop | Risk classification + AWAITING_HUMAN thật |
| P10.6 | Streaming & progress | Token streaming + event tiến trình |
| P10.9 | Runtime goal ingress | `POST /goal` + hàng đợi goal lúc runtime đang chạy |
| P10.7 | Integration E2E + dogfood | Chạy task thật, thu metrics empiric |
| P10.8 | Sign-off autonomous v1 | Chốt khi đạt tiêu chí tự chủ |

### 2.2 Out-of-scope (hoãn tường minh)

- **UI đầy đủ (chat panel, dashboard giàu)** — đến sau P10.6; là client trên substrate
  Phase 9. Hiện có khung web (P9.3) + VS Code thin-client (P9.11).
- **Intelligence Plane / self-model / learning** — Phase 11+.
- **Self-contained extension (bỏ SQLite)** — chỉ nếu bắt buộc; mất ưu điểm authoritative state.

---

## 3. Component breakdown

### 3.1 P10.1 — Verification policy thật ⭐ (giá trị cao nhất)

**Vấn đề:** `checks: []` → task PASS không chạy test.

**Làm:** `VerificationPolicyBuilder` suy ra checks từ dự án — có `package.json` →
`npm run build`/`test`; có `tsconfig.json` → `tsc --noEmit`; có linter → lint. Checks
chạy qua `NodeProcessSupervisor` (đã có). Nối vào CLI: task PASSED chỉ khi
`CompletionGate.canComplete` thấy report PASS tươi (TI-005/VR-002/VR-004 — tất cả đã có).

**Kết quả:** Ranh giới demo ↔ agent thật. Đo bằng `verification.passed/failed` thật.

### 3.2 P10.2 — Recovery loop end-to-end

**Vấn đề:** Recovery engine (Phase 5) chủ yếu test fake.

**Làm:** Khi verification FAIL → `FailureAnalyzer.analyze` → `RecoveryEngine.execute` →
retry với **failure evidence bơm vào context** (model thấy test output đỏ → sửa). Vòng
`RUNNING→FAILED→FAILURE_ANALYZED→RECOVERY→RUNNING` kiểm chứng với Ollama. No-progress
detector (đã có RC-003) chặn lặp vô hạn → escalate.

**Kết quả:** Agent tự sửa lỗi của chính mình.

### 3.3 P10.3 — Context wiring

**Vấn đề:** Agent "mù" codebase.

**Làm:** Nối `ContextBuilder` + `Retriever` (code-intelligence symbols + import-graph +
RAG — đã có Phase 2/6/7) vào TaskExecutor. Context items untrusted đánh dấu đúng
(TrustMarker, CX-005). Token budget giữ trong giới hạn (TokenBudgeter, CX-004).

**Kết quả:** Agent viết code dựa trên codebase thật.

### 3.4 P10.4 — Planning chất lượng

**Vấn đề:** Planner thường ra 1 task.

**Làm:** Prompt engineering cho Planner (hướng dẫn phân rã, few-shot, ràng buộc độ chi
tiết). Tùy chọn: PlanCritic pass (đã có MG-006) review plan trước commit. Replanning khi
thiếu task giữa chừng (replanner path đã có). TaskGraph + Scheduler + ParallelExecutor
(đã có) chạy nhiều task theo dependency.

**Kết quả:** Xử lý được dự án nhiều bước.

### 3.5 P10.5 — Policy & approval + human-in-the-loop (bổ sung khoảng trống)

**Vấn đề:** `PERMISSIVE_TEST_POLICY` auto-approve mọi thứ; `AWAITING_HUMAN` + ApprovalEngine
**có cấu trúc nhưng chưa nối vào agent loop** → agent chưa bao giờ escalate thật.

**Làm:**
- `ProductionToolPolicy`: phân loại risk theo toolName + arguments (READ_ONLY /
  MODIFY_WORKSPACE / DESTRUCTIVE — đã có risk classes).
- Autonomy levels (như `ollama-code-chat`: all / edits / none): auto-approve theo mức.
- **Nối AWAITING_HUMAN thật:** khi ToolGateway trả APPROVAL_PENDING cho hành động nguy
  hiểm, TaskExecutor dừng, SessionService.transition(HUMAN_REQUIRED) → session
  AWAITING_HUMAN; ApprovalEngine tạo approval request; agent đợi `HUMAN_DECIDED`
  (guard: humanDecisionRecorded, SS-007). User approve/deny qua ControlPlane
  (`/control` intent approve/deny — đã có) → session resume.

**Kết quả:** Agent tự chủ *an toàn* — tự quyết việc an toàn, hỏi việc nguy hiểm. Lấp
khoảng trống "AWAITING_HUMAN chưa nối vào loop".

### 3.6 P10.6 — Streaming & progress

**Vấn đề:** Model call blocking, im lặng.

**Làm:** `OllamaModelGateway` hỗ trợ streaming (hiện `stream:false`). Phát event tiến
trình đang thiếu (`MODEL_SELECTED`, `DECISION_REQUESTED/COMPLETED` — đã khai báo vocab
ở P9.1) qua EventLog → SSE (đã có). Giữ determinism của *quyết định*; streaming chỉ ở
*hiển thị tiến trình*.

**Kết quả:** Người quan sát thấy agent "sống" real-time.

### 3.7 P10.9 — Runtime goal ingress (bổ sung khoảng trống)

**Vấn đề:** Goal chỉ vào qua `--goal` lúc khởi động CLI. Muốn giao goal mới phải restart.
Một UI chat thật cần gửi goal lúc runtime đang chạy.

**Làm:**
- `POST /goal { description, acceptanceCriteria? }` trên HttpTransport (cùng server P9.3).
- `ObservabilityService.submitGoal()` (hoặc một `GoalIngressService`): dựng Goal entity
  (createdBy='user'), tạo session mới HOẶC enqueue vào session đang chạy, rồi khởi
  orchestrator.run() cho goal đó.
- Goal queue: nhiều goal xếp hàng; agent xử lý tuần tự (hoặc theo policy).
- **Giữ ranh giới:** goal ingress là *Decision Gate* ("làm gì"), tách khỏi *Approval
  Gate* ("được phép làm không"). Goal vẫn qua Planner → GraphCommit (kernel quyết định),
  không bypass.

**Kết quả:** User (qua dashboard/Telegram/VS Code/API) gửi yêu cầu công việc lúc runtime
đang chạy — nền cho UI chat. Lấp khoảng trống "goal chỉ vào qua CLI arg".

### 3.8 P10.7 — Integration E2E + dogfood

**Làm:** Bộ task dogfood chuẩn (docs, bug fix, refactor, feature nhỏ, test gen). Chạy với
Ollama thật, thu metrics (DogfoodMetrics đã có). Vá điểm yếu phát hiện.

**Kết quả:** Số liệu thật về "agent giao được việc gì, ở mức nào".

### 3.9 P10.8 — Sign-off autonomous v1

Tiêu chí (xem §6).

---

## 4. Ghi chú thiết kế: control responsiveness (khoảng trống #2)

Pause/cancel hiện tác dụng ở **ranh giới iteration** của orchestrator loop (giữa các
task), KHÔNG giữa một tool call đang chạy. Đây là **thiết kế có chủ đích**: một tool
call (write_file, run_command) là atomic — ngắt giữa chừng để lại trạng thái không nhất
quán. Vì vậy:

- **Giữ nguyên:** control checkpoint ở ranh giới iteration (đã có qua SessionStateControlGate).
- **Bổ sung (P10.6):** control checkpoint thêm ở ranh giới *tool-call* trong vòng ReAct
  (giữa các bước model→tool→model), để pause/cancel phản hồi nhanh hơn mà không ngắt
  giữa một tool call đang thực thi. Tool call đang chạy có timeout riêng (TG-010, đã có).
- Cancel một `run_command` dài: dựa vào `commandTimeout` + process kill (EX-006 no-orphan,
  đã có) — không ngắt lệnh con tùy tiện.

Đây không phải component riêng mà là một tinh chỉnh trong P10.6, ghi rõ để không nhầm là
thiếu sót.

---

## 5. Thứ tự & phụ thuộc

```
P10.1 Verification thật ⭐        ← làm trước, mở khóa "trust"
   ↓
P10.2 Recovery e2e               ← cần verification thật để kích hoạt
   ↓
P10.3 Context wiring  ─┐
P10.4 Planning        ─┴─ song song được; cùng nâng chất lượng
   ↓
P10.5 Policy + human-in-the-loop ← cần cho "an toàn khi tự chủ"
   ↓
P10.9 Runtime goal ingress       ← nền cho UI gửi goal động
P10.6 Streaming/progress + control-at-tool-boundary
   ↓
P10.7 Dogfood + đo               ← kiểm chứng toàn bộ
   ↓
P10.8 Sign-off autonomous v1
```

Giá trị cao nhất, làm trước: **P10.1 + P10.2**.

---

## 6. Exit criteria Phase 10

Agent "tự chủ v1" khi, trên bộ dogfood:

1. Verification thật chạy (build/test/lint); task chỉ PASSED khi xanh (TI-005).
2. Khi verification đỏ, agent tự phân tích + retry; tự sửa được phần lớn lỗi của chính mình.
3. Context phong phú được bơm vào agent loop (symbols/imports/RAG); agent không đoán mù.
4. Planner phân rã được goal nhiều task với dependency đúng; agent chạy theo Scheduler.
5. Policy thật phân loại risk; hành động DESTRUCTIVE escalate qua AWAITING_HUMAN + Approval.
6. `POST /goal` cho phép gửi yêu cầu lúc runtime chạy (goal ingress động).
7. Streaming + event tiến trình; pause/cancel phản hồi ở ranh giới tool-call.
8. Metrics empiric thu được trên bộ dogfood (success rate, duration, retries, interventions).
9. Không TypeScript/ESLint/depcruise error; `agent-core ↛ infrastructure`.
10. Toàn bộ test Phase 0–9 vẫn xanh; test mới (unit/invariant/adversarial/e2e) pass.
11. CI green Win + WSL.
12. `PHASE_10_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Model nhỏ (7B) phân rã/sửa lỗi kém | Cao | Cao | Prompt engineering kỹ; cho dùng model lớn hơn (deepseek-r1:14b); recovery + no-progress chặn lặp |
| Verification chạy chậm/treo | Trung bình | Trung bình | Timeout qua ProcessSupervisor (TG-010); failFast policy |
| Agent escalate quá nhiều (phiền) hoặc quá ít (nguy hiểm) | Trung bình | Cao | Autonomy levels tinh chỉnh được; dogfood đo tần suất |
| Context quá lớn tràn window | Trung bình | Trung bình | TokenBudgeter (CX-004, đã có) cắt theo priority |
| Goal ingress tạo authority path mới | Thấp | Rất cao | Goal vẫn qua Planner→GraphCommit; `/goal` chỉ là transport, không bypass |
| Streaming phá determinism | Thấp | Cao | Streaming chỉ ở hiển thị; quyết định vẫn deterministic (temp=0 cho decision) |

---

## 8. UI — khi nào và hình hài (trả lời câu hỏi người dùng)

**Khi nào:** Sau P10.6. Lúc đó agent đã đáng tin (P10.1–2), thông minh (P10.3–4), an
toàn (P10.5), gửi goal động được (P10.9), và "sống" quan sát được (P10.6).

**Hình hài — CẢ HAI dạng, nhờ kiến trúc Phase 9 (không phải chọn một):**

- **(a) Dashboard web — tách khỏi IDE:** chạy runtime → mở browser. Độc lập, remote được
  (Telegram đã có). Khung đã có ở P9.3.
- **(b) VS Code extension — trong IDE (thin-client):** extension nối runtime (có SQLite)
  qua HTTP, hiển thị chat + dashboard trong sidebar. **Giữ nguyên ưu điểm kernel v2**
  (SQLite authoritative). Khung đã có ở P9.11.

Cả hai dùng chung `ObservabilityService` + `ControlPlane` + (mới) `POST /goal`. Viết một
lần, nhiều mặt tiền. Thêm UI = thêm transport, không đụng kernel → không mất ưu điểm nào.

---

## Phụ lục A — Vì sao thứ tự này

Một agent tự chủ **đáng tin** = tự biết khi nào sai và tự sửa. Quyết định điều đó không
phải UI đẹp, mà là verification thật + recovery + context + planning. Vì vậy roadmap đi
"làm agent đáng tin" trước "làm agent dễ dùng". UI mà không có agent đáng tin phía sau
chỉ là vỏ. Phase 9 đã cố ý làm substrate observability/control *trước* UI, nên khi agent
đủ tốt, UI là bước dễ — và hiện được ở cả web lẫn IDE mà không hy sinh gì.
