// MissionContextStrategy (P12.7) — deterministic Mission → context scope recommendation. A
// trivial task must NOT widen to repository scope (CX-005 / §34); heavy/architectural missions
// warrant repository (or multi-repo) scope. Pure: same mission → same strategy.
import { describe, it, expect } from 'vitest';
import { decideContextStrategy, type Mission, type MissionType, type Complexity } from '@codeforge/agent-core';

function mission(type: MissionType, level: Complexity, contextScope: Mission['contextScope'] = 'FILE'): Mission {
  return {
    missionId: 'm', goalId: 'g', userGoal: 'x', normalizedGoal: 'x',
    missionType: type,
    complexity: { level, confidence: 0.8, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['READ_ONLY'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope, planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [], modelRequirement: { reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true },
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('decideContextStrategy', () => {
  it('trivial bug fix → TASK scope, not repository-wide (CX-005)', () => {
    const s = decideContextStrategy(mission('BUG_FIX', 'LOW', 'TASK'));
    expect(s.scope).toBe('TASK');
    expect(s.repositoryWide).toBe(false);
    expect(s.maxFiles).toBeLessThan(10);
  });

  it('PROJECT → REPOSITORY scope', () => {
    const s = decideContextStrategy(mission('PROJECT', 'HIGH', 'REPOSITORY'));
    expect(s.scope).toBe('REPOSITORY');
    expect(s.repositoryWide).toBe(true);
  });

  it('SYSTEM complexity → REPOSITORY scope regardless of type', () => {
    expect(decideContextStrategy(mission('FEATURE', 'SYSTEM')).scope).toBe('REPOSITORY');
  });

  it('MULTI_REPOSITORY mission → MULTI_REPOSITORY scope', () => {
    expect(decideContextStrategy(mission('MULTI_REPOSITORY', 'HIGH')).scope).toBe('MULTI_REPOSITORY');
  });

  it('RESEARCH mission → EXTERNAL_RESEARCH scope', () => {
    expect(decideContextStrategy(mission('RESEARCH', 'MEDIUM')).scope).toBe('EXTERNAL_RESEARCH');
  });

  it('HIGH complexity feature → MODULE scope', () => {
    expect(decideContextStrategy(mission('FEATURE', 'HIGH')).scope).toBe('MODULE');
  });

  it('is deterministic', () => {
    const m = mission('REFACTOR', 'MEDIUM');
    expect(JSON.stringify(decideContextStrategy(m))).toEqual(JSON.stringify(decideContextStrategy(m)));
  });
});
