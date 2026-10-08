// P12.5 unit — PlanningModeRouter decision table (§15/§31).
import { describe, it, expect } from 'vitest';
import { decidePlanningMode } from '@codeforge/agent-core';
import type { Mission, Complexity, MissionType, UncertaintyLevel, ArchitectureRequirement } from '@codeforge/agent-core';

function mission(over: {
  type?: MissionType; level?: Complexity; uncertainty?: UncertaintyLevel; archReq?: ArchitectureRequirement;
}): Mission {
  return {
    missionId: 'm', goalId: 'g', userGoal: 'x', normalizedGoal: 'x',
    missionType: over.type ?? 'FEATURE',
    complexity: { level: over.level ?? 'LOW', confidence: 0.9, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: over.uncertainty ?? 'KNOWN', openQuestions: [] },
    contextScope: 'FILE', planningMode: 'DIRECT',
    architectureRequirement: over.archReq ?? 'NOT_REQUIRED',
    capabilityRequirements: [],
    modelRequirement: { reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true },
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('decidePlanningMode — §31 planning', () => {
  it('simple (LOW) → DIRECT', () => {
    expect(decidePlanningMode(mission({ type: 'REFACTOR', level: 'LOW' })).mode).toBe('DIRECT');
  });
  it('medium (MEDIUM) → LOCAL_PLAN', () => {
    expect(decidePlanningMode(mission({ type: 'FEATURE', level: 'MEDIUM' })).mode).toBe('LOCAL_PLAN');
  });
  it('complex new application (PROJECT) → ARCHITECTURE_FIRST', () => {
    expect(decidePlanningMode(mission({ type: 'PROJECT', level: 'HIGH' })).mode).toBe('ARCHITECTURE_FIRST');
  });
  it('HIGH complexity (non-project) → ARCHITECTURE_FIRST', () => {
    expect(decidePlanningMode(mission({ type: 'REFACTOR', level: 'HIGH' })).mode).toBe('ARCHITECTURE_FIRST');
  });
  it('unknown technology / RESEARCH → RESEARCH_FIRST', () => {
    expect(decidePlanningMode(mission({ type: 'RESEARCH', level: 'MEDIUM' })).mode).toBe('RESEARCH_FIRST');
    expect(decidePlanningMode(mission({ type: 'FEATURE', level: 'MEDIUM', uncertainty: 'UNKNOWN' })).mode).toBe('RESEARCH_FIRST');
  });
  it('MIGRATION → MIGRATION_PLAN', () => {
    expect(decidePlanningMode(mission({ type: 'MIGRATION', level: 'HIGH' })).mode).toBe('MIGRATION_PLAN');
  });
  it('PERFORMANCE / EXPERIMENT → EXPERIMENT', () => {
    expect(decidePlanningMode(mission({ type: 'PERFORMANCE', level: 'MEDIUM' })).mode).toBe('EXPERIMENT');
    expect(decidePlanningMode(mission({ type: 'EXPERIMENT', level: 'LOW' })).mode).toBe('EXPERIMENT');
  });
  it('architecture explicitly REQUIRED overrides a low complexity', () => {
    expect(decidePlanningMode(mission({ type: 'FEATURE', level: 'LOW', archReq: 'REQUIRED' })).mode).toBe('ARCHITECTURE_FIRST');
  });
  it('is deterministic', () => {
    const m = mission({ type: 'FEATURE', level: 'MEDIUM' });
    expect(JSON.stringify(decidePlanningMode(m))).toEqual(JSON.stringify(decidePlanningMode(m)));
  });
});
