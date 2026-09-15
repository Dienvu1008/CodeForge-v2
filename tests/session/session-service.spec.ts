// P1-S1 SessionService — integration over real SQLite repos (SS-001/002/003/007).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { SessionService, SessionError } from '@codeforge/agent-core';
import type { Session, SessionServiceDeps } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let service: SessionService;
let events: SqliteEventLog;
let lock: SqliteWorkspaceLockService;

// Deterministic id/time sources (no wall-clock / random).
function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0;
  let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'S1',
    workspaceId: 'W1',
    workspaceRoot: '/r',
    goalId: 'G',
    graphVersion: 1,
    state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.1.0',
    schemaVersion: 1,
    budgetId: 'B',
    lockId: 'L1',
    metadata: {
      hostname: 'h',
      processId: 1,
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  events = new SqliteEventLog(db);
  lock = new SqliteWorkspaceLockService(db);
  const deps: SessionServiceDeps = {
    sessions: new SqliteSessionRepository(db),
    events,
    lock,
    ...makeCounters(),
  };
  service = new SessionService(deps);
});
afterEach(() => db.close());

describe('SessionService.create — lock + persist + event (SS-001)', () => {
  it('creates a session, acquires the lock, and emits SESSION_CREATED', async () => {
    await service.create({ session: session(), hostname: 'h', processId: 1 });
    expect((await lock.getActive('W1'))?.sessionId).toBe('S1');
    const evs = await events.query({ sessionId: 'S1' });
    expect(evs.map((e) => e.type)).toEqual(['SESSION_CREATED']);
  });

  it('rejects a second active session on the same workspace (SS-001)', async () => {
    await service.create({ session: session(), hostname: 'h', processId: 1 });
    await expect(
      service.create({
        session: session({ sessionId: 'S2', lockId: 'L2' }),
        hostname: 'h',
        processId: 2,
      }),
    ).rejects.toMatchObject({ code: 'LOCK_HELD' });
    // The rejected session must NOT have been persisted.
    expect(await new SqliteSessionRepository(db).getById('S2')).toBeNull();
  });

  it('rejects a session that does not start in CREATED', async () => {
    await expect(
      service.create({ session: session({ state: 'RUNNING' }), hostname: 'h', processId: 1 }),
    ).rejects.toBeInstanceOf(SessionError);
  });
});

describe('SessionService.transition — lifecycle (SS-002/007)', () => {
  beforeEach(async () => {
    await service.create({ session: session(), hostname: 'h', processId: 1 });
  });

  it('advances CREATED -> INITIALIZING -> RUNNING and emits state-changed events', async () => {
    await service.transition('S1', 'SESSION_INITIALIZED');
    await service.transition('S1', 'SESSION_READY');
    expect((await new SqliteSessionRepository(db).getById('S1'))?.state).toBe('RUNNING');
    const types = (await events.query({ sessionId: 'S1' })).map((e) => e.type);
    expect(types).toEqual(['SESSION_CREATED', 'SESSION_STATE_CHANGED', 'SESSION_STATE_CHANGED']);
  });

  it('rejects an invalid transition (SS-002)', async () => {
    await expect(service.transition('S1', 'SESSION_READY')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('blocks AWAITING_HUMAN -> RUNNING without a decision (SS-007)', async () => {
    await service.transition('S1', 'SESSION_INITIALIZED');
    await service.transition('S1', 'SESSION_READY');
    await service.transition('S1', 'HUMAN_REQUIRED');
    await expect(service.transition('S1', 'HUMAN_DECIDED', {})).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await service.transition('S1', 'HUMAN_DECIDED', { humanDecisionRecorded: true });
    expect((await new SqliteSessionRepository(db).getById('S1'))?.state).toBe('RUNNING');
  });
});

describe('SessionService.complete — SS-003 + lock release', () => {
  beforeEach(async () => {
    await service.create({ session: session(), hostname: 'h', processId: 1 });
    await service.transition('S1', 'SESSION_INITIALIZED');
    await service.transition('S1', 'SESSION_READY');
  });

  it('blocks completion while tasks are non-terminal (SS-003)', async () => {
    await expect(service.complete('S1', false)).rejects.toMatchObject({
      code: 'PREMATURE_COMPLETION',
    });
  });

  it('completes when all tasks terminal, emits SESSION_COMPLETED, releases lock', async () => {
    await service.complete('S1', true);
    expect((await new SqliteSessionRepository(db).getById('S1'))?.state).toBe('COMPLETED');
    const types = (await events.query({ sessionId: 'S1' })).map((e) => e.type);
    expect(types).toContain('SESSION_COMPLETED');
    // Lock released → the workspace can host a new session.
    expect(await lock.getActive('W1')).toBeNull();
  });

  it('abort releases the lock too', async () => {
    await service.transition('S1', 'ABORT');
    expect((await new SqliteSessionRepository(db).getById('S1'))?.state).toBe('ABORTED');
    expect(await lock.getActive('W1')).toBeNull();
  });
});
