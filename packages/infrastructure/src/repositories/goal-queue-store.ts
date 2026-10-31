/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SqliteGoalQueueStore (session-resume v1) — GoalQueueStore over the `goals` table (v1) and the
// `goal_queue` table (migration 0007). Scoped to one workspace id. Every mutation runs inside a
// single db.transaction, so enqueue (goal + queue row) and claimNext (QUEUED → STARTED + sessionId)
// are atomic: a goal is never claimed twice.
import type { Goal, GoalQueueStore } from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { GOAL_INSERT_SQL, goalInsertParams, rowToGoal, type GoalRow } from './goal-repository.js';

interface QueueRow {
  goal_id: string;
  goal_version: number;
  start_revision_hash: string | null;
}

export class SqliteGoalQueueStore implements GoalQueueStore {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly workspaceId: string,
    private readonly schemaVersion = 1,
  ) {}

  enqueue(goal: Goal, at: string): void {
    this.db.transaction((tx) => {
      tx.execute(GOAL_INSERT_SQL, goalInsertParams(goal, this.schemaVersion));
      const max = tx.query<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM goal_queue', []);
      const seq = (max[0]?.seq ?? 0) + 1;
      tx.execute(
        `INSERT INTO goal_queue (goal_id, goal_version, workspace_id, seq, status, enqueued_at)
         VALUES (?, ?, ?, ?, 'QUEUED', ?)`,
        [goal.goalId, goal.version, this.workspaceId, seq, at],
      );
    });
  }

  claimNext(sessionId: string, at: string): Goal | undefined {
    return this.db.transaction((tx): Goal | undefined => {
      const next = tx.query<QueueRow>(
        `SELECT goal_id, goal_version, start_revision_hash FROM goal_queue
          WHERE workspace_id = ? AND status = 'QUEUED' ORDER BY seq ASC LIMIT 1`,
        [this.workspaceId],
      )[0];
      if (next === undefined) return undefined;
      tx.execute(
        `UPDATE goal_queue SET status = 'STARTED', session_id = ?, started_at = ?
          WHERE goal_id = ? AND status = 'QUEUED'`,
        [sessionId, at, next.goal_id],
      );
      const row = tx.query<GoalRow>('SELECT * FROM goals WHERE goal_id = ? AND version = ?', [
        next.goal_id, next.goal_version,
      ])[0];
      return row === undefined ? undefined : rowToGoal(row);
    });
  }

  recordStartRevision(sessionId: string, revisionHash: string): void {
    this.db.execute('UPDATE goal_queue SET start_revision_hash = ? WHERE session_id = ?', [revisionHash, sessionId]);
  }

  getBySession(sessionId: string): { goal: Goal; startRevisionHash?: string } | null {
    const q = this.db.query<QueueRow>(
      'SELECT goal_id, goal_version, start_revision_hash FROM goal_queue WHERE session_id = ? LIMIT 1',
      [sessionId],
    )[0];
    if (q === undefined) return null;
    const row = this.db.query<GoalRow>('SELECT * FROM goals WHERE goal_id = ? AND version = ?', [
      q.goal_id, q.goal_version,
    ])[0];
    if (row === undefined) return null;
    return {
      goal: rowToGoal(row),
      ...(q.start_revision_hash !== null ? { startRevisionHash: q.start_revision_hash } : {}),
    };
  }

  queuedCount(): number {
    const r = this.db.query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM goal_queue WHERE workspace_id = ? AND status = 'QUEUED'",
      [this.workspaceId],
    );
    return r[0]?.c ?? 0;
  }
}