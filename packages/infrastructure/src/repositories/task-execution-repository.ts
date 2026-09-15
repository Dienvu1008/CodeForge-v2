// SqliteTaskExecutionRepository — DOMAIN_CONTRACTS §5, EX-003.
//
// TaskExecution is a projection (EX-003: not authority). `upsert` replaces the row
// for a taskId. The `version` column advances each write (diagnostic optimistic-lock
// counter); the projection itself is always re-derivable from TaskRun history.
import type { TaskExecution, TaskExecutionRepository } from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';

interface ExecRow {
  task_id: string;
  current_state: string;
  current_run_id: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  latest_verification_id: string | null;
  latest_failure_id: string | null;
  version: number;
}

export class SqliteTaskExecutionRepository implements TaskExecutionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async upsert(execution: TaskExecution): Promise<void> {
    this.db.transaction((tx) => {
      const existing = tx.query<{ version: number }>(
        'SELECT version FROM task_executions WHERE task_id = ?',
        [execution.taskId],
      );
      if (existing.length === 0) {
        tx.execute(
          `INSERT INTO task_executions
             (task_id, current_state, current_run_id, attempts, created_at, updated_at,
              latest_verification_id, latest_failure_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            execution.taskId,
            execution.currentState,
            execution.currentRunId ?? null,
            execution.attempts,
            execution.createdAt,
            execution.updatedAt,
            execution.latestVerificationId ?? null,
            execution.latestFailureId ?? null,
          ],
        );
      } else {
        tx.execute(
          `UPDATE task_executions SET
              current_state = ?, current_run_id = ?, attempts = ?, updated_at = ?,
              latest_verification_id = ?, latest_failure_id = ?, version = version + 1
            WHERE task_id = ?`,
          [
            execution.currentState,
            execution.currentRunId ?? null,
            execution.attempts,
            execution.updatedAt,
            execution.latestVerificationId ?? null,
            execution.latestFailureId ?? null,
            execution.taskId,
          ],
        );
      }
    });
  }

  async getByTask(taskId: string): Promise<TaskExecution | null> {
    const rows = this.db.query<ExecRow>('SELECT * FROM task_executions WHERE task_id = ?', [
      taskId,
    ]);
    return rows[0] ? rowToExecution(rows[0]) : null;
  }
}

function rowToExecution(row: ExecRow): TaskExecution {
  return {
    taskId: row.task_id,
    currentState: row.current_state as TaskExecution['currentState'],
    ...(row.current_run_id === null ? {} : { currentRunId: row.current_run_id }),
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.latest_verification_id === null
      ? {}
      : { latestVerificationId: row.latest_verification_id }),
    ...(row.latest_failure_id === null ? {} : { latestFailureId: row.latest_failure_id }),
  };
}
