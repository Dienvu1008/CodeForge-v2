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
