// MissionIntelligence — Goal Clarification Gate branches (opt-in `--clarify on`).
//
// When a ClarificationGate is wired and the goal scores UNKNOWN, the stage ASKS the user
// (GOAL_CLARIFICATION_REQUESTED → gate.awaitAnswers → GOAL_CLARIFICATION_ANSWERED) and the
// AssumptionAdvisor only assumes for the skipped questions. Deterministic: FakeModel advisor
// (FM-8), injected clock/id, in-memory EventLog, scripted fake gate.
//
// Validates: Requirements 2.1, 2.2, 3.6, 4.1, 4.2, 4.3, 4.4, 7.4, 7.5, 7.7, 7.8
import { describe, it, expect, vi } from 'vitest';
import {
  MissionIntelligence,
  MissionArchitect,
  AssumptionAdvisor,
  ModelRegistry,
  assessUncertainty,
  extractSignals,
  classifyMissionType,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
  type ClarificationGate,
  type ClarificationRequest,
  type ClarificationOutcome,
  type RegisteredModel,
  type Mission,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── Test doubles ──────────────────────────────────────────────────────────────

class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(event: DomainEvent): Promise<void> { this.events.push(event); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(filter: EventFilter): Promise<readonly DomainEvent[]> {
    return this.events.filter((e) => filter.type === undefined || e.type === filter.type);
  }
  types(): string[] { return this.events.map((e) => e.type); }
  ofType(type: string): DomainEvent[] { return this.events.filter((e) => e.type === type); }
}

/** Scripted gate: records every call + a snapshot of the event types at call time. */
class FakeGate implements ClarificationGate {
  public readonly calls: { sessionId: string; request: ClarificationRequest; eventTypesAtCall: string[] }[] = [];
  constructor(
    private readonly log: MemoryEventLog,
    private readonly respond: (request: ClarificationRequest) => ClarificationOutcome,
  ) {}
  async awaitAnswers(sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    this.calls.push({ sessionId, request, eventTypesAtCall: this.log.types() });
    return this.respond(request);
  }
}

function rt() {
  let n = 0;
  return { now: () => '2026-01-02T00:00:00.000Z', newId: () => `id-${++n}` };
}

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** Same derivation MissionIntelligence uses, so the test can assert the level up front. */
function scoreGoal(g: Goal) {
  const signals = extractSignals(g.description);
  const t = classifyMissionType(signals).type;
  return assessUncertainty(signals, t === 'UNKNOWN' ? 'FEATURE' : t, g.acceptanceCriteria);
}

// Vague: no acceptance + "a script that" + no I/O spec words → UNKNOWN (3 open questions).
const vagueGoal = (): Goal => ({
  goalId: 'g-vague', version: 1, description: 'create a script that multiplies two matrices',
  constraints: [], acceptanceCriteria: [], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
});
// Precise + acceptance → KNOWN.
const knownGoal = (): Goal => ({
  goalId: 'g-known', version: 1, description: 'add an exported isEven(n) that returns true for even integers',
  constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
});
// Precise but no acceptance → exactly one signal → INFERRED.
const inferredGoal = (): Goal => ({ ...knownGoal(), goalId: 'g-inferred', acceptanceCriteria: [] });

const DEFAULTS = JSON.stringify({
  clarifiedGoal: 'matmul.py exposing multiply(a,b) over nested-list matrices',
  assumptions: [
    { question: 'representation?', assumption: 'nested Python lists', acceptance: 'multiply([[1,2],[3,4]],[[5,6],[7,8]]) == [[19,22],[43,50]]' },
    { question: 'verify?', assumption: 'a pytest unit test', acceptance: 'pytest passes' },
  ],
});
const DEFAULT_STATEMENTS = ['nested Python lists', 'a pytest unit test'];

function advisorWith(response: string) {
  const gw = new FakeModel();
  gw.setResponse(/.*/, response);
  const advisor = new AssumptionAdvisor({ gateway: gw, now: () => 't', newProvenanceId: () => 'p' });
  const spy = vi.spyOn(advisor, 'clarify');
  return { gw, advisor, spy };
}

function userStatement(q: { text: string }, answer: string): string {
  return `[user-provided] ${q.text} → ${answer}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MissionIntelligence — clarification gate (UNKNOWN goal)', () => {
  it('the vague fixture scores UNKNOWN with open questions', () => {
    const u = scoreGoal(vagueGoal());
    expect(u.level).toBe('UNKNOWN');
    expect(u.openQuestions.length).toBeGreaterThanOrEqual(2);
  });

  it('appends GOAL_CLARIFICATION_REQUESTED (with the full payload) BEFORE awaitAnswers is called', async () => {
    const events = new MemoryEventLog();
    const gate = new FakeGate(events, () => ({ kind: 'timeout' }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate });

    const out = await stage.analyze('s-1', vagueGoal());

    expect(gate.calls).toHaveLength(1);
    const call = gate.calls[0]!;
    expect(call.sessionId).toBe('s-1');
    expect(call.eventTypesAtCall).toContain('GOAL_CLARIFICATION_REQUESTED');
    expect(call.eventTypesAtCall).not.toContain('GOAL_CLARIFICATION_ANSWERED');

    const requested = events.ofType('GOAL_CLARIFICATION_REQUESTED');
    expect(requested).toHaveLength(1);
    const expectedQuestions = scoreGoal(vagueGoal()).openQuestions;
    expect(requested[0]!.aggregate).toEqual({ kind: 'mission', id: out.mission.missionId });
    expect(requested[0]!.payload).toEqual({
      requestId: call.request.requestId,
      missionId: out.mission.missionId,
      goalId: 'g-vague',
      level: 'UNKNOWN',
      openQuestions: call.request.openQuestions,
    });
    // ids q1..qN follow the analyzer's order; the gate receives the same request.
    expect(call.request.openQuestions.map((q) => q.id)).toEqual(expectedQuestions.map((_, i) => `q${i + 1}`));
    expect(call.request.openQuestions.map((q) => q.text)).toEqual(expectedQuestions);
    expect(call.request.missionId).toBe(out.mission.missionId);
    expect(call.request.goalId).toBe('g-vague');
  });

  it('all questions answered → KNOWN copy, advisor not called, user statements in q order, ANSWERED source=user', async () => {
    const events = new MemoryEventLog();
    const { gw, advisor, spy } = advisorWith(DEFAULTS);
    const gate = new FakeGate(events, (req) => ({
      kind: 'answered',
      answers: Object.fromEntries(req.openQuestions.map((q) => [q.id, `answer ${q.id}`])),
    }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });

    const out = await stage.analyze('s-2', vagueGoal());
    const req = gate.calls[0]!.request;
    const expected = req.openQuestions.map((q) => userStatement(q, `answer ${q.id}`));

    expect(out.proceed).toBe(true);
    expect(out.mission.uncertainty).toEqual({ level: 'KNOWN', openQuestions: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(gw.callCount).toBe(0);
    expect(out.assumptions).toEqual(expected);
    expect(out.clarification).toBeUndefined();
    expect(events.types()).not.toContain('MISSION_ASSUMPTIONS_MADE');

    const answered = events.ofType('GOAL_CLARIFICATION_ANSWERED');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toEqual({
      requestId: req.requestId,
      source: 'user',
      answers: req.openQuestions.map((q) => ({ questionId: q.id, question: q.text, answer: `answer ${q.id}` })),
      skippedQuestionIds: [],
      assumptions: expected,
    });
  });

  it('partial skip → advisor sees only skipped texts, MISSION_ASSUMPTIONS_MADE, user statements then defaults', async () => {
    const events = new MemoryEventLog();
    const { advisor, spy } = advisorWith(DEFAULTS);
    // Answer q1 only; q2 blank (whitespace-only normalizes to ''), q3 key omitted.
    const gate = new FakeGate(events, () => ({ kind: 'answered', answers: { q1: '  a matrix\nmultiply CLI ', q2: '   ' } }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });

    const out = await stage.analyze('s-3', vagueGoal());
    const req = gate.calls[0]!.request;
    const [q1, ...skipped] = req.openQuestions;

    expect(spy).toHaveBeenCalledTimes(1);
    const seen = spy.mock.calls[0]![0] as Mission;
    expect(seen.uncertainty.openQuestions).toEqual(skipped.map((q) => q.text));

    expect(events.types()).toContain('MISSION_ASSUMPTIONS_MADE');
    const userStmt = userStatement(q1!, 'a matrix multiply CLI');
    expect(out.assumptions).toEqual([userStmt, ...DEFAULT_STATEMENTS]);
    // Real uncertainty is kept on the copy (not forced to KNOWN) when something was skipped.
    expect(out.mission.uncertainty.level).toBe('UNKNOWN');

    const answered = events.ofType('GOAL_CLARIFICATION_ANSWERED');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toMatchObject({
      requestId: req.requestId,
      source: 'user',
      answers: [{ questionId: 'q1', question: q1!.text, answer: 'a matrix multiply CLI' }],
      skippedQuestionIds: skipped.map((q) => q.id),
      assumptions: [userStmt, ...DEFAULT_STATEMENTS],
    });
    // ASSUMPTIONS_MADE precedes ANSWERED (ANSWERED carries the merged list).
    expect(events.types().indexOf('MISSION_ASSUMPTIONS_MADE'))
      .toBeLessThan(events.types().indexOf('GOAL_CLARIFICATION_ANSWERED'));
  });

  it('advisor throws (invalid output) → only user statements, ANSWERED still emitted', async () => {
    const events = new MemoryEventLog();
    const { advisor, spy } = advisorWith('not json');
    const gate = new FakeGate(events, () => ({ kind: 'answered', answers: { q1: 'yes' } }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });

    const out = await stage.analyze('s-4', vagueGoal());
    const q1 = gate.calls[0]!.request.openQuestions[0]!;

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.proceed).toBe(true);
    expect(out.clarification).toBeUndefined();
    expect(out.assumptions).toEqual([userStatement(q1, 'yes')]);
    expect(events.types()).not.toContain('MISSION_ASSUMPTIONS_MADE');
    const answered = events.ofType('GOAL_CLARIFICATION_ANSWERED');
    expect(answered).toHaveLength(1);
    expect((answered[0]!.payload as { assumptions: string[] }).assumptions).toEqual([userStatement(q1, 'yes')]);
  });

  it('timeout → source=timeout, every question skipped, defaults from the advisor', async () => {
    const events = new MemoryEventLog();
    const { advisor, spy } = advisorWith(DEFAULTS);
    const gate = new FakeGate(events, () => ({ kind: 'timeout' }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });

    const out = await stage.analyze('s-5', vagueGoal());
    const req = gate.calls[0]!.request;

    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0]![0] as Mission).uncertainty.openQuestions).toEqual(req.openQuestions.map((q) => q.text));
    expect(out.proceed).toBe(true);
    expect(out.assumptions).toEqual(DEFAULT_STATEMENTS);
    expect(events.types()).toContain('MISSION_ASSUMPTIONS_MADE');
    const answered = events.ofType('GOAL_CLARIFICATION_ANSWERED');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toEqual({
      requestId: req.requestId,
      source: 'timeout',
      answers: [],
      skippedQuestionIds: req.openQuestions.map((q) => q.id),
      assumptions: DEFAULT_STATEMENTS,
    });
  });

  it('cancelled → proceed=false, blocker, no ANSWERED, no routing/architect', async () => {
    const events = new MemoryEventLog();
    const { advisor, spy } = advisorWith(DEFAULTS);
    const archGw = new FakeModel();
    archGw.setResponse(/.*/, '{}');
    const model: RegisteredModel = {
      id: 'm-medium', tier: 'MEDIUM',
      capabilities: { reasoning: 'MEDIUM', coding: 'MEDIUM', architecture: 'MEDIUM', context: 'MEDIUM', toolUse: 'MEDIUM', speed: 'MEDIUM' },
    };
    const gate = new FakeGate(events, () => ({ kind: 'cancelled' }));
    const stage = new MissionIntelligence({
      events, ...rt(),
      clarificationGate: gate,
      assumptionAdvisor: advisor,
      modelRegistry: new ModelRegistry([model]),
      architect: new MissionArchitect({ gateway: archGw, now: () => 't', newProvenanceId: () => 'p' }),
    });

    const out = await stage.analyze('s-6', vagueGoal());

    expect(out.proceed).toBe(false);
    expect(out.blockers).toEqual(['clarification cancelled']);
    expect(out.routing).toBeUndefined();
    expect(out.selectedModelId).toBeUndefined();
    expect(out.architecture).toBeUndefined();
    expect(out.assumptions).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(archGw.callCount).toBe(0);
    expect(events.types()).toContain('GOAL_CLARIFICATION_REQUESTED');
    expect(events.types()).not.toContain('GOAL_CLARIFICATION_ANSWERED');
    expect(events.types()).not.toContain('MISSION_MODEL_SELECTED');
    expect(events.types()).not.toContain('MISSION_ARCHITECTURE_PROPOSED');
  });

  it('never mutates the Goal (MI-004)', async () => {
    const events = new MemoryEventLog();
    const { advisor } = advisorWith(DEFAULTS);
    const gate = new FakeGate(events, () => ({ kind: 'answered', answers: { q1: 'x' } }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });
    const g = vagueGoal();
    const before = structuredClone(g);
    deepFreeze(g);

    const out = await stage.analyze('s-7', g);

    expect(g).toEqual(before);
    expect(out.mission.acceptanceCriteria.length).toBeGreaterThan(0); // copy got assumed criteria
    expect(g.acceptanceCriteria).toEqual([]);
  });
});

describe('MissionIntelligence — clarification gate skipped for KNOWN / INFERRED goals', () => {
  it.each([
    ['KNOWN', knownGoal],
    ['INFERRED', inferredGoal],
  ] as const)('%s goal → gate never called, no GOAL_CLARIFICATION_* events', async (level, make) => {
    expect(scoreGoal(make()).level).toBe(level);
    const events = new MemoryEventLog();
    const { advisor } = advisorWith(DEFAULTS);
    const gate = new FakeGate(events, () => ({ kind: 'timeout' }));
    const stage = new MissionIntelligence({ events, ...rt(), clarificationGate: gate, assumptionAdvisor: advisor });

    const out = await stage.analyze('s-8', make());

    expect(gate.calls).toHaveLength(0);
    expect(out.proceed).toBe(true);
    expect(events.types().some((t) => t.startsWith('GOAL_CLARIFICATION_'))).toBe(false);
    if (level === 'INFERRED') {
      // Existing assume-and-state path still runs for INFERRED.
      expect(out.assumptions).toEqual(DEFAULT_STATEMENTS);
      expect(events.types()).toContain('MISSION_ASSUMPTIONS_MADE');
    }
  });
});
