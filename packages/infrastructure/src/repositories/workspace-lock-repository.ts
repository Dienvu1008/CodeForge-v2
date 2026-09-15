// SqliteWorkspaceLockService (P1-S1) — enforces SS-001 (one active session/workspace).
//
// acquire() checks-and-inserts inside a transaction; the partial unique index
// `idx_locks_active_workspace` (locks(workspace_id) WHERE released_at IS NULL) is the
// last-resort guard if two acquires race. release() marks released_at (never deletes).
import type {
  WorkspaceLock,
  WorkspaceLockService,
  AcquireLockRequest,
} from '@codeforge/agent-core';
import { LockError } from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';

interface LockRow {
  lock_id: string;
  workspace_id: string;
  session_id: string;
  state: string;
  hostname: string;
  process_id: number;
  acquired_at: string;
  heartbeat_at: string;
  released_at: string | null;
}

export class SqliteWorkspaceLockService implements WorkspaceLockService {
  constructor(private readonly db: DatabaseAdapter) {}

  async acquire(req: AcquireLockRequest): Promise<WorkspaceLock> {
    return this.db.transaction((tx): WorkspaceLock => {
      const active = tx.query<{ c: number }>(
        'SELECT COUNT(*) AS c FROM locks WHERE workspace_id = ? AND released_at IS NULL',
        [req.workspaceId],
      );
      if ((active[0]?.c ?? 0) > 0) {
        throw new LockError('LOCK_HELD', `workspace ${req.workspaceId} already locked`);
      }
      tx.execute(
        `INSERT INTO locks
           (lock_id, workspace_id, session_id, state, hostname, process_id, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, 'HELD', ?, ?, ?, ?)`,
        [req.lockId, req.workspaceId, req.sessionId, req.hostname, req.processId, req.at, req.at],
      );
      return {
        lockId: req.lockId,
        workspaceId: req.workspaceId,
        sessionId: req.sessionId,
        state: 'HELD',
        hostname: req.hostname,
        processId: req.processId,
        acquiredAt: req.at,
        heartbeatAt: req.at,
      };
    });
  }

  async release(lockId: string, sessionId: string, at: string): Promise<void> {
    this.db.transaction((tx) => {
      const rows = tx.query<{ session_id: string; released_at: string | null }>(
        'SELECT session_id, released_at FROM locks WHERE lock_id = ?',
        [lockId],
      );
      if (rows.length === 0) {
        throw new LockError('LOCK_NOT_FOUND', lockId);
      }
      if (rows[0]?.session_id !== sessionId) {
        throw new LockError('LOCK_NOT_OWNED', `lock ${lockId} not owned by session ${sessionId}`);
      }
      // Idempotent: releasing an already-released lock is a no-op.
      if (rows[0]?.released_at === null) {
        tx.execute("UPDATE locks SET state = 'RELEASED', released_at = ? WHERE lock_id = ?", [
          at,
          lockId,
        ]);
      }
    });
  }

  async getActive(workspaceId: string): Promise<WorkspaceLock | null> {
    const rows = this.db.query<LockRow>(
      'SELECT * FROM locks WHERE workspace_id = ? AND released_at IS NULL LIMIT 1',
      [workspaceId],
    );
    return rows[0] ? rowToLock(rows[0]) : null;
  }
}

function rowToLock(row: LockRow): WorkspaceLock {
  return {
    lockId: row.lock_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    state: row.state as WorkspaceLock['state'],
    hostname: row.hostname,
    processId: row.process_id,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
  };
}
