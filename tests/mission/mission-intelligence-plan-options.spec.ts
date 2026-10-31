// Feature: plan-options, Property 4: Tắt cờ thì không đổi
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// MissionIntelligence — plan options branches (Goal Clarification Phase 2).
// **Validates: Requirements 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.4, 4.5, 4.6, 6.1, 6.4, 6.6, 8.2**
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  ApproachAdvisor,
  buildPlanOptionsRequest,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
  type Mission,
  type PlanOption,
  type PlanChoiceGate,
  type PlanChoiceOutcome,
  type PlanOptionsRequest,
  type ClarificationGate,
  type ClarificationOutcome,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';
import { mulberry32, pick, bool } from './clarification-generators.js';

class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(e: DomainEvent): Promise<void> { this.events.push(e); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(f: EventFilter): Promise<readonly DomainEvent[]> { return this.events.filter((e) => f.type === undefined || e.type === f.type); }
  types(): string[] { return this.events.map((e) => e.type); }
}

const OPTIONS: readonly PlanOption[] = [
  { id: 'o1', title: 'Single script', summary: 'One file with a CLI.', pros: ['Fast'], cons: ['No tests'], recommended: false },
  { id: 'o2', title: 'Module + tests', summary: 'A module plus pytest tests.', pros: ['Verifiable'], cons: ['More files'], recommended: true },
];

class FakeAdvisor {
  public calls: { mission: Mission; statements: readonly string[] }[] = [];
  constructor(private readonly result: readonly PlanOption[] | Error) {}
  async propose(mission: Mission, statements: readonly string[]): Promise<readonly PlanOption[]> {
    this.calls.push({ mission, statements });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
const asAdvisor = (a: FakeAdvisor) => a as unknown as ApproachAdvisor;

class FakePlanGate implements PlanChoiceGate {
  public calls: { request: PlanOptionsRequest; typesAtCall: string[] }[] = [];
  constructor(private readonly log: MemoryEventLog, private readonly respond: (r: PlanOptionsRequest) => PlanChoiceOutcome) {}
  async awaitChoice(_sid: string, request: PlanOptionsRequest): Promise<PlanChoiceOutcome> {
    this.calls.push({ request, typesAtCall: this.log.types() });
    return this.respond(request);
  }
}

function rt(prefix = 'id') { let n = 0; return { now: () => '2026-01-02T00:00:00.000Z', newId: () => `${prefix}-${++n}` }; }
const AC = [{ criterionId: 'a', description: 'tests pass', mandatory: true }];
const mk = (goalId: string, description: string, acceptance = AC): Goal => ({
  goalId, version: 1, description, constraints: [], acceptanceCriteria: acceptance, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
});
// Probed fixtures: MEDIUM/KNOWN, LOW/KNOWN, MEDIUM/UNKNOWN (no acceptance).
const MEDIUM = mk('g-med', 'build a command-line tool that multiplies two matrices read from CSV files and writes the result to a file, with unit tests');
const LOW = mk('g-low', 'add an exported isEven(n) that returns true for even integers');
const VAGUE_MEDIUM = mk('g-vm', 'build a project that does something useful with matrices', []);

function stage(events: MemoryEventLog, extra: Record<string, unknown> = {}, prefix = 'id') {
  return new MissionIntelligence({ events, ...rt(prefix), ...extra } as never);
}

describe('plan options — main branches', () => {
  it('MEDIUM goal: PROPOSED is logged before the wait; user choice steers assumptions + outcome', async () => {
    const events = new MemoryEventLog();
    const advisor = new FakeAdvisor(OPTIONS);
    const gate = new FakePlanGate(events, () => ({ kind: 'chosen', optionId: 'o1', source: 'user' }));
    const out = await stage(events, { approachAdvisor: asAdvisor(advisor), planChoiceGate: gate }).analyze('S', MEDIUM);

    expect(out.mission.complexity.level).toBe('MEDIUM');
    expect(advisor.calls).toHaveLength(1);
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]!.typesAtCall).toContain('PLAN_OPTIONS_PROPOSED');
    expect(gate.calls[0]!.typesAtCall).not.toContain('PLAN_OPTION_CHOSEN');
    const proposed = events.events.find((e) => e.type === 'PLAN_OPTIONS_PROPOSED')!;
    expect(proposed.payload).toEqual({
      requestId: gate.calls[0]!.request.requestId, missionId: out.mission.missionId, goalId: 'g-med',
      options: OPTIONS, recommendedOptionId: 'o2',
    });
    const chosen = events.events.filter((e) => e.type === 'PLAN_OPTION_CHOSEN');
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.payload).toEqual({ requestId: gate.calls[0]!.request.requestId, optionId: 'o1', source: 'user' });
    expect(out.proceed).toBe(true);
    expect(out.chosenApproach).toEqual({ requestId: gate.calls[0]!.request.requestId, option: OPTIONS[0], source: 'user' });
    expect(out.assumptions).toEqual(['[chosen-approach] Single script — One file with a CLI.']);
  });

  it('useRecommended → source default; timeout → recommended with source timeout', async () => {
    for (const [outcome, source] of [[{ kind: 'chosen', optionId: 'o2', source: 'default' }, 'default'], [{ kind: 'timeout' }, 'timeout']] as const) {
      const events = new MemoryEventLog();
      const gate = new FakePlanGate(events, () => outcome as PlanChoiceOutcome);
      const out = await stage(events, { approachAdvisor: asAdvisor(new FakeAdvisor(OPTIONS)), planChoiceGate: gate }).analyze('S', MEDIUM);
      expect(out.chosenApproach?.option.id).toBe('o2');
      expect(out.chosenApproach?.source).toBe(source);
      expect(events.events.find((e) => e.type === 'PLAN_OPTION_CHOSEN')!.payload).toMatchObject({ optionId: 'o2', source });
    }
  });

  it('cancelled → proceed:false, blocker, no CHOSEN, no routing', async () => {
    const events = new MemoryEventLog();
    const gate = new FakePlanGate(events, () => ({ kind: 'cancelled' }));
    const out = await stage(events, { approachAdvisor: asAdvisor(new FakeAdvisor(OPTIONS)), planChoiceGate: gate }).analyze('S', MEDIUM);
    expect(out.proceed).toBe(false);
    expect(out.blockers).toEqual(['plan choice cancelled']);
    expect(out.chosenApproach).toBeUndefined();
    expect(events.types()).not.toContain('PLAN_OPTION_CHOSEN');
    expect(events.types()).not.toContain('MISSION_MODEL_SELECTED');
  });

  it.each([
    ['LOW complexity', LOW, new FakeAdvisor(OPTIONS)],
    ['advisor throws', MEDIUM, new FakeAdvisor(new Error('model down'))],
    ['fewer than 2 options', MEDIUM, new FakeAdvisor(OPTIONS.slice(0, 1))],
  ] as const)('%s → skipped: no PLAN_* events, gate not called, no chosenApproach', async (_l, goal, advisor) => {
    const events = new MemoryEventLog();
    const gate = new FakePlanGate(events, () => ({ kind: 'timeout' }));
    const out = await stage(events, { approachAdvisor: asAdvisor(advisor), planChoiceGate: gate }).analyze('S', goal);
    expect(gate.calls).toHaveLength(0);
    expect(events.types().some((t) => t.startsWith('PLAN_OPTION'))).toBe(false);
    expect(out.chosenApproach).toBeUndefined();
    expect(out.proceed).toBe(true);
  });

  it('runs AFTER clarification and receives the user statements; a cancelled clarification never proposes', async () => {
    const events = new MemoryEventLog();
    const clarify: ClarificationGate = { awaitAnswers: async (_s, r) => ({ kind: 'answered', answers: { [r.openQuestions[0]!.id]: 'numpy arrays' } }) };
    const advisor = new FakeAdvisor(OPTIONS);
    const gate = new FakePlanGate(events, () => ({ kind: 'chosen', optionId: 'o2', source: 'user' }));
    const out = await stage(events, { clarificationGate: clarify, approachAdvisor: asAdvisor(advisor), planChoiceGate: gate }).analyze('S', VAGUE_MEDIUM);
    const types = events.types();
    expect(types.indexOf('GOAL_CLARIFICATION_ANSWERED')).toBeLessThan(types.indexOf('PLAN_OPTIONS_PROPOSED'));
    expect(advisor.calls[0]!.statements[0]).toMatch(/^\[user-provided\] .* → numpy arrays$/);
    expect(out.assumptions?.at(-1)).toBe('[chosen-approach] Module + tests — A module plus pytest tests.');

    const events2 = new MemoryEventLog();
    const cancelClarify: ClarificationGate = { awaitAnswers: async (): Promise<ClarificationOutcome> => ({ kind: 'cancelled' }) };
    const advisor2 = new FakeAdvisor(OPTIONS);
    await stage(events2, { clarificationGate: cancelClarify, approachAdvisor: asAdvisor(advisor2), planChoiceGate: gate }).analyze('S', VAGUE_MEDIUM);
    expect(advisor2.calls).toHaveLength(0);
  });

  it('the real ApproachAdvisor (FakeModel) feeds the same flow', async () => {
    const gw = new FakeModel();
    gw.setResponse(/.*/, JSON.stringify({ options: OPTIONS.map(({ id: _id, ...o }) => o) }));
    const events = new MemoryEventLog();
    const gate = new FakePlanGate(events, () => ({ kind: 'chosen', optionId: 'o2', source: 'user' }));
    const out = await stage(events, { approachAdvisor: new ApproachAdvisor({ gateway: gw }), planChoiceGate: gate }).analyze('S', MEDIUM);
    expect(out.chosenApproach?.option.title).toBe('Module + tests');
  });
});

describe('plan options — resumePlanChoice (session-resume)', () => {
  it('waits on the logged request, does not call the advisor or re-run clarification, no event replay', async () => {
    const events = new MemoryEventLog();
    // Process A proposes then "dies" (cancelled).
    const a = await stage(events, { approachAdvisor: asAdvisor(new FakeAdvisor(OPTIONS)), planChoiceGate: new FakePlanGate(events, () => ({ kind: 'cancelled' })) }, 'A').analyze('S', MEDIUM);
    const proposed = events.events.find((e) => e.type === 'PLAN_OPTIONS_PROPOSED')!;
    const request = buildPlanOptionsRequest((proposed.payload as { requestId: string }).requestId, a.mission.missionId, 'g-med', OPTIONS);
    const before = events.events.length;

    const advisor = new FakeAdvisor(OPTIONS);
    let clarifyCalled = false;
    const clarify: ClarificationGate = { awaitAnswers: async () => { clarifyCalled = true; return { kind: 'timeout' }; } };
    const gate = new FakePlanGate(events, () => ({ kind: 'chosen', optionId: 'o1', source: 'user' }));
    const out = await stage(events, { clarificationGate: clarify, approachAdvisor: asAdvisor(advisor), planChoiceGate: gate }, 'B')
      .analyze('S', MEDIUM, { resumePlanChoice: { missionId: a.mission.missionId, request, priorAssumptions: ['[user-provided] q → a'] } });

    expect(advisor.calls).toHaveLength(0);
    expect(clarifyCalled).toBe(false);
    expect(gate.calls[0]!.request).toEqual(request);
    const added = events.events.slice(before).map((e) => e.type);
    expect(added).not.toContain('MISSION_RECEIVED');
    expect(added).not.toContain('PLAN_OPTIONS_PROPOSED');
    expect(added).toContain('PLAN_OPTION_CHOSEN');
    expect(out.mission.missionId).toBe(a.mission.missionId);
    expect(out.assumptions).toEqual(['[user-provided] q → a', '[chosen-approach] Single script — One file with a CLI.']);
  });
});

describe('Property 4: without plan deps the stage is unchanged', () => {
  it('no PLAN_* events / no chosenApproach without deps; with deps on LOW goals the run is identical', async () => {
    const rng = mulberry32(0x91074);
    const pool = [MEDIUM, LOW, VAGUE_MEDIUM, mk('g-x', 'create a REST API service with user authentication, a database layer and integration tests'),
      mk('g-y', 'refactor the parser module into separate lexer and parser files and update all imports')];
    for (let i = 0; i < 120; i++) {
      const goal = pick(rng, pool);
      const withAcceptance = bool(rng, 0.7) ? goal : { ...goal, acceptanceCriteria: [] };
      const e1 = new MemoryEventLog();
      const plain = await stage(e1).analyze('S', withAcceptance);
      expect(e1.types().some((t) => t.startsWith('PLAN_OPTION'))).toBe(false);
      expect(plain.chosenApproach).toBeUndefined();
      if (plain.mission.complexity.level === 'LOW') {
        const e2 = new MemoryEventLog();
        const advisor = new FakeAdvisor(OPTIONS);
        const wired = await stage(e2, { approachAdvisor: asAdvisor(advisor), planChoiceGate: new FakePlanGate(e2, () => ({ kind: 'timeout' })) }).analyze('S', withAcceptance);
        expect(advisor.calls).toHaveLength(0);
        expect(e2.events).toEqual(e1.events);
        expect(wired).toEqual(plain);
      }
    }
  });
});