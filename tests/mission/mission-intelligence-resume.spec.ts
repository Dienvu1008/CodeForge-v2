/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// MissionIntelligence.analyze(..., { resumeClarification }) — session-resume v1.
// A first stage instance asks and "dies" (gate → cancelled), leaving REQUESTED without ANSWERED in
// the shared log. A NEW instance resumes on the SAME request: no analysis event is re-emitted, no
// new REQUESTED, and from the answer onward it emits exactly like Phase 1.
// **Validates: Requirements 4.4, 4.6, 4.7, 7.5**
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
  type ClarificationGate,
  type ClarificationRequest,
  type ClarificationOutcome,
} from '@codeforge/agent-core';

class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(event: DomainEvent): Promise<void> { this.events.push(event); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(filter: EventFilter): Promise<readonly DomainEvent[]> {
    return this.events.filter((e) => filter.type === undefined || e.type === filter.type);
  }
  types(): string[] { return this.events.map((e) => e.type); }
}

class ScriptedGate implements ClarificationGate {
  public readonly calls: ClarificationRequest[] = [];
  constructor(private readonly respond: (r: ClarificationRequest) => ClarificationOutcome) {}
  async awaitAnswers(_sid: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    this.calls.push(request);
    return this.respond(request);
  }
}

function rt(prefix: string) {
  let n = 0;
  return { now: () => '2026-01-02T00:00:00.000Z', newId: () => `${prefix}-${++n}` };
}

const goal: Goal = {
  goalId: 'g-vague', version: 1, description: 'create a script that multiplies two matrices',
  constraints: [], acceptanceCriteria: [], createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
};

/** Process A: asks, then "dies" (cancelled) — REQUESTED stays open in the log. */
async function firstRun(events: MemoryEventLog): Promise<{ missionId: string; request: ClarificationRequest }> {
  const gate = new ScriptedGate(() => ({ kind: 'cancelled' }));
  const a = new MissionIntelligence({ events, ...rt('A'), clarificationGate: gate });
  const out = await a.analyze('S', goal);
  expect(out.proceed).toBe(false);
  return { missionId: out.mission.missionId, request: gate.calls[0]! };
}

describe('MissionIntelligence — resumeClarification', () => {
  it('waits on the SAME request, re-emits nothing from before the wait, then emits like Phase 1', async () => {
    const events = new MemoryEventLog();
    const open = await firstRun(events);
    const before = events.events.length;
    expect(events.types()).toContain('GOAL_CLARIFICATION_REQUESTED');
    expect(events.types()).not.toContain('GOAL_CLARIFICATION_ANSWERED');

    const gate = new ScriptedGate((r) => ({ kind: 'answered', answers: { [r.openQuestions[0]!.id]: 'nested lists' } }));
    const b = new MissionIntelligence({ events, ...rt('B'), clarificationGate: gate });
    const out = await b.analyze('S', goal, { resumeClarification: open });

    expect(gate.calls).toEqual([open.request]);            // same request object shape, same requestId
    expect(out.proceed).toBe(true);
    expect(out.mission.missionId).toBe(open.missionId);    // same aggregate as the logged events

    const added = events.events.slice(before);
    const addedTypes = added.map((e) => e.type);
    // Nothing from the analysis prefix is replayed, and no second REQUESTED.
    for (const t of ['MISSION_RECEIVED', 'MISSION_CLASSIFIED', 'MISSION_COMPLEXITY_ESTIMATED', 'MISSION_RISK_ASSESSED',
      'MISSION_UNCERTAINTY_ASSESSED', 'MISSION_PLANNING_MODE_SELECTED', 'GOAL_CLARIFICATION_REQUESTED']) {
      expect(addedTypes, t).not.toContain(t);
    }
    expect(addedTypes).toContain('GOAL_CLARIFICATION_ANSWERED');
    const answered = added.find((e) => e.type === 'GOAL_CLARIFICATION_ANSWERED')!;
    expect(answered.aggregate).toEqual({ kind: 'mission', id: open.missionId });
    const q1 = open.request.openQuestions[0]!;
    expect(answered.payload).toMatchObject({
      requestId: open.request.requestId,
      source: 'user',
      answers: [{ questionId: q1.id, question: q1.text, answer: 'nested lists' }],
    });
    expect(out.assumptions).toEqual([`[user-provided] ${q1.text} → nested lists`]);
    // Exactly one REQUESTED and one ANSWERED for the request across both processes.
    expect(events.types().filter((t) => t === 'GOAL_CLARIFICATION_REQUESTED')).toHaveLength(1);
    expect(events.types().filter((t) => t === 'GOAL_CLARIFICATION_ANSWERED')).toHaveLength(1);
  });

  it('a resumed wait can still be cancelled (proceed:false, no ANSWERED)', async () => {
    const events = new MemoryEventLog();
    const open = await firstRun(events);
    const b = new MissionIntelligence({ events, ...rt('B'), clarificationGate: new ScriptedGate(() => ({ kind: 'cancelled' })) });
    const out = await b.analyze('S', goal, { resumeClarification: open });
    expect(out.proceed).toBe(false);
    expect(out.blockers).toEqual(['clarification cancelled']);
    expect(events.types()).not.toContain('GOAL_CLARIFICATION_ANSWERED');
  });

  it('defensive: resume without a wired gate behaves like a timeout (all skipped, source=timeout)', async () => {
    const events = new MemoryEventLog();
    const open = await firstRun(events);
    const b = new MissionIntelligence({ events, ...rt('B') });
    const out = await b.analyze('S', goal, { resumeClarification: open });
    expect(out.proceed).toBe(true);
    const answered = events.events.find((e) => e.type === 'GOAL_CLARIFICATION_ANSWERED')!;
    expect(answered.payload).toMatchObject({ source: 'timeout', answers: [] });
  });

  it('the quiet mode is per call: a later fresh analyze on the same instance emits normally', async () => {
    const events = new MemoryEventLog();
    const open = await firstRun(events);
    const gate = new ScriptedGate(() => ({ kind: 'answered', answers: { q1: 'x' } }));
    const b = new MissionIntelligence({ events, ...rt('B'), clarificationGate: gate });
    await b.analyze('S', goal, { resumeClarification: open });
    const before = events.events.length;
    await b.analyze('S2', goal);
    const added = events.events.slice(before).map((e) => e.type);
    expect(added[0]).toBe('MISSION_RECEIVED');
    expect(added).toContain('GOAL_CLARIFICATION_REQUESTED');
  });
});