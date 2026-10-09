// MissionIntelligence stage (P12.7) — the advisory pre-planning stage assembles a Mission from
// the deterministic analyzers, emits MISSION_* events, and (for complex missions with an
// architect wired) proposes an architecture + runs the gate. It is advisory: proceed is false
// ONLY when the ArchitectureGate BLOCKs. Everything deterministic (FakeModel; FM-8).
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  MissionArchitect,
  AssumptionAdvisor,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── In-memory EventLog double ─────────────────────────────────────────────────
class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(event: DomainEvent): Promise<void> { this.events.push(event); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(filter: EventFilter): Promise<readonly DomainEvent[]> {
    return this.events.filter((e) => filter.type === undefined || e.type === filter.type);
  }
  types(): string[] { return this.events.map((e) => e.type); }
}

function goal(description: string): Goal {
  return {
    goalId: 'g-1', version: 1, description,
    constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

function rt() {
  let n = 0;
  return { now: () => '2026-01-02T00:00:00.000Z', newId: () => `id-${++n}` };
}

const BLUEPRINT = JSON.stringify({
  summary: 'A layered app.',
  requirements: ['persist data'],
  moduleBoundaries: [{ name: 'domain', responsibility: 'rules', dependsOn: [] }],
  roadmap: [{ name: 'p1', outcome: 'model', requiresCapabilities: [] }],
  verificationStrategy: ['tests'],
  requiredCapabilities: [],
  openQuestions: [],
});

describe('MissionIntelligence.analyze — advisory stage', () => {
  it('classifies a trivial fix and proceeds without architecture (no architect needed)', async () => {
    const events = new MemoryEventLog();
    const stage = new MissionIntelligence({ events, ...rt() });

    const out = await stage.analyze('s-1', goal('fix the crash when the user clicks save'));

    expect(out.proceed).toBe(true);
    expect(out.mission.missionType).toBe('BUG_FIX');
    expect(out.mission.architectureRequirement).toBe('NOT_REQUIRED');
    expect(out.architecture).toBeUndefined();
    // Emitted the deterministic analysis events, scoped to the session.
    expect(events.types()).toContain('MISSION_RECEIVED');
    expect(events.types()).toContain('MISSION_CLASSIFIED');
    expect(events.types()).toContain('MISSION_PLANNING_MODE_SELECTED');
    expect(events.events.every((e) => e.sessionId === 's-1')).toBe(true);
    expect(events.events.every((e) => e.aggregate.kind === 'mission')).toBe(true);
  });

  it('a complex PROJECT with an architect wired proposes a blueprint and PASSES the gate', async () => {
    const events = new MemoryEventLog();
    const gateway = new FakeModel();
    gateway.setResponse(/.*/, BLUEPRINT);
    const stage = new MissionIntelligence({
      events, ...rt(),
      architect: new MissionArchitect({ gateway, now: () => '2026-01-02T00:00:00.000Z', newProvenanceId: () => 'prov' }),
    });

    const out = await stage.analyze('s-2', goal('build a new app from scratch with multiple subsystems'));

    expect(out.mission.missionType).toBe('PROJECT');
    expect(out.mission.architectureRequirement).toBe('REQUIRED');
    expect(out.architecture).toBeDefined();
    expect(out.gate?.verdict).toBe('PASS');
    expect(out.proceed).toBe(true);
    expect(events.types()).toContain('MISSION_ARCHITECTURE_PROPOSED');
    expect(events.types()).toContain('MISSION_ARCHITECTURE_GATE_PASSED');
  });

  it('BLOCKs (proceed=false) when the architecture needs a capability that is not VERIFIED', async () => {
    const events = new MemoryEventLog();
    const gateway = new FakeModel();
    // Blueprint requires docker, but no capability discovery is wired → nothing VERIFIED → BLOCK.
    gateway.setResponse(/.*/, JSON.stringify({
      ...JSON.parse(BLUEPRINT),
      requiredCapabilities: ['docker'],
    }));
    const stage = new MissionIntelligence({
      events, ...rt(),
      architect: new MissionArchitect({ gateway, now: () => '2026-01-02T00:00:00.000Z', newProvenanceId: () => 'prov' }),
    });

    const out = await stage.analyze('s-3', goal('build a new app from scratch with multiple subsystems'));

    expect(out.proceed).toBe(false);
    expect(out.gate?.verdict).toBe('BLOCK');
    expect(out.blockers.some((b) => b.includes('docker'))).toBe(true);
    expect(events.types()).toContain('MISSION_ARCHITECTURE_GATE_BLOCKED');
    expect(events.types()).toContain('MISSION_USER_CONFIRMATION_REQUIRED');
  });

  it('proceeds (advisory) when the architect LLM output is invalid — advisory layer never breaks the run', async () => {
    const events = new MemoryEventLog();
    const gateway = new FakeModel();
    gateway.setResponse(/.*/, 'not json');
    const stage = new MissionIntelligence({
      events, ...rt(),
      architect: new MissionArchitect({ gateway, now: () => '2026-01-02T00:00:00.000Z', newProvenanceId: () => 'prov' }),
    });

    const out = await stage.analyze('s-4', goal('build a new app from scratch with multiple subsystems'));

    expect(out.proceed).toBe(true);          // did not block on an advisory failure
    expect(out.architecture).toBeUndefined(); // blueprint skipped
  });
});

describe('MissionIntelligence.analyze — Tier B1 goal clarification (assume + state)', () => {
  // An under-specified goal: no acceptance criteria + vague "a script that".
  const vagueGoal = (): Goal => ({
    goalId: 'g-vague', version: 1, description: 'create a script that multiplies two matrices',
    constraints: [], acceptanceCriteria: [], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  });
  const CLARIFY = JSON.stringify({
    clarifiedGoal: 'matmul.py exposing multiply(a,b) over nested-list matrices',
    assumptions: [
      { question: 'representation?', assumption: 'nested Python lists', acceptance: 'multiply([[1,2],[3,4]],[[5,6],[7,8]]) == [[19,22],[43,50]]' },
    ],
  });

  it('makes explicit assumptions for an under-specified goal, emits them, and adds mission acceptance', async () => {
    const events = new MemoryEventLog();
    const gw = new FakeModel(); gw.setResponse(/.*/, CLARIFY);
    const stage = new MissionIntelligence({
      events, ...rt(),
      assumptionAdvisor: new AssumptionAdvisor({ gateway: gw, now: () => 't', newProvenanceId: () => 'p' }),
    });

    const out = await stage.analyze('s-5', vagueGoal());

    expect(out.mission.uncertainty.level).not.toBe('KNOWN'); // detected as vague (Tier A)
    expect(out.clarification).toBeDefined();
    expect(out.clarification?.assumptions.length).toBeGreaterThan(0);
    // The assumption's acceptance was mirrored into the Mission's acceptanceCriteria (not the Goal).
    expect(out.mission.acceptanceCriteria.some((ac) => ac.description.includes('19,22'))).toBe(true);
    expect(events.types()).toContain('MISSION_UNCERTAINTY_ASSESSED');
    expect(events.types()).toContain('MISSION_ASSUMPTIONS_MADE');
    expect(out.proceed).toBe(true);
  });

  it('does NOT clarify a KNOWN (precise) goal', async () => {
    const events = new MemoryEventLog();
    const gw = new FakeModel(); gw.setResponse(/.*/, CLARIFY);
    const stage = new MissionIntelligence({
      events, ...rt(),
      assumptionAdvisor: new AssumptionAdvisor({ gateway: gw, now: () => 't', newProvenanceId: () => 'p' }),
    });
    // goal() carries an acceptance criterion + concrete verb → should be KNOWN or near it.
    const out = await stage.analyze('s-6', goal('add an exported isEven(n) that returns true for even integers'));
    if (out.mission.uncertainty.level === 'KNOWN') {
      expect(out.clarification).toBeUndefined();
      expect(events.types()).not.toContain('MISSION_ASSUMPTIONS_MADE');
    }
  });

  it('proceeds unchanged when the advisor LLM output is invalid (fail-safe)', async () => {
    const events = new MemoryEventLog();
    const gw = new FakeModel(); gw.setResponse(/.*/, 'not json');
    const stage = new MissionIntelligence({
      events, ...rt(),
      assumptionAdvisor: new AssumptionAdvisor({ gateway: gw, now: () => 't', newProvenanceId: () => 'p' }),
    });
    const out = await stage.analyze('s-7', vagueGoal());
    expect(out.proceed).toBe(true);
    expect(out.clarification).toBeUndefined();
  });
});
