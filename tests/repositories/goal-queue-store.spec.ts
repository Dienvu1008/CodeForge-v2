// Feature: session-resume, Property 3: Hàng đợi FIFO, không chạy hai lần
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SqliteGoalQueueStore + migration 0007 + GoalIngressService with a durable store.
// **Validates: Requirements 1.1, 1.2, 1.3, 8.3**
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteGoalQueueStore,
  SqliteGoalRepository,
  runMigrations,
  createMigrationRegistry,
  migration0007,
} from '@codeforge/infrastructure';
import { GoalIngressService, type Goal } from '@codeforge/agent-core';
import { mulberry32, int, bool } from '../mission/clarification-generators.js';

let db: SqliteDatabaseAdapter;
beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => 't' });
});
afterEach(() => db.close());

function goal(id: string): Goal {
  return {
    goalId: id, version: 1, description: `goal ${id}`, constraints: [],
    acceptanceCriteria: [{ criterionId: `c-${id}`, description: 'done', mandatory: true }],
    createdAt: 't', createdBy: 'user',
  };
}

describe('Property 3: durable FIFO, never claimed twice, survives restart', () => {
  it('random enqueue / claim / restart sequences', () => {
    const rng = mulberry32(0x9a7e03);
    for (let iter = 0; iter < 120; iter++) {
      db.execute('DELETE FROM goal_queue', []);
      db.execute('DELETE FROM goals', []);
      let store = new SqliteGoalQueueStore(db, 'W');
      const enqueued: string[] = [];
      const claimed: string[] = [];
      let next = 0;
      const ops = int(rng, 1, 30);
      for (let k = 0; k < ops; k++) {
        const r = rng();
        if (r < 0.45) {
          const id = `g${iter}-${next++}`;
          store.enqueue(goal(id), 't');
          enqueued.push(id);
        } else if (r < 0.85) {
          const sid = `S-${iter}-${k}`;
          const g = store.claimNext(sid, 't');
          if (g !== undefined) {
            claimed.push(g.goalId);
            expect(store.getBySession(sid)?.goal.goalId).toBe(g.goalId);
          }
        } else {
          store = new SqliteGoalQueueStore(db, 'W'); // "restart": a new store on the same DB
        }
      }
      // FIFO: the claimed ids are exactly the first |claimed| enqueued ids, in order; no duplicates.
      expect(claimed).toEqual(enqueued.slice(0, claimed.length));
      expect(new Set(claimed).size).toBe(claimed.length);
      // Everything enqueued but not claimed is still queued after a restart.
      const fresh = new SqliteGoalQueueStore(db, 'W');
      expect(fresh.queuedCount()).toBe(enqueued.length - claimed.length);
      if (bool(rng)) {
        const rest: string[] = [];
        for (let g = fresh.claimNext('drain', 't'); g !== undefined; g = fresh.claimNext('drain', 't')) rest.push(g.goalId);
        expect(rest).toEqual(enqueued.slice(claimed.length));
      }
    }
  });
});

describe('SqliteGoalQueueStore — examples', () => {
  it('enqueue persists the Goal itself (readable via SqliteGoalRepository)', async () => {
    const store = new SqliteGoalQueueStore(db, 'W');
    store.enqueue(goal('A'), 't');
    expect(await new SqliteGoalRepository(db).getById('A')).toEqual(goal('A'));
  });

  it('recordStartRevision is returned by getBySession; unknown session → null', () => {
    const store = new SqliteGoalQueueStore(db, 'W');
    store.enqueue(goal('A'), 't');
    store.claimNext('S1', 't');
    expect(store.getBySession('S1')).toEqual({ goal: goal('A') });
    store.recordStartRevision('S1', 'HASH');
    expect(store.getBySession('S1')).toEqual({ goal: goal('A'), startRevisionHash: 'HASH' });
    expect(store.getBySession('nope')).toBeNull();
  });

  it('queues are scoped per workspace id', () => {
    new SqliteGoalQueueStore(db, 'W1').enqueue(goal('A'), 't');
    new SqliteGoalQueueStore(db, 'W2').enqueue(goal('B'), 't');
    expect(new SqliteGoalQueueStore(db, 'W1').claimNext('S', 't')?.goalId).toBe('A');
    expect(new SqliteGoalQueueStore(db, 'W1').claimNext('S2', 't')).toBeUndefined();
    expect(new SqliteGoalQueueStore(db, 'W2').queuedCount()).toBe(1);
  });

  it('a queue row must reference an existing goal (FK)', () => {
    db.execute('PRAGMA foreign_keys = ON', []);
    expect(() => db.execute(
      "INSERT INTO goal_queue (goal_id, goal_version, workspace_id, seq, status, enqueued_at) VALUES ('X', 1, 'W', 1, 'QUEUED', 't')",
      [],
    )).toThrow();
  });
});

describe('migration 0007', () => {
  it('rollback drops goal_queue and re-apply recreates it', () => {
    const has = (): boolean => db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='goal_queue'", []).length === 1;
    expect(has()).toBe(true);
    migration0007.rollback(db);
    expect(has()).toBe(false);
    migration0007.apply(db);
    expect(has()).toBe(true);
  });
});

describe('GoalIngressService with a durable store', () => {
  let n = 0;
  const deps = () => ({ now: () => 't', nextId: () => `id-${++n}` });

  it('submit persists through the store; claimNext takes FIFO and binds the session', () => {
    const store = new SqliteGoalQueueStore(db, 'W');
    const svc = new GoalIngressService({ ...deps(), store });
    const a = svc.submitGoal({ description: 'first' });
    const b = svc.submitGoal({ description: 'second' });
    expect(a.position).toBe(1);
    expect(b.position).toBe(2);
    expect(svc.size()).toBe(2);
    // A NEW service over the same DB (restart) sees the same queue.
    const after = new GoalIngressService({ ...deps(), store: new SqliteGoalQueueStore(db, 'W') });
    expect(after.claimNext('S1')?.description).toBe('first');
    expect(after.claimNext('S2')?.description).toBe('second');
    expect(after.claimNext('S3')).toBeUndefined();
    expect(store.getBySession('S2')?.goal.goalId).toBe(b.goalId);
  });

  it('without a store the in-memory FIFO is unchanged (claimNext ≡ dequeue)', () => {
    const svc = new GoalIngressService(deps());
    svc.submitGoal({ description: 'x' });
    svc.submitGoal({ description: 'y' });
    expect(svc.claimNext('S')?.description).toBe('x');
    expect(svc.dequeue()?.description).toBe('y');
    expect(svc.size()).toBe(0);
  });
});