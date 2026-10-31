/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// session-resume v1 — StartupRecovery.recover() (effect shell) + SqliteOrphanSource (real SQLite).
// Requirements 2.1, 2.2, 2.4, 3.1, 3.3, 4.1, 4.2, 8.1, 8.4.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  SqliteTaskGraphRepository,
  SqliteGoalQueueStore,
  SqliteOrphanSource,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  SessionService,
  StartupRecovery,
  buildClarificationRequest,
  buildPlanOptionsRequest,
  classifyOrphan,
  type Session,
  type Goal,
  type OrphanSnapshot,
  type DomainEvent,
  type EventLog,
  type EventFilter,
} from '@codeforge/agent-core';

const REQUEST = buildClarificationRequest('REQ', 'M', 'G', ['What is the input?']);
const META = { hostname: 'h', processId: 42, ollamaEndpoint: 'e', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } };

function snap(sessionId: string, createdAt: string, over: Partial<OrphanSnapshot> = {}): OrphanSnapshot {
  return {
    session: { sessionId, state: 'AWAITING_HUMAN', createdAt, metadata: META },
    openClarification: { missionId: 'M', request: REQUEST },
    graphIsSeedOnly: true, goalPersisted: true, pendingToolApproval: false,
    ...over,
  };
}

class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(e: DomainEvent): Promise<void> { this.events.push(e); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(f: EventFilter): Promise<readonly DomainEvent[]> {
    return this.events.filter((e) => (f.sessionId === undefined || e.sessionId === f.sessionId) && (f.type === undefined || e.type === f.type));
  }
}

function fakeSessionService(opts: { adoptThrows?: Error; abortThrowsFor?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async transition(sid: string, ev: string) {
      calls.push(`${ev}:${sid}`);
      if (opts.abortThrowsFor === sid) throw new Error('boom');
      return {} as Session;
    },
    async adopt(input: { sessionId: string }) {
      calls.push(`ADOPT:${input.sessionId}`);
      if (opts.adoptThrows) throw opts.adoptThrows;
      return {} as Session;
    },
  };
}

function recovery(orphans: OrphanSnapshot[], svc: ReturnType<typeof fakeSessionService>, events = new MemoryEventLog()) {
  let n = 0;
  const r = new StartupRecovery({
    orphans: { listOrphans: async () => orphans },
    sessionService: svc as never,
    events, now: () => 't', nextId: () => `e-${++n}`,
  });
  return { r, events };
}
const INPUT = { clarifyEnabled: true, hostname: 'h', processId: 7, newLockId: () => 'L-new' };

describe('StartupRecovery.recover()', () => {
  it('aborts the non-resumable ones first, then adopts the newest resumable one', async () => {
    const svc = fakeSessionService();
    const { r, events } = recovery([
      snap('OLD', '2026-01-01T00:00:00.000Z'),
      snap('RUN', '2026-01-02T00:00:00.000Z', { session: { sessionId: 'RUN', state: 'RUNNING', createdAt: '2026-01-02T00:00:00.000Z', metadata: META } }),
      snap('NEW', '2026-01-03T00:00:00.000Z'),
    ], svc);
    const out = await r.recover(INPUT);

    expect(svc.calls).toEqual(['ABORT:OLD', 'ABORT:RUN', 'ADOPT:NEW']);
    expect(out.resume).toEqual({ kind: 'clarification', sessionId: 'NEW', missionId: 'M', request: REQUEST, previousProcessId: 42 });
    expect(out.aborted).toEqual([
      { sessionId: 'OLD', reason: 'superseded by a newer resumable session' },
      { sessionId: 'RUN', reason: 'runtime restarted during execution' },
    ]);
    const decided = events.events.filter((e) => e.type === 'SESSION_RECOVERY_DECIDED');
    expect(decided.map((e) => [e.sessionId, (e.payload as { decision: string }).decision])).toEqual([
      ['OLD', 'abort'], ['RUN', 'abort'], ['NEW', 'resume'],
    ]);
    expect(decided[0]!.payload).toMatchObject({ previousProcessId: 42 });
  });

  it('LOCK_HELD on adopt: no resume and no abort of that session (a live runtime owns the workspace)', async () => {
    const svc = fakeSessionService({ adoptThrows: new Error('LOCK_HELD: workspace already locked') });
    const { r, events } = recovery([snap('S', 't')], svc);
    const out = await r.recover(INPUT);
    expect(out.resume).toBeUndefined();
    expect(out.skippedResume).toEqual({ sessionId: 'S', message: 'LOCK_HELD: workspace already locked' });
    expect(svc.calls).toEqual(['ADOPT:S']);
    expect(events.events).toHaveLength(0);
  });

  it('a failure on one orphan does not block the others', async () => {
    const svc = fakeSessionService({ abortThrowsFor: 'A' });
    const off = { session: { sessionId: 'A', state: 'PAUSED' as const, createdAt: 't', metadata: META } };
    const { r } = recovery([snap('A', 't', off), snap('B', 't', { session: { ...off.session, sessionId: 'B' } })], svc);
    const out = await r.recover(INPUT);
    expect(out.errors).toEqual([{ sessionId: 'A', message: 'boom' }]);
    expect(out.aborted).toEqual([{ sessionId: 'B', reason: 'runtime restarted while paused' }]);
  });

  it('--clarify off: a would-be resumable session is closed with the reason', async () => {
    const svc = fakeSessionService();
    const { r } = recovery([snap('S', 't')], svc);
    const out = await r.recover({ ...INPUT, clarifyEnabled: false });
    expect(out.resume).toBeUndefined();
    expect(out.aborted).toEqual([{ sessionId: 'S', reason: 'clarification gate is disabled on this runtime (--clarify off)' }]);
  });

  it('never throws when listing fails', async () => {
    const r = new StartupRecovery({
      orphans: { listOrphans: async () => { throw new Error('db down'); } },
      sessionService: fakeSessionService() as never,
      events: new MemoryEventLog(), now: () => 't', nextId: () => 'x',
    });
    await expect(r.recover(INPUT)).resolves.toEqual({ aborted: [], errors: [{ sessionId: '*', message: 'db down' }] });
  });
});

// ── SqliteOrphanSource over real SQLite ───────────────────────────────────────

let db: SqliteDatabaseAdapter;
let svc: SessionService;
let sessions: SqliteSessionRepository;
let events: SqliteEventLog;
let graphs: SqliteTaskGraphRepository;
let queue: SqliteGoalQueueStore;
const DEAD = 111;
const LIVE = 222;

function session(id: string, pid: number, host = 'this-host'): Session {
  return {
    sessionId: id, workspaceId: 'W', workspaceRoot: '/r', goalId: `G-${id}`, graphVersion: 1,
    state: 'CREATED', createdAt: `2026-01-01T00:00:0${id.length}.000Z`, updatedAt: 't', runtimeVersion: '0.12.0',
    schemaVersion: 1, budgetId: 'B', lockId: `L-${id}`,
    metadata: { ...META, hostname: host, processId: pid },
  };
}
function goal(id: string): Goal {
  return { goalId: id, version: 1, description: 'd', constraints: [], acceptanceCriteria: [], createdAt: 't', createdBy: 'user' };
}

/** Create session `id` parked in AWAITING_HUMAN on an open clarification, lock released (dead owner). */
async function parkedSession(id: string, pid: number, host = 'this-host'): Promise<void> {
  queue.enqueue(goal(`G-${id}`), 't');
  queue.claimNext(id, 't');
  await svc.create({ session: session(id, pid, host), hostname: host, processId: pid });
  await graphs.commit({
    graphId: `GR-${id}`, sessionId: id, version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner',
    canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: `M0-${id}`, sessionId: id, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: `P-${id}`, source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'init', at: 't' },
    createdAt: 't', status: 'COMMITTED',
  });
  await svc.transition(id, 'SESSION_INITIALIZED');
  await svc.transition(id, 'SESSION_READY');
  await events.append({
    eventId: `ev-${id}`, sessionId: id, type: 'GOAL_CLARIFICATION_REQUESTED', aggregate: { kind: 'mission', id: `M-${id}` },
    payload: { requestId: `R-${id}`, missionId: `M-${id}`, goalId: `G-${id}`, level: 'UNKNOWN', openQuestions: REQUEST.openQuestions },
    at: 't', sequenceNumber: 0,
  });
  await svc.transition(id, 'HUMAN_REQUIRED');
  db.execute("UPDATE locks SET state = 'RELEASED', released_at = 't' WHERE session_id = ?", [id]);
}

function source(): SqliteOrphanSource {
  return new SqliteOrphanSource({
    db, workspaceId: 'W', hostname: 'this-host', isAlive: (pid) => pid === LIVE, sessions, graphs, events,
  });
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => 't' });
  sessions = new SqliteSessionRepository(db);
  events = new SqliteEventLog(db);
  graphs = new SqliteTaskGraphRepository(db);
  queue = new SqliteGoalQueueStore(db, 'W');
  let n = 0;
  svc = new SessionService({ sessions, events, lock: new SqliteWorkspaceLockService(db), now: () => 't', nextId: () => `id-${++n}` });
});
afterEach(() => db.close());

describe('SqliteOrphanSource', () => {
  it('builds a resumable snapshot for a parked session of a dead pid', async () => {
    await parkedSession('S', DEAD);
    const orphans = await source().listOrphans();
    expect(orphans).toHaveLength(1);
    const o = orphans[0]!;
    expect(o.session.sessionId).toBe('S');
    expect(o.session.state).toBe('AWAITING_HUMAN');
    expect(o.graphIsSeedOnly).toBe(true);
    expect(o.goalPersisted).toBe(true);
    expect(o.pendingToolApproval).toBe(false);
    expect(o.openClarification).toEqual({
      missionId: 'M-S',
      request: { requestId: 'R-S', missionId: 'M-S', goalId: 'G-S', openQuestions: REQUEST.openQuestions },
    });
  });

  it('never returns sessions of a LIVE pid or of another host, nor terminal sessions (Req 2.2)', async () => {
    await parkedSession('LIVE1', LIVE);
    await parkedSession('OTHER', DEAD, 'other-host');
    await parkedSession('DONE', DEAD);
    await svc.transition('DONE', 'ABORT');
    expect(await source().listOrphans()).toEqual([]);
  });

  it('an answered request is not open; a session without a queue row is not goalPersisted', async () => {
    await parkedSession('S', DEAD);
    await events.append({
      eventId: 'ans', sessionId: 'S', type: 'GOAL_CLARIFICATION_ANSWERED', aggregate: { kind: 'mission', id: 'M-S' },
      payload: { requestId: 'R-S' }, at: 't', sequenceNumber: 0,
    });
    db.execute('DELETE FROM goal_queue WHERE session_id = ?', ['S']);
    const [o] = await source().listOrphans();
    expect(o!.openClarification).toBeUndefined();
    expect(o!.goalPersisted).toBe(false);
  });

  it('end-to-end with StartupRecovery: resumes the parked one, aborts a RUNNING orphan, frees nothing it must not', async () => {
    await parkedSession('S', DEAD);
    // A second orphan that died mid-execution: RUNNING with no clarification.
    queue.enqueue(goal('G-RUN'), 't');
    queue.claimNext('RUN', 't');
    await svc.create({ session: session('RUN', DEAD), hostname: 'this-host', processId: DEAD });
    await svc.transition('RUN', 'SESSION_INITIALIZED');
    await svc.transition('RUN', 'SESSION_READY');

    let n = 0;
    const rec = new StartupRecovery({ orphans: source(), sessionService: svc, events, now: () => 't', nextId: () => `r-${++n}` });
    // The dead RUN process still holds the workspace lock here (as before reclaimStale); recovery aborts it first.
    const out = await rec.recover({ clarifyEnabled: true, hostname: 'this-host', processId: 999, newLockId: () => 'L-adopted' });

    expect(out.aborted).toEqual([{ sessionId: 'RUN', reason: 'runtime restarted during execution' }]);
    expect(out.resume?.sessionId).toBe('S');
    expect((await sessions.getById('RUN'))?.state).toBe('ABORTED');
    const s = await sessions.getById('S');
    expect(s?.state).toBe('AWAITING_HUMAN');
    expect(s?.metadata.processId).toBe(999);
    expect(await new SqliteWorkspaceLockService(db).getActive('W')).toMatchObject({ lockId: 'L-adopted', sessionId: 'S' });
  });
});

// ── Plan options (Phase 2): resume an open plan choice ─────────────────────────
describe('startup recovery — open plan choice', () => {
  const OPTIONS = [
    { id: 'o1', title: 'A', summary: 'a', pros: ['p'], cons: ['c'], recommended: false },
    { id: 'o2', title: 'B', summary: 'b', pros: ['p'], cons: ['c'], recommended: true },
  ];
  const PREQ = buildPlanOptionsRequest('PR', 'M', 'G', OPTIONS);
  const planSnap = (): OrphanSnapshot => ({
    session: { sessionId: 'P', state: 'AWAITING_HUMAN', createdAt: 't', metadata: META },
    openPlanChoice: { missionId: 'M', request: PREQ, priorAssumptions: ['[user-provided] q → a'] },
    graphIsSeedOnly: true, goalPersisted: true, pendingToolApproval: false,
  });

  it('classifier: resumable only with --plan-options on', () => {
    expect(classifyOrphan(planSnap(), { clarifyEnabled: false, planOptionsEnabled: true })).toEqual({ kind: 'resume' });
    expect(classifyOrphan(planSnap(), { clarifyEnabled: true })).toEqual({
      kind: 'abort', reason: 'plan options are disabled on this runtime (--plan-options off)',
    });
    expect(classifyOrphan({ ...planSnap(), graphIsSeedOnly: false }, { clarifyEnabled: true, planOptionsEnabled: true }))
      .toEqual({ kind: 'abort', reason: 'runtime restarted after planning had started' });
  });

  it('recover(): a plan-choice resume plan carries the request and prior assumptions', async () => {
    const svc = fakeSessionService();
    const { r, events } = recovery([planSnap()], svc);
    const out = await r.recover({ ...INPUT, planOptionsEnabled: true });
    expect(out.resume).toEqual({
      kind: 'plan-choice', sessionId: 'P', missionId: 'M', request: PREQ,
      priorAssumptions: ['[user-provided] q → a'], previousProcessId: 42,
    });
    expect(events.events[0]!.payload).toMatchObject({ decision: 'resume', reason: 'awaiting a plan choice before planning' });
  });

  it('SqliteOrphanSource rebuilds the open plan choice + prior assumptions from the log', async () => {
    await parkedSession('S', DEAD);
    // The clarification was answered, then options were proposed (no choice yet).
    await events.append({
      eventId: 'ans', sessionId: 'S', type: 'GOAL_CLARIFICATION_ANSWERED', aggregate: { kind: 'mission', id: 'M-S' },
      payload: { requestId: 'R-S', source: 'user', answers: [], skippedQuestionIds: [], assumptions: ['[user-provided] q → numpy'] },
      at: 't', sequenceNumber: 0,
    });
    await events.append({
      eventId: 'prop', sessionId: 'S', type: 'PLAN_OPTIONS_PROPOSED', aggregate: { kind: 'mission', id: 'M-S' },
      payload: { requestId: 'PR-S', missionId: 'M-S', goalId: 'G-S', options: OPTIONS, recommendedOptionId: 'o2' },
      at: 't', sequenceNumber: 0,
    });
    const [o] = await source().listOrphans();
    expect(o!.openClarification).toBeUndefined();
    expect(o!.openPlanChoice).toEqual({
      missionId: 'M-S',
      request: { requestId: 'PR-S', missionId: 'M-S', goalId: 'G-S', options: OPTIONS, recommendedOptionId: 'o2' },
      priorAssumptions: ['[user-provided] q → numpy'],
    });
    expect(classifyOrphan(o!, { clarifyEnabled: false, planOptionsEnabled: true })).toEqual({ kind: 'resume' });
  });
});
