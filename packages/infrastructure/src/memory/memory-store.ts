// SqliteMemoryStore — P7-MS1. Persistence for memory records (schema v5).
//
// Append-only (ME-003): insert only, no update/delete in the contract. Query
// ordering is deterministic (ME-004): recency desc, then memoryId asc as a stable
// tiebreaker. Parameterized queries only (SE-008). Retention/eviction is NOT here —
// it is a MemoryWriter concern (ME-006).
import type {
  MemoryStore,
  MemoryRecord,
  MemoryQuery,
  MemoryKind,
  MemoryScope,
  Provenance,
} from '@codeforge/agent-core';
import type { DatabaseAdapter, SqlParam } from '../sqlite/types.js';
import { RepoError } from '../repositories/errors.js';

interface MemoryRow {
  memory_id:       string;
  kind:            string;
  scope:           string;
  content:         string;
  tags_json:       string;
  provenance_json: string;
  created_at:      string;
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async insert(record: MemoryRecord): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO memory_records
           (memory_id, kind, scope, content, tags_json, provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.memoryId,
          record.kind,
          record.scope,
          record.content,
          JSON.stringify(record.tags),
          JSON.stringify(record.provenance),
          record.createdAt,
        ],
      );
    } catch (err) {
      throw wrapConstraint(err, record.memoryId);
    }
  }

  async query(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const where: string[] = [];
    const params: SqlParam[] = [];

    if (query.scope !== undefined) {
      where.push('scope = ?');
      params.push(query.scope);
    }
    if (query.kinds !== undefined && query.kinds.length > 0) {
      where.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
      for (const k of query.kinds) params.push(k);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    // Deterministic order (ME-004): recency desc, stable tiebreaker by id asc.
    const rows = this.db.query<MemoryRow>(
      `SELECT * FROM memory_records ${whereSql}
       ORDER BY created_at DESC, memory_id ASC`,
      params,
    );

    let records = rows.map(rowToRecord);

    // Tag filter applied in-memory: a record matches if it carries ALL query tags.
    // (Kept out of SQL to avoid JSON querying across drivers; the SQL ORDER already
    // fixes a deterministic sequence, so filtering preserves determinism.)
    if (query.tags !== undefined && query.tags.length > 0) {
      const needed = query.tags;
      records = records.filter((r) => needed.every((t) => r.tags.includes(t)));
    }

    return records.slice(0, Math.max(0, query.limit));
  }

  async count(scope: MemoryScope, kind: MemoryKind): Promise<number> {
    const rows = this.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_records WHERE scope = ? AND kind = ?',
      [scope, kind],
    );
    return rows[0]?.n ?? 0;
  }
}

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    memoryId:   row.memory_id,
    kind:       row.kind as MemoryKind,
    scope:      row.scope as MemoryScope,
    content:    row.content,
    tags:       JSON.parse(row.tags_json) as string[],
    provenance: JSON.parse(row.provenance_json) as Provenance,
    createdAt:  row.created_at,
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (
    err && typeof err === 'object' && 'code' in err &&
    (err as { code: unknown }).code === 'DB_CONSTRAINT'
  ) {
    return new RepoError('ALREADY_EXISTS', 'MemoryRecord', id);
  }
  return err;
}
