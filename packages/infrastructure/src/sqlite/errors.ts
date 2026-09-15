// SQLite error mapping — INFRASTRUCTURE_SPEC §3.11.
// Native SQLITE_* codes are mapped to stable domain error codes so the rest of
// the runtime never depends on the driver's error shape (DC-002 spirit).

export type DbErrorCode =
  | 'DB_BUSY' // SQLITE_BUSY — lock contention, retryable
  | 'DB_CORRUPT' // SQLITE_CORRUPT — needs backup/restore, NOT auto-recovered (§3.7)
  | 'DB_CONSTRAINT' // SQLITE_CONSTRAINT — integrity/unique/fk violation
  | 'DB_FULL' // SQLITE_FULL — disk/db full
  | 'DB_READONLY' // SQLITE_READONLY — write to read-only db
  | 'DB_NESTED_TRANSACTION' // caller tried to open a transaction inside a transaction (§3.4)
  | 'DB_NOT_OPEN' // operation before open() / after close()
  | 'DB_INTEGRITY_FAILED' // PRAGMA integrity_check did not return "ok"
  | 'DB_UNKNOWN'; // anything unmapped

export class DbError extends Error {
  public readonly code: DbErrorCode;
  /** The original driver error, kept for diagnostics (never surfaced to models). */
  public override readonly cause?: unknown;

  constructor(code: DbErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.name = 'DbError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Map a native better-sqlite3 error to a domain DbError.
 *
 * better-sqlite3 throws `SqliteError` with a `.code` like "SQLITE_BUSY" and a
 * broader `.code` family (e.g. "SQLITE_CONSTRAINT_UNIQUE"). We match by prefix
 * so subtype codes fold into their family.
 */
export function mapSqliteError(err: unknown): DbError {
  if (err instanceof DbError) {
    return err;
  }
  const code = extractCode(err);
  const message = err instanceof Error ? err.message : String(err);
  if (code) {
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      return new DbError('DB_BUSY', message, err);
    }
    if (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) {
      return new DbError('DB_CORRUPT', message, err);
    }
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      return new DbError('DB_CONSTRAINT', message, err);
    }
    if (code.startsWith('SQLITE_FULL')) {
      return new DbError('DB_FULL', message, err);
    }
    if (code.startsWith('SQLITE_READONLY')) {
      return new DbError('DB_READONLY', message, err);
    }
  }
  return new DbError('DB_UNKNOWN', message, err);
}

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}
