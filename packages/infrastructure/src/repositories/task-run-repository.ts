// SqliteTaskRunRepository — DOMAIN_CONTRACTS §23.4, RI-4/RI-7.
//
// TaskRun is immutable AFTER finalize. `create` inserts a RUNNING run; `finalize`
// writes the terminal state + end revision/verification exactly once. A second
// finalize on an already-ended run is an IMMUTABLE_VIOLATION (EX-001).
import type {
  TaskRun,
  TaskRunRepository,
  TaskRunPatch,
  TaskStrategy,
  WorkspaceRevision,
  BudgetConsumption,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface TaskRunRow {
  task_run_id: string;
  task_id: string;
  session_id: string;
  attempt_number: number;
  state: string;
  graph_version_at_start: number;
  workspace_revision_start_json: string;
  workspace_revision_end_json: string | null;
  strategy_used_json: string;
  context_snapshot_id: string | null;
  started_at: string;
  ended_at: string | null;
  tool_calls_json: string;
  failures_json: string;
  verification_id: string | null;
  budget_consumed_json: string;
  schema_version: number;
}

const TERMINAL_RUN_STATES = ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED'];

export class SqliteTaskRunRepository implements TaskRunRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly schemaVersion = 1,
  ) {}

  async create(run: TaskRun): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO task_runs
           (task_run_id, task_id, session_id, attempt_number, state, graph_version_at_start,
            workspace_revision_start_json, workspace_revision_end_json, strategy_used_json,
            context_snapshot_id, started_at, ended_at, tool_calls_json, failures_json,
            verification_id, budget_consumed_json, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.taskRunId,
          run.taskId,
          run.sessionId,
          run.attemptNumber,
          run.state,
          run.graphVersionAtStart,
          JSON.stringify(run.workspaceRevisionAtStart),
          run.workspaceRevisionAtEnd === undefined
            ? null
            : JSON.stringify(run.workspaceRevisionAtEnd),
          JSON.stringify(run.strategyUsed),
          run.contextSnapshotId ?? null,
          run.startedAt,
          run.endedAt ?? null,
          JSON.stringify(run.toolCalls),
          JSON.stringify(run.failures),
          run.verificationId ?? null,
          JSON.stringify(run.budgetConsumed),
          this.schemaVersion,
        ],
      );
    } catch (err) {
      throw wrapConstraint(err, run.taskRunId);
    }
  }

  async getById(runId: string): Promise<TaskRun | null> {
    const rows = this.db.query<TaskRunRow>('SELECT * FROM task_runs WHERE task_run_id = ?', [
      runId,
    ]);
    return rows[0] ? rowToRun(rows[0]) : null;
  }

  async finalize(runId: string, patch: TaskRunPatch): Promise<void> {
    this.db.transaction((tx) => {
      const rows = tx.query<{ state: string }>('SELECT state FROM task_runs WHERE task_run_id = ?', [
        runId,
      ]);
      if (rows.length === 0) {
        throw new RepoError('NOT_FOUND', 'TaskRun', runId);
      }
      const current = rows[0]?.state ?? '';
      if (TERMINAL_RUN_STATES.includes(current)) {
        // Already finalized — immutable after finalize (EX-001).
        throw new RepoError('IMMUTABLE_VIOLATION', 'TaskRun', runId, 'run already finalized');
      }
      tx.execute(
        `UPDATE task_runs SET
            state = ?, ended_at = ?, workspace_revision_end_json = ?, verification_id = ?
          WHERE task_run_id = ?`,
        [
          patch.state,
          patch.endedAt,
          patch.workspaceRevisionAtEnd === undefined
            ? null
            : JSON.stringify(patch.workspaceRevisionAtEnd),
          patch.verificationId ?? null,
          runId,
        ],
      );
    });
  }
}

function rowToRun(row: TaskRunRow): TaskRun {
  return {
    taskRunId: row.task_run_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    attemptNumber: row.attempt_number,
    state: row.state as TaskRun['state'],
    graphVersionAtStart: row.graph_version_at_start,
    workspaceRevisionAtStart: JSON.parse(row.workspace_revision_start_json) as WorkspaceRevision,
    ...(row.workspace_revision_end_json === null
      ? {}
      : {
          workspaceRevisionAtEnd: JSON.parse(
            row.workspace_revision_end_json,
          ) as WorkspaceRevision,
        }),
    strategyUsed: JSON.parse(row.strategy_used_json) as TaskStrategy,
    ...(row.context_snapshot_id === null ? {} : { contextSnapshotId: row.context_snapshot_id }),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    toolCalls: JSON.parse(row.tool_calls_json) as string[],
    failures: JSON.parse(row.failures_json) as string[],
    ...(row.verification_id === null ? {} : { verificationId: row.verification_id }),
    budgetConsumed: JSON.parse(row.budget_consumed_json) as BudgetConsumption,
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
    return new RepoError('ALREADY_EXISTS', 'TaskRun', id);
  }
  return err;
}
