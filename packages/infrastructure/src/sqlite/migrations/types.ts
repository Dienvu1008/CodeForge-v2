// Migration types — MIGRATION_SPEC §2.2, §4, §5.
import type { DatabaseAdapter } from '../types.js';

/**
 * A single schema migration (MIGRATION_SPEC §5.1). `apply` moves the schema from
 * `fromVersion` to `toVersion`; `rollback` (when reversible) reverses it. Both run
 * inside a transaction owned by the engine. Migrations are pure DDL/data steps —
 * no LLM, no network, deterministic.
 */
export interface Migration {
  readonly migrationId: string; // "0001_create_initial_schema"
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly forwardOnly: boolean;
  readonly reversible: boolean;
  readonly description: string;
  readonly introducedIn: string; // runtime version

  apply(db: DatabaseAdapter): void;
  rollback?(db: DatabaseAdapter): void;
}

/** A row in the schema_versions table (MIGRATION_SPEC §2.2). */
export interface SchemaVersionRecord {
  readonly schemaVersion: number;
  readonly appliedAt: string;
  readonly runtimeVersion: string;
  readonly migrationId: string;
  readonly description: string;
  readonly forwardOnly: boolean;
  readonly rollbackTo: number | null;
}

/** Outcome of running the migration engine. */
export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly string[]; // migrationIds applied, in order
}

/** Lookup + ordering of registered migrations (MIGRATION_SPEC §5.4). */
export interface MigrationRegistry {
  list(): readonly Migration[];
  getByToVersion(version: number): Migration | undefined;
  /** Ordered migrations to move from `from` to the latest version. */
  path(from: number): readonly Migration[];
  /** Highest toVersion in the registry (the target schema version). */
  latestVersion(): number;
}
