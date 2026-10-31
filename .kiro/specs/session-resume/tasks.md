# Implementation Plan: Session Resume (v1)

## Overview

Làm từ lõi thuần ra ngoài: event types + phân loại thuần → `adopt` → hàng đợi bền vững (migration
0007) → `StartupRecovery` → resume trong mission stage / orchestrator → wiring CLI → test tích hợp
restart. TypeScript; test bằng vitest (`node node_modules/vitest/vitest.mjs run <path>`), property
test dùng generator có seed (≥ 100 vòng). Trước commit: theo `.kiro/steering/commit-gate.md`.

## Tasks

- [x] 1. Lõi thuần cho startup recovery (agent-core)
  - [x] 1.1 Thêm event types và module `session/startup-recovery.ts`
    - `KnownEventType` += `SESSION_RECOVERY_DECIDED`, `SESSION_ADOPTED`, `SESSION_RESUMED`.
    - Types `OrphanSnapshot`, `OrphanDecision`, `ResumePlan`, port `OrphanSource`.
    - Hàm thuần `classifyOrphan` (thứ tự kiểm tra theo bảng design C4) và `planRecovery`.
    - Export qua `session/index.ts` (và root index).
    - _Requirements: 2.3, 3.2, 4.2, 7.1_
  - [x]* 1.2 Property test cho phân loại
    - File `tests/session/startup-recovery.spec.ts`.
    - **Property 1: Phân loại toàn phần và đúng lý do**
    - **Property 2: Tối đa một resume**
    - Thêm ví dụ cho từng dòng bảng C4.
    - **Validates: Requirements 2.3, 3.2, 4.2, 7.2**

- [x] 2. `SessionService.adopt()` (agent-core)
  - [x] 2.1 Hiện thực `adopt`
    - `AdoptSessionInput`; lock mới qua `lock.acquire`; cập nhật `lockId` + `metadata.hostname/processId`;
      emit `SESSION_ADOPTED`; `NOT_FOUND` / `TERMINAL`; `LOCK_HELD` ném nguyên vẹn; không đổi state.
    - _Requirements: 4.1, 7.1, 7.2_
  - [x]* 2.2 Unit test cho `adopt`
    - File `tests/session/session-service-adopt.spec.ts` (SQLite `:memory:` + lock thật).
    - _Requirements: 4.1, 7.2_

- [x] 3. Hàng đợi goal bền vững
  - [x] 3.1 Migration 0007 `goal_queue`
    - File `packages/infrastructure/src/sqlite/migrations/0007-goal-queue.ts`, đăng ký trong
      `registry.ts`; additive, reversible; FK `(goal_id, goal_version) → goals`.
    - Cập nhật test migration hiện có nếu chúng khẳng định số version cuối.
    - _Requirements: 1.2_
  - [x] 3.2 Port `GoalQueueStore` + `SqliteGoalQueueStore`
    - Port trong `agent-core/src/goal/goal-queue-store.ts`.
    - Impl trong `infrastructure/src/repositories/goal-queue-store.ts`: `enqueue` (goals + queue trong một
      transaction, dùng chung mapping với `SqliteGoalRepository`), `claimNext` (atomic
      QUEUED → STARTED + sessionId), `recordStartRevision`, `getBySession`, `queuedCount`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 3.3 `GoalIngressService` dùng store tùy chọn
    - Dep `store?`; `submitGoal` qua store khi có; thêm `claimNext(sessionId)`; giữ `dequeue()` cho đường
      trong bộ nhớ.
    - _Requirements: 1.1, 1.2, 1.3_
  - [x]* 3.4 Property test hàng đợi + test migration
    - File `tests/repositories/goal-queue-store.spec.ts`: **Property 3: Hàng đợi FIFO, không chạy hai
      lần** (restart = store mới trên cùng DB); migration apply/rollback; FK.
    - Bổ sung `tests/goal/…` cho `GoalIngressService` có/không store.
    - **Validates: Requirements 1.1, 1.2, 1.3, 8.3**

- [x] 4. Checkpoint: lõi + lưu trữ
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. `StartupRecovery` + nguồn orphan
  - [x] 5.1 Lớp `StartupRecovery.recover()` (agent-core)
    - Theo design C4: abort (emit `SESSION_RECOVERY_DECIDED` rồi `ABORT`), adopt cho resume, `LOCK_HELD`
      ⇒ bỏ resume không abort, lỗi từng session không chặn session khác.
    - _Requirements: 2.1, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2_
  - [x] 5.2 `SqliteOrphanSource` (infrastructure)
    - Liệt kê session không kết thúc của workspace; lọc hostname + PID chết; dựng `openClarification`
      từ event; `graphIsSeedOnly`; `goalPersisted` từ `goal_queue`; `pendingToolApproval` từ `tool_calls`.
    - _Requirements: 2.1, 2.2, 2.3_
  - [x]* 5.3 Unit test cho `recover()` và `SqliteOrphanSource`
    - Bổ sung `tests/session/startup-recovery.spec.ts` (port giả) và test SQLite cho orphan source,
      gồm session của PID sống và của máy khác không bị đụng.
    - _Requirements: 2.2, 3.1, 3.3, 8.1, 8.4_

- [x] 6. Resume trong mission stage và orchestrator (agent-core)
  - [x] 6.1 `MissionIntelligence.analyze(..., { resumeClarification })`
    - Dùng `missionId` + request truyền vào; chế độ im lặng cho tới điểm chờ; không `REQUESTED` mới;
      sau điểm chờ phát event như Phase 1. Không `options` ⇒ không đổi.
    - Thêm tham số tùy chọn vào `MissionStageContract`.
    - _Requirements: 4.4, 4.6, 4.7, 7.4, 7.5_
  - [x] 6.2 `SessionOrchestrator.resume()`
    - Tách `run()` thành init transitions + `continueRun()`; `resume()` gọi `continueRun()` với
      `resumeClarification`, không phát lại `SESSION_INITIALIZED` / `SESSION_READY`.
    - _Requirements: 4.3, 4.6_
  - [x]* 6.3 Test resume của mission stage + parity
    - File `tests/mission/mission-intelligence-resume.spec.ts`; chạy lại toàn bộ
      `tests/mission/mission-intelligence-clarify*` không sửa.
    - **Validates: Requirements 4.4, 4.7, 7.5**

- [x] 7. Wiring CLI
  - [x] 7.1 Hàng đợi bền vững + startup recovery trong `runtime-cli.ts`
    - `SqliteGoalQueueStore` vào `GoalIngressService`; worker dùng `claimNext(sid)` + `recordStartRevision`.
    - Sau `reclaimStale`: `recover()`, in từng abort; nếu có resume: lấy goal + start revision, tính
      revision mới, cảnh báo + `SESSION_RESUMED { workspaceChanged }`, chạy `resume()` trước worker,
      xử lý `AWAITING_HUMAN` ⇒ ABORT như `runGoal`. Dòng banner `Resume:`.
    - _Requirements: 1.1, 1.4, 2.1, 4.1, 4.8, 4.9, 5.1, 5.2, 5.3, 7.5_
  - [x]* 7.2 Test tích hợp restart
    - File `tests/integration/session-resume-e2e.spec.ts` theo design (SQLite dùng chung, PID giả,
      `HttpTransport` thật cho `POST /clarification`, planner được gọi sau khi trả lời; orphan RUNNING
      bị ABORT; session của PID sống không bị đụng).
    - _Requirements: 4.5, 4.6, 5.1, 6.1, 6.2, 8.2_

- [x] 8. Tài liệu và checkpoint cuối
  - [x] 8.1 Cập nhật tài liệu
    - README (giới hạn restart đã gỡ một phần; hành vi khởi động), PROJECT_STATUS (dòng trạng thái,
      giới hạn, last-updated), ROADMAP, `STATE_MACHINE_SPEC.md` / `INFRASTRUCTURE_SPEC.md` nếu mô tả
      vòng đời session hay schema, `MIGRATION_SPEC.md` (migration 0007).
    - _Requirements: 7.6_
  - [x] 8.2 Checkpoint cuối
    - `npm run build`; WSL `scripts/_wsl-tmp.sh` (full suite, eslint, depcruise); so sánh baseline.
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Task có `*` là test; theo yêu cầu của bạn, mình sẽ làm cả các task này.
- Không thêm trạng thái hay transition session; mọi đổi trạng thái đi qua `SessionService`.
- Hạn chế còn lại được ghi ở design: không resume giữa lúc thực thi / chờ phê duyệt tool / PAUSED.
## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.2"] },
    { "id": 2, "tasks": ["2.2", "3.3", "6.1"] },
    { "id": 3, "tasks": ["3.4", "5.1", "5.2", "6.2"] },
    { "id": 4, "tasks": ["5.3", "6.3", "7.1"] },
    { "id": 5, "tasks": ["7.2", "8.1"] }
  ]
}
```