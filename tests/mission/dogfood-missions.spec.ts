// Phase 12 dogfood (§32) — drive 7 goals of increasing complexity through the REAL
// MissionIntelligence stage and assert the behavior SHIFT Phase 12 exists to produce:
//   - mission type is classified from objective signals,
//   - complexity scales from LOW → SYSTEM,
//   - model routing picks a cheaper model for trivial work and a stronger one for heavy work
//     (MI-006, within a real registry),
//   - planning mode escalates DIRECT → ARCHITECTURE_FIRST,
//   - architecture is produced ONLY for complex missions (trivial stays cheap — MI-002/§34).
//
// Deterministic: FakeModel architect (FM-8), injected clock/id, in-memory event log.
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  MissionArchitect,
  ModelRegistry,
  type RegisteredModel,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

class MemEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(e: DomainEvent): Promise<void> { this.events.push(e); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(_f: EventFilter): Promise<readonly DomainEvent[]> { return this.events; }
}

const SMALL: RegisteredModel = {
  id: 'qwen2.5-coder:1.5b', tier: 'SMALL',
  capabilities: { reasoning: 'LOW', coding: 'MEDIUM', architecture: 'LOW', context: 'SMALL', toolUse: 'MEDIUM', speed: 'FAST' },
};
const MEDIUM: RegisteredModel = {
  id: 'qwen2.5-coder:7b', tier: 'MEDIUM',
  capabilities: { reasoning: 'MEDIUM', coding: 'MEDIUM', architecture: 'MEDIUM', context: 'MEDIUM', toolUse: 'MEDIUM', speed: 'MEDIUM' },
};
const STRONG: RegisteredModel = {
  id: 'deepseek-r1:14b', tier: 'STRONG',
  capabilities: { reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', speed: 'SLOW' },
};
const REGISTRY = new ModelRegistry([SMALL, MEDIUM, STRONG]);

const VALID_BLUEPRINT = JSON.stringify({
  summary: 'Layered design.',
  requirements: ['persist data', 'expose API'],
  moduleBoundaries: [{ name: 'domain', responsibility: 'rules', dependsOn: [] }],
  roadmap: [{ name: 'p1', outcome: 'model', requiresCapabilities: [] }],
  verificationStrategy: ['unit tests', 'typecheck'],
  requiredCapabilities: [],
  openQuestions: [],
});

function goal(description: string): Goal {
  return {
    goalId: `G-${description.length}`, version: 1, description,
    constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

function makeStage() {
  let n = 0;
  const events = new MemEventLog();
  const gateway = new FakeModel();
  gateway.setResponse(/.*/, VALID_BLUEPRINT);
  const stage = new MissionIntelligence({
    events,
    now: () => '2026-01-02T00:00:00.000Z',
    newId: () => `id-${++n}`,
    modelRegistry: REGISTRY,
    architect: new MissionArchitect({ gateway, now: () => '2026-01-02T00:00:00.000Z', newProvenanceId: () => `prov-${++n}` }),
  });
  return { stage, events };
}

// The 7 dogfood missions, increasing in scope (§32).
const MISSIONS = [
  { label: 'M1 trivial rename', goal: 'rename the variable count to total in utils' },
  { label: 'M2 bug fix',        goal: 'fix the crash when the user submits an empty form' },
  { label: 'M3 small feature',  goal: 'add a logout button to the settings screen' },
  { label: 'M4 integration',    goal: 'integrate the telegram bot api to send notifications on build failure' },
  { label: 'M5 migration',      goal: 'migrate the database schema from mysql to postgres with reversible steps' },
  { label: 'M6 new project',    goal: 'build a new app from scratch with multiple subsystems and a web and android target' },
  { label: 'M7 system/multi',   goal: 'design the system architecture for a multi-repo monorepo spanning several subsystems across windows android and web' },
];

describe('Phase 12 dogfood (§32) — 7 missions of increasing complexity', () => {
  it('each mission is analyzed and produces a coherent advisory outcome', async () => {
    const summary: Array<Record<string, unknown>> = [];
    for (const m of MISSIONS) {
      const { stage } = makeStage();
      const out = await stage.analyze('S', goal(m.goal));
      summary.push({
        label: m.label,
        type: out.mission.missionType,
        complexity: out.mission.complexity.level,
        planning: out.mission.planningMode,
        archReq: out.mission.architectureRequirement,
        model: out.routing?.kind === 'escalate' ? 'escalate' : out.routing?.model.id,
        hasArchitecture: out.architecture !== undefined,
        proceed: out.proceed,
      });
    }
    // Print the dogfood table so the sign-off numbers are reproducible from the test log.
    console.log('DOGFOOD\n' + JSON.stringify(summary, null, 2));

    // Every mission produced an outcome and proceeded (all blueprints here PASS the gate).
    expect(summary).toHaveLength(7);
    expect(summary.every((s) => s.proceed === true)).toBe(true);
  });

  it('M1 trivial: LOW complexity, DIRECT planning, cheapest model, NO architecture (stays cheap)', async () => {
    const { stage } = makeStage();
    const out = await stage.analyze('S', goal(MISSIONS[0]!.goal));
    expect(out.mission.complexity.level).toBe('LOW');
    expect(out.mission.planningMode).toBe('DIRECT');
    expect(out.mission.architectureRequirement).toBe('NOT_REQUIRED');
    expect(out.architecture).toBeUndefined();
    expect(out.routing?.kind).toBe('selected');
    if (out.routing?.kind === 'selected') expect(out.routing.model.id).toBe(SMALL.id);
  });

  it('M6 new project: HIGH/SYSTEM complexity, ARCHITECTURE_FIRST, strong model, architecture produced', async () => {
    const { stage } = makeStage();
    const out = await stage.analyze('S', goal(MISSIONS[5]!.goal));
    expect(out.mission.missionType).toBe('PROJECT');
    expect(['HIGH', 'SYSTEM']).toContain(out.mission.complexity.level);
    expect(out.mission.planningMode).toBe('ARCHITECTURE_FIRST');
    expect(out.architecture).toBeDefined();
    expect(out.routing?.kind).toBe('selected');
    if (out.routing?.kind === 'selected') expect(out.routing.model.id).toBe(STRONG.id);
  });

  it('M7 system/multi-repo: SYSTEM complexity routes to the strongest model', async () => {
    const { stage } = makeStage();
    const out = await stage.analyze('S', goal(MISSIONS[6]!.goal));
    expect(out.mission.complexity.level).toBe('SYSTEM');
    if (out.routing?.kind === 'selected') expect(out.routing.model.id).toBe(STRONG.id);
  });

  it('trivial vs project route to DIFFERENT models (the core §34 differentiation)', async () => {
    const { stage: s1 } = makeStage();
    const trivial = await s1.analyze('S', goal(MISSIONS[0]!.goal));
    const { stage: s2 } = makeStage();
    const project = await s2.analyze('S', goal(MISSIONS[5]!.goal));
    const trivialModel = trivial.routing?.kind === 'selected' ? trivial.routing.model.id : undefined;
    const projectModel = project.routing?.kind === 'selected' ? project.routing.model.id : undefined;
    expect(trivialModel).toBeDefined();
    expect(projectModel).toBeDefined();
    expect(trivialModel).not.toBe(projectModel);
  });
});
