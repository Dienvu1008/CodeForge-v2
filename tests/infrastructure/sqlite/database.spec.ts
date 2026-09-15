// P1-F2 SQLite adapter acceptance — INFRASTRUCTURE_SPEC §3, §17.1.
// Cross-platform: runs identically on Windows + Linux (WSL2/ubuntu CI).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabaseAdapter, DbError } from '@codeforge/infrastructure';

let dir: string;
let dbPath: string;
let db: SqliteDatabaseAdapter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf2-sqlite-'));
  dbPath = join(dir, 'test.db');
  db = new SqliteDatabaseAdapter(dbPath);
  db.open();
  db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('SqliteDatabaseAdapter — open/close', () => {
  it('opens a file-backed db and reports isOpen', () => {
    expect(db.isOpen).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('close() is idempotent and flips isOpen', () => {
    db.close();
    expect(db.isOpen).toBe(false);
    expect(() => db.close()).not.toThrow();
  });

  it('operations after close throw DB_NOT_OPEN', () => {
    db.close();
    try {
      db.query('SELECT 1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect((e as DbError).code).toBe('DB_NOT_OPEN');
    }
  });
});

describe('SqliteDatabaseAdapter — WAL mode (§3.6)', () => {
  it('enables WAL journal mode on a file-backed db', () => {
    const rows = db.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode.toLowerCase()).toBe('wal');
  });

  it('enables foreign_keys enforcement', () => {
    const rows = db.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(rows[0]?.foreign_keys).toBe(1);
  });
});

describe('SqliteDatabaseAdapter — transactions (§3.4, CP-001)', () => {
  it('commits when the callback returns', () => {
    db.transaction((tx) => {
      tx.execute('INSERT INTO t (v) VALUES (?)', ['a']);
      tx.execute('INSERT INTO t (v) VALUES (?)', ['b']);
    });
    const rows = db.query<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows[0]?.c).toBe(2);
  });

  it('rolls back atomically when the callback throws', () => {
    expect(() =>
      db.transaction((tx) => {
        tx.execute('INSERT INTO t (v) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const rows = db.query<{ c: number }>('SELECT COUNT(*) AS c FROM t');
    expect(rows[0]?.c).toBe(0); // nothing persisted
  });

  it('rejects nested transactions with DB_NESTED_TRANSACTION', () => {
    try {
      db.transaction(() => {
        db.transaction(() => undefined);
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect((e as DbError).code).toBe('DB_NESTED_TRANSACTION');
    }
    // adapter recovers: a normal transaction still works afterward
    db.transaction((tx) => tx.execute('INSERT INTO t (v) VALUES (?)', ['ok']));
    expect(db.query<{ c: number }>('SELECT COUNT(*) AS c FROM t')[0]?.c).toBe(1);
  });
});

describe('SqliteDatabaseAdapter — parameterized queries (SE-008)', () => {
  it('treats params as data, not SQL (injection is inert)', () => {
    const malicious = "x'); DROP TABLE t; --";
    db.execute('INSERT INTO t (v) VALUES (?)', [malicious]);
    // Table still exists and the value was stored verbatim.
    const rows = db.query<{ v: string }>('SELECT v FROM t WHERE v = ?', [malicious]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.v).toBe(malicious);
  });

  it('maps a constraint violation to DB_CONSTRAINT', () => {
    try {
      db.execute('INSERT INTO t (id, v) VALUES (?, ?)', [1, null as unknown as string]);
      expect.unreachable('NOT NULL should have failed');
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect((e as DbError).code).toBe('DB_CONSTRAINT');
    }
  });
});

describe('SqliteDatabaseAdapter — integrity (§3.7)', () => {
  it('reports ok on a healthy database', () => {
    const report = db.integrityCheck();
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });
});

describe('SqliteDatabaseAdapter — schema version (§3.9)', () => {
  it('round-trips user_version', () => {
    expect(db.getSchemaVersion()).toBe(0);
    db.setSchemaVersion(3);
    expect(db.getSchemaVersion()).toBe(3);
  });

  it('rejects a negative schema version', () => {
    expect(() => db.setSchemaVersion(-1)).toThrow(DbError);
  });
});

describe('SqliteDatabaseAdapter — backup/restore (§3.8)', () => {
  it('backs up (WAL-safe) and restores data', () => {
    db.transaction((tx) => {
      tx.execute('INSERT INTO t (v) VALUES (?)', ['keep-me']);
    });
    const backupPath = join(dir, 'backup', 'snap.db');
    db.backup(backupPath);
    expect(existsSync(backupPath)).toBe(true);

    // Mutate after backup, then restore should discard the mutation.
    db.execute('INSERT INTO t (v) VALUES (?)', ['transient']);
    expect(db.query<{ c: number }>('SELECT COUNT(*) AS c FROM t')[0]?.c).toBe(2);

    db.restore(backupPath);
    const rows = db.query<{ v: string }>('SELECT v FROM t');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.v).toBe('keep-me');
  });
});

describe('SqliteDatabaseAdapter — in-memory', () => {
  it('supports :memory: without touching the filesystem', () => {
    const mem = new SqliteDatabaseAdapter(':memory:');
    mem.open();
    mem.execute('CREATE TABLE m (id INTEGER PRIMARY KEY)');
    mem.execute('INSERT INTO m (id) VALUES (?)', [1]);
    expect(mem.query<{ c: number }>('SELECT COUNT(*) AS c FROM m')[0]?.c).toBe(1);
    mem.close();
  });
});
