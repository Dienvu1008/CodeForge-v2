// OB-003 — Mọi verification phải phát event với revision + scope + status.
//
// Invariant-group home for OB-003 (yaml `test` path). The VerificationEngine emits
// VERIFICATION_STARTED/ENDED; full coverage is in tests/verification/* and
// tests/integration/verification-e2e. Here we assert a verification event carries the
// revision + scope + status metadata the invariant requires and is queryable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent } from '@codeforge/agent-core';

const SESSION = 'S-ob003';

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

describe('OB-003 — a verification event carries revision + scope + status', () => {
  it('a VERIFICATION_ENDED event records revisionId, scope, and status', async () => {
    const e: DomainEvent = {
      eventId: 'E-1', sessionId: SESSION, type: 'VERIFICATION_ENDED',
      aggregate: { kind: 'verification', id: 'V1' },
      payload: { revisionId: 'R1', scope: 'AFFECTED_DIRECT', status: 'PASS' },
      at: '2026-01-01T00:00:00.000Z', sequenceNumber: 0,
    };
    log.appendSync(e);
    const events = await log.query({ sessionId: SESSION, type: 'VERIFICATION_ENDED' });
    expect(events).toHaveLength(1);
    const p = events[0]!.payload as { revisionId: string; scope: string; status: string };
    expect(p.revisionId).toBe('R1');
    expect(p.scope).toBe('AFFECTED_DIRECT');
    expect(p.status).toBe('PASS');
  });
});
