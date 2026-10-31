/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// session-resume v1 — end-to-end restart on ONE shared SQLite database.
//
// Runtime A (pid DEAD) asks a clarification question and "dies" while waiting (its coordinator is
// parked forever, as if the process were gone). Runtime B starts on the same DB: reclaims the stale
// lock, runs StartupRecovery (SqliteOrphanSource), adopts the parked session, resumes it through
// SessionOrchestrator.resume(), receives the answer over a REAL HttpTransport (POST /clarification),
// then plans and executes. A second orphan that died RUNNING is closed with a reason.
//
// Real: SessionService + SQLite repos/lock/event log/goal queue, MissionIntelligence, both
// ClarificationCoordinators, StartupRecovery, ObservabilityService + HttpTransport.
// Faked: planner / graph commit / executor plumbing (copied from mi-b2-assumptions.spec.ts).
// Validates: Requirements 4.1, 4.3, 4.5, 4.6, 4.7, 5.1, 6.1, 6.2, 8.2
import { describe, it, expect, afterEach } from 'vitest';
import {
  SessionOrchestrator,
  SessionService,
  MissionIntelligence,
  StartupRecovery,
  ControlPlane,
  type Goal,
  type Session,
  type WorkspaceRevision,
  type TaskGraph,
  type GraphMutation,
  type Task,
  type TaskExecutorRequest,
  type SessionOrchestratorDeps,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  SqliteTaskGraphRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskRunRepository,
  SqliteGoalQueueStore,
  SqliteOrphanSource,
  ClarificationCoordinator,
  ObservabilityService,
  HttpTransport,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';

const HOST = 'test-host';
const DEAD = 4242;
const WS = 'ws-/r';
const T0 = '2026-01-01T00:00:00.000Z';

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r', includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH', fileCount: 0, totalBytes: 0,
  createdAt: T0, createdBy: { sessionId: 'S', reason: 'session_start' },
};
const TASK: Task = {
  taskId: 'T1', description: 'do the thing', acceptanceCriteria: [{ criterionId: 'c', description: 'done', mandatory: true }],
  constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: T0, createdBy: 'planner',
};
const oneNodeGraph = (sid: string): TaskGraph => ({
  graphId: 'GR', sessionId: sid, version: 2, nodes: [{ taskId: 'T1', addedInVersion: 2 }], edges: [],
  createdAt: T0, createdBy: 'planner', canonicalHash: 'h', schemaVersion: 1, canonicalFormVersion: 'v1',
} as unknown as TaskGraph);
const mutationWithTask = (sid: string): GraphMutation => ({
  mutationId: 'M', sessionId: sid, baseVersion: 1, operations: [{ kind: 'ADD_TASK', task: TASK } as never],
  proposedBy: 'planner', reason: 'plan',
  provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: T0 },
  createdAt: T0, status: 'PROPOSED',
} as unknown as GraphMutation);

function session(id: string): Session {
  return {
    sessionId: id, workspaceId: WS, workspaceRoot: '/r', goalId: `G-${id}`, graphVersion: 1, state: 'CREATED',
    createdAt: T0, updatedAt: T0, runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: `B-${id}`, lockId: `L-${id}`,
    metadata: { hostname: HOST, processId: DEAD, ollamaEndpoint: 'e', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}
const vagueGoal = (id: string): Goal => ({
  goalId: id, version: 1, description: 'create a script that multiplies two matrices',
  constraints: [], acceptanceCriteria: [], createdAt: T0, createdBy: 'user',
});

/** Planner/executor plumbing (orchestrator deps minus sessionService/missionStage). */
function plumbing() {
  const states = new Map<string, string>([['T1', 'PENDING']]);
  const captured: TaskExecutorRequest[] = [];
  let plannerCalls = 0;
  return {
    captured,
    plannerCalls: () => plannerCalls,
    deps: {
      planner: { async plan(sid: string): Promise<GraphMutation> { plannerCalls++; return mutationWithTask(sid); } },
      graphCommitService: { async commit() { return { status: 'COMMITTED' as const, version: 2, validation: { status: 'VALIDATED' as const, errors: [] } }; } },
      graphRepository: { async getCurrent(sid: string): Promise<TaskGraph> { return oneNodeGraph(sid); } },
      taskRepository: { async create() {}, async getById() { return TASK; } },
      executionRepository: { async getByTask(id: string) { const s = states.get(id); return s === undefined ? null : { currentState: s, attempts: 0 }; } },
      executionCoordinator: { async init(id: string) { if (!states.has(id)) states.set(id, 'PENDING'); }, async setState(id: string, s: string) { states.set(id, s); } },
      taskExecutor: {
        async execute(req: TaskExecutorRequest) {
          captured.push(req);
          states.set(req.task.taskId, 'PASSED');
          return { taskPassed: true, finalState: 'SUCCEEDED', toolCallCount: 0 } as never;
        },
      },
      checkpointService: { async capture() {} },
    },
  };
}

let db: SqliteDatabaseAdapter | undefined;
let transport: HttpTransport | undefined;
afterEach(async () => { await transport?.close(); transport = undefined; db?.close(); db = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('session resume — restart while awaiting clarification', () => {
  it('runtime B adopts + resumes the parked session, takes the answer over HTTP, plans and completes', async () => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => T0 });
    let n = 0;
    const nextId = () => `id-${++n}`;
    const now = () => T0;
    const sessions = new SqliteSessionRepository(db);
    const events = new SqliteEventLog(db);
    const lock = new SqliteWorkspaceLockService(db);
    const graphs = new SqliteTaskGraphRepository(db);
    const queue = new SqliteGoalQueueStore(db, WS);
    const sessionSvc = new SessionService({ sessions, events, lock, now, nextId });
    const seedGraph = (sid: string) => graphs.commit({
      graphId: `GR-${sid}`, sessionId: sid, version: 1, nodes: [], edges: [], createdAt: T0, createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: `M0-${sid}`, sessionId: sid, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: `P0-${sid}`, source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'init', at: T0 },
      createdAt: T0, status: 'COMMITTED',
    });

    // ── An older orphan that died mid-execution (RUNNING), its lock already reclaimed earlier ──
    queue.enqueue(vagueGoal('G-RUN'), T0);
    queue.claimNext('RUN', T0);
    await sessionSvc.create({ session: session('RUN'), hostname: HOST, processId: DEAD });
    await sessionSvc.transition('RUN', 'SESSION_INITIALIZED');
    await sessionSvc.transition('RUN', 'SESSION_READY');
    db.execute("UPDATE locks SET state = 'RELEASED', released_at = ? WHERE session_id = 'RUN'", [T0]);

    // ── Runtime A (pid DEAD): asks, then "dies" while waiting ──
    queue.enqueue(vagueGoal('G-S'), T0);
    const goalA = queue.claimNext('S', T0)!;
    await sessionSvc.create({ session: session('S'), hostname: HOST, processId: DEAD });
    await seedGraph('S');
    const coordA = new ClarificationCoordinator({
      sessionService: sessionSvc, sessions,
      sleep: () => new Promise<void>(() => { /* the process is gone: never wakes up */ }),
    });
    const a = plumbing();
    const orchA = new SessionOrchestrator({
      ...(a.deps as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId' | 'missionStage' | 'sessionService'>),
      sessionService: sessionSvc,
      missionStage: new MissionIntelligence({ events, now, newId: nextId, clarificationGate: coordA }),
      now, nextId,
    } as SessionOrchestratorDeps);
    void orchA.run({ sessionId: 'S', goal: goalA, revision: REVISION, graphVersion: 1 });
    for (let i = 0; i < 100 && (await sessions.getById('S'))?.state !== 'AWAITING_HUMAN'; i++) await sleep(10);
    expect((await sessions.getById('S'))?.state).toBe('AWAITING_HUMAN');
    expect(a.plannerCalls()).toBe(0);

    // ── Runtime B starts on the same DB ──
    const coordB = new ClarificationCoordinator({ sessionService: sessionSvc, sessions, pollIntervalMs: 10 });
    const service = new ObservabilityService({
      sessions, graphs, executions: new SqliteTaskExecutionRepository(db), taskRuns: new SqliteTaskRunRepository(db), events,
      controlPlane: new ControlPlane(),
      sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
      clarification: coordB, now, nextId,
    });
    transport = new HttpTransport({ service, streamPollMs: 50 });
    const base = `http://127.0.0.1:${await transport.listen(0)}`;
    const post = (answers: Record<string, string>) => fetch(`${base}/clarification`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'S', answers }),
    });

    // Before recovery nothing in B is waiting: exactly the Phase 1 "restart" behavior (409).
    expect((await post({ q1: 'x' })).status).toBe(409);

    const isAlive = (pid: number) => pid !== DEAD;
    expect(await lock.reclaimStale(WS, HOST, isAlive, T0)).toBe(true);
    const recovery = new StartupRecovery({
      orphans: new SqliteOrphanSource({ db, workspaceId: WS, hostname: HOST, isAlive, sessions, graphs, events }),
      sessionService: sessionSvc, events, now, nextId,
    });
    const recovered = await recovery.recover({ clarifyEnabled: true, hostname: HOST, processId: 5151, newLockId: () => 'L-B' });
    expect(recovered.aborted).toEqual([{ sessionId: 'RUN', reason: 'runtime restarted during execution' }]);
    expect((await sessions.getById('RUN'))?.state).toBe('ABORTED');
    const plan = recovered.resume!;
    if (plan.kind !== 'clarification') throw new Error('expected a clarification resume');
    expect(plan.sessionId).toBe('S');
    expect((await sessions.getById('S'))?.metadata.processId).toBe(5151);

    const bound = queue.getBySession('S')!;
    expect(bound.goal).toEqual(goalA);
    const b = plumbing();
    const orchB = new SessionOrchestrator({
      ...(b.deps as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId' | 'missionStage' | 'sessionService'>),
      sessionService: sessionSvc,
      missionStage: new MissionIntelligence({ events, now, newId: nextId, clarificationGate: coordB }),
      now, nextId,
    } as SessionOrchestratorDeps);
    const eventsBeforeResume = (await events.query({ sessionId: 'S' })).length;
    const resumed = orchB.resume({
      sessionId: 'S', goal: bound.goal, revision: REVISION, graphVersion: 1,
      resume: { resumeClarification: { missionId: plan.missionId, request: plan.request } },
    });

    // The Goals panel would now POST the answer: 409 until B's waiter is registered, then 200.
    const q1 = plan.request.openQuestions[0]!;
    let res: Response | undefined;
    for (let i = 0; i < 100; i++) {
      res = await post({ [q1.id]: 'nested Python lists' });
      if (res.status !== 409) break;
      await sleep(10);
    }
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ requestId: plan.request.requestId, answered: 1 });

    const result = await resumed;
    expect(result.sessionState).toBe('COMPLETED');
    expect(b.plannerCalls()).toBe(1);
    expect(b.captured[0]!.goalAssumptions).toEqual([`[user-provided] ${q1.text} → nested Python lists`]);
    expect(await lock.getActive(WS)).toBeNull(); // the adopted lock was released on completion

    const all = await events.query({ sessionId: 'S' });
    const types = all.map((e) => e.type);
    expect(types.filter((t) => t === 'GOAL_CLARIFICATION_REQUESTED')).toHaveLength(1);
    expect(types.filter((t) => t === 'GOAL_CLARIFICATION_ANSWERED')).toHaveLength(1);
    expect(types.filter((t) => t === 'MISSION_RECEIVED')).toHaveLength(1); // not replayed by B
    const afterResume = all.slice(eventsBeforeResume).map((e) => e.type);
    expect(afterResume).not.toContain('MISSION_RECEIVED');
    expect(types).toContain('SESSION_ADOPTED');
    const decided = all.filter((e) => e.type === 'SESSION_RECOVERY_DECIDED');
    expect(decided.map((e) => (e.payload as { decision: string }).decision)).toEqual(['resume']);
    // No SESSION_INITIALIZED replay: exactly one CREATED → INITIALIZING for S.
    const init = all.filter((e) => e.type === 'SESSION_STATE_CHANGED' && (e.payload as { event: string }).event === 'SESSION_INITIALIZED');
    expect(init).toHaveLength(1);
  });
});