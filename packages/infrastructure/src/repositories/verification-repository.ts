// SqliteVerificationRepository — DOMAIN_CONTRACTS §23.5, RI-5.
//
// VerificationReport is append-only (VR-006): create + read only, no update/delete.
import type {
  VerificationReport,
  VerificationRepository,
  VerificationCheck,
  InvariantCheck,
  WorkspaceRevision,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface VerifRow {
  verification_id: string;
  session_id: string;
  task_id: string;
  task_run_id: string;
  target_revision_json: string;
  canonical_form_version: string;
  scope: string;
  checks_json: string;
  status: string;
  started_at: string;
  ended_at: string;
  tool_versions_json: string;
  artifacts_json: string;
  invariants_json: string;
  schema_version: number;
}

export class SqliteVerificationRepository implements VerificationRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(report: VerificationReport): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO verification_reports
           (verification_id, session_id, task_id, task_run_id, target_revision_json,
            canonical_form_version, scope, checks_json, status, started_at, ended_at,
            tool_versions_json, artifacts_json, invariants_json, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          report.verificationId,
          report.sessionId,
          report.taskId,
          report.taskRunId,
          JSON.stringify(report.targetWorkspaceRevision),
          report.canonicalFormVersion,
          report.scope,
          JSON.stringify(report.checks),
          report.status,
          report.startedAt,
          report.endedAt,
          JSON.stringify(report.toolVersions),
          JSON.stringify(report.artifacts),
          JSON.stringify(report.invariantsChecked),
          report.schemaVersion,
        ],
      );
    } catch (err) {
      throw wrapConstraint(err, report.verificationId);
    }
  }

  async getById(id: string): Promise<VerificationReport | null> {
    const rows = this.db.query<VerifRow>(
      'SELECT * FROM verification_reports WHERE verification_id = ?',
      [id],
    );
    return rows[0] ? rowToReport(rows[0]) : null;
  }

  async getByTask(taskId: string): Promise<readonly VerificationReport[]> {
    const rows = this.db.query<VerifRow>(
      'SELECT * FROM verification_reports WHERE task_id = ? ORDER BY started_at ASC, verification_id ASC',
      [taskId],
    );
    return rows.map(rowToReport);
  }

  async getLatestForRevision(revisionId: string): Promise<VerificationReport | null> {
    // The target revision is stored as JSON; filter in memory (v1 volumes are small,
    // single-session). Deterministic: newest by endedAt then id.
    const rows = this.db.query<VerifRow>(
      'SELECT * FROM verification_reports ORDER BY ended_at DESC, verification_id DESC',
    );
    for (const row of rows) {
      const rev = JSON.parse(row.target_revision_json) as WorkspaceRevision;
      if (rev.revisionId === revisionId) {
        return rowToReport(row);
      }
    }
    return null;
  }
}

function rowToReport(row: VerifRow): VerificationReport {
  return {
    verificationId: row.verification_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskRunId: row.task_run_id,
    targetWorkspaceRevision: JSON.parse(row.target_revision_json) as WorkspaceRevision,
    canonicalFormVersion: row.canonical_form_version,
    scope: row.scope as VerificationReport['scope'],
    checks: JSON.parse(row.checks_json) as VerificationCheck[],
    status: row.status as VerificationReport['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    toolVersions: JSON.parse(row.tool_versions_json) as Readonly<Record<string, string>>,
    artifacts: JSON.parse(row.artifacts_json) as string[],
    invariantsChecked: JSON.parse(row.invariants_json) as InvariantCheck[],
    schemaVersion: row.schema_version,
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
    return new RepoError('ALREADY_EXISTS', 'VerificationReport', id);
  }
  return err;
}
