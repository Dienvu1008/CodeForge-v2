// OB-009 — Live event tailer chỉ đọc EventLog đã persist (tail theo sequenceNumber);
// không phải đường ghi thứ hai.
//
// A live tailer (P9.3) consumes events via EventLog.stream(sessionId, fromSequence),
// which returns persisted events in sequenceNumber order and offers NO write. This spec
// asserts the read-only shape the tailer relies on now, so the future tailer cannot be
// a second write path (CP-001/CP-008/OB-001 remain the sole write path via append()).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent } from '@codeforge/agent-core';

const SESSION = 'S-ob009';

function evt(seq: number, type: string): DomainEvent {
  return {
    eventId: `E-${seq}`,
    sessionId: SESSION,
    type,
    aggregate: { kind: 'session', id: SESSION },
    payload: { n: seq },
    at: `2026-01-01T00:00:0${seq}.000Z`,
    sequenceNumber: 0, // adapter assigns the real sequence
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

describe('OB-009 — event tailer reads persisted events, never a second write path', () => {
  it('stream() tails by sequenceNumber in deterministic order and only reads', async () => {
    log.appendSync(evt(1, 'SESSION_CREATED'));
    log.appendSync(evt(2, 'SESSION_STATE_CHANGED'));
    log.appendSync(evt(3, 'SESSION_STATE_CHANGED'));

    // A tailer resumes from the last seen sequence — pure read.
    const seen: number[] = [];
    for await (const e of log.stream(SESSION, 1)) seen.push(e.sequenceNumber);
    expect(seen).toEqual([2, 3]); // only events after fromSequence, in order

    // The tailer surface (stream) exposes no mutator — append is the only writer.
    expect(typeof log.stream).toBe('function');
    expect(typeof log.append).toBe('function');
    expect('update' in log).toBe(false);
    expect('delete' in log).toBe(false);
  });

  it('tailing does not alter the log (read is side-effect free)', async () => {
    log.appendSync(evt(1, 'SESSION_CREATED'));
    const before = await log.query({ sessionId: SESSION });
    for await (const _e of log.stream(SESSION, 0)) { /* drain */ }
    const after = await log.query({ sessionId: SESSION });
    expect(after.length).toBe(before.length);
    expect(after.map((e) => e.sequenceNumber)).toEqual(before.map((e) => e.sequenceNumber));
  });
});
