// MI-006 — The Model Router selects ONLY from models that are actually registered. A preferred
// model that is not registered is ignored (never routed to a non-existent model); when nothing
// qualifies it falls back to the strongest available; an empty registry escalates.
import { describe, it, expect } from 'vitest';
import {
  ModelRegistry,
  analyzeModelRequirement,
  routeModel,
  type RegisteredModel,
  type ModelRequirement,
  type Mission,
} from '@codeforge/agent-core';

const SMALL: RegisteredModel = {
  id: 'qwen2.5-coder:latest', tier: 'SMALL',
  capabilities: { reasoning: 'LOW', coding: 'MEDIUM', architecture: 'LOW', context: 'SMALL', toolUse: 'MEDIUM', speed: 'FAST' },
};
const MEDIUM: RegisteredModel = {
  id: 'deepseek-coder:6.7b', tier: 'MEDIUM',
  capabilities: { reasoning: 'MEDIUM', coding: 'MEDIUM', architecture: 'MEDIUM', context: 'MEDIUM', toolUse: 'MEDIUM', speed: 'MEDIUM' },
};
const STRONG: RegisteredModel = {
  id: 'deepseek-r1:14b', tier: 'STRONG',
  capabilities: { reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', speed: 'SLOW' },
};

const REGISTRY = new ModelRegistry([SMALL, MEDIUM, STRONG]);

const req = (over: Partial<ModelRequirement>): ModelRequirement => ({
  reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true, ...over,
});

describe('MI-006 — routing selects only real registered models', () => {
  it('small task → cheapest sufficient model (SMALL/FAST), not the strongest', () => {
    const out = routeModel(req({}), REGISTRY);
    expect(out.kind).toBe('selected');
    if (out.kind === 'selected') expect(out.model.id).toBe(SMALL.id);
  });

  it('architecture-grade requirement → the STRONG model', () => {
    const out = routeModel(req({ reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', latencySensitive: false }), REGISTRY);
    expect(out.kind).toBe('selected');
    if (out.kind === 'selected') expect(out.model.id).toBe(STRONG.id);
  });

  it('a preferred model that is NOT registered is ignored (route normally)', () => {
    const out = routeModel(req({}), REGISTRY, 'gpt-4o-does-not-exist');
    expect(out.kind).toBe('selected');
    if (out.kind === 'selected') {
      expect(out.model.id).toBe(SMALL.id); // routed normally; the invented id was not chosen
      expect(REGISTRY.has('gpt-4o-does-not-exist')).toBe(false);
    }
  });

  it('a preferred model that IS registered + qualifies is honored', () => {
    const out = routeModel(req({}), REGISTRY, STRONG.id);
    expect(out.kind).toBe('selected');
    if (out.kind === 'selected') expect(out.model.id).toBe(STRONG.id);
  });

  it('no model meets the requirement → fallback to strongest available (flagged)', () => {
    const weakOnly = new ModelRegistry([SMALL]);
    const out = routeModel(req({ reasoning: 'HIGH', architecture: 'HIGH', context: 'LARGE' }), weakOnly);
    expect(out.kind).toBe('fallback');
    if (out.kind === 'fallback') expect(out.model.id).toBe(SMALL.id);
  });

  it('empty registry → escalate (no model to route to)', () => {
    const out = routeModel(req({}), new ModelRegistry([]));
    expect(out.kind).toBe('escalate');
  });

  it('routing is deterministic (same req + registry → same outcome)', () => {
    const r = req({ reasoning: 'MEDIUM', coding: 'MEDIUM', context: 'MEDIUM' });
    expect(JSON.stringify(routeModel(r, REGISTRY))).toEqual(JSON.stringify(routeModel(r, REGISTRY)));
  });
});

describe('analyzeModelRequirement — mission → requirement (§12)', () => {
  const mission = (over: Partial<Mission>): Mission => ({
    missionId: 'm', goalId: 'g', userGoal: 'x', normalizedGoal: 'x',
    missionType: 'FEATURE',
    complexity: { level: 'LOW', confidence: 0.9, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope: 'FILE', planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [], modelRequirement: req({}), researchRequired: false,
    constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('LOW complexity → latency-sensitive, low capability', () => {
    const r = analyzeModelRequirement(mission({ complexity: { level: 'LOW', confidence: 0.9, reasons: [], usedAdvisory: false } }));
    expect(r.latencySensitive).toBe(true);
    expect(r.reasoning).toBe('LOW');
  });

  it('PROJECT / architecture-required → HIGH architecture + LARGE context, not latency-sensitive', () => {
    const r = analyzeModelRequirement(mission({
      missionType: 'PROJECT',
      complexity: { level: 'SYSTEM', confidence: 0.8, reasons: [], usedAdvisory: false },
      contextScope: 'REPOSITORY', architectureRequirement: 'REQUIRED',
    }));
    expect(r.architecture).toBe('HIGH');
    expect(r.context).toBe('LARGE');
    expect(r.latencySensitive).toBe(false);
  });

  it('full pipeline: a SYSTEM project routes to the STRONG model', () => {
    const r = analyzeModelRequirement(mission({
      missionType: 'PROJECT',
      complexity: { level: 'SYSTEM', confidence: 0.8, reasons: [], usedAdvisory: false },
      contextScope: 'REPOSITORY', architectureRequirement: 'REQUIRED',
    }));
    const out = routeModel(r, REGISTRY);
    expect(out.kind).toBe('selected');
    if (out.kind === 'selected') expect(out.model.id).toBe(STRONG.id);
  });
});
