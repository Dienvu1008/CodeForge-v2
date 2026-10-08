// Mission Intelligence module — Phase 12.
//
// Everything here is ADVISORY (MI-001): it analyzes a Goal into a Mission and produces
// recommendations (type, complexity, risk, model/planning). The deterministic kernel (Planner,
// ToolGateway, approval, verification, state machine) remains the authority. Capabilities are
// VERIFIED via ProcessSupervisor (MI-003), never trusted from LLM claims.
//
// P12.2: deterministic intake + analyzers (pure functions over objective signals).
export { extractSignals, type MissionSignals, type WorkspaceSignals } from './signals.js';
export { classifyMissionType, KNOWN_MISSION_TYPES, type MissionTypeResult } from './mission-intake.js';
export { assessComplexity } from './complexity-analyzer.js';
export { assessRisk } from './risk-analyzer.js';
// P12.3: capability discovery + verification (VERIFIED only via a real probe — MI-003).
export {
  DEFAULT_MACHINE_PROBES,
  verdictFromOutcome,
  EnvironmentInventory,
  type CapabilityProbe,
  type CapabilityProber,
  type ProbeOutcome,
  type InventoryEntry,
} from './capability.js';
export { CapabilityDiscovery, type CapabilityDiscoveryDeps } from './capability-discovery.js';
// P12.4: model requirement analysis + capability-based routing over a REAL registry (MI-006).
export {
  ModelRegistry,
  analyzeModelRequirement,
  routeModel,
  type RegisteredModel,
  type ModelCapabilities,
  type RoutingOutcome,
} from './model-router.js';
// P12.5: planning strategy router + expert profiles (advisory; MI-001, MI-008).
export { decidePlanningMode, type PlanningDecision } from './planning-router.js';
export { selectExpertProfile, renderExpertProfile } from './expert-profile.js';
// P12.6: Mission Architect (LLM blueprint) + Architecture Gate (deterministic; MI-007).
export { MissionArchitect, type MissionArchitectDeps } from './mission-architect.js';
export { evaluateArchitecture } from './architecture-gate.js';
