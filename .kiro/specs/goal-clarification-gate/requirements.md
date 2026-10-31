# Requirements Document

## Introduction

Tính năng "Goal Clarification Gate" (Phase 1) bổ sung một bước hỏi lại người dùng khi goal quá mơ hồ. Hiện tại, khi `--mission on`, stage `MissionIntelligence` đánh giá độ mơ hồ bằng `assessUncertainty` và, nếu goal chưa rõ, gọi `AssumptionAdvisor` để tự đưa ra giả định (assume-and-state) rồi chạy tiếp mà không hỏi người dùng.

Với tính năng này, khi bật cờ opt-in `--clarify on` (dùng cùng `--mission on`) và `assessUncertainty` trả về `UNKNOWN`, runtime sẽ:

1. phát event `GOAL_CLARIFICATION_REQUESTED` chứa các câu hỏi mở;
2. tạm dừng session ở trạng thái `AWAITING_HUMAN` có sẵn;
3. hiển thị câu hỏi trong Goals panel của VS Code kèm form trả lời;
4. nhận câu trả lời qua endpoint mới `POST /clarification`;
5. gộp câu trả lời vào `goalAssumptions` (và từ đó vào prompt section `STATED_ASSUMPTIONS`) dưới dạng giá trị KNOWN do người dùng cung cấp, phát `GOAL_CLARIFICATION_ANSWERED`, rồi lập kế hoạch tiếp.

Khi cờ tắt (mặc định), hành vi assume-and-state hiện tại giữ nguyên. Phase 2 (nhiều phương án kế hoạch kèm ưu/nhược điểm) nằm ngoài phạm vi. Mục tiêu khoảng 200–300 LOC mã production, cộng thêm test.

## Glossary

- **Runtime_CLI**: Tiến trình runtime khởi động từ `packages/infrastructure/src/cli/runtime-cli.ts`. Nó parse cờ CLI và wire mọi thành phần.
- **Mission_Stage**: Lớp `MissionIntelligence` (`packages/agent-core/src/mission/mission-intelligence.ts`). Đây là stage advisory chạy một lần trước khi lập kế hoạch.
- **Session_Orchestrator**: Lớp `SessionOrchestrator`. Nó gọi Mission_Stage, sau đó gọi Planner và vòng lặp thực thi.
- **Session_Service**: `SessionService`. Đây là nơi duy nhất có quyền chuyển trạng thái session (`HUMAN_REQUIRED`, `HUMAN_DECIDED`, ...).
- **Clarification_Coordinator**: Thành phần mới ở tầng infrastructure. Nó chuyển session sang `AWAITING_HUMAN`, giữ yêu cầu làm rõ đang chờ và nhận câu trả lời. Nó tương tự `NodeApprovalCoordinator`.
- **Clarification_Endpoint**: Route mới `POST /clarification` trong `HttpTransport`, đi qua `ObservabilityService`.
- **Goals_Panel**: Webview "CodeForge Goals" của extension VS Code (`goals-webview.ts`, `goal-history.ts`, `extension.ts`).
- **Event_Store**: `EventLog` hiện có (SQLite `SqliteEventLog`). Nó append-only và đánh số thứ tự theo session.
- **Assumption_Advisor**: Lớp `AssumptionAdvisor` hiện có. Nó dùng LLM để sinh giả định cho các câu hỏi mở.
- **Task_Executor**: `TaskExecutor`. Nó dựng prompt và chèn section `STATED_ASSUMPTIONS` từ `goalAssumptions`.
- **Open_Question**: Một câu hỏi mở gồm `id` (chuỗi), `text` (chuỗi) và `suggestedOptions` (mảng chuỗi, tùy chọn).
- **Clarification_Request**: Một lần hỏi người dùng. Nó gồm `requestId` duy nhất, `missionId`, `goalId` và danh sách Open_Question.
- **Clarification_Answers**: Đối tượng ánh xạ `questionId` sang chuỗi trả lời.
- **Skipped_Question**: Một Open_Question không có câu trả lời, tức là key bị bỏ hoặc giá trị rỗng sau khi chuẩn hóa. Nó có nghĩa là người dùng chấp nhận giả định mặc định.
- **User_Statement**: Một chuỗi giả định KNOWN do người dùng cung cấp, được dựng từ một câu hỏi và câu trả lời của nó.
- **Default_Assumption**: Một chuỗi giả định do Assumption_Advisor sinh cho một Skipped_Question.

## Requirements

### Requirement 1: Cờ opt-in và hành vi mặc định

**User Story:** Là người vận hành runtime, tôi muốn bật cổng làm rõ goal bằng một cờ riêng, để chế độ tự trị mặc định không thay đổi khi tôi không bật nó.

#### Acceptance Criteria

1. WHERE Runtime_CLI được khởi động với cả `--clarify on` và `--mission on`, THE Runtime_CLI SHALL wire Clarification_Coordinator vào Mission_Stage và vào Clarification_Endpoint.
2. WHERE Runtime_CLI được khởi động không có `--clarify on`, THE Mission_Stage SHALL áp dụng hành vi assume-and-state hiện có qua Assumption_Advisor và không phát event `GOAL_CLARIFICATION_REQUESTED` hay `GOAL_CLARIFICATION_ANSWERED`.
3. IF Runtime_CLI nhận `--clarify on` mà không có `--mission on`, THEN THE Runtime_CLI SHALL in một dòng cảnh báo ra console và chạy với cổng làm rõ bị tắt.
4. THE Runtime_CLI SHALL in trạng thái cổng làm rõ (`ON` hoặc `off`) trong banner khởi động.
5. WHILE cổng làm rõ bị tắt, THE Clarification_Endpoint SHALL trả HTTP 501 với body `{ "error": "clarification not enabled" }`.
6. WHERE setting VS Code `codeforge.clarify` bằng `true`, THE Goals_Panel extension SHALL khởi chạy runtime với các đối số `--mission on --clarify on`.

### Requirement 2: Điều kiện kích hoạt

**User Story:** Là người dùng, tôi muốn runtime chỉ hỏi lại khi goal thật sự mơ hồ, để các goal rõ ràng vẫn chạy thẳng.

#### Acceptance Criteria

1. WHILE Clarification_Coordinator được wire, WHEN `assessUncertainty` trả về level `UNKNOWN` với ít nhất một câu hỏi mở, THE Mission_Stage SHALL tạo một Clarification_Request trước khi gọi Assumption_Advisor.
2. WHEN `assessUncertainty` trả về level `KNOWN` hoặc `INFERRED`, THE Mission_Stage SHALL bỏ qua cổng làm rõ và áp dụng hành vi assume-and-state hiện có.
3. THE Mission_Stage SHALL gán id `q1`, `q2`, …, `qN` cho các Open_Question theo đúng thứ tự mảng `openQuestions` mà `assessUncertainty` trả về.
4. THE Mission_Stage SHALL gắn `suggestedOptions` chỉ cho những câu hỏi có trong bảng gợi ý tĩnh, và bỏ trống trường này với các câu hỏi khác.
5. THE Mission_Stage SHALL gán cho mỗi Clarification_Request một `requestId` lấy từ nguồn id được inject (`newId`).

### Requirement 3: Tạm dừng và chuyển trạng thái session

**User Story:** Là người dùng, tôi muốn runtime dừng lại chờ câu trả lời của tôi, để kế hoạch không được dựng trên một cách hiểu sai.

#### Acceptance Criteria

1. THE Clarification_Coordinator SHALL dùng lại trạng thái session `AWAITING_HUMAN` hiện có và các sự kiện `HUMAN_REQUIRED` và `HUMAN_DECIDED` mà không thêm trạng thái session mới.
2. WHEN một Clarification_Request được tạo, THE Clarification_Coordinator SHALL chuyển session từ `RUNNING` sang `AWAITING_HUMAN` qua Session_Service với sự kiện `HUMAN_REQUIRED` trước khi bắt đầu chờ.
3. WHILE Clarification_Coordinator đang chờ câu trả lời, THE Session_Orchestrator SHALL chưa gọi Planner và chưa commit graph nào.
4. WHEN Clarification_Coordinator nhận một bộ câu trả lời hợp lệ, THE Clarification_Coordinator SHALL chuyển session từ `AWAITING_HUMAN` về `RUNNING` qua Session_Service với sự kiện `HUMAN_DECIDED` và context `{ humanDecisionRecorded: true }`.
5. IF không có câu trả lời hợp lệ nào trong thời gian `maxWaitMs` (mặc định 3.600.000 ms), THEN THE Clarification_Coordinator SHALL kết thúc chờ với kết quả `timeout` và chuyển session về `RUNNING`. Sau đó THE Mission_Stage SHALL coi mọi Open_Question là Skipped_Question.
6. IF trạng thái session rời khỏi `AWAITING_HUMAN` vì lý do khác trong lúc chờ (ví dụ cancel qua `POST /control`), THEN THE Clarification_Coordinator SHALL kết thúc chờ với kết quả `cancelled` trong vòng hai chu kỳ `pollIntervalMs`. Sau đó THE Mission_Stage SHALL trả về `proceed: false` với blocker `clarification cancelled`.

### Requirement 4: Phát event

**User Story:** Là người kiểm toán, tôi muốn mỗi lần hỏi và trả lời được ghi thành event, để có thể replay và audit quyết định của người dùng.

#### Acceptance Criteria

1. WHEN một Clarification_Request được tạo, THE Mission_Stage SHALL append event `GOAL_CLARIFICATION_REQUESTED` (aggregate kind `mission`) trước khi chuyển session. Payload là `{ requestId, missionId, goalId, level, openQuestions: [{ id, text, suggestedOptions? }] }`.
2. WHEN câu trả lời đã được gộp, dù đến từ người dùng hay từ timeout, THE Mission_Stage SHALL append event `GOAL_CLARIFICATION_ANSWERED`. Payload là `{ requestId, source: 'user' | 'timeout', answers: [{ questionId, question, answer }], skippedQuestionIds, assumptions }`.
3. THE Mission_Stage SHALL append đúng một event `GOAL_CLARIFICATION_ANSWERED` cho mỗi `requestId` đã kết thúc với kết quả `answered` hoặc `timeout`.
4. WHEN có ít nhất một Skipped_Question và Assumption_Advisor sinh được Default_Assumption, THE Mission_Stage SHALL append event `MISSION_ASSUMPTIONS_MADE` với payload cùng định dạng hiện có.
5. THE `KnownEventType` union SHALL chứa `GOAL_CLARIFICATION_REQUESTED` và `GOAL_CLARIFICATION_ANSWERED`.

### Requirement 5: Hợp đồng endpoint `POST /clarification`

**User Story:** Là client (extension VS Code hoặc dashboard), tôi muốn một endpoint có hợp đồng rõ ràng để gửi câu trả lời, để lỗi được báo bằng mã HTTP cụ thể.

#### Acceptance Criteria

1. WHEN Clarification_Endpoint nhận body `{ sessionId, answers }` hợp lệ cho một session đang có Clarification_Request chờ, THE Clarification_Endpoint SHALL trả HTTP 200 với body `{ requestId, answered, skipped }`. Ở đây `answered` là số câu đã trả lời và `skipped` là số Skipped_Question.
2. IF body không phải JSON hợp lệ, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "invalid JSON body" }`.
3. IF `sessionId` thiếu hoặc không phải chuỗi khác rỗng, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "sessionId required" }`.
4. IF `answers` thiếu, không phải object thuần (null hoặc mảng), hoặc không có key nào, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "answers required" }`.
5. IF một giá trị trong `answers` không phải chuỗi, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "answers must be strings" }`.
6. IF một key trong `answers` không khớp id của Open_Question nào trong Clarification_Request đang chờ, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "unknown question id: <id>" }`.
7. IF một câu trả lời dài hơn 500 ký tự sau khi chuẩn hóa, THEN THE Clarification_Endpoint SHALL trả HTTP 400 với `{ "error": "answer too long" }`.
8. IF `sessionId` không tồn tại trong session repository, THEN THE Clarification_Endpoint SHALL trả HTTP 404 với `{ "error": "session not found" }`.
9. IF session tồn tại nhưng không có Clarification_Request nào đang chờ, THEN THE Clarification_Endpoint SHALL trả HTTP 409 với `{ "error": "session not awaiting clarification" }`.
10. IF một yêu cầu bị từ chối với mã 400, 404 hoặc 409, THEN THE Clarification_Coordinator SHALL giữ nguyên Clarification_Request đang chờ.

### Requirement 6: Gửi trùng lặp

**User Story:** Là người dùng, tôi muốn việc lỡ bấm gửi hai lần không làm hỏng phiên, để chỉ một bộ câu trả lời được dùng.

#### Acceptance Criteria

1. THE Clarification_Coordinator SHALL chấp nhận tối đa một bộ câu trả lời hợp lệ cho mỗi `requestId`.
2. WHEN một bộ câu trả lời hợp lệ được chấp nhận, THE Clarification_Coordinator SHALL gỡ Clarification_Request khỏi danh sách chờ trong cùng lời gọi đồng bộ, trước mọi thao tác bất đồng bộ.
3. IF Clarification_Endpoint nhận một yêu cầu thứ hai cho session mà Clarification_Request đã được chấp nhận, THEN THE Clarification_Endpoint SHALL trả HTTP 409 với `{ "error": "session not awaiting clarification" }`.
4. WHILE yêu cầu gửi câu trả lời đang được xử lý, THE Goals_Panel SHALL vô hiệu hóa các nút gửi của form đó.

### Requirement 7: Tiếp tục và gộp câu trả lời

**User Story:** Là người dùng, tôi muốn câu trả lời của tôi được agent coi là sự thật đã biết, để kế hoạch và mã sinh ra theo đúng ý tôi.

#### Acceptance Criteria

1. THE Mission_Stage SHALL chuẩn hóa mỗi câu trả lời như sau: loại ký tự điều khiển, gộp mọi chuỗi khoảng trắng (kể cả xuống dòng) thành một dấu cách, rồi trim.
2. WHEN câu trả lời đã chuẩn hóa của một Open_Question khác rỗng, THE Mission_Stage SHALL tạo một User_Statement trên một dòng theo định dạng `[user-provided] <question text> → <answer>`.
3. WHEN một key bị bỏ hoặc câu trả lời đã chuẩn hóa rỗng, THE Mission_Stage SHALL coi Open_Question đó là Skipped_Question.
4. WHILE Assumption_Advisor được wire, WHEN có ít nhất một Skipped_Question, THE Mission_Stage SHALL gọi Assumption_Advisor một lần với một bản sao Mission. Trong bản sao này `uncertainty.openQuestions` chỉ chứa văn bản các Skipped_Question.
5. IF Assumption_Advisor ném lỗi, THEN THE Mission_Stage SHALL tiếp tục chỉ với các User_Statement.
6. THE Mission_Stage SHALL trả `assumptions` gồm mọi User_Statement theo thứ tự id câu hỏi, tiếp theo là các Default_Assumption.
7. WHEN mọi Open_Question đều có câu trả lời, THE Mission_Stage SHALL đặt `uncertainty` của bản sao Mission thành `{ level: 'KNOWN', openQuestions: [] }`.
8. THE Mission_Stage SHALL giữ nguyên Goal (MI-004) và chỉ ghi câu trả lời vào bản sao Mission và vào `assumptions`.
9. WHEN Mission_Stage trả về `proceed: true` sau khi làm rõ, THE Session_Orchestrator SHALL truyền `assumptions` đã gộp vào mọi `TaskExecutorRequest` qua trường `goalAssumptions` hiện có, và tiếp tục gọi Planner.
10. WHEN Task_Executor dựng prompt cho một request có `goalAssumptions` chứa User_Statement, THE Task_Executor SHALL đưa các User_Statement đó vào section `STATED_ASSUMPTIONS`.

### Requirement 8: Hiển thị và gửi trong Goals panel

**User Story:** Là người dùng VS Code, tôi muốn thấy các câu hỏi ngay dưới goal của mình và trả lời bằng form dễ tiếp cận, để tôi không phải dùng công cụ khác.

#### Acceptance Criteria

1. WHILE session gắn với một entry của Goals_Panel đang ở `AWAITING_HUMAN`, WHEN event của session đó có một `GOAL_CLARIFICATION_REQUESTED` chưa có `GOAL_CLARIFICATION_ANSWERED` cùng `requestId`, THE Goals_Panel SHALL hiển thị các Open_Question của request đó ngay dưới entry, kèm nhãn trạng thái `needs input`.
2. THE Goals_Panel SHALL hiển thị mỗi Open_Question bằng một `<label>` hiển thị gắn với ô nhập văn bản qua thuộc tính `for`/`id`.
3. WHERE một Open_Question có `suggestedOptions`, THE Goals_Panel SHALL hiển thị các lựa chọn dưới dạng nhóm radio trong `<fieldset>` có `<legend>` là văn bản câu hỏi, kèm ô nhập văn bản tự do.
4. THE Goals_Panel SHALL cung cấp hai nút `<button>` dùng được bằng bàn phím: "Send answers" và "Use defaults for all".
5. WHEN người dùng kích hoạt "Send answers", THE Goals_Panel SHALL gửi message `{ type: 'clarify', sessionId, requestId, answers }`. Message này chứa mọi id câu hỏi, với chuỗi rỗng cho câu bỏ qua.
6. WHEN người dùng kích hoạt "Use defaults for all", THE Goals_Panel SHALL gửi message `clarify` với chuỗi rỗng cho mọi id câu hỏi.
7. WHEN extension nhận message `clarify`, THE Goals_Panel extension SHALL gọi `POST /clarification` với `{ sessionId, answers }`.
8. WHEN `POST /clarification` trả HTTP 200, THE Goals_Panel SHALL hiển thị thông báo xác nhận trong vùng `aria-live="polite"`.
9. IF `POST /clarification` trả mã khác 200, THEN THE Goals_Panel SHALL hiển thị chuỗi `error` từ response trong vùng `aria-live="polite"`, giữ nguyên giá trị người dùng đã nhập và bật lại các nút gửi.
10. THE Goals_Panel SHALL escape văn bản câu hỏi và lựa chọn trước khi chèn vào DOM.
11. WHEN form của một `requestId` mới xuất hiện lần đầu, THE Goals_Panel SHALL chuyển focus vào ô nhập đầu tiên đúng một lần cho `requestId` đó.

### Requirement 9: Lưu trữ và khởi động lại runtime

**User Story:** Là người vận hành, tôi muốn trạng thái làm rõ nằm trong event store hiện có, để có thể audit được và UI không cần kho lưu riêng.

#### Acceptance Criteria

1. THE Mission_Stage SHALL append các event `GOAL_CLARIFICATION_*` qua Event_Store hiện có mà không thêm bảng hay migration mới.
2. WHEN client gọi `GET /events?session=<id>&from=0`, THE observability server SHALL trả về các event `GOAL_CLARIFICATION_*` với dữ liệu trong trường `payload`, giống các event khác.
3. THE Goals_Panel SHALL suy ra câu hỏi đang mở chỉ từ event của session và trạng thái session, không dùng kho lưu cục bộ của extension.
4. IF runtime khởi động lại trong lúc một Clarification_Request đang chờ, THEN THE Clarification_Endpoint SHALL trả HTTP 409 `session not awaiting clarification` cho session đó. Trong trường hợp này THE Goals_Panel SHALL hiển thị thông báo lỗi đó trong vùng `aria-live`.

### Requirement 10: Kiểm thử

**User Story:** Là người bảo trì, tôi muốn tính năng có test tự động bằng vitest, để chống hồi quy cho cả chế độ bật và tắt.

#### Acceptance Criteria

1. THE test suite SHALL có test vitest cho các hàm thuần làm rõ (dựng request, kiểm tra hợp lệ, chuẩn hóa, gộp) trong thư mục `tests/mission/`.
2. THE test suite SHALL có một test chứng minh rằng Mission_Stage không có Clarification_Coordinator thì không phát event `GOAL_CLARIFICATION_*` và trả về cùng `assumptions` như hành vi hiện có.
3. THE test suite SHALL có test cho Clarification_Endpoint, gồm mỗi mã 200, 400, 404, 409 và 501 ở Requirement 1 và Requirement 5.
4. THE test suite SHALL có test cho Clarification_Coordinator bằng clock và sleep giả, gồm các trường hợp answered, timeout, cancelled và gửi trùng lặp.
5. THE test suite SHALL có test cho hàm suy ra câu hỏi đang mở của Goals_Panel trong `tests/vscode-extension/`.
6. THE test suite SHALL chạy được bằng lệnh `node node_modules/vitest/vitest.mjs run <path>`. THE monorepo SHALL build không lỗi bằng `npm run build`.
