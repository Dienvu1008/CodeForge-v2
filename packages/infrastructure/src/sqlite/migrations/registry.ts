// Migration registry + engine — MIGRATION_SPEC §4, §5.4.
//
// Engine flow (§4.1, simplified for v1 single-user/local): DETECT current version
// from PRAGMA user_version → apply each pending migration inside its own transaction
// → bump user_version → RECORD in schema_versions. Idempotent: at-target is a no-op.
// Resumable: user_version only advances after a migration's transaction commits.
import type { DatabaseAdapter } from '../types.js';
import { DbError } from '../errors.js';
import type { Migration, MigrationRegistry, MigrationResult, SchemaVersionRecord } from './types.js';
import { migration0001 } from './0001-initial-schema.js';

/** All migrations, ordered by toVersion. Append new migrations here. */
export const MIGRATIONS: readonly Migration[] = [migration0001];

class DefaultMigrationRegistry implements MigrationRegistry {
  constructor(private readonly migrations: readonly Migration[]) {
    // Validate the chain once at construction: contiguous, no gaps, starts at 0.
    let expected = 0;
    for (const m of migrations) {
      if (m.fromVersion !== expected || m.toVersion !== expected + 1) {
        throw new DbError(
          'DB_UNKNOWN',
          `migration chain broken at ${m.migrationId}: expected ${expected}->${expected + 1}, got ${m.fromVersion}->${m.toVersion}`,
        );
      }
      expected = m.toVersion;
    }
  }

  list(): readonly Migration[] {
    return this.migrations;
  }

  getByToVersion(version: number): Migration | undefined {
    return this.migrations.find((m) => m.toVersion === version);
  }

  path(from: number): readonly Migration[] {
    return this.migrations.filter((m) => m.fromVersion >= from);
  }

  latestVersion(): number {
    return this.migrations.length === 0 ? 0 : (this.migrations[this.migrations.length - 1]?.toVersion ?? 0);
  }
}

export function createMigrationRegistry(
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationRegistry {
  return new DefaultMigrationRegistry(migrations);
}

const SCHEMA_VERSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_versions (
  schema_version   INTEGER PRIMARY KEY,
  applied_at       TEXT NOT NULL,
  runtime_version  TEXT NOT NULL,
  migration_id     TEXT NOT NULL,
  description      TEXT NOT NULL,
  forward_only     INTEGER NOT NULL,
  rollback_to      INTEGER
);
`;

export interface MigrateOptions {
  /** Recorded in schema_versions.runtime_version. */
  readonly runtimeVersion?: string;
  /** ISO timestamp injector for determinism in tests (no wall-clock by default). */
  readonly now?: () => string;
}

/**
 * Bring `db` up to the registry's latest schema version. Runs pending migrations
 * in order, each in its own transaction, recording each in schema_versions and
 * advancing PRAGMA user_version. Returns which migrations were applied.
 */
export function runMigrations(
  db: DatabaseAdapter,
  registry: MigrationRegistry = createMigrationRegistry(),
  options: MigrateOptions = {},
): MigrationResult {
  const runtimeVersion = options.runtimeVersion ?? '0.1.0';
  const now = options.now ?? (() => new Date().toISOString());

  db.exec(SCHEMA_VERSIONS_TABLE);

  const fromVersion = db.getSchemaVersion();
  const target = registry.latestVersion();
  const applied: string[] = [];

  if (fromVersion > target) {
    throw new DbError(
      'DB_UNKNOWN',
      `database schema ${fromVersion} is newer than runtime target ${target}`,
    );
  }

  for (const migration of registry.path(fromVersion)) {
    // Each migration is atomic: DDL + version bump + record in one transaction.
    db.transaction((tx) => {
      migration.apply(db);
      tx.execute(
        `INSERT INTO schema_versions
           (schema_version, applied_at, runtime_version, migration_id, description, forward_only, rollback_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          migration.toVersion,
          now(),
          runtimeVersion,
          migration.migrationId,
          migration.description,
          migration.forwardOnly ? 1 : 0,
          migration.reversible ? migration.fromVersion : null,
        ],
      );
    });
    db.setSchemaVersion(migration.toVersion);
    applied.push(migration.migrationId);
  }

  return { fromVersion, toVersion: db.getSchemaVersion(), applied };
}

/** Read the full schema version history (newest last). */
export function readSchemaHistory(db: DatabaseAdapter): SchemaVersionRecord[] {
  const rows = db.query<{
    schema_version: number;
    applied_at: string;
    runtime_version: string;
    migration_id: string;
    description: string;
    forward_only: number;
    rollback_to: number | null;
  }>('SELECT * FROM schema_versions ORDER BY schema_version ASC');
  return rows.map((r) => ({
    schemaVersion: r.schema_version,
    appliedAt: r.applied_at,
    runtimeVersion: r.runtime_version,
    migrationId: r.migration_id,
    description: r.description,
    forwardOnly: r.forward_only === 1,
    rollbackTo: r.rollback_to,
  }));
}
