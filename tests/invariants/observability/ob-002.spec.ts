// OB-002 — Mọi tool call phải phát event với đủ metadata.
//
// Invariant-group home for OB-002 (yaml `test` path). The ToolGateway emits
// TOOL_CALL_REQUESTED/APPROVED/DENIED/STARTED/ENDED with the toolCallId in the payload;
// full lifecycle coverage is in tests/tool/* and tests/integration/tool-gateway-e2e.
// Here we assert a tool-call event carries its identifying metadata and is queryable.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DomainEvent } from '@codeforge/agent-core';

const SESSION = 'S-ob002';

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

describe('OB-002 — a tool call event carries identifying metadata', () => {
  it('a TOOL_CALL_REQUESTED event is queryable by type with toolCallId metadata', async () => {
    const e: DomainEvent = {
      eventId: 'E-1', sessionId: SESSION, type: 'TOOL_CALL_REQUESTED',
      aggregate: { kind: 'tool_call', id: 'TC1' },
      payload: { toolCallId: 'TC1', state: 'REQUESTED' },
      at: '2026-01-01T00:00:00.000Z', sequenceNumber: 0,
    };
    log.appendSync(e);
    const byType = await log.query({ type: 'TOOL_CALL_REQUESTED' });
    expect(byType).toHaveLength(1);
    expect(byType[0]!.aggregate).toEqual({ kind: 'tool_call', id: 'TC1' });
    expect((byType[0]!.payload as { toolCallId: string }).toolCallId).toBe('TC1');
  });
});
