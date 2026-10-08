// @codeforge/agent-core
//
// Domain layer (Layer 2). MUST NOT import from infrastructure, models, or tools.
// Enforced by dependency-cruiser (DC-001..DC-005) and ESLint no-restricted-imports.
//
// Phase 0 progress:
//   - id/            (ULID primitive) — DONE
//   - domain/        (C4: 20 entity types) — DONE
//   - state-machine/ (C5: 10 state machine types + transition types) — DONE
//   - graph/         (C6: graph types) — DONE
//   - repositories/  (C7: 6 repository interfaces) — DONE
export { generateUlid, isUlid } from './id/ulid.js';
export type { UlidSources } from './id/ulid.js';

export * from './domain/index.js';
export * from './state-machine/index.js';
export * from './graph/index.js';
export * from './repositories/index.js';
export * from './model/index.js';

// Phase 1:
//   - session/  (P1-S1: SessionStateMachine + SessionService + WorkspaceLock contract)
//   - goal/     (P1-S2: GoalService — GL-001..GL-004)
//   - task/     (P1-T1: TaskService — TI-001..TI-004)
//   - execution/ (P1-T2: ExecutionCoordinator — EX-002/EX-003 projection)
//   - scheduler/ (P1-SC1: deterministic Scheduler — SC-001..006)
//   - budget/    (P1-B1: BudgetEngine — BU-001/002/003/005/006)
//   - checkpoint/ (P1-C1: CheckpointService — CP-002/009/010/011/012)
//   - recovery/  (P1-CR1: CrashRecoveryService — CP-004/005/006)
export * from './session/index.js';
export * from './goal/index.js';
export * from './task/index.js';
export * from './execution/index.js';
export * from './scheduler/index.js';
export * from './budget/index.js';
export * from './checkpoint/index.js';
export * from './recovery/index.js';

// Phase 1.5:
//   - process/ (P1.5-PS1: ProcessSupervisor contract — SE-007/008, TG-010)
export * from './process/index.js';
//   - security/ (P1.5-SE1: StructuredOutputValidator + PromptBoundary + EnvGuard)
export * from './security/index.js';
//   - tool/    (P1.5-TG1: ToolGateway + ToolPolicy + ToolCallStateMachine)
export * from './tool/index.js';
//   - verification/ (P1.5-VR1/VR2: VerificationEngine + CompletionGate — TI-005)
export * from './verification/index.js';
// Phase 2:
//   - context/ (P2-CX1: ContextBuilder pipeline — CX-001..006, PR-002)
export * from './context/index.js';
//   - planning/ (P2-PL1: Planner + PlanValidator + PlanCritic — MG-001/002/006, GI-009)
export * from './planning/index.js';
// Phase 3:
//   - workspace/ (P3-WM1: WorkspaceManager contract — WS-003/004/005/006/010)
export * from './workspace/index.js';
// Phase 7:
//   - memory/ (P7-MW1: MemoryWriter — ME-003/006)
export * from './memory/index.js';
// Phase 8:
//   - coordination/ (P8-MA1: MultiAgentCoordinator — AU-002/007)
export * from './coordination/index.js';
// Phase 9:
//   - observability/ (P9.2: RuntimeProjection + ContextTelemetry — OB-005/010)
export * from './observability/index.js';
//   - control/ (P9.7: ControlPlane — OB-006)
export * from './control/index.js';
// Phase 11:
//   - learning/ (P11.1: SelfModelBuilder — LE-004/008, read-only projection)
export * from './learning/index.js';
// Phase 12:
//   - mission/ (P12.2: Mission Intake + Complexity/Risk analyzers — MI-001/005, advisory)
export * from './mission/index.js';
// Evaluation / Benchmark (Task Correctness axis): pure loader/evaluator/metrics/baseline/report.
export * from './evaluation/index.js';
