# Implementation Plan: Plan Options (Goal Clarification Phase 2)

## Overview

Làm từ lõi thuần ra ngoài: hàm thuần + event types → ApproachAdvisor → tích hợp MissionIntelligence →
Planner/orchestrator → refactor lõi chờ + PlanChoiceCoordinator → endpoint → CLI + resume → Goals panel
→ tài liệu + checkpoint. Trước commit: theo `.kiro/steering/commit-gate.md`.

## Tasks

- [x] 1. Lõi thuần (agent-core)
  - [x] 1.1 Event types và `mission/plan-options.ts`
    - `KnownEventType` += `PLAN_OPTIONS_PROPOSED`, `PLAN_OPTION_CHOSEN`.
    - Types, `PLAN_OPTION_LIMITS`, `sanitizePlanOptions`, `buildPlanOptionsRequest`, `validatePlanChoice`,
      `resolveChosenApproach`, `chosenApproachStatement`, `renderChosenApproachSection`,
      `shouldProposePlanOptions`. Export qua `mission/index.ts`.
    - _Requirements: 2.1, 2.2, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.5, 5.2, 5.5, 5.6, 6.4_
  - [x]* 1.2 Property test cho sanitize và validate
    - File `tests/mission/plan-options.spec.ts`.
    - **Property 1: Sanitize đúng giới hạn và đúng một khuyến nghị**
    - **Property 2: Kiểm tra lựa chọn**
    - **Validates: Requirements 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.5, 5.6**

- [x] 2. `ApproachAdvisor` (agent-core)
  - [x] 2.1 Hiện thực advisor theo khuôn `AssumptionAdvisor` (gateway duy nhất, bounded retries, ném khi hết lượt)
    - _Requirements: 2.5, 3.1, 3.6_
  - [x]* 2.2 Unit test với FakeModel
    - File `tests/mission/approach-advisor.spec.ts`.
    - _Requirements: 2.5, 3.6_

- [x] 3. Tích hợp vào stage, orchestrator và Planner (agent-core)
  - [x] 3.1 `MissionIntelligence`: deps `approachAdvisor` / `planChoiceGate`, bước đề xuất sau làm rõ,
    `chosenApproach` trong outcome, `resumePlanChoice` (dùng `priorAssumptions`, không gọi advisor)
    - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.3, 4.4, 4.5, 4.6, 6.1, 6.4, 6.6, 8.2_
  - [x] 3.2 Orchestrator + Planner: `MissionStageDecision.chosenApproach`, `SessionOrchestratorResumeInput.resume`,
    tham số `chosenApproach` của `Planner.plan`, section `CHOSEN_APPROACH`; cập nhật caller và test resume v1
    - _Requirements: 6.2, 6.3, 6.5_
  - [x]* 3.3 Test stage + Planner
    - File `tests/mission/mission-intelligence-plan-options.spec.ts`: **Property 4: Tắt cờ thì không đổi**,
      các nhánh theo design; test Planner có/không `chosenApproach`.
    - **Validates: Requirements 1.2, 2.1–2.6, 4.4–4.6, 6.3, 6.5, 8.2**

- [x] 4. Checkpoint: lõi agent-core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Lõi chờ dùng chung + `PlanChoiceCoordinator` (infrastructure)
  - [x] 5.1 Tách `HumanDecisionWaiter<TRequest, TAnswer>`; `ClarificationCoordinator` dùng lại, API không đổi
    - _Requirements: 4.2, 4.7_
  - [x] 5.2 `PlanChoiceCoordinator` (`awaitChoice`, `submit` đồng bộ với `validatePlanChoice`)
    - _Requirements: 4.2, 4.5, 4.6, 5.9_
  - [x]* 5.3 Test coordinator
    - File `tests/approval-runtime/plan-choice-coordinator.spec.ts`: **Property 3: Tối đa một lựa chọn được chấp nhận**
      + timing/transition; chạy lại `clarification-coordinator.spec.ts` không sửa.
    - **Validates: Requirements 4.2, 5.8, 5.9**

- [x] 6. Endpoint `POST /plan-choice`
  - [x] 6.1 Port + `ObservabilityService.submitPlanChoice` + route theo bảng C6
    - _Requirements: 1.5, 5.1–5.8_
  - [x]* 6.2 Test HTTP cho từng dòng bảng hợp đồng
    - Bổ sung `tests/observability-server/http-transport.spec.ts`.
    - _Requirements: 9.3_

- [x] 7. CLI và session resume
  - [x] 7.1 Cờ `--plan-options` trong `runtime-cli.ts` (cảnh báo, banner, wiring advisor + coordinator)
    - _Requirements: 1.1, 1.3, 1.4_
  - [x] 7.2 Resume: `openPlanChoice` trong `OrphanSnapshot` / `SqliteOrphanSource`, `classifyOrphan` với
    `planOptionsEnabled`, `ResumePlan.kind`, `resumeSession` chọn đúng loại resume
    - _Requirements: 8.1, 8.2, 8.3_
  - [x]* 7.3 Test resume + test tích hợp
    - Bổ sung `tests/session/startup-recovery*.spec.ts`; file mới `tests/integration/plan-options-e2e.spec.ts`
      (chọn qua HTTP → Planner nhận `CHOSEN_APPROACH`, executor nhận `[chosen-approach]`).
    - _Requirements: 8.1, 8.3, 9.4, 9.5_

- [x] 8. Goals panel (VS Code)
  - [x] 8.1 `findOpenPlanChoice` + `postPlanChoice`
    - _Requirements: 7.1, 7.7_
  - [x] 8.2 Render thẻ phương án trong `goals-webview.ts` (fieldset/radio, pros/cons, recommended, hai nút,
    aria-live, escape, ưu tiên form làm rõ)
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.8_
  - [x] 8.3 Nối message trong `extension.ts`; setting `codeforge.planOptions` + `buildRuntimeArgv`
    - _Requirements: 1.6, 7.5_
  - [x]* 8.4 Test extension
    - **Property 5: Projection phương án đang mở**; `postPlanChoice` với fetch giả; HTML panel; launch args.
    - **Validates: Requirements 1.6, 7.1, 7.7**

- [x] 9. Tài liệu và checkpoint cuối
  - [x] 9.1 Cập nhật README (cờ, panel), PROJECT_STATUS, ROADMAP (Tier C Phase 2), PHASE_12_SIGNOFF addendum,
    README extension (setting), mục resume nếu cần
    - _Requirements: 9.1_
  - [x] 9.2 Checkpoint cuối: `npm run build`; WSL `scripts/_wsl-tmp.sh`; smoke test CLI với runtime thật
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Task có `*` là test; sẽ làm cả các task này như các phase trước.
- Không thêm trạng thái/transition session, không migration.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "5.1", "8.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "5.2", "8.2"] },
    { "id": 3, "tasks": ["3.2", "5.3", "6.1", "8.3"] },
    { "id": 4, "tasks": ["3.3", "6.2", "7.1", "8.4"] },
    { "id": 5, "tasks": ["7.2"] },
    { "id": 6, "tasks": ["7.3", "9.1"] }
  ]
}
```