# Requirements Document

## Introduction

Tính năng "Plan Options" là Phase 2 của Goal Clarification. Phase 1 hỏi lại khi goal **mơ hồ**
(thiếu thông tin). Phase 2 xử lý một tình huống khác: goal đã đủ rõ nhưng có **nhiều cách làm hợp
lý** với đánh đổi khác nhau (ví dụ: một script đơn giản hay một module có test; dùng thư viện có sẵn
hay tự viết). Thay vì để Planner tự chọn ngầm, runtime đề xuất 2–4 phương án, mỗi phương án có tóm
tắt, ưu điểm và nhược điểm, đánh dấu một phương án được khuyến nghị, rồi dừng lại để người dùng chọn
trong Goals panel của VS Code. Phương án được chọn định hướng cả Planner (cách chia task) và
TaskExecutor (cách viết code).

Tính năng là opt-in (`--plan-options on`, cần `--mission on`), dùng lại hạ tầng của Phase 1 (dừng ở
`AWAITING_HUMAN`, chờ trong lúc run, event log làm nguồn sự thật, Goals panel suy dữ liệu từ event)
và của Session Resume v1 (resume sau restart). Khi cờ tắt, hành vi hiện tại giữ nguyên.

Ngoài phạm vi: sinh nhiều task graph đầy đủ để so sánh, cho người dùng sửa nội dung phương án, chọn
nhiều phương án cùng lúc, hiển thị trên web dashboard, và đưa phương án vào MissionArchitect.

## Glossary

- **Runtime_CLI**: tiến trình runtime (`runtime-cli.ts`).
- **Session_Orchestrator**: `SessionOrchestrator`.
- **Mission_Stage**: `MissionIntelligence`.
- **User_Statement**: giả định `[user-provided] …` sinh từ câu trả lời làm rõ (Phase 1).
- **Approach_Advisor**: thành phần mới (LLM, advisory) sinh danh sách phương án từ Mission.
- **Plan_Option**: một phương án gồm `id` (`o1`..`oN`), `title`, `summary`, `pros` (danh sách),
  `cons` (danh sách), và cờ `recommended`.
- **Plan_Options_Request**: một lần hỏi chọn phương án: `requestId`, `missionId`, `goalId`, danh sách
  Plan_Option (2–4), và `recommendedOptionId`.
- **Plan_Choice_Coordinator**: thành phần chờ lựa chọn của người dùng, cùng cơ chế với
  `ClarificationCoordinator` của Phase 1.
- **Plan_Choice_Endpoint**: route mới `POST /plan-choice`.
- **Chosen_Approach**: Plan_Option được chọn (hoặc được khuyến nghị nếu người dùng để agent tự quyết).
- **Goals_Panel**: webview "CodeForge Goals" của extension VS Code.
- **Planner**: `Planner` trong agent-core, dựng prompt từ các section có nhãn tin cậy.
- **Task_Executor**: `TaskExecutor`, nhận `goalAssumptions` vào section `STATED_ASSUMPTIONS`.

## Requirements

### Requirement 1: Cờ opt-in và hành vi mặc định

**User Story:** Là người vận hành, tôi muốn bật đề xuất phương án bằng một cờ riêng, để chế độ tự
trị mặc định không đổi khi tôi không bật.

#### Acceptance Criteria

1. WHERE Runtime_CLI được khởi động với `--plan-options on` và `--mission on`, THE Runtime_CLI SHALL
   wire Approach_Advisor và Plan_Choice_Coordinator vào Mission_Stage, và Plan_Choice_Coordinator vào
   Plan_Choice_Endpoint.
2. WHERE `--plan-options` không bật, THE Mission_Stage SHALL không gọi Approach_Advisor và không phát
   event `PLAN_OPTIONS_PROPOSED` hay `PLAN_OPTION_CHOSEN`, và kết quả của stage SHALL giống hệt
   hiện tại.
3. IF Runtime_CLI nhận `--plan-options on` mà không có `--mission on`, THEN THE Runtime_CLI SHALL in
   cảnh báo và chạy với tính năng bị tắt.
4. THE Runtime_CLI SHALL in trạng thái tính năng (`ON` / `off`) trong banner khởi động.
5. WHILE tính năng bị tắt, THE Plan_Choice_Endpoint SHALL trả HTTP 501
   `{ "error": "plan options not enabled" }`.
6. WHERE setting VS Code `codeforge.planOptions` bằng `true`, THE extension SHALL khởi chạy runtime với
   `--mission on --plan-options on`.

### Requirement 2: Khi nào đề xuất phương án

**User Story:** Là người dùng, tôi muốn chỉ được hỏi chọn phương án khi việc chọn thực sự có ý nghĩa,
để các việc nhỏ vẫn chạy thẳng.

#### Acceptance Criteria

1. WHILE tính năng được bật, WHEN độ phức tạp của Mission (`assessComplexity`) ở mức `MEDIUM` trở lên,
   THE Mission_Stage SHALL gọi Approach_Advisor.
2. WHEN độ phức tạp ở mức `LOW`, THE Mission_Stage SHALL bỏ qua bước đề xuất phương án.
3. WHEN goal cũng cần làm rõ (Phase 1), THE Mission_Stage SHALL hoàn tất bước làm rõ trước, và
   Approach_Advisor SHALL nhận cả các User_Statement và giả định đã gộp.
4. WHEN cổng làm rõ kết thúc với `cancelled`, THE Mission_Stage SHALL không gọi Approach_Advisor.
5. IF Approach_Advisor ném lỗi hoặc trả kết quả không hợp lệ sau số lần thử giới hạn, THEN THE
   Mission_Stage SHALL bỏ qua bước đề xuất và tiếp tục lập kế hoạch như khi tính năng tắt (fail-safe).
6. IF Approach_Advisor trả về ít hơn 2 phương án hợp lệ, THEN THE Mission_Stage SHALL bỏ qua bước hỏi
   (không có gì để chọn) và tiếp tục như khi tính năng tắt.

### Requirement 3: Nội dung và kiểm tra phương án

**User Story:** Là người dùng, tôi muốn các phương án ngắn gọn, so sánh được và an toàn để hiển thị.

#### Acceptance Criteria

1. THE Approach_Advisor SHALL trả về từ 2 đến 4 Plan_Option.
2. THE Mission_Stage SHALL kiểm tra tất định mỗi Plan_Option: `title` 1–80 ký tự, `summary` 1–400 ký
   tự, `pros` và `cons` mỗi danh sách 1–4 mục, mỗi mục 1–160 ký tự; Plan_Option không đạt SHALL bị
   loại.
3. THE Mission_Stage SHALL chuẩn hóa mọi chuỗi về một dòng (loại ký tự điều khiển, gộp khoảng trắng)
   bằng cùng quy tắc với câu trả lời làm rõ của Phase 1.
4. THE Mission_Stage SHALL gán id `o1`..`oN` theo thứ tự Approach_Advisor trả về sau khi loại bỏ
   phương án không hợp lệ.
5. THE Mission_Stage SHALL đảm bảo có đúng một phương án `recommended`. IF Approach_Advisor không đánh
   dấu hoặc đánh dấu nhiều hơn một, THEN THE Mission_Stage SHALL chọn phương án đầu tiên được đánh dấu,
   hoặc `o1` nếu không có.
6. THE Approach_Advisor SHALL gọi model qua ModelGateway duy nhất đã inject (MG-001).

### Requirement 4: Dừng chờ lựa chọn và phát event

**User Story:** Là người dùng, tôi muốn runtime dừng lại chờ tôi chọn, và mọi lựa chọn được ghi lại để
audit.

#### Acceptance Criteria

1. WHEN có Plan_Options_Request, THE Mission_Stage SHALL append event `PLAN_OPTIONS_PROPOSED`
   (aggregate `mission`) với payload `{ requestId, missionId, goalId, options, recommendedOptionId }`
   trước khi chờ.
2. THE Plan_Choice_Coordinator SHALL chuyển session `RUNNING → AWAITING_HUMAN` (`HUMAN_REQUIRED`) trước
   khi chờ, và `AWAITING_HUMAN → RUNNING` (`HUMAN_DECIDED`, `humanDecisionRecorded: true`) khi nhận
   lựa chọn hợp lệ hoặc hết thời gian chờ.
3. WHILE đang chờ lựa chọn, THE Session_Orchestrator SHALL chưa gọi Planner.
4. WHEN lựa chọn kết thúc, THE Mission_Stage SHALL append đúng một event `PLAN_OPTION_CHOSEN` cho mỗi
   `requestId` với payload `{ requestId, optionId, source: 'user' | 'default' | 'timeout' }`.
5. IF không có lựa chọn trong `maxWaitMs` (mặc định 3.600.000 ms), THEN THE Mission_Stage SHALL dùng
   phương án được khuyến nghị với `source: 'timeout'`.
6. IF session rời `AWAITING_HUMAN` vì lý do khác trong lúc chờ (cancel), THEN THE Mission_Stage SHALL
   trả `proceed: false` với blocker `plan choice cancelled` và không phát `PLAN_OPTION_CHOSEN`.
7. THE tính năng SHALL không thêm trạng thái session hay transition mới.

### Requirement 5: Endpoint `POST /plan-choice`

**User Story:** Là client, tôi muốn gửi lựa chọn qua một endpoint có hợp đồng rõ ràng.

#### Acceptance Criteria

1. WHEN nhận body hợp lệ `{ sessionId, optionId }` cho session đang chờ, THE Plan_Choice_Endpoint SHALL
   trả 200 với `{ requestId, optionId, source: 'user' }`.
2. WHEN nhận `{ sessionId, useRecommended: true }`, THE Plan_Choice_Endpoint SHALL chọn phương án
   khuyến nghị và trả 200 với `source: 'default'`.
3. IF body không phải JSON hợp lệ, THEN trả 400 `{ "error": "invalid JSON body" }`.
4. IF `sessionId` thiếu hoặc rỗng, THEN trả 400 `{ "error": "sessionId required" }`.
5. IF không có `optionId` dạng chuỗi và cũng không có `useRecommended: true`, THEN trả 400
   `{ "error": "optionId required" }`.
6. IF `optionId` không thuộc request đang chờ, THEN trả 400 `{ "error": "unknown option id: <id>" }`.
7. IF session không tồn tại, THEN trả 404 `{ "error": "session not found" }`.
8. IF session không có request chọn phương án đang chờ (kể cả gửi lần hai), THEN trả 409
   `{ "error": "session not awaiting plan choice" }`.
9. THE Plan_Choice_Coordinator SHALL chấp nhận tối đa một lựa chọn cho mỗi `requestId`, và một yêu cầu
   bị từ chối (400/404/409) SHALL không làm mất request đang chờ.

### Requirement 6: Phương án được chọn định hướng Planner và Executor

**User Story:** Là người dùng, tôi muốn kế hoạch và code đi theo đúng phương án tôi chọn.

#### Acceptance Criteria

1. WHEN Mission_Stage trả `proceed: true` sau khi chọn phương án, THE outcome SHALL chứa Chosen_Approach.
2. THE Session_Orchestrator SHALL truyền Chosen_Approach vào Planner.
3. WHEN Planner dựng prompt có Chosen_Approach, THE Planner SHALL thêm section `CHOSEN_APPROACH` chứa
   `title`, `summary`, `pros` và `cons` của phương án, kèm chỉ dẫn lập kế hoạch theo phương án đó.
4. THE Mission_Stage SHALL thêm vào `assumptions` (và do đó `goalAssumptions` của mọi
   TaskExecutorRequest) một dòng `[chosen-approach] <title> — <summary>`.
5. WHEN không có Chosen_Approach (tính năng tắt, bị bỏ qua, hoặc fail-safe), THE prompt của Planner và
   Task_Executor SHALL giống hệt hiện tại.
6. THE Mission_Stage SHALL không sửa Goal (MI-004).

### Requirement 7: Hiển thị và chọn trong Goals panel

**User Story:** Là người dùng VS Code, tôi muốn so sánh các phương án ngay dưới goal và chọn bằng bàn
phím hoặc chuột.

#### Acceptance Criteria

1. WHILE session của một entry ở `AWAITING_HUMAN`, WHEN event của session có `PLAN_OPTIONS_PROPOSED`
   chưa có `PLAN_OPTION_CHOSEN` cùng `requestId`, THE Goals_Panel SHALL hiển thị các phương án dưới
   entry kèm nhãn `choose a plan`.
2. THE Goals_Panel SHALL hiển thị mỗi phương án với title, summary, danh sách ưu điểm và nhược điểm, và
   một nhãn `recommended` cho phương án được khuyến nghị.
3. THE Goals_Panel SHALL cho chọn phương án qua một nhóm radio trong `<fieldset>` có `<legend>`, chọn
   sẵn phương án khuyến nghị.
4. THE Goals_Panel SHALL có hai nút: "Use this plan" và "Let the agent decide".
5. WHEN người dùng kích hoạt một nút, THE extension SHALL gọi `POST /plan-choice` và hiển thị kết quả
   hoặc lỗi trong vùng `aria-live="polite"`; khi đang gửi, các nút SHALL bị vô hiệu hóa.
6. THE Goals_Panel SHALL escape mọi văn bản phương án trước khi chèn vào DOM.
7. THE Goals_Panel SHALL suy ra phương án đang mở chỉ từ event của session, không dùng kho lưu cục bộ.
8. WHEN cùng lúc có câu hỏi làm rõ đang mở, THE Goals_Panel SHALL chỉ hiển thị form làm rõ (bước làm rõ
   luôn đi trước).

### Requirement 8: Resume sau restart

**User Story:** Là người dùng, tôi muốn việc chọn phương án không bị mất nếu runtime restart.

#### Acceptance Criteria

1. THE startup recovery SHALL coi một session mồ côi ở `AWAITING_HUMAN` có `PLAN_OPTIONS_PROPOSED`
   chưa có `PLAN_OPTION_CHOSEN`, trước planning, là resumable (cùng điều kiện về graph seed, goal đã
   lưu, và cờ `--plan-options` đang bật).
2. WHEN resume, THE Mission_Stage SHALL chờ lại đúng request cũ (cùng `requestId`, cùng phương án),
   không gọi lại Approach_Advisor và không phát lại event đã có.
3. IF runtime mới khởi động với `--plan-options off`, THEN session đó SHALL bị đóng với lý do
   `plan options are disabled on this runtime (--plan-options off)`.

### Requirement 9: Kiểm thử

**User Story:** Là người bảo trì, tôi muốn tính năng có test tự động chống hồi quy.

#### Acceptance Criteria

1. THE test suite SHALL có property test cho việc kiểm tra và chuẩn hóa phương án (giới hạn độ dài,
   số mục, đúng một `recommended`, id liên tục).
2. THE test suite SHALL có test chứng minh khi tắt cờ thì stage, prompt Planner và prompt Executor
   không đổi.
3. THE test suite SHALL có test cho từng mã HTTP của Plan_Choice_Endpoint.
4. THE test suite SHALL có test tích hợp: đề xuất → chọn qua HTTP → Planner nhận `CHOSEN_APPROACH`.
5. THE test suite SHALL có test cho hàm suy ra phương án đang mở của Goals_Panel và cho resume sau
   restart.