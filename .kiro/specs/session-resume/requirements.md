# Requirements Document

## Introduction

Tính năng "Session Resume" cho phép runtime CodeForge **tiếp tục** một session đang chờ con người
sau khi tiến trình runtime bị khởi động lại (tắt máy, Ctrl+C, crash, reload VS Code). Hiện tại,
khi runtime restart lúc một session đang ở `AWAITING_HUMAN` chờ câu trả lời làm rõ (Goal
Clarification Gate, Phase 1), run đó mất hẳn: waiter của `ClarificationCoordinator` chỉ nằm trong
bộ nhớ, `orchestrator.run()` không chạy lại được cho session đã có, goal không được lưu vào DB,
và `POST /clarification` trả 409. Session cũ bị bỏ lại ở `AWAITING_HUMAN` mãi mãi.

Phase 2 của Goal Clarification (chọn giữa nhiều phương án kế hoạch) sẽ khiến thời gian chờ người
dài hơn, nên khả năng resume là điều kiện tiên quyết.

Phạm vi v1 ("pre-planning resume"):

1. Lưu Goal và hàng đợi goal vào SQLite để không mất goal khi restart.
2. Khi khởi động, phát hiện các session "mồ côi" (thuộc một tiến trình runtime đã chết) và xử lý
   từng loại một cách tường minh:
   - session đang chờ làm rõ **trước planning** → **resume**: nhận lại workspace lock, khôi phục
     yêu cầu làm rõ đang mở với cùng `requestId`, chờ câu trả lời, rồi lập kế hoạch như bình thường;
   - mọi session mồ côi khác (đã có graph/đang thực thi, chờ phê duyệt tool, PAUSED) → **đóng
     tường minh** (ABORT kèm lý do), không để treo.
3. Không đổi hành vi khi không có session mồ côi.

Ngoài phạm vi v1: resume giữa lúc thực thi task (task run dở, tool call dở, process con),
resume chờ phê duyệt tool, và resume trên một máy khác.

## Glossary

- **Runtime_CLI**: tiến trình runtime (`packages/infrastructure/src/cli/runtime-cli.ts`).
- **Session_Service**: `SessionService`, nơi duy nhất có quyền chuyển trạng thái session.
- **Session_Orchestrator**: `SessionOrchestrator`, điều phối mission stage → planning → thực thi.
- **Mission_Stage**: `MissionIntelligence`.
- **Clarification_Coordinator**: `ClarificationCoordinator` (Phase 1).
- **Event_Store**: `EventLog` SQLite.
- **Goal_Store**: bảng `goals` có sẵn (migration 0001) qua `SqliteGoalRepository`.
- **Goal_Queue**: hàng đợi FIFO các goal đã nhận nhưng chưa bắt đầu session.
- **Orphaned_Session**: session ở trạng thái không-kết-thúc (`CREATED`, `INITIALIZING`, `RUNNING`,
  `AWAITING_HUMAN`, `PAUSED`, `CANCELLING`) mà `metadata.hostname` là máy hiện tại và
  `metadata.processId` là một tiến trình không còn sống.
- **Resumable_Session**: Orphaned_Session ở `AWAITING_HUMAN` có một `GOAL_CLARIFICATION_REQUESTED`
  chưa có `GOAL_CLARIFICATION_ANSWERED` cùng `requestId`, và chưa có graph nào được commit ngoài
  graph seed rỗng (version 1, không node).
- **Startup_Recovery**: bước chạy một lần lúc Runtime_CLI khởi động, trước khi worker nhận goal mới.

## Requirements

### Requirement 1: Lưu goal và hàng đợi

**User Story:** Là người dùng, tôi muốn goal tôi đã gửi không bị mất khi runtime restart, để không
phải gửi lại.

#### Acceptance Criteria

1. WHEN Runtime_CLI nhận một goal (qua `--goal` hoặc `POST /goal`), THE Runtime_CLI SHALL ghi Goal
   vào Goal_Store trước khi trả kết quả cho client.
2. THE Goal_Queue SHALL được lưu bền vững, sao cho sau khi restart, các goal đã nhận nhưng chưa bắt
   đầu session được xếp lại theo đúng thứ tự FIFO ban đầu.
3. WHEN một goal được lấy ra khỏi Goal_Queue để chạy, THE Runtime_CLI SHALL đánh dấu nó đã bắt đầu
   kèm `sessionId`, trong cùng thao tác với việc lấy ra, để một goal không bao giờ chạy hai lần.
4. THE Session_Orchestrator SHALL đọc Goal của một session từ Goal_Store (theo `session.goalId`) khi
   resume, không phải từ payload event.

### Requirement 2: Phát hiện session mồ côi

**User Story:** Là người vận hành, tôi muốn runtime nhận ra các session bị bỏ dở từ lần chạy trước,
để không có session nào treo vô thời hạn.

#### Acceptance Criteria

1. WHEN Runtime_CLI khởi động, THE Startup_Recovery SHALL liệt kê mọi Orphaned_Session của
   workspace hiện tại trước khi worker bắt đầu lấy goal.
2. THE Startup_Recovery SHALL coi một session là mồ côi chỉ khi `metadata.hostname` trùng máy hiện
   tại và tiến trình `metadata.processId` không còn sống. Session của tiến trình còn sống hoặc của
   máy khác SHALL không bị động tới.
3. THE Startup_Recovery SHALL phân loại mỗi Orphaned_Session thành đúng một trong hai loại:
   Resumable_Session hoặc phải đóng.
4. THE Startup_Recovery SHALL ghi một event `SESSION_RECOVERY_DECIDED` cho mỗi Orphaned_Session,
   với payload `{ decision: 'resume' | 'abort', reason, previousProcessId }`.

### Requirement 3: Đóng tường minh các session không resume được

**User Story:** Là người dùng, tôi muốn session không tiếp tục được hiện rõ là đã dừng và lý do,
thay vì đứng mãi ở trạng thái đang chạy.

#### Acceptance Criteria

1. WHEN một Orphaned_Session không phải Resumable_Session, THE Startup_Recovery SHALL chuyển nó
   sang `ABORTED` qua Session_Service với sự kiện `ABORT`.
2. THE Startup_Recovery SHALL ghi lý do đóng vào `SESSION_RECOVERY_DECIDED`
   (ví dụ `runtime restarted during execution`, `runtime restarted while awaiting tool approval`).
3. WHEN một session bị đóng theo cách này, THE workspace lock của nó SHALL được giải phóng.
4. THE Startup_Recovery SHALL không sửa đổi file nào trong workspace khi đóng session.

### Requirement 4: Resume session đang chờ làm rõ

**User Story:** Là người dùng, tôi muốn trả lời câu hỏi làm rõ sau khi runtime restart và để agent
tiếp tục đúng goal đó.

#### Acceptance Criteria

1. WHEN Startup_Recovery quyết định resume một Resumable_Session, THE Runtime_CLI SHALL nhận lại
   workspace lock cho session đó và cập nhật `metadata.processId` sang tiến trình hiện tại.
2. THE Runtime_CLI SHALL resume tối đa một session tại một thời điểm (SS-001: một session hoạt động
   mỗi workspace). Nếu có nhiều Resumable_Session, THE Startup_Recovery SHALL resume session mới
   nhất và đóng các session còn lại theo Requirement 3.
3. WHEN resume, THE Session_Orchestrator SHALL bắt đầu từ trạng thái `AWAITING_HUMAN` hiện có, không
   phát lại `SESSION_INITIALIZED` / `SESSION_READY`.
4. WHEN resume, THE Mission_Stage SHALL khôi phục Clarification_Request đang mở từ payload
   `GOAL_CLARIFICATION_REQUESTED` (cùng `requestId`, cùng id và văn bản câu hỏi) và chờ qua
   Clarification_Coordinator, không tạo request mới.
5. WHILE session resume đang chờ, THE `POST /clarification` SHALL chấp nhận câu trả lời cho
   session đó với cùng hợp đồng như Phase 1 (200/400/404/409/501).
6. WHEN câu trả lời được chấp nhận, THE luồng SHALL tiếp tục giống hệt Phase 1: gộp câu trả lời,
   gọi Assumption_Advisor cho câu bỏ qua, phát `GOAL_CLARIFICATION_ANSWERED`, chuyển session về
   `RUNNING`, lập kế hoạch và thực thi.
7. THE Mission_Stage SHALL không phát lại các event phân tích (`MISSION_RECEIVED`,
   `MISSION_CLASSIFIED`, …, `GOAL_CLARIFICATION_REQUESTED`) đã có trong Event_Store của session.
8. WHEN resume, THE Session_Orchestrator SHALL tính lại `WorkspaceRevision` từ workspace hiện tại.
9. IF workspace đã thay đổi so với revision lúc session bắt đầu, THEN THE Runtime_CLI SHALL ghi một
   cảnh báo vào console và vào payload `SESSION_RECOVERY_DECIDED` (`workspaceChanged: true`), và
   vẫn resume.

### Requirement 5: Thứ tự giữa resume và hàng đợi

**User Story:** Là người dùng, tôi muốn session đang dở được ưu tiên trước goal mới, để công việc
không bị chen ngang.

#### Acceptance Criteria

1. WHILE một session đang được resume và chưa kết thúc, THE worker SHALL không bắt đầu goal nào từ
   Goal_Queue.
2. WHEN session resume kết thúc (COMPLETED hoặc ABORTED), THE worker SHALL tiếp tục lấy goal từ
   Goal_Queue như bình thường.
3. WHEN người dùng cancel session resume (qua `POST /control`), THE session SHALL kết thúc như
   Phase 1 (không lập kế hoạch) và lock SHALL được giải phóng.

### Requirement 6: Hiển thị trong Goals panel

**User Story:** Là người dùng VS Code, tôi muốn sau khi runtime restart vẫn thấy câu hỏi đang mở và
trả lời được ngay.

#### Acceptance Criteria

1. WHEN session được resume, THE Goals_Panel SHALL tiếp tục hiển thị form làm rõ của request cũ mà
   không cần thay đổi logic suy ra từ event (`findOpenClarification`).
2. WHEN người dùng gửi câu trả lời cho session đã resume, THE Goals_Panel SHALL nhận HTTP 200 thay
   cho 409.
3. WHEN một session bị đóng bởi Startup_Recovery, THE Goals_Panel SHALL hiển thị entry đó là
   `failed`.

### Requirement 7: Bất biến và tương thích

**User Story:** Là người bảo trì, tôi muốn tính năng này không phá vỡ các bất biến kernel.

#### Acceptance Criteria

1. THE tính năng SHALL không thêm trạng thái session mới và không thêm chuyển trạng thái mới vào
   `SESSION_TRANSITIONS`.
2. THE tính năng SHALL giữ SS-001: tại mọi thời điểm có tối đa một lock hoạt động mỗi workspace.
3. THE tính năng SHALL giữ SS-007: session chỉ rời `AWAITING_HUMAN` về `RUNNING` khi đã ghi nhận
   quyết định của con người.
4. THE tính năng SHALL giữ MI-004: không sửa Goal.
5. WHEN không có Orphaned_Session lúc khởi động, THE Runtime_CLI SHALL hoạt động y hệt trước đây
   (ngoài việc lưu goal và hàng đợi).
6. THE tính năng SHALL chạy được bằng `npm run build`, và bộ test đầy đủ, `eslint`, `depcruise`
   SHALL không có lỗi.

### Requirement 8: Kiểm thử

**User Story:** Là người bảo trì, tôi muốn có test cho từng nhánh phục hồi.

#### Acceptance Criteria

1. THE test suite SHALL có test cho việc phân loại Orphaned_Session (resume / abort, kèm lý do) bằng
   dữ liệu event và session giả.
2. THE test suite SHALL có test tích hợp mô phỏng restart: một runtime dừng khi đang chờ làm rõ, một
   runtime mới khởi động trên cùng DB, nhận câu trả lời qua `POST /clarification`, rồi lập kế hoạch.
3. THE test suite SHALL có test cho việc lưu và khôi phục Goal_Queue, kể cả việc một goal không bao
   giờ chạy hai lần.
4. THE test suite SHALL có test chứng minh session của tiến trình còn sống hoặc của máy khác không bị
   động tới.