# PHASE_12_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 12 (Mission Intelligence, Environment Preflight & Adaptive Planning)**

Version: 1.0
Status: Working plan (draft for review)
Owner: Mission Intelligence Plane
Scope: Một lớp **intelligence trước-thực-thi**: hiểu *mission* của người dùng (phân loại,
       ước lượng độ phức tạp, đánh giá rủi ro), khám phá + **xác minh** năng lực môi trường,
       chọn model và chiến lược planning theo yêu cầu thực tế, (với mission phức tạp) dựng
       kiến trúc và dừng ở một **Architecture Gate** để xin xác nhận — rồi mới giao cho kernel
       deterministic hiện có. **Advisory, không bao giờ là authority.**
Related:
`Coding Agent Architecture Target §4` (Intelligence Plane), `PHASE_11_SIGNOFF.md`
(AdviceGate — khuôn deterministic-clamp-over-LLM), `INVARIANTS.md`
(`GL-*`, `MG-006`, `SE-010`, `SE-007/008`, `CX-005`, `SM-*`, `OB-*`, `DC-*`),
`EVALUATION_MODEL §9` (fixtures), `invariants.yaml`, `invariants.schema.json`

---

## 0. Nguyên tắc Phase 12

> **Kernel đã biết *thực thi an toàn*. Phase 12 dạy agent *hiểu nhiệm vụ trước khi thực thi*
> — nhưng mọi hiểu biết chỉ là đề xuất; runtime deterministic vẫn xác minh, ràng buộc và
> quyết định.**

Năm luật (mở rộng trực tiếp triết lý *«LLM proposes, deterministic runtime decides»*):

1. **Mission Intelligence là advisory, không phải authority.** Classification, complexity,
   risk, model recommendation, context requirement, architecture proposal — tất cả là *đề
   xuất*. Chúng không được tự thay đổi filesystem, tool permission, approval, task/verification
   state, security policy, hay "sự thật" về năng lực/môi trường. Mỗi đề xuất đi qua một
   **evaluator/gate deterministic** trước khi ảnh hưởng execution (mirror AdviceGate, Phase 11).

2. **Không bao giờ tin lời LLM về sự tồn tại của công cụ** (§9). "Flutter đã cài" là *giả
   thuyết* cho tới khi runtime chạy `flutter --version` qua `ProcessSupervisor` (SE-007/008) và
   có **evidence**. Chỉ capability `VERIFIED` mới được coi là tiền-điều-kiện execution.

3. **Deterministic-first, LLM-advisory.** Mọi điểm có thể quyết định bằng tín hiệu khách quan
   (độ phức tạp từ scope/platform count/repo signals; risk từ keyword + policy; model từ một
   registry năng lực; planning mode từ bảng quyết định) thì runtime quyết định; LLM chỉ bổ
   sung tín hiệu, và tín hiệu đó bị kẹp (clamp) vào biên deterministic. Cùng input → cùng
   quyết định ở biên authority.

4. **Fail-safe = hành vi hiện tại.** Tắt toàn bộ Mission Intelligence (không wire) → orchestrator
   hành xử **y hệt** trước Phase 12: Goal → Planner → kernel. Mission Intelligence là một stage
   *optional* chèn trước planning, không phải đường thay thế.

5. **Adaptive, không đắt đỏ mặc định** (§34). Mission tầm thường → phân tích tối thiểu, model
   nhỏ, context hẹp, không architecture. Mission lớn → preflight + architecture + model mạnh +
   verification planning. Tối ưu *quality × reliability × latency × resource*, không "luôn dùng
   model mạnh nhất".

North Star: *Trước Phase 12, "Build X" → "bắt đầu code X". Sau Phase 12, "Build X" → "Đây là
mission PROJECT độ phức tạp HIGH; năng lực cần: …; môi trường sẵn sàng: …; model đề xuất: …;
planning: ARCHITECTURE_FIRST; kiến trúc đề xuất: …; blocker: Android SDK thiếu — xin xác
nhận." — rồi mới giao kernel.*

---

## 1. Con số Phase 12

Thêm mới một nhóm invariant **`MI`** (Mission Intelligence) vào `INVARIANTS.md` + `invariants.yaml`
(prefix 2 chữ cái theo `invariants.schema.json`; `MI` chưa dùng, phân biệt với `MG` = Model
Gateway). Thêm theo từng sub-phase khi enforcement + test có mặt (invariants-first).

Nhóm invariant đề xuất (chốt khi review):

| ID | Statement | Enforcement | Severity |
|---|---|---|---|
| MI-001 | Mission Intelligence output (type/complexity/risk/model/architecture) không bao giờ là runtime authority — chỉ là đề xuất đi qua một evaluator/gate deterministic. | MissionGate / PolicyEngine | CRITICAL |
| MI-002 | Tắt Mission Intelligence (không wire) → orchestrator hành xử y hệt trước Phase 12 (fail-safe). | SessionOrchestrator (optional stage) | CRITICAL |
| MI-003 | Một capability chỉ được coi là tiền-điều-kiện khi `VERIFIED` bằng evidence từ ProcessSupervisor; lời LLM về tool existence không bao giờ đủ. | CapabilityVerifier | CRITICAL |
| MI-004 | Mission là projection chiến lược của một Goal; nó KHÔNG mutate Goal (GL-*) và không tạo Task/Graph (chỉ Planner+GraphCommit làm, GI-009). | MissionBuilder | CRITICAL |
| MI-005 | Complexity/risk classification deterministic trên cùng tín hiệu khách quan + (optional) advisory LLM đã clamp; cùng input → cùng phân loại. | ComplexityAnalyzer / RiskAnalyzer | HIGH |
| MI-006 | Model Router chỉ chọn trong các model THỰC SỰ có trong registry; đề xuất model không tồn tại → fallback/escalate, không bao giờ chọn bừa. | ModelRouter | CRITICAL |
| MI-007 | Architecture Gate với mission đủ phức tạp phải dừng ở AWAITING_HUMAN khi có blocker/uncertainty tới hạn — không thực thi mù. | ArchitectureGate + SessionService | CRITICAL |
| MI-008 | ExpertProfile và mọi nội dung do LLM sinh là prompt-context untrusted (SE-010); không mang authority. | PromptBoundary | HIGH |

Invariant đã có được Phase 12 làm giàu (không thêm mới): `GL-*` (Goal immutable), `GI-009`
(chỉ Planner→GraphCommit tạo task), `MG-006` (model output không authority), `SE-010`
(untrusted output), `SE-007/008` (process timeout + tree cleanup — dùng khi verify capability),
`SM-005/007` (AWAITING_HUMAN chỉ thoát khi có human decision — dùng cho Architecture Gate),
`CX-005` (context không authority), `OB-*` (observable), `DC-*` (dependency direction).

---

## 2. Scope Phase 12

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `domain/mission.ts` | Mission type + enums (MissionType, Complexity, RiskLevel, PlanningMode, ContextScope, Uncertainty, Capability status). Pure types. | MI-004 |
| `MissionIntake` | raw Goal → normalized Mission (phân loại type, chưa chốt tech). Deterministic + optional LLM-advisory. | MI-001, MI-004 |
| `ComplexityAnalyzer` | tín hiệu khách quan (scope, #platforms, #repos, keyword, workspace signals) → Complexity + confidence + reasons; optional LLM advisory đã clamp. | MI-005 |
| `RiskAnalyzer` | risk dimensions (network/credential/destructive/…) → RiskLevel + factors + requiredApprovals/verification. Policy vẫn authoritative. | MI-001, MI-005 |
| `Capability` + `CapabilityVerifier` | khám phá + **xác minh** tool bằng ProcessSupervisor (`--version`); status VERIFIED/UNAVAILABLE/STALE + evidence. | MI-003 |
| `EnvironmentInventory` | tách Machine vs Workspace capabilities; cache + TTL/freshness + on-demand verify. | MI-003 |
| `PreflightReport` | tổng hợp readiness %, blockers, warnings (machine-readable). | MI-003 |
| `ModelRegistry` + `ModelRouter` | registry các model THỰC SỰ có (danh sách inject/`/api/tags`) với capability tags; router chọn theo ModelRequirement; fallback khi thiếu. | MI-006 |
| `ModelRequirementAnalyzer` | mission → yêu cầu (reasoning/coding/architecture/context/toolUse/latency). | MI-006 |
| `PlanningModeRouter` | bảng quyết định deterministic (type×complexity×risk×uncertainty×capabilities) → DIRECT/LOCAL_PLAN/ARCHITECTURE_FIRST/RESEARCH_FIRST/MIGRATION_PLAN/EXPERIMENT. | MI-001 |
| `ExpertProfile` | abstraction cho domain-expert prompt context (không scatter string). Untrusted. | MI-008 |
| `MissionArchitect` | mission phức tạp → blueprint (requirements/architecture/folder/roadmap/verification). Không viết code. | MI-001 |
| `ArchitectureGate` | kiểm requirement coverage / capability prereq / uncertainty; đủ phức tạp → dừng AWAITING_HUMAN xin xác nhận. | MI-007 |
| `MissionContextStrategy` | mission → ContextScope (TASK/FILE/MODULE/REPOSITORY) cho ContextBuilder; không load cả repo. | MI-001, CX-005 |
| `MISSION_*` events | MISSION_RECEIVED/CLASSIFIED/COMPLEXITY_ESTIMATED/RISK_ASSESSED/ENVIRONMENT_DISCOVERED/CAPABILITY_VERIFIED/MODEL_SELECTED/PLANNING_MODE_SELECTED/ARCHITECTURE_*/ARCHITECTURE_GATE_*/USER_CONFIRMATION_REQUIRED. | OB-* |
| Orchestrator + CLI wiring | optional `MissionIntelligence` stage trước Planner.plan; `--mission on\|off` flag; preflight + model selection + gate. | MI-002 |

### 2.2 Out-of-scope (Phase 12) — §36 avoid overengineering

- Không formal language / ontology / knowledge graph / vector DB.
- Không multi-agent orchestration mới, không remote execution, không self-modification.
- Không web access không kiểm soát (research requirement chỉ *đánh dấu cần research*; thực
  hiện vẫn qua tool/network/approval policy hiện có).
- Không UI/dashboard mới (chỉ expose structured state để dashboard sau tiêu thụ — §29).
- Không mở rộng Telegram quá mức (chỉ dữ liệu tối thiểu — §30).
- Không đổi ModelGateway contract; không đổi kernel (ToolGateway/approval/verification/state).

---

## 3. Kiến trúc những gì đã có (đã xác minh) → tái dùng thế nào

| Thứ đã có | Location | Vai trò Phase 12 |
|---|---|---|
| `ModelGateway` (single-model: identity + generate) | `agent-core/src/model/gateway.ts` | ModelRouter chọn **gateway instance** theo model-id; không đổi contract. Thêm `ModelPurpose` mới (`classify`/`architect`) cho các call Mission. |
| `ProcessSupervisor.spawn → SpawnResult` (SE-007/008) | `agent-core/src/process/`, infra `node-process-supervisor.ts` | **Primitive xác minh capability**: `flutter --version` → VERIFIED + evidence; `SpawnError COMMAND_NOT_FOUND` → UNAVAILABLE. |
| `inspectProject → ProjectSignals` | infra `verification-runtime/project-inspector.ts` | Khuôn khám phá **workspace capability** (đọc marker file). Mở rộng cho đa ngôn ngữ (pubspec.yaml→Dart/Flutter, Cargo.toml, pom.xml…). |
| `Goal` (immutable) + `GoalIngressService` | `agent-core/src/domain/goal.ts`, `goal/` | Mission tham chiếu `goalId`, KHÔNG mutate Goal. Intake chạy sau khi Goal được tạo. |
| `Planner.plan(goal,…)→GraphMutation`; `PlannerDeps.planCritic` (optional-advisory) | `agent-core/src/planning/planner.ts` | Mission bơm context (expert profile, architecture, scope) vào planning + chọn planning mode. Mirror khuôn optional-advisory dep. |
| `SessionOrchestrator.run()` hook giữa RUNNING và Planner.plan; optional-deps | `agent-core/src/session/session-orchestrator.ts` | Nơi chèn Mission Intelligence stage (optional dep → MI-002 fail-safe). |
| `EventLog.append` + `KnownEventType \| (string&{})` | `agent-core/src/domain/event.ts`, observability | MISSION_* events chỉ cần append (forward-compatible). |
| **AdviceGate** (Phase 11) | `agent-core/src/learning/advice-gate.ts` | **Khuôn mẫu chuẩn** cho MissionGate: nhận đề xuất LLM, clamp vào biên deterministic, null-safe. |
| `ContextBuilder`/`Retriever` + token budgeter | `agent-core/src/context/` | MissionContextStrategy chọn scope → feed ContextBuilder. |
| code-intelligence (SymbolExtractor/ImportGraphBuilder) | infra `code-intelligence/` | Tín hiệu complexity cho workspace đã tồn tại (ngôn ngữ, #file). |

**Không refactor lớn.** `TaskExecutor` không bị quá tải (recovery/learning sống ở orchestrator).
Mission Intelligence là stage *additive, optional, trước Planner* — không chạm kernel.

---

## 4. Sub-phases (thứ tự thực hiện — mỗi bước verify + commit)

### P12.1 — Mission domain model (pure types)
`domain/mission.ts`: `Mission`, `MissionType`, `Complexity{LOW,MEDIUM,HIGH,SYSTEM}`, `RiskLevel`,
`PlanningMode`, `ContextScope`, `Uncertainty`, `Capability{name,status,evidence,version,enables[]}`,
`CapabilityStatus{VERIFIED,AVAILABLE,UNAVAILABLE,UNKNOWN,STALE}`, `PreflightReport`,
`ModelRequirement`, `ExpertProfile`. Zero logic. Invariant: MI-004 (shape only).

### P12.2 — MissionIntake + ComplexityAnalyzer + RiskAnalyzer (deterministic core)
Pure functions: Goal → Mission với type/complexity/risk từ **tín hiệu khách quan** (keyword
taxonomy, scope, #platforms/#repos từ text, workspace signals). LLM-advisory **optional** (một
`MissionAdvisor` giống RecoveryAdvisor) đi qua một `MissionGate` clamp. Invariants: MI-001, MI-005.

### P12.3 — Capability discovery + verification (ProcessSupervisor)
`CapabilityVerifier` (agent-core contract) + impl infra chạy `<tool> --version` qua
ProcessSupervisor; `EnvironmentInventory` (machine vs workspace, TTL). `PreflightReport`.
Invariant: MI-003. Test: tool exists / missing / version mismatch / stale.

### P12.4 — ModelRegistry + ModelRequirementAnalyzer + ModelRouter
Registry model thực-có (inject danh sách + optional `/api/tags`), capability tags. Router chọn
theo requirement; model không tồn tại → fallback/escalate. Invariant: MI-006. Test: small→small,
architecture→strong, unavailable→fallback.

### P12.5 — PlanningModeRouter + ExpertProfile
Bảng quyết định deterministic → PlanningMode. ExpertProfile registry (prompt-context untrusted).
Invariants: MI-001, MI-008.

### P12.6 — MissionArchitect + ArchitectureGate
Mission phức tạp → blueprint (LLM, structured output, validated); Gate kiểm coverage/capability/
uncertainty → PASS hoặc BLOCK→AWAITING_HUMAN. Invariant: MI-007. Mirror CompletionGate pattern.

### P12.7 — MissionContextStrategy + MISSION_* events + orchestrator/CLI wiring
Scope selection cho ContextBuilder; append MISSION_* events; chèn optional MissionIntelligence
stage vào orchestrator + `--mission on|off` CLI flag. Invariant: MI-002 (flag-off parity).

### P12.8 — Tests đầy đủ + dogfood 7 mission + sign-off
Toàn bộ test §31 + dogfood §32 (7 mission tăng dần) + `PHASE_12_SIGNOFF.md` + trả lời 20 câu §39.

---

## 5. Phase gate (exit criteria — §33/§39)

1. Toàn bộ invariant `MI-*` có test và xanh (CRITICAL 100%).
2. **Flag-off parity (MI-002)**: `--mission off` (hoặc không wire) → runtime y hệt Phase 11.
3. Phân biệt được trivial task vs project mission; chọn model khác nhau theo requirement.
4. Capability **VERIFIED** bằng ProcessSupervisor (LLM nói "có Docker" → vẫn phải `docker --version`).
5. Phát hiện capability thiếu TRƯỚC execution; Architecture Gate dừng AWAITING_HUMAN đúng điểm.
6. Mission phức tạp → architecture + folder hierarchy + roadmap + verification strategy trước code.
7. Simple task vẫn NHANH (phân tích tối thiểu, không architecture) — MI-002/§34.
8. Deterministic ở biên authority; không bypass kernel; không weaken invariant Phase 0-11.
9. Full suite xanh Win + WSL; depcruise 0 (DC-*: Mission Intelligence pure trong agent-core,
   I/O như capability-verifier/model-registry ở infrastructure).
10. `PHASE_12_SIGNOFF.md` + dogfood numbers trung thực.

---

## 6. Rủi ro & kiểm soát

| Rủi ro | Kiểm soát |
|---|---|
| Mission Intelligence lặng lẽ thành authority | MissionGate là điểm nghẽn; MI-001/002 test; flag-off parity chứng minh zero-authority. |
| Tin lời LLM về tool existence | MI-003: chỉ VERIFIED (evidence ProcessSupervisor) mới là prereq. |
| Mọi task thành đắt đỏ | §34/MI-002: trivial → DIRECT, model nhỏ, không architecture; chi phí tỉ lệ với complexity. |
| Phình scope / overengineering (§36) | Scope §2.2 cấm; mỗi sub-phase nhỏ, verify+commit; ưu tiên vài abstraction mạnh. |
| LLM sinh architecture rác | ArchitectureGate validate coverage/capability/uncertainty; BLOCK thay vì thực thi mù. |
| Đổi model-id không tồn tại | MI-006: router chỉ chọn trong registry thực-có; fallback/escalate. |
| Chạm kernel recovery/verification | Mission Intelligence sống trước Planner, chỉ đọc; không chạm ToolGateway/approval/state. |

---

## 7. Lưu ý triết lý

Giá trị Phase 12 **không** phải "thêm nhiều class thông minh". Nó là **chuyển dịch hành vi**:
từ "nhận task → code" sang "hiểu mission → biết năng lực/môi trường → chọn đúng trí tuệ → dựng
đúng kế hoạch → rồi mới giao kernel deterministic". Và quan trọng không kém: làm điều đó **mà
không nhượng một gram quyền quyết định** cho lớp intelligence — mọi đề xuất đều qua một cổng
deterministic, mọi năng lực đều được xác minh bằng evidence, và tắt lớp này đi thì runtime lui
về đúng Phase 11.

> Smart model. Strict runtime. Verifiable outcome. — và giờ: *Understand the mission before you
> touch the code; verify the ground before you build on it.*
