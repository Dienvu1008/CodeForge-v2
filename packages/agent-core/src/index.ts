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
export * from './session/index.js';
export * from './goal/index.js';
export * from './task/index.js';
export * from './execution/index.js';
export * from './scheduler/index.js';
export * from './budget/index.js';
