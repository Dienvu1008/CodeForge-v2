// OB-004 — EventLog phải queryable theo session, task, revision.
//
// Invariant-group home for OB-004 (yaml `test` path). Exhaustive adapter coverage lives
// in tests/infrastructure/event-log/event-log.spec.ts; here we assert the queryable
// contract the dashboard/replay layer depends on: filter by session, by aggregate id
// (task), and by type, with deterministic ordering.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let log: SqliteEventLog;

function evt(session: string, seq: number, type: string, aggId: string): DomainEvent {
  return {
    eventId: `E-${session}-${seq}`, sessionId: session, type,
    aggregate: { kind: 'task', id: aggId }, payload: { n: seq },
    at: '2026-01-01T00:00:00.000Z', sequenceNumber: 0,
  };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  for (const s of ['SA', 'SB']) {
    db.execute(
      `INSERT INTO sessions
         (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
          created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES (?, 'W', '/r', 'G', 1, 'RUNNING', 't', 't', '0.1.0', 1, ?, ?, '{}')`,
      [s, `B-${s}`, `L-${s}`],
    );
  }
  log = new SqliteEventLog(db);
});
afterEach(() => db.close());

describe('OB-004 — EventLog is queryable by session, task, and type', () => {
  it('filters by session, by aggregate id, and by type with deterministic order', async () => {
    log.appendSync(evt('SA', 1, 'TASK_CREATED', 'T1'));
    log.appendSync(evt('SA', 2, 'TASK_SUPERSEDED', 'T1'));
    log.appendSync(evt('SA', 3, 'TASK_CREATED', 'T2'));
    log.appendSync(evt('SB', 1, 'TASK_CREATED', 'T3'));

    const bySession = await log.query({ sessionId: 'SA' });
    expect(bySession.map((e) => e.sequenceNumber)).toEqual([1, 2, 3]); // ordered

    const byTask = await log.query({ aggregateId: 'T1' });
    expect(byTask).toHaveLength(2);

    const byType = await log.query({ type: 'TASK_CREATED' });
    expect(byType).toHaveLength(3);
  });
});
