// SqliteToolCallRepository + SqliteApprovalRepository — DOMAIN_CONTRACTS §12, §13.
// schema v1 table: tool_calls (forward-designed in Phase 1).
// schema v2 table: approvals (P1.5-DB2).
import type {
  ToolCall,
  Approval,
  ToolResult,
  RiskClass,
  Provenance,
} from '@codeforge/agent-core';
import type {
  ToolCallRepository,
  ToolCallPatch,
  ApprovalRepository,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

// ── ToolCall row shape ────────────────────────────────────────────────────────

interface ToolCallRow {
  tool_call_id: string;
  session_id: string;
  task_id: string | null;
  task_run_id: string | null;
  tool_name: string;
  tool_version: string;
  risk_class: string;
  arguments_json: string;
  arguments_hash: string;
  idempotency_key: string | null;
  state: string;
  approval_json: string | null;
  result_json: string | null;
  proposed_by: string;
  provenance_json: string;
  requested_at: string;
  started_at: string | null;
  ended_at: string | null;
  schema_version: number;
}

function rowToCall(row: ToolCallRow): ToolCall {
  return {
    toolCallId: row.tool_call_id,
    sessionId: row.session_id,
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.task_run_id !== null ? { taskRunId: row.task_run_id } : {}),
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    riskClass: row.risk_class as RiskClass,
    arguments: JSON.parse(row.arguments_json) as unknown,
    argumentsHash: row.arguments_hash,
    ...(row.idempotency_key !== null ? { idempotencyKey: row.idempotency_key } : {}),
    state: row.state as ToolCall['state'],
    ...(row.approval_json !== null
      ? { approval: JSON.parse(row.approval_json) as Approval }
      : {}),
    ...(row.result_json !== null
      ? { result: JSON.parse(row.result_json) as ToolResult }
      : {}),
    proposedBy: row.proposed_by as ToolCall['proposedBy'],
    provenance: JSON.parse(row.provenance_json) as Provenance,
    requestedAt: row.requested_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}

// ── SqliteToolCallRepository ──────────────────────────────────────────────────

export class SqliteToolCallRepository implements ToolCallRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly schemaVersion = 1,
  ) {}

  async create(call: ToolCall): Promise<void> {
    try {
      this.db.execute(
        `INSERT INTO tool_calls
           (tool_call_id, session_id, task_id, task_run_id, tool_name, tool_version,
            risk_class, arguments_json, arguments_hash, idempotency_key, state,
            approval_json, result_json, proposed_by, provenance_json,
            requested_at, started_at, ended_at, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          call.toolCallId,
          call.sessionId,
          call.taskId ?? null,
          call.taskRunId ?? null,
          call.toolName,
          call.toolVersion,
          call.riskClass,
          JSON.stringify(call.arguments),
          call.argumentsHash,
          call.idempotencyKey ?? null,
          call.state,
          call.approval !== undefined ? JSON.stringify(call.approval) : null,
          call.result !== undefined ? JSON.stringify(call.result) : null,
          call.proposedBy,
          JSON.stringify(call.provenance),
          call.requestedAt,
          call.startedAt ?? null,
          call.endedAt ?? null,
          this.schemaVersion,
        ],
      );
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: unknown }).code === 'DB_CONSTRAINT'
      ) {
        throw new RepoError('ALREADY_EXISTS', 'ToolCall', call.toolCallId);
      }
      throw err;
    }
  }

  async getById(toolCallId: string): Promise<ToolCall | null> {
    const rows = this.db.query<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE tool_call_id = ?',
      [toolCallId],
    );
    return rows[0] ? rowToCall(rows[0]) : null;
  }

  async transition(toolCallId: string, patch: ToolCallPatch): Promise<void> {
    this.db.transaction((tx) => {
      const rows = tx.query<{ state: string }>(
        'SELECT state FROM tool_calls WHERE tool_call_id = ?',
        [toolCallId],
      );
      if (rows.length === 0) {
        throw new RepoError('NOT_FOUND', 'ToolCall', toolCallId);
      }
      tx.execute(
        `UPDATE tool_calls SET
           state = ?,
           started_at = COALESCE(?, started_at),
           ended_at = COALESCE(?, ended_at),
           approval_json = COALESCE(?, approval_json),
           result_json = COALESCE(?, result_json)
         WHERE tool_call_id = ?`,
        [
          patch.state,
          patch.startedAt ?? null,
          patch.endedAt ?? null,
          patch.approval !== undefined ? JSON.stringify(patch.approval) : null,
          patch.result !== undefined ? JSON.stringify(patch.result) : null,
          toolCallId,
        ],
      );
    });
  }
}

// ── Approval row shape ────────────────────────────────────────────────────────

interface ApprovalRow {
  approval_id: string;
  tool_call_id: string;
  arguments_hash: string;
  tool_policy_version: number;
  decision: string;
  decided_by: string;
  reason: string | null;
  decided_at: string;
  expires_at: string | null;
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    approvalId: row.approval_id,
    toolCallId: row.tool_call_id,
    binding: {
      argumentsHash: row.arguments_hash,
      toolPolicyVersion: row.tool_policy_version,
    },
    decision: row.decision as Approval['decision'],
    decidedBy: row.decided_by as Approval['decidedBy'],
    ...(row.reason !== null ? { reason: row.reason } : {}),
    decidedAt: row.decided_at,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  };
}

// ── SqliteApprovalRepository ──────────────────────────────────────────────────

export class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(approval: Approval): Promise<void> {
    this.db.execute(
      `INSERT INTO approvals
         (approval_id, tool_call_id, arguments_hash, tool_policy_version,
          decision, decided_by, reason, decided_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        approval.approvalId,
        approval.toolCallId,
        approval.binding.argumentsHash,
        approval.binding.toolPolicyVersion,
        approval.decision,
        approval.decidedBy,
        approval.reason ?? null,
        approval.decidedAt,
        approval.expiresAt ?? null,
      ],
    );
  }

  async getByToolCall(toolCallId: string): Promise<Approval | null> {
    // Return the latest approval for this call (most recent decidedAt).
    const rows = this.db.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE tool_call_id = ? ORDER BY decided_at DESC LIMIT 1',
      [toolCallId],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }
}
