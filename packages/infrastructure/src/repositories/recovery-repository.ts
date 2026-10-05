// SqliteFailureRepository + SqliteRecoveryActionRepository — P5-FA1/RE1.
// failures and recovery_actions tables (schema migration v2).
import type { Failure, RecoveryAction } from '@codeforge/agent-core';
import type { FailureRepository, RecoveryActionRepository } from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';

// ── SqliteFailureRepository ───────────────────────────────────────────────────

export class SqliteFailureRepository implements FailureRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(f: Failure): Promise<void> {
    this.db.execute(
      `INSERT INTO failures
         (failure_id, session_id, task_id, task_run_id, stage, class, signature,
          evidence_json, detected_at, classified_by, recovery_action_ids_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        f.failureId, f.sessionId, f.taskId, f.taskRunId,
        f.stage, f.class, f.signature,
        JSON.stringify(f.evidence),
        f.detectedAt, f.classifiedBy,
        JSON.stringify(f.recoveryActionIds),
      ],
    );
  }

  async getById(failureId: string): Promise<Failure | null> {
    const rows = this.db.query<Row>(
      'SELECT * FROM failures WHERE failure_id = ?', [failureId],
    );
    return rows.length === 0 ? null : rowToFailure(rows[0]!);
  }

  async getByTask(taskId: string): Promise<readonly Failure[]> {
    return this.db.query<Row>('SELECT * FROM failures WHERE task_id = ? ORDER BY detected_at ASC', [taskId]).map(rowToFailure);
  }

  async getBySession(sessionId: string): Promise<readonly Failure[]> {
    return this.db.query<Row>('SELECT * FROM failures WHERE session_id = ? ORDER BY detected_at ASC', [sessionId]).map(rowToFailure);
  }
}

interface Row {
  failure_id: string; session_id: string; task_id: string; task_run_id: string;
  stage: string; class: string; signature: string;
  evidence_json: string; detected_at: string; classified_by: string;
  recovery_action_ids_json: string;
}

function rowToFailure(r: Row): Failure {
  return {
    failureId:         r.failure_id,
    sessionId:         r.session_id,
    taskId:            r.task_id,
    taskRunId:         r.task_run_id,
    stage:             r.stage as Failure['stage'],
    class:             r.class as Failure['class'],
    signature:         r.signature,
    evidence:          JSON.parse(r.evidence_json) as Failure['evidence'],
    detectedAt:        r.detected_at,
    classifiedBy:      r.classified_by as Failure['classifiedBy'],
    recoveryActionIds: JSON.parse(r.recovery_action_ids_json) as string[],
  };
}

// ── SqliteRecoveryActionRepository ───────────────────────────────────────────

export class SqliteRecoveryActionRepository implements RecoveryActionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(a: RecoveryAction): Promise<void> {
    this.db.execute(
      `INSERT INTO recovery_actions
         (action_id, failure_id, action, reason, policy_version,
          budget_consumed_json, started_at, ended_at, outcome)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        a.actionId, a.failureId, a.action, a.reason, a.policyVersion,
        JSON.stringify(a.budgetConsumed),
        a.startedAt,
        a.endedAt ?? null,
        a.outcome,
      ],
    );
  }

  async getById(actionId: string): Promise<RecoveryAction | null> {
    const rows = this.db.query<ARow>('SELECT * FROM recovery_actions WHERE action_id = ?', [actionId]);
    return rows.length === 0 ? null : rowToAction(rows[0]!);
  }

  async getByFailure(failureId: string): Promise<readonly RecoveryAction[]> {
    return this.db.query<ARow>('SELECT * FROM recovery_actions WHERE failure_id = ? ORDER BY started_at ASC', [failureId]).map(rowToAction);
  }

  async setOutcome(actionId: string, outcome: RecoveryAction['outcome'], endedAt: string): Promise<void> {
    this.db.execute('UPDATE recovery_actions SET outcome = ?, ended_at = ? WHERE action_id = ?', [outcome, endedAt, actionId]);
  }
}

interface ARow {
  action_id: string; failure_id: string; action: string; reason: string;
  policy_version: number; budget_consumed_json: string;
  started_at: string; ended_at: string | null; outcome: string;
}

function rowToAction(r: ARow): RecoveryAction {
  return {
    actionId:       r.action_id,
    failureId:      r.failure_id,
    action:         r.action as RecoveryAction['action'],
    reason:         r.reason,
    policyVersion:  r.policy_version,
    budgetConsumed: JSON.parse(r.budget_consumed_json) as RecoveryAction['budgetConsumed'],
    startedAt:      r.started_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
    outcome:        r.outcome as RecoveryAction['outcome'],
  };
}