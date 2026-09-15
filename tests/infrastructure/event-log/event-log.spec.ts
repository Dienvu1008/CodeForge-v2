// P1-F4 EventLog acceptance — DOMAIN_CONTRACTS §18; CP-008, OB-001, PR-003.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent, Provenance } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let log: SqliteEventLog;

const SESSION = 'S1';

function seedSession(id: string): void {
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES (?, 'W', '/r', 'G', 1, 'RUNNING', 't', 't', '0.1.0', 1, 'B', 'L', '{}')`,
    [id],
  );
}

function evt(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: `E-${Math.random().toString(36).slice(2)}`,
    sessionId: SESSION,
    type: 'SESSION_STATE_CHANGED',
    aggregate: { kind: 'session', id: SESSION },
    payload: { from: 'CREATED', to: 'RUNNING' },
    at: '2026-01-01T00:00:00.000Z',
    sequenceNumber: -999, // caller value is IGNORED by the adapter (CP-008)
    ...overrides,
  };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  seedSession(SESSION);
  log = new SqliteEventLog(db);
});

afterEach(() => {
  db.close();
});

describe('SqliteEventLog — sequence authority (CP-008)', () => {
  it('assigns monotonic sequence numbers starting at 1, ignoring caller value', () => {
    const a = log.appendSync(evt({ eventId: 'A', sequenceNumber: 42 }));
    const b = log.appendSync(evt({ eventId: 'B', sequenceNumber: 7 }));
    const c = log.appendSync(evt({ eventId: 'C' }));
    expect(a.sequenceNumber).toBe(1);
    expect(b.sequenceNumber).toBe(2);
    expect(c.sequenceNumber).toBe(3);
  });

  it('has no gaps across many appends', () => {
    for (let i = 0; i < 25; i++) {
      log.appendSync(evt({ eventId: `E${i}` }));
    }
    const seqs = db
      .query<{ sequence_number: number }>(
        'SELECT sequence_number FROM events WHERE session_id = ? ORDER BY sequence_number',
        [SESSION],
      )
      .map((r) => r.sequence_number);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('keeps independent sequences per session', () => {
    seedSession('S2');
    log.appendSync(evt({ eventId: 'A', sessionId: SESSION }));
    const b = log.appendSync(evt({ eventId: 'B', sessionId: 'S2', aggregate: { kind: 'session', id: 'S2' } }));
    expect(b.sequenceNumber).toBe(1); // S2's own sequence
  });

  it('rejects a duplicate (session, sequence) at the DB level', () => {
    log.appendSync(evt({ eventId: 'A' }));
    // Bypass the adapter to force a collision — the UNIQUE index must reject it.
    expect(() =>
      db.execute(
        `INSERT INTO events
          (event_id, session_id, type, aggregate_kind, aggregate_id, payload_json, at, sequence_number)
         VALUES ('DUP', ?, 'X', 'session', ?, '{}', 't', 1)`,
        [SESSION, SESSION],
      ),
    ).toThrow(/DB_CONSTRAINT|UNIQUE/i);
  });
});

describe('SqliteEventLog — redaction before persist (PR-003)', () => {
  it('redacts secrets in the payload before writing', async () => {
    log.appendSync(
      evt({
        eventId: 'SEC',
        payload: { note: 'token=abcdEFGH1234 done', url: 'postgres://u:p@host/db' },
      }),
    );
    const stored = db.query<{ payload_json: string }>(
      "SELECT payload_json FROM events WHERE event_id = 'SEC'",
    )[0]?.payload_json;
    expect(stored).toContain('[REDACTED]');
    expect(stored).not.toContain('abcdEFGH1234');
    expect(stored).not.toContain('u:p@host');
  });

  it('redacts secrets in provenance before writing', () => {
    const provenance: Provenance = {
      provenanceId: 'P',
      source: { kind: 'model', id: 'planner' },
      inputs: [],
      reason: 'Bearer sk-supersecrettoken123',
      at: '2026-01-01T00:00:00.000Z',
    };
    const persisted = log.appendSync(evt({ eventId: 'PROV', provenance }));
    expect((persisted.provenance as Provenance).reason).toContain('[REDACTED]');
    expect((persisted.provenance as Provenance).reason).not.toContain('supersecrettoken');
  });
});

describe('SqliteEventLog — query + stream (deterministic replay, OB-001)', () => {
  beforeEach(() => {
    log.appendSync(evt({ eventId: 'A', type: 'SESSION_CREATED', aggregate: { kind: 'session', id: SESSION } }));
    log.appendSync(evt({ eventId: 'B', type: 'TASK_CREATED', aggregate: { kind: 'task', id: 'T1' } }));
    log.appendSync(evt({ eventId: 'C', type: 'TASK_STATE_CHANGED', aggregate: { kind: 'task', id: 'T1' } }));
  });

  it('streams in sequence order from a given point', async () => {
    const collected: number[] = [];
    for await (const e of log.stream(SESSION, 1)) {
      collected.push(e.sequenceNumber);
    }
    expect(collected).toEqual([2, 3]); // strictly greater than fromSequence
  });

  it('query filters by type', async () => {
    const rows = await log.query({ sessionId: SESSION, type: 'TASK_CREATED' });
    expect(rows.map((r) => r.eventId)).toEqual(['B']);
  });

  it('query filters by aggregate', async () => {
    const rows = await log.query({ sessionId: SESSION, aggregateId: 'T1' });
    expect(rows.map((r) => r.eventId)).toEqual(['B', 'C']);
  });

  it('query filters by fromSequence (inclusive)', async () => {
    const rows = await log.query({ sessionId: SESSION, fromSequence: 2 });
    expect(rows.map((r) => r.sequenceNumber)).toEqual([2, 3]);
  });

  it('round-trips event shape (payload parsed back)', async () => {
    const rows = await log.query({ sessionId: SESSION, type: 'SESSION_CREATED' });
    expect(rows[0]?.aggregate).toEqual({ kind: 'session', id: SESSION });
    expect(rows[0]?.payload).toEqual({ from: 'CREATED', to: 'RUNNING' });
  });
});
