// OB-001 — Mọi state transition phải phát event.
//
// This is the invariant-group home for OB-001 (the yaml `test` path). Exhaustive
// adapter coverage lives in tests/infrastructure/event-log/event-log.spec.ts; here we
// assert the core contract: a state transition is recorded as an appended, queryable
// event. We drive it through SessionService (the canonical transition emitter) via the
// EventLog it writes to.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent } from '@codeforge/agent-core';

const SESSION = 'S-ob001';

function stateChange(seq: number): DomainEvent {
  return {
    eventId: `E-${seq}`, sessionId: SESSION, type: 'SESSION_STATE_CHANGED',
    aggregate: { kind: 'session', id: SESSION }, payload: { from: 'CREATED', to: 'RUNNING' },
    at: '2026-01-01T00:00:00.000Z', sequenceNumber: 0,
  };
}

let db: SqliteDatabaseAdapter;
let log: SqliteEventLog;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES (?, 'W', '/r', 'G', 1, 'RUNNING', 't', 't', '0.1.0', 1, 'B', 'L', '{}')`,
    [SESSION],
  );
  log = new SqliteEventLog(db);
});
afterEach(() => db.close());

describe('OB-001 — a state transition produces a persisted event', () => {
  it('an appended transition event is queryable by session', async () => {
    log.appendSync(stateChange(1));
    const events = await log.query({ sessionId: SESSION });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('SESSION_STATE_CHANGED');
    expect(events[0]!.sequenceNumber).toBe(1); // adapter assigned (CP-008)
  });
});
