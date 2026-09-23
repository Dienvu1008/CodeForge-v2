// P1-F3 + P1.5-DB2 Schema migrations acceptance -- MIGRATION_SPEC §4-§5, §17.1.
// Updated for migration v2 (Phase 1.5 tables: approvals, failures, recovery_actions).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  runMigrations,
  createMigrationRegistry,
  readSchemaHistory,
  MIGRATIONS,
  migration0001,
  migration0002,
} from '@codeforge/infrastructure';

let db: SqliteDatabaseAdapter;
const now = () => '2026-01-01T00:00:00.000Z'; // deterministic (no wall-clock)

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
});

afterEach(() => {
  db.close();
});

const EXPECTED_TABLES = [
  'sessions',
  'goals',
  'tasks',
  'task_executions',
  'task_runs',
  'task_graph_versions',
  'task_graph_nodes',
  'task_graph_edges',
  'graph_mutations',
  'budgets',
  'tool_calls',
  'verification_reports',
  'change_records',
  'checkpoints',
  'provenance',
  'events',
  'locks',
];

function tableNames(d: SqliteDatabaseAdapter): string[] {
  return d
    .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
}

describe('runMigrations — forward (MIGRATION_SPEC §4)', () => {
  it('brings a fresh db from version 0 to the latest', () => {
    expect(db.getSchemaVersion()).toBe(0);
    const result = runMigrations(db, createMigrationRegistry(), { now });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(2);
    expect(result.applied).toEqual([
      '0001_create_initial_schema',
      '0002_phase15_approvals_failures_recovery',
    ]);
    expect(db.getSchemaVersion()).toBe(2);
  });

  it('creates every Phase 1 table', () => {
    runMigrations(db, createMigrationRegistry(), { now });
    const names = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(names, `missing table ${t}`).toContain(t);
    }
    expect(names).toContain('schema_versions');
  });

  it('records the migration in schema_versions', () => {
    runMigrations(db, createMigrationRegistry(), { now, runtimeVersion: '0.1.0' });
    const history = readSchemaHistory(db);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      schemaVersion: 1,
      migrationId: '0001_create_initial_schema',
      runtimeVersion: '0.1.0',
      appliedAt: '2026-01-01T00:00:00.000Z',
      forwardOnly: false,
      rollbackTo: 0,
    });
    expect(history[1]).toMatchObject({
      schemaVersion: 2,
      migrationId: '0002_phase15_approvals_failures_recovery',
      forwardOnly: false,
      rollbackTo: 1,
    });
  });
});

describe('runMigrations — idempotent (MIGRATION_SPEC §1.3)', () => {
  it('is a no-op when already at target', () => {
    runMigrations(db, createMigrationRegistry(), { now });
    const second = runMigrations(db, createMigrationRegistry(), { now });
    expect(second.fromVersion).toBe(2);
    expect(second.toVersion).toBe(2);
    expect(second.applied).toEqual([]);
    // two rows: one per migration
    expect(readSchemaHistory(db)).toHaveLength(2);
  });

  it('fails fast if the db is newer than the runtime target', () => {
    db.exec('CREATE TABLE schema_versions (schema_version INTEGER)');
    db.setSchemaVersion(99);
    expect(() => runMigrations(db, createMigrationRegistry(), { now })).toThrow(/newer than/);
  });
});

describe('migration 0001 — rollback (MIGRATION_SPEC §5.1)', () => {
  it('drops all tables it created', () => {
    runMigrations(db, createMigrationRegistry(), { now });
    expect(tableNames(db)).toContain('sessions');
    migration0001.rollback?.(db);
    const names = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(names, `table ${t} should be dropped`).not.toContain(t);
    }
  });
});

describe('schema v1 — structure', () => {
  beforeEach(() => {
    runMigrations(db, createMigrationRegistry(), { now });
  });

  it('enforces the events per-session monotonic uniqueness (CP-008)', () => {
    // Seed a session to satisfy the FK.
    db.execute(
      `INSERT INTO sessions
        (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
         created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
    );
    const insertEvent = (seq: number): void => {
      db.execute(
        `INSERT INTO events
          (event_id, session_id, type, aggregate_kind, aggregate_id, payload_json, at, sequence_number)
         VALUES (?, 'S', 'SESSION_CREATED', 'session', 'S', '{}', 't', ?)`,
        [`E${seq}`, seq],
      );
    };
    insertEvent(1);
    // Same (session_id, sequence_number) must be rejected.
    expect(() => insertEvent(1)).toThrow(/DB_CONSTRAINT|UNIQUE/i);
  });

  it('has the roadmap UX hook columns (nullable, unused in Phase 1)', () => {
    const toolCols = db
      .query<{ name: string }>("PRAGMA table_info('tool_calls')")
      .map((r) => r.name);
    expect(toolCols).toContain('before_content');
    expect(toolCols).toContain('after_content');
    const sessionCols = db
      .query<{ name: string }>("PRAGMA table_info('sessions')")
      .map((r) => r.name);
    expect(sessionCols).toContain('capability_set');
    const taskCols = db.query<{ name: string }>("PRAGMA table_info('tasks')").map((r) => r.name);
    expect(taskCols).toContain('capability_set');
  });

  it('enforces one active lock per workspace (partial unique index)', () => {
    const insertLock = (id: string): void => {
      db.execute(
        `INSERT INTO locks
          (lock_id, workspace_id, session_id, state, hostname, process_id, acquired_at, heartbeat_at)
         VALUES (?, 'W', 'S', 'HELD', 'host', 1, 't', 't')`,
        [id],
      );
    };
    insertLock('L1');
    expect(() => insertLock('L2')).toThrow(/DB_CONSTRAINT|UNIQUE/i);
    // Releasing the first allows a second active lock.
    db.execute("UPDATE locks SET released_at = 't' WHERE lock_id = 'L1'");
    expect(() => insertLock('L3')).not.toThrow();
  });
});

describe('migration registry -- chain validation', () => {
  it('MIGRATIONS forms a contiguous chain from 0', () => {
    const reg = createMigrationRegistry(MIGRATIONS);
    expect(reg.latestVersion()).toBe(2);
    expect(reg.getByToVersion(1)?.migrationId).toBe('0001_create_initial_schema');
    expect(reg.getByToVersion(2)?.migrationId).toBe('0002_phase15_approvals_failures_recovery');
  });

  it('rejects a broken chain (gap)', () => {
    const broken = [{ ...migration0001, fromVersion: 0, toVersion: 2 }];
    expect(() => createMigrationRegistry(broken)).toThrow(/chain broken/);
  });

  it('migration0002 is exported and has correct version bounds', () => {
    expect(migration0002.fromVersion).toBe(1);
    expect(migration0002.toVersion).toBe(2);
    expect(migration0002.reversible).toBe(true);
  });
});
