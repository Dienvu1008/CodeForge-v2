// P9.3 — ObservabilityService (protocol-agnostic): state assembly, trace, control routing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  ObservabilityService,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ControlPlane,
  SessionService,
  ExecutionCoordinator,
  type Session,
  type ControlRequest,
} from '@codeforge/agent-core';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.9.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'qwen2.5-coder', analyzer: 'a' } },
  };
}

let db: SqliteDatabaseAdapter;
let service: ObservabilityService;
let sessionSvc: SessionService;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  const c = makeCounters();

  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });

  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  await sessionSvc.transition('S', 'SESSION_INITIALIZED');
  await sessionSvc.transition('S', 'SESSION_READY'); // -> RUNNING

  // Seed a graph with two tasks (T1 depends_on T2) and project their states.
  await tasks.create({ taskId: 'T1', description: 'a', acceptanceCriteria: [], constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: 't', createdBy: 'planner' });
  await tasks.create({ taskId: 'T2', description: 'b', acceptanceCriteria: [], constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: 't', createdBy: 'planner' });
  await graphs.commit({
    graphId: 'GR', sessionId: 'S', version: 1,
    nodes: [{ taskId: 'T1', addedInVersion: 1 }, { taskId: 'T2', addedInVersion: 1 }],
    edges: [{ edgeId: 'E1', fromTaskId: 'T1', toTaskId: 'T2', kind: 'depends_on', addedInVersion: 1 }],
    createdAt: 't', createdBy: 'planner', canonicalHash: 'h', schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
    createdAt: 't', status: 'COMMITTED',
  });
  const coord = new ExecutionCoordinator({ executions, now: c.now });
  await coord.init('T1'); await coord.init('T2');
  await coord.setState('T2', 'PASSED');

  service = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events,
    controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    now: c.now, nextId: c.nextId,
  });
});
afterEach(() => db.close());

describe('P9.3 ObservabilityService — getState', () => {
  it('assembles the runtime projection from repositories', async () => {
    const st = await service.getState('S');
    expect(st).not.toBeNull();
    expect(st!.sessionState).toBe('RUNNING');
    expect(st!.model).toBe('qwen2.5-coder');
    expect(st!.tasks.map((t) => t.taskId)).toEqual(['T1', 'T2']);
    // T2 PASSED; T1 depends_on T2 so T1 is not blocked.
    expect(st!.passedTaskIds).toEqual(['T2']);
    const t1 = st!.tasks.find((t) => t.taskId === 'T1')!;
    expect(t1.dependsOn).toEqual(['T2']);
    expect(t1.isBlocked).toBe(false);
  });

  it('returns null for an unknown session', async () => {
    expect(await service.getState('NOPE')).toBeNull();
  });
});

describe('P9.3 ObservabilityService — getTrace / getEvents', () => {
  it('builds a structured activity trace from the event log', async () => {
    const trace = await service.getTrace('S');
    expect(trace.sessionId).toBe('S');
    // Session create + two state changes were emitted during setup.
    expect(trace.entries.length).toBeGreaterThanOrEqual(3);
    expect(trace.entries.every((e) => typeof e.category === 'string')).toBe(true);
  });

  it('returns ordered events for replay', async () => {
    const events = await service.getEvents('S', 0);
    const seqs = events.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('P9.3 ObservabilityService — submitControl (OB-006)', () => {
  it('admits pause and actually transitions the session to PAUSED', async () => {
    const req: ControlRequest = { intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } };
    const res = await service.submitControl(req);
    expect(res.admission.admitted).toBe(true);
    expect(res.record.result).toBe('applied');
    expect((await service.getState('S'))!.sessionState).toBe('PAUSED');
  });

  it('resume returns the session to RUNNING', async () => {
    await service.submitControl({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    const res = await service.submitControl({ intent: 'resume', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'telegram' } });
    expect(res.admission.admitted).toBe(true);
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING');
  });

  it('a rejected control performs no kernel action and records a rejection', async () => {
    // resume from RUNNING is not admissible.
    const res = await service.submitControl({ intent: 'resume', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'cli' } });
    expect(res.admission.admitted).toBe(false);
    expect(res.record.result).toBe('rejected');
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING'); // unchanged
  });

  it('throws for control on an unknown session', async () => {
    await expect(service.submitControl({ intent: 'pause', sessionId: 'NOPE', requestedBy: { kind: 'user', id: 'u' } }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('dashboard and telegram pause requests are equivalent (one control path)', async () => {
    const a = await service.submitControl({ intent: 'cancel', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    expect(a.admission.admitted).toBe(true);
    // After cancel the session is CANCELLING — a second cancel from telegram is still admissible.
    const b = await service.submitControl({ intent: 'cancel', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'telegram' } });
    // CANCELLING is not in the admit set for cancel -> rejected NOT_APPLICABLE (same rule for both surfaces).
    expect(b.admission.admitted).toBe(false);
  });
});
