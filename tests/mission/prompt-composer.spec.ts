// PromptComposer (P12.8) — deterministic prompt-shaping from mission signals. Pure: same mission
// → same plan. Advisory only (MI-008): the plan is prompt guidance, never authority.
import { describe, it, expect } from 'vitest';
import {
  composePromptPlan, selectVerbosity, resolveFewShotExample,
  type Mission, type MissionType, type Complexity, type ExpertProfile, type ModelRequirement,
} from '@codeforge/agent-core';

const PROFILE: ExpertProfile = {
  domain: 'TypeScript Systems Engineer',
  expertise: ['TypeScript', 'Node.js'],
  responsibilities: ['type-safe implementation'],
  constraints: ['no any-casts without reason'],
  preferredPractices: ['pure functions at the core'],
};

function modelReq(over: Partial<ModelRequirement> = {}): ModelRequirement {
  return { reasoning: 'MEDIUM', coding: 'MEDIUM', architecture: 'LOW', context: 'SMALL', toolUse: 'MEDIUM', latencySensitive: false, ...over };
}

function mission(type: MissionType, level: Complexity = 'MEDIUM', req: ModelRequirement = modelReq()): Mission {
  return {
    missionId: 'm', goalId: 'g', userGoal: 'x', normalizedGoal: 'x',
    missionType: type,
    complexity: { level, confidence: 0.8, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['READ_ONLY'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope: 'FILE', planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [], modelRequirement: req,
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('selectVerbosity', () => {
  it('weak coder (LOW coding) → guarded', () => {
    expect(selectVerbosity(modelReq({ coding: 'LOW' }), { level: 'MEDIUM', confidence: 1, reasons: [], usedAdvisory: false })).toBe('guarded');
  });
  it('latency-sensitive → guarded', () => {
    expect(selectVerbosity(modelReq({ latencySensitive: true }), { level: 'LOW', confidence: 1, reasons: [], usedAdvisory: false })).toBe('guarded');
  });
  it('strong reasoner on non-SYSTEM work → terse', () => {
    expect(selectVerbosity(modelReq({ reasoning: 'HIGH' }), { level: 'MEDIUM', confidence: 1, reasons: [], usedAdvisory: false })).toBe('terse');
  });
  it('strong reasoner on SYSTEM work → normal (keep the scaffolding)', () => {
    expect(selectVerbosity(modelReq({ reasoning: 'HIGH' }), { level: 'SYSTEM', confidence: 1, reasons: [], usedAdvisory: false })).toBe('normal');
  });
  it('default → normal', () => {
    expect(selectVerbosity(modelReq(), { level: 'MEDIUM', confidence: 1, reasons: [], usedAdvisory: false })).toBe('normal');
  });
});

describe('composePromptPlan', () => {
  it('includes the rendered expert persona', () => {
    const plan = composePromptPlan(mission('FEATURE'), PROFILE);
    expect(plan.expertPersona).toContain('TypeScript Systems Engineer');
    expect(plan.expertPersona).toContain('guidance only'); // the authority disclaimer
  });

  it('BUG_FIX gets root-cause guidance + a bugfix few-shot id', () => {
    const plan = composePromptPlan(mission('BUG_FIX'), PROFILE);
    expect(plan.taskTypeGuidance).toMatch(/ROOT CAUSE/);
    expect(plan.fewShotExampleId).toBe('example-bugfix');
  });

  it('REFACTOR guidance insists on updating callers', () => {
    const plan = composePromptPlan(mission('REFACTOR'), PROFILE);
    expect(plan.taskTypeGuidance).toMatch(/caller/i);
    expect(plan.fewShotExampleId).toBe('example-refactor');
  });

  it('an unmapped type omits guidance + few-shot but still has persona + verbosity', () => {
    const plan = composePromptPlan(mission('EXPERIMENT'), PROFILE);
    expect(plan.taskTypeGuidance).toBeUndefined();
    expect(plan.fewShotExampleId).toBeUndefined();
    expect(plan.expertPersona).toBeDefined();
    expect(plan.verbosity).toBeDefined();
  });

  it('weak model → guarded verbosity in the plan', () => {
    const plan = composePromptPlan(mission('FEATURE', 'MEDIUM', modelReq({ coding: 'LOW' })), PROFILE);
    expect(plan.verbosity).toBe('guarded');
  });

  it('is pure/deterministic', () => {
    const m = mission('BUG_FIX');
    expect(JSON.stringify(composePromptPlan(m, PROFILE))).toEqual(JSON.stringify(composePromptPlan(m, PROFILE)));
  });
});

describe('resolveFewShotExample', () => {
  it('resolves known ids to text', () => {
    expect(resolveFewShotExample('example-bugfix')).toMatch(/bug fix/i);
    expect(resolveFewShotExample('example-refactor')).toMatch(/refactor/i);
  });
  it('returns undefined for an unknown id', () => {
    expect(resolveFewShotExample('nope')).toBeUndefined();
  });
});
