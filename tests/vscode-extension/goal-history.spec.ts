// goal-history (P12.23) — pure model binding submitted goals to runtime sessions (no vscode).
import { describe, it, expect } from 'vitest';
import {
  newGoalEntry, withGoalId, reconcileHistory, statusFromSessionState, statusChip,
  findOpenClarification, findOpenPlanChoice,
  type GoalEntry, type BindableSession, type ClarificationEventLike,
} from '../../packages/vscode-extension/src/goal-history.js';
import { forAll, int, pick, bool, type Rng } from '../mission/clarification-generators.js';

describe('statusFromSessionState', () => {
  it('maps terminal success states to completed', () => {
    expect(statusFromSessionState('COMPLETED')).toBe('completed');
    expect(statusFromSessionState('succeeded')).toBe('completed');
  });
  it('maps terminal failure states to failed', () => {
    expect(statusFromSessionState('FAILED')).toBe('failed');
    expect(statusFromSessionState('ABORTED')).toBe('failed');
    expect(statusFromSessionState('cancelled')).toBe('failed');
  });
  it('treats anything else as running', () => {
    expect(statusFromSessionState('RUNNING')).toBe('running');
    expect(statusFromSessionState('PLANNING')).toBe('running');
  });
});

describe('newGoalEntry / withGoalId', () => {
  it('starts queued with no session', () => {
    const e = newGoalEntry('g1', 'do a thing', '2026-01-01T00:00:00.000Z');
    expect(e.status).toBe('queued');
    expect(e.sessionId).toBeUndefined();
    expect(e.goalId).toBeUndefined();
  });
  it('records the runtime goalId without changing status', () => {
    const e = withGoalId(newGoalEntry('g1', 'x', 't'), 'goal-42');
    expect(e.goalId).toBe('goal-42');
    expect(e.status).toBe('queued');
  });
});

describe('reconcileHistory', () => {
  const base = (localId: string, submittedAt: string): GoalEntry => newGoalEntry(localId, localId, submittedAt);

  it('binds a queued goal to the oldest session created at/after submit time', () => {
    const history = [base('g1', '2026-01-01T00:00:00.000Z')];
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'RUNNING', createdAt: '2026-01-01T00:00:05.000Z' },
    ];
    const [out] = reconcileHistory(history, sessions);
    expect(out.sessionId).toBe('s1');
    expect(out.status).toBe('running');
  });

  it('does not bind a session created before the goal was submitted', () => {
    const history = [base('g1', '2026-01-01T00:00:10.000Z')];
    const sessions: BindableSession[] = [
      { sessionId: 's-old', state: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const [out] = reconcileHistory(history, sessions);
    expect(out.sessionId).toBeUndefined();
    expect(out.status).toBe('queued');
  });

  it('gives two goals two distinct sessions (first-come-first-served)', () => {
    const history = [
      base('g1', '2026-01-01T00:00:00.000Z'),
      base('g2', '2026-01-01T00:00:01.000Z'),
    ];
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'COMPLETED', createdAt: '2026-01-01T00:00:02.000Z' },
      { sessionId: 's2', state: 'RUNNING', createdAt: '2026-01-01T00:00:03.000Z' },
    ];
    const out = reconcileHistory(history, sessions);
    expect(out.find((e) => e.localId === 'g1')?.sessionId).toBe('s1');
    expect(out.find((e) => e.localId === 'g2')?.sessionId).toBe('s2');
  });

  it('refreshes status for an already-bound goal when its session state changes', () => {
    const bound: GoalEntry = { ...base('g1', '2026-01-01T00:00:00.000Z'), sessionId: 's1', status: 'running' };
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'COMPLETED', createdAt: '2026-01-01T00:00:05.000Z' },
    ];
    const [out] = reconcileHistory([bound], sessions);
    expect(out.status).toBe('completed');
  });

  it('keeps a bound entry untouched when its session is no longer listed', () => {
    const bound: GoalEntry = { ...base('g1', 't'), sessionId: 's1', status: 'running' };
    const [out] = reconcileHistory([bound], []);
    expect(out).toEqual(bound);
  });

  it('preserves submit order in the output', () => {
    const history = [
      base('g2', '2026-01-01T00:00:02.000Z'),
      base('g1', '2026-01-01T00:00:01.000Z'),
    ];
    const out = reconcileHistory(history, []);
    expect(out.map((e) => e.localId)).toEqual(['g1', 'g2']);
  });
});

describe('statusChip', () => {
  it('labels every status', () => {
    expect(statusChip('queued')).toBe('queued');
    expect(statusChip('running')).toBe('running');
    expect(statusChip('completed')).toBe('completed');
    expect(statusChip('failed')).toBe('failed');
  });
});

// ── Goal clarification projection (goal-clarification-gate) ──────────────────────────────────

const REQ_IDS = ['r1', 'r2', 'r3', 'r4', ''];

/** A question that may or may not be well-formed. */
function genQuestion(rng: Rng, i: number): unknown {
  const r = rng();
  if (r < 0.75) {
    return bool(rng, 0.3)
      ? { id: `q${i + 1}`, text: `Question ${i}?`, suggestedOptions: ['a', 'b'] }
      : { id: `q${i + 1}`, text: `Question ${i}?` };
  }
  return pick<unknown>(rng, [
    null,
    ['q1', 'text'],
    'q1',
    { text: 'no id' },
    { id: '', text: 'empty id' },
    { id: 7, text: 'numeric id' },
    { id: `q${i + 1}` },
    { id: `q${i + 1}`, text: 42 },
  ]);
}

/** A REQUESTED payload: valid object, JSON string, or one of several broken shapes. */
function genRequestedPayload(rng: Rng): unknown {
  const requestId = pick(rng, REQ_IDS);
  const n = int(rng, 1, 4);
  const questions = Array.from({ length: n }, (_, i) => genQuestion(rng, i));
  const valid = { requestId, missionId: 'm', goalId: 'g', openQuestions: questions };
  const r = rng();
  if (r < 0.5) return valid;
  if (r < 0.65) return JSON.stringify(valid);
  return pick<unknown>(rng, [
    null,
    undefined,
    'not json {',
    '"just a string"',
    '[1,2]',
    [valid],
    { openQuestions: questions },
    { requestId: 5, openQuestions: questions },
    { requestId, openQuestions: [] },
    { requestId, openQuestions: 'q1' },
    { requestId },
  ]);
}

function genAnsweredPayload(rng: Rng): unknown {
  const requestId = pick(rng, REQ_IDS);
  const r = rng();
  if (r < 0.6) return { requestId, answers: { q1: 'x' }, skippedQuestionIds: [] };
  if (r < 0.75) return JSON.stringify({ requestId });
  return pick<unknown>(rng, [null, 'not json {', { requestId: 1 }, {}, [requestId]]);
}

function genEvents(rng: Rng): ClarificationEventLike[] {
  const len = int(rng, 0, 12);
  const events: ClarificationEventLike[] = [];
  for (let i = 0; i < len; i++) {
    const r = rng();
    if (r < 0.45) events.push({ type: 'GOAL_CLARIFICATION_REQUESTED', payload: genRequestedPayload(rng) });
    else if (r < 0.7) events.push({ type: 'GOAL_CLARIFICATION_ANSWERED', payload: genAnsweredPayload(rng) });
    else {
      // Unrelated events — some even carry a requestId that must be ignored.
      events.push({
        type: pick(rng, ['TASK_STARTED', 'MISSION_CREATED', 'VERIFICATION_ENDED', 'goal_clarification_answered']),
        payload: bool(rng) ? { requestId: pick(rng, REQ_IDS) } : undefined,
      });
    }
  }
  return events;
}

/** Reference oracle: last valid REQUESTED whose requestId has no ANSWERED anywhere. */
function oracle(events: readonly ClarificationEventLike[]): { requestId: string; questions: { id: string; text: string }[] } | null {
  const toObj = (p: unknown): Record<string, unknown> | null => {
    let v = p;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return null; }
    }
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type !== 'GOAL_CLARIFICATION_ANSWERED') continue;
    const id = toObj(e.payload)?.['requestId'];
    if (typeof id === 'string') answered.add(id);
  }
  let found: { requestId: string; questions: { id: string; text: string }[] } | null = null;
  for (const e of events) {
    if (e.type !== 'GOAL_CLARIFICATION_REQUESTED') continue;
    const p = toObj(e.payload);
    if (!p) continue;
    const rid = p['requestId'];
    const qs = p['openQuestions'];
    if (typeof rid !== 'string' || rid === '' || !Array.isArray(qs) || qs.length === 0) continue;
    const ok = qs.every((q) =>
      q !== null && typeof q === 'object' && !Array.isArray(q) &&
      typeof (q as Record<string, unknown>)['id'] === 'string' && (q as Record<string, unknown>)['id'] !== '' &&
      typeof (q as Record<string, unknown>)['text'] === 'string');
    if (!ok || answered.has(rid)) continue;
    found = { requestId: rid, questions: qs.map((q) => ({ id: (q as { id: string }).id, text: (q as { text: string }).text })) };
  }
  return found;
}

describe('findOpenClarification', () => {
  // Feature: goal-clarification-gate, Property 7: Projection câu hỏi đang mở từ event
  // **Validates: Requirements 8.1, 9.3**
  it('Property 7: matches the reference oracle on random event sequences and never throws', () => {
    forAll(0x1c1a7e07, 300, (rng) => {
      const events = genEvents(rng);
      let actual: ReturnType<typeof findOpenClarification> = null;
      expect(() => { actual = findOpenClarification(events); }).not.toThrow();
      const expected = oracle(events);
      const got = actual as ReturnType<typeof findOpenClarification>;
      if (expected === null) {
        expect(got).toBeNull();
      } else {
        expect(got).not.toBeNull();
        expect(got!.requestId).toBe(expected.requestId);
        expect(got!.questions.map((q) => ({ id: q.id, text: q.text }))).toEqual(expected.questions);
      }
    });
  });

  it('returns the open request with suggested options and null once answered', () => {
    const requested: ClarificationEventLike = {
      type: 'GOAL_CLARIFICATION_REQUESTED',
      payload: { requestId: 'r1', openQuestions: [{ id: 'q1', text: 'Which format?', suggestedOptions: ['json', 'csv'] }] },
    };
    expect(findOpenClarification([requested])).toEqual({
      requestId: 'r1',
      questions: [{ id: 'q1', text: 'Which format?', suggestedOptions: ['json', 'csv'] }],
    });
    expect(findOpenClarification([requested, { type: 'GOAL_CLARIFICATION_ANSWERED', payload: '{"requestId":"r1"}' }])).toBeNull();
  });
});

// ── Plan options projection (plan-options, Goal Clarification Phase 2) ─────────────────────────

const OPT = (id: string, recommended = false) => ({ id, title: `T ${id}`, summary: 's', pros: ['p'], cons: ['c'], recommended });

function genProposedPayload(rng: Rng): unknown {
  const requestId = pick(rng, REQ_IDS);
  const n = int(rng, 1, 4);
  const options: unknown[] = Array.from({ length: n }, (_, i) => (bool(rng, 0.85) ? OPT(`o${i + 1}`, i === 0) : pick<unknown>(rng, [null, { id: 'x' }, { id: 'o9', title: 1 }])));
  const rec = bool(rng, 0.85) ? 'o1' : pick(rng, ['o9', '']);
  const valid = { requestId, missionId: 'm', goalId: 'g', options, recommendedOptionId: rec };
  const r = rng();
  if (r < 0.6) return valid;
  if (r < 0.75) return JSON.stringify(valid);
  return pick<unknown>(rng, [null, 'not json {', [valid], { requestId }, { requestId, options: 'x', recommendedOptionId: 'o1' }]);
}

function planOracle(events: readonly ClarificationEventLike[]): { requestId: string; ids: string[] } | null {
  const toObj = (p: unknown): Record<string, unknown> | null => {
    let v = p;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };
  const chosen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'PLAN_OPTION_CHOSEN') continue;
    const id = toObj(e.payload)?.['requestId'];
    if (typeof id === 'string') chosen.add(id);
  }
  let found: { requestId: string; ids: string[] } | null = null;
  for (const e of events) {
    if (e.type !== 'PLAN_OPTIONS_PROPOSED') continue;
    const p = toObj(e.payload);
    if (!p) continue;
    const rid = p['requestId'];
    const rec = p['recommendedOptionId'];
    const opts = p['options'];
    if (typeof rid !== 'string' || rid === '' || typeof rec !== 'string' || !Array.isArray(opts) || opts.length < 2) continue;
    const ok = opts.every((o) => {
      if (o === null || typeof o !== 'object' || Array.isArray(o)) return false;
      const r = o as Record<string, unknown>;
      const list = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
      return typeof r['id'] === 'string' && r['id'] !== '' && typeof r['title'] === 'string' && typeof r['summary'] === 'string' && list(r['pros']) && list(r['cons']);
    });
    if (!ok || !opts.some((o) => (o as { id: string }).id === rec) || chosen.has(rid)) continue;
    found = { requestId: rid, ids: opts.map((o) => (o as { id: string }).id) };
  }
  return found;
}

describe('findOpenPlanChoice', () => {
  // Feature: plan-options, Property 5: Projection phương án đang mở
  // **Validates: Requirements 7.1, 7.7**
  it('Property 5: matches the reference oracle on random event sequences and never throws', () => {
    forAll(0x91076, 300, (rng) => {
      const len = int(rng, 0, 10);
      const events: ClarificationEventLike[] = [];
      for (let i = 0; i < len; i++) {
        const r = rng();
        if (r < 0.5) events.push({ type: 'PLAN_OPTIONS_PROPOSED', payload: genProposedPayload(rng) });
        else if (r < 0.75) events.push({ type: 'PLAN_OPTION_CHOSEN', payload: bool(rng, 0.8) ? { requestId: pick(rng, REQ_IDS), optionId: 'o1' } : 'bad {' });
        else events.push({ type: pick(rng, ['GOAL_CLARIFICATION_REQUESTED', 'TASK_STARTED', 'plan_option_chosen']), payload: { requestId: pick(rng, REQ_IDS) } });
      }
      let got: ReturnType<typeof findOpenPlanChoice> = null;
      expect(() => { got = findOpenPlanChoice(events); }).not.toThrow();
      const exp = planOracle(events);
      const g = got as ReturnType<typeof findOpenPlanChoice>;
      if (exp === null) expect(g).toBeNull();
      else {
        expect(g?.requestId).toBe(exp.requestId);
        expect(g?.options.map((o) => o.id)).toEqual(exp.ids);
      }
    });
  });

  it('returns the open request with its recommendation and null once chosen', () => {
    const proposed: ClarificationEventLike = {
      type: 'PLAN_OPTIONS_PROPOSED',
      payload: { requestId: 'r1', options: [OPT('o1'), OPT('o2', true)], recommendedOptionId: 'o2' },
    };
    expect(findOpenPlanChoice([proposed])).toEqual({ requestId: 'r1', options: [OPT('o1'), OPT('o2', true)], recommendedOptionId: 'o2' });
    expect(findOpenPlanChoice([proposed, { type: 'PLAN_OPTION_CHOSEN', payload: { requestId: 'r1' } }])).toBeNull();
  });
});
