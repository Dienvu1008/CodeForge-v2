/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SessionService.adopt() (session-resume v1) over real SQLite repositories + lock service.
// Requirements 4.1, 7.1, 7.2.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { SessionService, type Session } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let svc: SessionService;
let sessions: SqliteSessionRepository;
let events: SqliteEventLog;
let lock: SqliteWorkspaceLockService;

function session(id: string, lockId: string): Session {
  return {
    sessionId: id, workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.12.0', schemaVersion: 1,
    budgetId: 'B', lockId,
    metadata: { hostname: 'old-host', processId: 111, ollamaEndpoint: 'e',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

/** Put session S in AWAITING_HUMAN with its lock released, as reclaimStale leaves a dead owner's lock. */
async function orphanAwaiting(id = 'S', lockId = 'L-old'): Promise<void> {
  await svc.create({ session: session(id, lockId), hostname: 'old-host', processId: 111 });
  await svc.transition(id, 'SESSION_INITIALIZED');
  await svc.transition(id, 'SESSION_READY');
  await svc.transition(id, 'HUMAN_REQUIRED');
  db.execute("UPDATE locks SET state = 'RELEASED', released_at = 't' WHERE lock_id = ?", [lockId]);
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => 't' });
  sessions = new SqliteSessionRepository(db);
  events = new SqliteEventLog(db);
  lock = new SqliteWorkspaceLockService(db);
  let n = 0;
  svc = new SessionService({ sessions, events, lock, now: () => 't2', nextId: () => `id-${++n}` });
});
afterEach(() => db.close());

describe('SessionService.adopt', () => {
  it('acquires a fresh lock, records the new owner, keeps the state, emits SESSION_ADOPTED', async () => {
    await orphanAwaiting();
    const adopted = await svc.adopt({ sessionId: 'S', lockId: 'L-new', hostname: 'new-host', processId: 222 });

    expect(adopted.state).toBe('AWAITING_HUMAN');
    const row = await sessions.getById('S');
    expect(row?.state).toBe('AWAITING_HUMAN');
    expect(row?.lockId).toBe('L-new');
    expect(row?.metadata.hostname).toBe('new-host');
    expect(row?.metadata.processId).toBe(222);

    const active = await lock.getActive('W');
    expect(active).toMatchObject({ lockId: 'L-new', sessionId: 'S', processId: 222, hostname: 'new-host' });

    const adoptedEvents = (await events.query({ sessionId: 'S' })).filter((e) => e.type === 'SESSION_ADOPTED');
    expect(adoptedEvents).toHaveLength(1);
    expect(adoptedEvents[0]!.payload).toEqual({ previousProcessId: 111, processId: 222, lockId: 'L-new' });
  });

  it('the adopted session can still be decided (SS-007) and terminal transitions release the NEW lock', async () => {
    await orphanAwaiting();
    await svc.adopt({ sessionId: 'S', lockId: 'L-new', hostname: 'new-host', processId: 222 });
    await svc.transition('S', 'HUMAN_DECIDED', { humanDecisionRecorded: true });
    await svc.transition('S', 'ABORT');
    expect(await lock.getActive('W')).toBeNull();
  });

  it('throws LOCK_HELD and changes nothing when a live session holds the workspace (SS-001)', async () => {
    await orphanAwaiting();
    // Another live session takes the workspace lock first.
    await svc.create({ session: session('LIVE', 'L-live'), hostname: 'h', processId: 333 });
    await expect(svc.adopt({ sessionId: 'S', lockId: 'L-new', hostname: 'h', processId: 222 }))
      .rejects.toThrow(/LOCK_HELD|already locked|held/i);
    const row = await sessions.getById('S');
    expect(row?.lockId).toBe('L-old');
    expect(row?.metadata.processId).toBe(111);
  });

  it('rejects unknown and terminal sessions', async () => {
    await expect(svc.adopt({ sessionId: 'NOPE', lockId: 'L', hostname: 'h', processId: 1 })).rejects.toThrow(/NOPE/);
    await orphanAwaiting();
    await svc.transition('S', 'ABORT');
    await expect(svc.adopt({ sessionId: 'S', lockId: 'L2', hostname: 'h', processId: 1 })).rejects.toThrow(/terminal/i);
  });
});