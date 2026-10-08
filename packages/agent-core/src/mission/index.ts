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
