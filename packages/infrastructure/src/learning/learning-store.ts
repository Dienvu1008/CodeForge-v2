// SqliteLearningStore — P11.2. Persistence for lessons (schema v6).
//
// Append-only (LE-005): insert only, no update/delete in the contract. Query ordering is
// deterministic: recency desc, then lessonId asc as a stable tiebreaker. Parameterized
// queries only (SE-008). Retention/eviction is NOT here — it is a LessonWriter concern
// (LE-006). Mirrors SqliteMemoryStore (Phase 7) exactly.
import type {
  LearningStore,
  Lesson,
  LessonQuery,
  LessonKind,
  LessonScope,
  LessonPayload,
  Provenance,
} from '@codeforge/agent-core';
import type { DatabaseAdapter, SqlParam } from '../sqlite/types.js';
import { RepoError } from '../repositories/errors.js';

interface LessonRow {
  lesson_id:       string;
  kind:            string;
  scope:           string;
  lesson_key:      string;
  payload_json:    string;
  provenance_json: string;
  created_at:      string;
}

export class SqliteLearningStore implements LearningStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async insert(lesson: Lesson): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO learning_lessons
           (lesson_id, kind, scope, lesson_key, payload_json, provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          lesson.lessonId,
          lesson.kind,
          lesson.scope,
          lesson.key,
          JSON.stringify(lesson.payload),
          JSON.stringify(lesson.provenance),
          lesson.createdAt,
        ],
      );
    } catch (err) {
      throw wrapConstraint(err, lesson.lessonId);
    }
  }

  async query(query: LessonQuery): Promise<readonly Lesson[]> {
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
    // Deterministic order: recency desc, stable tiebreaker by id asc.
    const rows = this.db.query<LessonRow>(
      `SELECT * FROM learning_lessons ${whereSql}
       ORDER BY created_at DESC, lesson_id ASC`,
      params,
    );

    return rows.map(rowToLesson).slice(0, Math.max(0, query.limit));
  }

  async count(scope: LessonScope, kind: LessonKind): Promise<number> {
    const rows = this.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM learning_lessons WHERE scope = ? AND kind = ?',
      [scope, kind],
    );
    return rows[0]?.n ?? 0;
  }

  async evictOldest(scope: LessonScope, kind: LessonKind, keep: number): Promise<number> {
    const keepN = Math.max(0, Math.floor(keep));
    // Delete every lesson in the bucket EXCEPT the newest `keep`, using the same
    // deterministic order as query(): created_at desc, lesson_id asc.
    const result = this.db.execute(
      `DELETE FROM learning_lessons
         WHERE scope = ? AND kind = ?
           AND lesson_id NOT IN (
             SELECT lesson_id FROM learning_lessons
              WHERE scope = ? AND kind = ?
              ORDER BY created_at DESC, lesson_id ASC
              LIMIT ?
           )`,
      [scope, kind, scope, kind, keepN],
    );
    return result.changes;
  }
}

function rowToLesson(row: LessonRow): Lesson {
  return {
    lessonId:   row.lesson_id,
    kind:       row.kind as LessonKind,
    scope:      row.scope as LessonScope,
    key:        row.lesson_key,
    payload:    JSON.parse(row.payload_json) as LessonPayload,
    provenance: JSON.parse(row.provenance_json) as Provenance,
    createdAt:  row.created_at,
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (
    err && typeof err === 'object' && 'code' in err &&
    (err as { code: unknown }).code === 'DB_CONSTRAINT'
  ) {
    return new RepoError('ALREADY_EXISTS', 'Lesson', id);
  }
  return err;
}
