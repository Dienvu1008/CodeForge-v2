// PlanningModeRouter — Phase 12 (P12.5). Deterministic decision table that maps a mission to a
// PlanningMode (§15). Advisory (MI-001): it recommends HOW to plan; the Planner/kernel still
// own the actual planning + commit (GI-009). Pure: same mission → same mode.
import type { Mission, PlanningMode, MissionType, Complexity, UncertaintyLevel } from '../domain/mission.js';

export interface PlanningDecision {
  readonly mode: PlanningMode;
  readonly reason: string;
}

const HEAVY_PROJECT_TYPES = new Set<MissionType>(['PROJECT']);

/**
 * Decide the planning mode. The rules are ordered by priority (first match wins), using the
 * deterministic mission facts: type, complexity, uncertainty, risk, architectureRequirement.
 *
 *   RESEARCH / high uncertainty      → RESEARCH_FIRST   (resolve the unknown before planning)
 *   MIGRATION                        → MIGRATION_PLAN
 *   EXPERIMENT / PERFORMANCE         → EXPERIMENT        (measure, then decide)
 *   PROJECT or architecture REQUIRED → ARCHITECTURE_FIRST
 *   HIGH/SYSTEM complexity           → ARCHITECTURE_FIRST
 *   MEDIUM complexity                → LOCAL_PLAN
 *   otherwise (LOW)                  → DIRECT
 */
export function decidePlanningMode(mission: Mission): PlanningDecision {
  const type: MissionType = mission.missionType;
  const level: Complexity = mission.complexity.level;
  const uncertainty: UncertaintyLevel = mission.uncertainty.level;
  const archReq = mission.architectureRequirement;

  // 1. Unknown technology / unresolved uncertainty → research first (§15, §20, §26).
  if (type === 'RESEARCH' || uncertainty === 'UNKNOWN' || uncertainty === 'CONFLICTING') {
    return { mode: 'RESEARCH_FIRST', reason: `research-first (type=${type}, uncertainty=${uncertainty})` };
  }

  // 2. Migration gets its own staged plan.
  if (type === 'MIGRATION') {
    return { mode: 'MIGRATION_PLAN', reason: 'migration mission → staged migration plan' };
  }

  // 3. Measure-then-decide missions.
  if (type === 'EXPERIMENT' || type === 'PERFORMANCE') {
    return { mode: 'EXPERIMENT', reason: `${type} → experiment (measure before deciding)` };
  }

  // 4. New applications / architecture explicitly required → architecture first.
  if (HEAVY_PROJECT_TYPES.has(type) || type === 'ARCHITECTURE' || archReq === 'REQUIRED') {
    return { mode: 'ARCHITECTURE_FIRST', reason: `architecture-first (type=${type}, archReq=${archReq})` };
  }

  // 5. Big/complex work → architecture first even if not a PROJECT.
  if (level === 'HIGH' || level === 'SYSTEM') {
    return { mode: 'ARCHITECTURE_FIRST', reason: `complexity ${level} → architecture-first` };
  }

  // 6. Moderate work → a local plan.
  if (level === 'MEDIUM' || archReq === 'RECOMMENDED') {
    return { mode: 'LOCAL_PLAN', reason: `complexity ${level} → local plan` };
  }

  // 7. Trivial → direct execution (no expensive planning, §22/§34).
  return { mode: 'DIRECT', reason: `complexity ${level} → direct` };
}
