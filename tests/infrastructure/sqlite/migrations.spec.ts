// P1-F3 + P1.5-DB2 + P2-DB3 Schema migrations acceptance -- MIGRATION_SPEC §4-§5, §17.1.
// Updated for migration v3 (Phase 2 tables: context_snapshots, context_items, context_provenance).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  runMigrations,
  createMigrationRegistry,
  readSchemaHistory,
  MIGRATIONS,
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
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
    expect(result.toVersion).toBe(5);
    expect(result.applied).toEqual([
      '0001_create_initial_schema',
      '0002_phase15_approvals_failures_recovery',
      '0003_phase2_context_tables',
      '0004_phase3_artifacts',
      '0005_phase7_memory',
    ]);
    expect(db.getSchemaVersion()).toBe(5);
  });

  it('creates every Phase 1 table', () => {
    runMigrations(db, createMigrationRegistry(), { now });
    const names = tableNames(db);
    for (const t of EXPECTED_TABLES) {
      expect(names, `missing table ${t}`).toContain(t);
    }
    expect(names).toContain('schema_versions');
    expect(names).toContain('memory_records'); // Phase 7 (v5)
  });

  it('records the migration in schema_versions', () => {
    runMigrations(db, createMigrationRegistry(), { now, runtimeVersion: '0.1.0' });
    const history = readSchemaHistory(db);
    expect(history).toHaveLength(5);
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
    expect(history[2]).toMatchObject({
      schemaVersion: 3,
      migrationId: '0003_phase2_context_tables',
      forwardOnly: false,
      rollbackTo: 2,
    });
    expect(history[3]).toMatchObject({
      schemaVersion: 4,
      migrationId: '0004_phase3_artifacts',
      forwardOnly: false,
      rollbackTo: 3,
    });
    expect(history[4]).toMatchObject({
      schemaVersion: 5,
      migrationId: '0005_phase7_memory',
      forwardOnly: false,
      rollbackTo: 4,
    });
  });
});

describe('runMigrations — idempotent (MIGRATION_SPEC §1.3)', () => {
  it('is a no-op when already at target', () => {
    runMigrations(db, createMigrationRegistry(), { now });
    const second = runMigrations(db, createMigrationRegistry(), { now });
    expect(second.fromVersion).toBe(5);
    expect(second.toVersion).toBe(5);
    expect(second.applied).toEqual([]);
    expect(readSchemaHistory(db)).toHaveLength(5);
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
    expect(reg.latestVersion()).toBe(5);
    expect(reg.getByToVersion(1)?.migrationId).toBe('0001_create_initial_schema');
    expect(reg.getByToVersion(2)?.migrationId).toBe('0002_phase15_approvals_failures_recovery');
    expect(reg.getByToVersion(3)?.migrationId).toBe('0003_phase2_context_tables');
    expect(reg.getByToVersion(4)?.migrationId).toBe('0004_phase3_artifacts');
    expect(reg.getByToVersion(5)?.migrationId).toBe('0005_phase7_memory');
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

  it('migration0003 is exported and has correct version bounds (P2-DB3)', () => {
    expect(migration0003.fromVersion).toBe(2);
    expect(migration0003.toVersion).toBe(3);
    expect(migration0003.reversible).toBe(true);
  });

  it('migration0005 is exported and has correct version bounds (P7-MS1)', () => {
    expect(migration0005.fromVersion).toBe(4);
    expect(migration0005.toVersion).toBe(5);
    expect(migration0005.reversible).toBe(true);
  });

  it('migration0004 is exported and has correct version bounds (P3-AS1)', () => {
    expect(migration0004.fromVersion).toBe(3);
    expect(migration0004.toVersion).toBe(4);
    expect(migration0004.reversible).toBe(true);
  });
});

describe('migration v3 (P2-DB3) — context tables', () => {
  beforeEach(() => {
    runMigrations(db, createMigrationRegistry(), { now });
  });

  it('creates context_snapshots, context_items, context_provenance tables', () => {
    const names = tableNames(db);
    expect(names).toContain('context_snapshots');
    expect(names).toContain('context_items');
    expect(names).toContain('context_provenance');
  });

  it('v1/v2 tables still exist after v3 (additive-only, CP-007)', () => {
    expect(tableNames(db)).toContain('sessions');
    expect(tableNames(db)).toContain('approvals');
    expect(tableNames(db)).toContain('failures');
  });

  it('context_items enforces trust CHECK constraint (CX-003)', () => {
    db.execute(
      `INSERT INTO sessions
         (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
          created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('S2','W','/r','G',1,'RUNNING','t','t','0.3.0',1,'B','L','{}')`,
    );
    db.execute(
      `INSERT INTO context_snapshots
         (snapshot_id, session_id, workspace_revision_id, canonical_form_version,
          token_budget, token_used, built_by, build_reason, policy_version, built_at, schema_version)
       VALUES ('SNAP1','S2','rev-1','v1',8192,100,'planner','initial_plan',1,'t',1)`,
    );
    // Valid trust value.
    expect(() =>
      db.execute(
        `INSERT INTO context_items
           (item_id, snapshot_id, kind, source_kind, content, token_count,
            trust, reason, priority, pinned, truncated)
         VALUES ('I1','SNAP1','file_full','workspace_file','code',50,'untrusted','changed',80,0,0)`,
      ),
    ).not.toThrow();
    // Invalid trust value — must be rejected by CHECK constraint.
    expect(() =>
      db.execute(
        `INSERT INTO context_items
           (item_id, snapshot_id, kind, source_kind, content, token_count,
            trust, reason, priority, pinned, truncated)
         VALUES ('I2','SNAP1','file_full','workspace_file','code',50,'maybe','changed',80,0,0)`,
      ),
    ).toThrow();
  });
});
