/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

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

  /**
   * Crash recovery: release an active lock on this workspace iff it was taken by a process on THIS
   * host whose PID is no longer alive (checked via `isAlive`). A hard crash (SIGKILL, the earlier
   * Electron-ABI exit) leaves the lock row with `released_at IS NULL` forever, wedging the
   * workspace with "already locked". We never reclaim a lock from a LIVE process or a different
   * host — only a provably-dead owner on the same machine. Returns true when a stale lock was
   * reclaimed. Marks it RELEASED (never deletes) so the audit trail is preserved.
   */
  async reclaimStale(
    workspaceId: string,
    thisHostname: string,
    isAlive: (pid: number) => boolean,
    at: string,
  ): Promise<boolean> {
    return this.db.transaction((tx): boolean => {
      const rows = tx.query<LockRow>(
        'SELECT * FROM locks WHERE workspace_id = ? AND released_at IS NULL LIMIT 1',
        [workspaceId],
      );
      const row = rows[0];
      if (row === undefined) return false;                 // nothing held
      if (row.hostname !== thisHostname) return false;      // different machine — leave it
      if (isAlive(row.process_id)) return false;            // owner still running — not stale
      tx.execute(
        "UPDATE locks SET state = 'RELEASED', released_at = ? WHERE lock_id = ?",
        [at, row.lock_id],
      );
      return true;
    });
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
