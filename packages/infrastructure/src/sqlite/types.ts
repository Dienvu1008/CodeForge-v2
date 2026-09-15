// SQLite adapter contract — INFRASTRUCTURE_SPEC §3.2, §3.3.
//
// Driver-agnostic types. The concrete impl (better-sqlite3) lives in database.ts;
// keeping the interface here lets a fallback driver (node:sqlite / sql.js) slot in
// without touching callers. Enforces CP-001 (all mutation via transaction) and
// SE-008 (parameterized queries only).

export interface DbOptions {
  readonly journalMode: 'WAL';
  readonly synchronous: 'NORMAL' | 'FULL';
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly pageSize: number;
  readonly cacheSizeKb: number;
}

// INFRASTRUCTURE_SPEC §3.3
export const DEFAULT_DB_OPTIONS: DbOptions = {
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  foreignKeys: true,
  busyTimeoutMs: 5000,
  pageSize: 4096,
  cacheSizeKb: 65536,
};

/** Result of a non-SELECT statement. */
export interface ExecuteResult {
  /** Rows changed by the statement. */
  readonly changes: number;
  /** ROWID of the last inserted row (0 when not applicable). */
  readonly lastInsertRowid: number;
}

/** A parameter bound into a prepared statement. Never interpolated into SQL. */
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

/**
 * Synchronous transaction handle passed to `transaction(fn)`. It intentionally
 * exposes only query/execute — no nested `transaction()` (§3.4). better-sqlite3
 * is synchronous, so the callback body runs inside a single atomic unit.
 */
export interface Transaction {
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[];
  execute(sql: string, params?: readonly SqlParam[]): ExecuteResult;
}

export interface IntegrityReport {
  readonly ok: boolean;
  /** Raw messages from PRAGMA integrity_check when not ok. */
  readonly problems: readonly string[];
}

/**
 * Operational database adapter. All state mutation goes through `transaction()`
 * (CP-001). Queries are parameterized only (SE-008): callers pass `params`,
 * never build SQL by concatenation.
 */
export interface DatabaseAdapter {
  /** True once open() has succeeded and close() has not run. */
  readonly isOpen: boolean;

  /** Absolute path this adapter is bound to (or ':memory:'). */
  readonly path: string;

  open(): void;
  close(): void;

  /** Run `fn` atomically. Throws DB_NESTED_TRANSACTION if already in one. */
  transaction<T>(fn: (tx: Transaction) => T): T;

  /** Read rows. Parameterized only. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[];

  /** Run a non-SELECT statement. Parameterized only. */
  execute(sql: string, params?: readonly SqlParam[]): ExecuteResult;

  /**
   * Execute a raw multi-statement SQL script (DDL). NO parameters — for
   * adapter/migration-owned schema scripts ONLY, never model-supplied data.
   * Kept separate from execute() so SE-008 (parameterized data queries) stays
   * unambiguous.
   */
  exec(sql: string): void;

  backup(destPath: string): void;
  restore(srcPath: string): void;

  integrityCheck(): IntegrityReport;

  /** Current schema version (PRAGMA user_version). */
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
}
