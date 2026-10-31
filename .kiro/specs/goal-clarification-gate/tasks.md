# Implementation Plan: Goal Clarification Gate (Phase 1)

## Overview

Các task được làm tăng dần từ lõi thuần (agent-core) ra ngoài:

1. hàm thuần và event types;
2. tích hợp vào `MissionIntelligence`;
3. `ClarificationCoordinator` ở infrastructure;
4. endpoint `POST /clarification`;
5. wiring CLI (`--clarify on`);
6. Goals panel của VS Code.

Ngôn ngữ là TypeScript. Test dùng vitest, chạy bằng `node node_modules/vitest/vitest.mjs run <path>`. Property test dùng generator có seed tự viết (repo không có `fast-check`), mỗi property ≥ 100 vòng. Không sửa `SessionOrchestrator`, `TaskExecutor` hay session state machine, vì đường `assumptions → goalAssumptions → STATED_ASSUMPTIONS` đã có sẵn.

## Tasks

- [x] 1. Lõi thuần cho làm rõ goal (agent-core)
  - [x] 1.1 Thêm event types và module `goal-clarification.ts`
    - Thêm `'GOAL_CLARIFICATION_REQUESTED'` và `'GOAL_CLARIFICATION_ANSWERED'` vào `KnownEventType` trong `packages/agent-core/src/domain/event.ts`.
    - Tạo `packages/agent-core/src/mission/goal-clarification.ts`, gồm:
      - các types: `OpenQuestion`, `ClarificationRequest`, `ClarificationAnswers`, `ClarificationOutcome`, `ClarificationGate`, `AnswerValidation`, `AnswerValidationCode`, `AnsweredQuestion`, `MergedClarification`;
      - các hằng: `MAX_ANSWER_LENGTH = 500` và bảng tĩnh `SUGGESTED_OPTIONS`, keyed theo văn bản câu hỏi của `uncertainty-analyzer.ts`;
      - các hàm: `buildClarificationRequest`, `normalizeAnswer`, `validateClarificationAnswers` (thứ tự kiểm tra như design C1), `mergeClarificationAnswers` (định dạng `[user-provided] <q> → <a>`).
    - Export từ `packages/agent-core/src/mission/index.ts`, và kiểm tra rằng root index của agent-core re-export.
    - _Requirements: 2.3, 2.4, 2.5, 4.5, 5.4, 5.5, 5.6, 5.7, 7.1, 7.2, 7.3, 7.6_

  - [x]* 1.2 Tạo generator có seed và viết property test cho dựng request
    - Tạo `tests/mission/clarification-generators.ts` (PRNG mulberry32 + generator chuỗi, câu hỏi, map câu trả lời, đầu vào lỗi).
    - File `tests/mission/goal-clarification-request.spec.ts`.
    - **Property 1: Dựng request tất định**
    - **Validates: Requirements 2.3, 2.4**

  - [x]* 1.3 Viết property test cho chuẩn hóa câu trả lời
    - File `tests/mission/goal-clarification-normalize.spec.ts`.
    - **Property 2: Chuẩn hóa câu trả lời**
    - **Validates: Requirements 7.1**

  - [x]* 1.4 Viết property test cho gộp câu trả lời
    - File `tests/mission/goal-clarification-merge.spec.ts`.
    - **Property 3: Gộp câu trả lời phân hoạch đúng câu hỏi**
    - **Validates: Requirements 5.1, 7.2, 7.3, 7.6**

  - [x]* 1.5 Viết property test cho kiểm tra hợp lệ
    - File `tests/mission/goal-clarification-validate.spec.ts`.
    - **Property 4: Kiểm tra hợp lệ từ chối đầu vào sai với đúng mã lỗi**
    - **Validates: Requirements 5.4, 5.5, 5.6, 5.7**

- [x] 2. Tích hợp cổng vào `MissionIntelligence`
  - [x] 2.1 Thêm dep `clarificationGate` và nhánh làm rõ
    - Thêm `readonly clarificationGate?: ClarificationGate` vào `MissionIntelligenceDeps`.
    - Tách khối Tier B1 thành private method `resolveAmbiguity(...)`. Nhánh cũ giữ nguyên hành vi khi không có gate, hoặc khi level khác `UNKNOWN`, hoặc khi không có câu hỏi mở.
    - Nhánh cổng chạy theo thứ tự sau:
      1. emit `GOAL_CLARIFICATION_REQUESTED`;
      2. `awaitAnswers`;
      3. `mergeClarificationAnswers`;
      4. gọi `AssumptionAdvisor` chỉ cho các câu bỏ qua (try/catch), emit `MISSION_ASSUMPTIONS_MADE` khi có giả định mặc định;
      5. nếu mọi câu đã được trả lời, đặt `uncertainty` thành `KNOWN`;
      6. emit `GOAL_CLARIFICATION_ANSWERED` với `source` là `'user'` hoặc `'timeout'`;
      7. `assumptions = [...userStatements, ...defaults]`.
    - Khi `cancelled`: trả sớm `proceed:false`, `blockers:['clarification cancelled']`, vẫn tính các trường thuần bắt buộc nhưng bỏ qua routing và architect, không emit `ANSWERED`.
    - Không đổi Goal (MI-004).
    - _Requirements: 1.2, 2.1, 2.2, 3.6, 4.1, 4.2, 4.3, 4.4, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x]* 2.2 Viết property test cho parity khi tắt cờ
    - File `tests/mission/mission-intelligence-clarify-parity.spec.ts`, dùng `FakeModel` và `MemoryEventLog` theo mẫu `tests/mission/mission-intelligence.spec.ts`.
    - **Property 6: Tắt cờ thì hành vi không đổi**
    - **Validates: Requirements 1.2, 2.2**

  - [x]* 2.3 Viết unit test cho các nhánh của stage
    - File `tests/mission/mission-intelligence-clarify.spec.ts`, dùng gate giả.
    - Các trường hợp:
      - `REQUESTED` được emit trước `awaitAnswers`;
      - tất cả câu được trả lời → `KNOWN` và advisor không được gọi;
      - một phần câu bị bỏ qua → advisor chỉ nhận các câu bỏ qua + `MISSION_ASSUMPTIONS_MADE`;
      - advisor lỗi → chỉ còn User_Statement;
      - timeout → `source:'timeout'`;
      - cancelled → `proceed:false`, không có `ANSWERED`;
      - goal KNOWN/INFERRED không gọi gate;
      - Goal deep-equal trước và sau.
    - _Requirements: 2.1, 2.2, 3.6, 4.1, 4.2, 4.3, 4.4, 7.4, 7.5, 7.7, 7.8_

- [x] 3. Checkpoint: kiểm tra lõi agent-core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. `ClarificationCoordinator` (infrastructure)
  - [x] 4.1 Hiện thực coordinator
    - Tạo `packages/infrastructure/src/approval-runtime/clarification-coordinator.ts`, dùng lại `SessionTransitionPort` từ `approval-coordinator.ts`. Thêm port `SessionStateReader`.
    - `awaitAnswers` chạy như sau:
      1. đăng ký entry chờ;
      2. gọi `HUMAN_REQUIRED` (lỗi và state khác `AWAITING_HUMAN` → `cancelled`);
      3. vòng lặp `Promise.race(answered, sleep(pollIntervalMs))`, kiểm tra state (`cancelled`) và deadline `maxWaitMs` (`timeout`);
      4. ở `finally`, xóa entry. Với answered hoặc timeout, gọi `HUMAN_DECIDED {humanDecisionRecorded:true}`.

      Hàm không bao giờ ném lỗi.
    - `submit` là hàm đồng bộ và chạy như sau:
      1. không có entry → `NOT_AWAITING`;
      2. gọi `validateClarificationAnswers`; nếu lỗi, trả lỗi và giữ entry;
      3. xóa entry, rồi resolve;
      4. trả `{ ok, requestId, answered, skipped }`.
    - Export từ index của infrastructure (cạnh `NodeApprovalCoordinator`).
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 5.9, 5.10, 6.1, 6.2_

  - [x]* 4.2 Viết property test cho chấp nhận tối đa một lần
    - File `tests/approval-runtime/clarification-coordinator.spec.ts`.
    - **Property 5: Chấp nhận tối đa một lần cho mỗi request**
    - **Validates: Requirements 5.10, 6.1, 6.3**

  - [x]* 4.3 Viết unit test thời gian và chuyển trạng thái cho coordinator
    - Thêm vào `tests/approval-runtime/clarification-coordinator.spec.ts`, dùng `nowMs`/`sleep` giả và session port giả.
    - Các trường hợp:
      - `HUMAN_REQUIRED` được gọi trước khi chờ;
      - `HUMAN_DECIDED {humanDecisionRecorded:true}` sau answered và sau timeout;
      - cancelled khi state đổi sang `CANCELLING`, và không gọi `HUMAN_DECIDED`;
      - hai `submit` liên tiếp không await → lần hai `NOT_AWAITING`;
      - coordinator mới (giả lập restart) → `NOT_AWAITING`.
    - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 6.2, 9.4_

- [x] 5. Endpoint `POST /clarification`
  - [x] 5.1 Thêm port và method vào `ObservabilityService`
    - Thêm interface `ClarificationIngressPort` và dep `clarification?`. Thêm mã `'CLARIFICATION_UNSUPPORTED'` vào `ObservabilityServiceError`.
    - `submitClarification(sessionId, rawAnswers)`:
      - không có port → throw `CLARIFICATION_UNSUPPORTED`;
      - session không tồn tại → throw `SESSION_NOT_FOUND`;
      - còn lại → ủy quyền cho `port.submit`.
    - _Requirements: 1.5, 5.8, 5.9_

  - [x] 5.2 Thêm route vào `HttpTransport`
    - Thêm route `POST /clarification` trong `http-transport.ts`, theo đúng thứ tự kiểm tra và ánh xạ mã HTTP trong bảng hợp đồng của design C4 (400/501/404/409/400/200).
    - Cập nhật comment Routes ở đầu file.
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 6.3_

  - [x]* 5.3 Viết test HTTP cho hợp đồng endpoint
    - Bổ sung vào `tests/observability-server/http-transport.spec.ts` (server thật trên port 0, port giả).
    - Mỗi dòng của bảng hợp đồng cần một test: 200 kèm `{requestId, answered, skipped}`, `invalid JSON body`, `sessionId required`, `answers required` (`{}`, `null`, mảng), `answers must be strings`, `unknown question id`, `answer too long`, 404, 409 (gửi lần hai), 501 (chưa wire).
    - _Requirements: 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 6.3_

- [x] 6. Wiring CLI và kiểm tra tích hợp
  - [x] 6.1 Thêm cờ `--clarify` vào `runtime-cli.ts`
    - Parse `--clarify <on|off>` (mặc định off). Hiệu lực chỉ khi có `--mission on`; ngược lại in cảnh báo.
    - Khi bật: tạo `ClarificationCoordinator`, truyền `clarificationGate` vào `MissionIntelligence` và `clarification` vào `ObservabilityService`.
    - Thêm dòng `Clarify:` vào banner và cập nhật comment usage ở đầu file.
    - _Requirements: 1.1, 1.3, 1.4_

  - [x]* 6.2 Viết test tích hợp luồng làm rõ đến planning
    - File `tests/integration/clarification-e2e.spec.ts`.
    - `SessionOrchestrator` + `MissionIntelligence` + gate giả trả lời. Kiểm tra:
      - Planner chỉ được gọi sau khi gate resolve;
      - `TaskExecutorRequest.goalAssumptions` chứa `[user-provided] …`;
      - prompt có section `STATED_ASSUMPTIONS` chứa statement đó.
    - _Requirements: 3.3, 7.9, 7.10, 9.1_

- [x] 7. Checkpoint: kiểm tra runtime
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Goals panel của VS Code
  - [x] 8.1 Thêm client method và projection thuần
    - `runtime-client.ts`: thêm `postClarification(sessionId, answers)`, trả `{ status, body }` và không ném lỗi (lỗi mạng → `status: 0`, `error: 'runtime unreachable'`).
    - `goal-history.ts`: thêm `OpenClarificationView` và `findOpenClarification(events)`, parse payload một cách phòng thủ.
    - _Requirements: 8.1, 8.7, 9.3_

  - [x]* 8.2 Viết property test cho projection câu hỏi đang mở
    - Bổ sung vào `tests/vscode-extension/goal-history.spec.ts`, cùng ví dụ payload hỏng và ví dụ `postClarification` với fetch giả.
    - **Property 7: Projection câu hỏi đang mở từ event**
    - **Validates: Requirements 8.1, 9.3**

  - [x] 8.3 Render form làm rõ trong `goals-webview.ts`
    - `GoalEntryView.clarification?` và chip `needs input`.
    - Form: `<label for>` + `<input type="text">` cho mỗi câu; `<fieldset><legend>` + radio cho `suggestedOptions`; các nút "Send answers" và "Use defaults for all"; vùng `role="status" aria-live="polite"`.
    - Escape mọi văn bản bằng `esc()`. Vô hiệu hóa nút khi đang gửi. Focus đúng một lần cho mỗi `requestId`. Giữ giá trị đang nhập qua các lần re-render.
    - Protocol: `clarify` (webview → extension) và `clarifyResult` (extension → webview). Cập nhật comment protocol.
    - _Requirements: 6.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.8, 8.9, 8.10, 8.11_

  - [x] 8.4 Nối dữ liệu và message trong `extension.ts`
    - Trong `refreshAll`: với các entry có session ở `AWAITING_HUMAN`, gọi `getEvents` → `findOpenClarification`, rồi lưu vào `Map` chỉ dùng cho view (không ghi `globalState`).
    - `toEntryView` gắn `clarification`.
    - Handler `clarify`: gọi `postClarification`, post `clarifyResult` (200 → `Answers sent (answered N, skipped M)`; khác 200 → `body.error`), sau đó gọi `refreshAll()`.
    - _Requirements: 8.1, 8.7, 8.8, 8.9, 9.3, 9.4_

  - [x] 8.5 Thêm setting `codeforge.clarify` để khởi chạy runtime
    - `packages/vscode-extension/package.json`: thêm configuration boolean `codeforge.clarify`, mặc định `false`.
    - `runtime-launch.ts`: `RuntimeLaunchSpec.clarify?`. `buildRuntimeArgs` thêm `--mission on --clarify on` khi giá trị là `true`. Truyền giá trị từ setting ở chỗ `extension.ts` dựng spec.
    - _Requirements: 1.6_

  - [x]* 8.6 Viết unit test cho launch args và HTML panel
    - Test `buildRuntimeArgs` với `clarify` bằng `true`/`false`. Test `goalsPanelHtml` chứa `aria-live="polite"` và xử lý message `clarifyResult`.
    - _Requirements: 1.6, 8.8_

- [x] 9. Checkpoint cuối: build và chạy test
  - Chạy `npm run build` và bảo đảm build không lỗi.
  - Chạy `node node_modules/vitest/vitest.mjs run tests/mission tests/approval-runtime tests/observability-server tests/vscode-extension tests/integration/clarification-e2e.spec.ts`.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Task có `*` là tùy chọn (test) và có thể bỏ qua nếu muốn có MVP nhanh hơn.
- Mỗi task tham chiếu acceptance criteria cụ thể trong `requirements.md` để truy vết.
- Property test dùng generator có seed tự viết (không thêm dependency), mỗi property ≥ 100 vòng, với tag `// Feature: goal-clarification-gate, Property N: …`.
- Hạn chế đã ghi trong design: runtime khởi động lại trong lúc chờ thì run không được tiếp tục. Endpoint trả 409 và người dùng cần gửi lại goal.
- Nếu vượt ngân sách LOC, có thể bỏ nhóm radio `suggestedOptions` trong 8.3 (chỉ giữ ô nhập văn bản).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.1", "8.1"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5", "2.2", "5.1", "8.2", "8.3"] },
    { "id": 3, "tasks": ["2.3", "4.2", "5.2", "8.4"] },
    { "id": 4, "tasks": ["4.3", "5.3", "6.1", "8.5"] },
    { "id": 5, "tasks": ["6.2", "8.6"] }
  ]
}
```
