// SqliteDatabaseAdapter — INFRASTRUCTURE_SPEC §3, backed by better-sqlite3.
//
// Deviation from spec §3.2 (documented): the interface is SYNCHRONOUS, not
// Promise-based. better-sqlite3 is a synchronous driver; wrapping it in fake
// Promises would add no concurrency (SQLite serializes writes anyway) and would
// only obscure error stacks. Callers that need async can await a resolved value.
//
// Enforces:
//   - CP-001: every mutation runs inside transaction() (callers' responsibility;
//     the adapter provides the atomic unit + rejects nesting §3.4).
//   - SE-008: query/execute are parameterized only — SQL text and bound params
//     are separate arguments; nothing interpolates model data into SQL.
//   - §3.6 WAL, §3.3 default pragmas, §3.10 file permissions (0600/0700 best-effort).

import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterDatabase } from 'better-sqlite3';
import {
  DEFAULT_DB_OPTIONS,
  type DatabaseAdapter,
  type DbOptions,
  type ExecuteResult,
  type IntegrityReport,
  type SqlParam,
  type Transaction,
} from './types.js';
import { DbError, mapSqliteError } from './errors.js';

const MEMORY = ':memory:';

export class SqliteDatabaseAdapter implements DatabaseAdapter {
  public readonly path: string;
  private readonly options: DbOptions;
  private db: BetterDatabase | undefined;
  private inTransaction = false;

  constructor(path: string, options: Partial<DbOptions> = {}) {
    this.path = path;
    this.options = { ...DEFAULT_DB_OPTIONS, ...options };
  }

  get isOpen(): boolean {
    return this.db !== undefined && this.db.open;
  }

  open(): void {
    if (this.isOpen) {
      return;
    }
    if (this.path !== MEMORY) {
      const dir = dirname(this.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
    try {
      const db = new Database(this.path);
      // Order matters: set page_size before WAL takes effect on a fresh db.
      db.pragma(`page_size = ${this.options.pageSize}`);
      db.pragma(`journal_mode = ${this.options.journalMode}`);
      db.pragma(`synchronous = ${this.options.synchronous}`);
      db.pragma(`foreign_keys = ${this.options.foreignKeys ? 'ON' : 'OFF'}`);
      db.pragma(`busy_timeout = ${this.options.busyTimeoutMs}`);
      db.pragma(`cache_size = ${-this.options.cacheSizeKb}`); // negative = KiB
      db.pragma('wal_autocheckpoint = 1000'); // §3.6
      this.db = db;
    } catch (err) {
      throw mapSqliteError(err);
    }
    // §3.10 — restrict the db file to the owner. Best-effort on Windows
    // (chmod is largely a no-op on NTFS but harmless).
    if (this.path !== MEMORY) {
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* non-fatal: permissions are advisory on some platforms */
      }
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        throw mapSqliteError(err);
      }
      this.db = undefined;
    }
  }

  transaction<T>(fn: (tx: Transaction) => T): T {
    const db = this.requireDb();
    if (this.inTransaction) {
      // §3.4 — no nested transactions. Callers must compose one atomic unit.
      throw new DbError('DB_NESTED_TRANSACTION', 'nested transaction is not allowed');
    }
    const tx: Transaction = {
      query: (sql, params) => this.runQuery(sql, params),
      execute: (sql, params) => this.runExecute(sql, params),
    };
    const wrapped = db.transaction((): T => fn(tx));
    this.inTransaction = true;
    try {
      return wrapped();
    } catch (err) {
      throw mapSqliteError(err);
    } finally {
      this.inTransaction = false;
    }
  }

  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[] {
    this.requireDb();
    return this.runQuery<T>(sql, params);
  }

  execute(sql: string, params?: readonly SqlParam[]): ExecuteResult {
    this.requireDb();
    return this.runExecute(sql, params);
  }

  exec(sql: string): void {
    const db = this.requireDb();
    try {
      db.exec(sql);
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  backup(destPath: string): void {
    const db = this.requireDb();
    const dir = dirname(destPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      // Synchronous backup via VACUUM INTO — safe with WAL active (§3.8),
      // unlike a raw file copy which would miss the -wal segment.
      db.exec(`VACUUM INTO ${quoteLiteral(destPath)}`);
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  restore(srcPath: string): void {
    if (!existsSync(srcPath)) {
      throw new DbError('DB_UNKNOWN', `backup not found: ${srcPath}`);
    }
    if (this.path === MEMORY) {
      throw new DbError('DB_UNKNOWN', 'cannot restore into an in-memory database');
    }
    // Reopen from the backup file: close, replace bytes, reopen.
    this.close();
    // VACUUM INTO refuses to overwrite an existing file, so remove the current
    // db and its WAL/SHM sidecars before restoring.
    for (const suffix of ['', '-wal', '-shm']) {
      const p = this.path + suffix;
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    }
    try {
      const src = new Database(srcPath, { readonly: true });
      src.exec(`VACUUM INTO ${quoteLiteral(this.path)}`);
      src.close();
    } catch (err) {
      throw mapSqliteError(err);
    }
    this.open();
  }

  integrityCheck(): IntegrityReport {
    const db = this.requireDb();
    try {
      const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const messages = rows.map((r) => r.integrity_check);
      const ok = messages.length === 1 && messages[0] === 'ok';
      return { ok, problems: ok ? [] : messages };
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  getSchemaVersion(): number {
    const db = this.requireDb();
    const v = db.pragma('user_version', { simple: true });
    return typeof v === 'number' ? v : 0;
  }

  setSchemaVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new DbError('DB_UNKNOWN', `invalid schema version: ${version}`);
    }
    const db = this.requireDb();
    // user_version pragma does not accept bound params; version is a validated integer.
    db.pragma(`user_version = ${version}`);
  }

  // ---- internals ----

  private runQuery<T>(sql: string, params?: readonly SqlParam[]): T[] {
    const db = this.requireDb();
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  private runExecute(sql: string, params?: readonly SqlParam[]): ExecuteResult {
    const db = this.requireDb();
    try {
      const stmt = db.prepare(sql);
      const info = stmt.run(...(params ?? []));
      return {
        changes: info.changes,
        lastInsertRowid:
          typeof info.lastInsertRowid === 'bigint'
            ? Number(info.lastInsertRowid)
            : info.lastInsertRowid,
      };
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  private requireDb(): BetterDatabase {
    if (!this.db || !this.db.open) {
      throw new DbError('DB_NOT_OPEN', 'database is not open');
    }
    return this.db;
  }
}

/**
 * Quote a filesystem path as a SQL string literal for PRAGMA-like statements
 * (VACUUM INTO) that cannot take bound parameters. Only used for adapter-owned
 * paths, never for model-supplied data. Doubles embedded single quotes.
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
