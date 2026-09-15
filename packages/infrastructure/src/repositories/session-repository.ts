// SqliteSessionRepository — DOMAIN_CONTRACTS §23.1, RI-1.
//
// Session is a MUTABLE-state aggregate, so update() is allowed (unlike immutable
// entities). Concurrent writers are guarded by an optimistic lock: the `version`
// column is checked-and-bumped in a single UPDATE; a mismatch means another writer
// won → VERSION_CONFLICT.
import type { Session, SessionRepository, SessionMetadata } from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface SessionRow {
  session_id: string;
  workspace_id: string;
  workspace_root: string;
  goal_id: string;
  graph_version: number;
  state: string;
  created_at: string;
  updated_at: string;
  runtime_version: string;
  schema_version: number;
  budget_id: string;
  lock_id: string;
  metadata_json: string;
  version: number;
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(session: Session): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO sessions
           (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
            created_at, updated_at, runtime_version, schema_version, budget_id, lock_id,
            metadata_json, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          session.sessionId,
          session.workspaceId,
          session.workspaceRoot,
          session.goalId,
          session.graphVersion,
          session.state,
          session.createdAt,
          session.updatedAt,
          session.runtimeVersion,
          session.schemaVersion,
          session.budgetId,
          session.lockId,
          JSON.stringify(session.metadata),
        ],
      );
    } catch (err) {
      throw wrapConstraint(err, 'Session', session.sessionId);
    }
  }

  async getById(sessionId: string): Promise<Session | null> {
    const rows = this.db.query<SessionRow>('SELECT * FROM sessions WHERE session_id = ?', [
      sessionId,
    ]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async getActiveByWorkspace(workspaceId: string): Promise<Session | null> {
    // "Active" = not in a terminal state. Deterministic pick: most recent update.
    const rows = this.db.query<SessionRow>(
      `SELECT * FROM sessions
        WHERE workspace_id = ? AND state NOT IN ('COMPLETED','ABORTED')
        ORDER BY updated_at DESC, session_id DESC
        LIMIT 1`,
      [workspaceId],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async update(session: Session): Promise<void> {
    // Optimistic lock: bump version only if the row is still at the version we read.
    // The domain Session type has no `version` field (it's a persistence concern), so
    // we read the current version and check-and-set it here.
    const result = this.db.transaction((tx) => {
      const rows = tx.query<{ version: number }>(
        'SELECT version FROM sessions WHERE session_id = ?',
        [session.sessionId],
      );
      if (rows.length === 0) {
        throw new RepoError('NOT_FOUND', 'Session', session.sessionId);
      }
      const current = rows[0]?.version ?? 0;
      return tx.execute(
        `UPDATE sessions SET
            workspace_id = ?, workspace_root = ?, goal_id = ?, graph_version = ?, state = ?,
            created_at = ?, updated_at = ?, runtime_version = ?, schema_version = ?,
            budget_id = ?, lock_id = ?, metadata_json = ?, version = version + 1
          WHERE session_id = ? AND version = ?`,
        [
          session.workspaceId,
          session.workspaceRoot,
          session.goalId,
          session.graphVersion,
          session.state,
          session.createdAt,
          session.updatedAt,
          session.runtimeVersion,
          session.schemaVersion,
          session.budgetId,
          session.lockId,
          JSON.stringify(session.metadata),
          session.sessionId,
          current,
        ],
      );
    });
    if (result.changes === 0) {
      throw new RepoError('VERSION_CONFLICT', 'Session', session.sessionId);
    }
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    workspaceRoot: row.workspace_root,
    goalId: row.goal_id,
    graphVersion: row.graph_version,
    state: row.state as Session['state'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeVersion: row.runtime_version,
    schemaVersion: row.schema_version,
    budgetId: row.budget_id,
    lockId: row.lock_id,
    metadata: JSON.parse(row.metadata_json) as SessionMetadata,
  };
}

function wrapConstraint(err: unknown, entity: string, id: string): unknown {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
    return new RepoError('ALREADY_EXISTS', entity, id);
  }
  return err;
}
