// MissionArchitect (P12.6) — the architect asks the model for a blueprint through the structured
// output pipeline, maps the validated output to the domain Architecture, and rejects invalid
// output. The model is a FakeModel (FM-8: never a real LLM); everything is deterministic.
import { describe, it, expect } from 'vitest';
import {
  MissionArchitect,
  type Mission,
  type ExpertProfile,
  ModelError,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

const PROFILE: ExpertProfile = {
  domain: 'TypeScript Systems Engineer',
  expertise: ['TypeScript'],
  responsibilities: ['type-safe implementation'],
  constraints: ['no any-casts'],
  preferredPractices: ['pure core'],
};

function mission(over: Partial<Mission> = {}): Mission {
  return {
    missionId: 'm-1',
    goalId: 'g-1',
    userGoal: 'build a thing',
    normalizedGoal: 'build a thing',
    missionType: 'PROJECT',
    complexity: { level: 'HIGH', confidence: 0.8, reasons: [], usedAdvisory: false },
    risk: { level: 'MEDIUM', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope: 'REPOSITORY',
    planningMode: 'ARCHITECTURE_FIRST',
    architectureRequirement: 'REQUIRED',
    capabilityRequirements: [],
    modelRequirement: {
      reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', latencySensitive: false,
    },
    researchRequired: false,
    constraints: [],
    acceptanceCriteria: [{ criterionId: 'a1', description: 'it works', mandatory: true }],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const VALID_BLUEPRINT = JSON.stringify({
  summary: 'Layered TypeScript service.',
  requirements: ['persist data', 'expose an API'],
  assumptions: ['single tenant'],
  techChoices: ['TypeScript', 'Postgres'],
  moduleBoundaries: [
    { name: 'domain', responsibility: 'pure business rules', dependsOn: [] },
    { name: 'adapters', responsibility: 'I/O', dependsOn: ['domain'] },
  ],
  folderHierarchy: ['src/domain', 'src/adapters'],
  roadmap: [{ name: 'phase 1', outcome: 'domain model', requiresCapabilities: ['node'] }],
  verificationStrategy: ['unit tests', 'typecheck'],
  risks: ['scope creep'],
  openQuestions: [],
  requiredCapabilities: ['node'],
});

function deps() {
  let n = 0;
  const gateway = new FakeModel();
  return {
    gateway,
    arch: new MissionArchitect({
      gateway,
      now: () => '2026-01-02T00:00:00.000Z',
      newProvenanceId: () => `prov-${++n}`,
    }),
  };
}

describe('MissionArchitect.needsArchitecture', () => {
  it('true for architecture REQUIRED/RECOMMENDED or HIGH/SYSTEM complexity', () => {
    expect(MissionArchitect.needsArchitecture(mission({ architectureRequirement: 'REQUIRED', complexity: { level: 'LOW', confidence: 1, reasons: [], usedAdvisory: false } }))).toBe(true);
    expect(MissionArchitect.needsArchitecture(mission({ architectureRequirement: 'RECOMMENDED', complexity: { level: 'LOW', confidence: 1, reasons: [], usedAdvisory: false } }))).toBe(true);
    expect(MissionArchitect.needsArchitecture(mission({ architectureRequirement: 'NOT_REQUIRED', complexity: { level: 'SYSTEM', confidence: 1, reasons: [], usedAdvisory: false } }))).toBe(true);
  });

  it('false for trivial work (NOT_REQUIRED + LOW/MEDIUM)', () => {
    expect(MissionArchitect.needsArchitecture(mission({ architectureRequirement: 'NOT_REQUIRED', complexity: { level: 'LOW', confidence: 1, reasons: [], usedAdvisory: false } }))).toBe(false);
    expect(MissionArchitect.needsArchitecture(mission({ architectureRequirement: 'NOT_REQUIRED', complexity: { level: 'MEDIUM', confidence: 1, reasons: [], usedAdvisory: false } }))).toBe(false);
  });
});

describe('MissionArchitect.architect', () => {
  it('maps a valid model blueprint into a domain Architecture (model output is a PROPOSAL)', async () => {
    const { gateway, arch } = deps();
    gateway.setResponse(/.*/, VALID_BLUEPRINT);

    const result = await arch.architect(mission(), PROFILE, ['node']);

    expect(result.missionId).toBe('m-1');
    expect(result.summary).toContain('Layered');
    expect(result.requirements).toEqual(['persist data', 'expose an API']);
    expect(result.moduleBoundaries).toHaveLength(2);
    expect(result.moduleBoundaries[1]).toEqual({ name: 'adapters', responsibility: 'I/O', dependsOn: ['domain'] });
    expect(result.roadmap[0]).toEqual({ name: 'phase 1', outcome: 'domain model', requiresCapabilities: ['node'] });
    expect(result.requiredCapabilities).toEqual(['node']);
    // Provenance marks the output as model-sourced (never authority).
    expect(result.provenance.source.kind).toBe('model');
    expect(result.createdAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('uses the "architect" purpose and wraps the goal as untrusted prompt context', async () => {
    const { gateway, arch } = deps();
    gateway.setResponse(/.*/, VALID_BLUEPRINT);
    await arch.architect(mission(), PROFILE, ['node']);
    const call = gateway.history[0]!;
    expect(call.request.purpose).toBe('architect');
    expect(call.request.taskPrompt).toContain('<untrusted>');
    expect(call.request.systemPrompt).toContain('UNTRUSTED'); // boundary preamble present
  });

  it('rejects output missing required module boundaries (semantic check), after bounded retries', async () => {
    const { gateway, arch } = deps();
    const bad = JSON.stringify({
      summary: 's', requirements: ['r'], moduleBoundaries: [], roadmap: [{ name: 'p', outcome: 'o' }],
      verificationStrategy: ['v'],
    });
    gateway.setResponse(/.*/, bad);
    await expect(arch.architect(mission(), PROFILE, [])).rejects.toBeInstanceOf(ModelError);
  });

  it('rejects non-JSON output', async () => {
    const { gateway, arch } = deps();
    gateway.setResponse(/.*/, 'not json at all');
    await expect(arch.architect(mission(), PROFILE, [])).rejects.toBeInstanceOf(ModelError);
  });
});
