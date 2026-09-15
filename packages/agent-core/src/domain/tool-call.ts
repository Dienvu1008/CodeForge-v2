// ToolCall & Approval — DOMAIN_CONTRACTS §12, §13.
import type { ToolCallState } from '../state-machine/states.js';
import type { Provenance } from './provenance.js';

export type RiskClass =
  | 'READ_ONLY'
  | 'LOW_RISK'
  | 'MODIFY_WORKSPACE'
  | 'NETWORK'
  | 'PACKAGE_INSTALL'
  | 'SYSTEM'
  | 'DESTRUCTIVE'
  | 'PRIVILEGED';

export interface ToolResult {
  readonly exitCode?: number;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly durationMs?: number;
}

export interface Approval {
  readonly approvalId: string; // ULID
  readonly toolCallId: string;

  readonly binding: {
    readonly argumentsHash: string;
    readonly toolPolicyVersion: number;
  };

  readonly decision: 'APPROVED' | 'DENIED';
  readonly decidedBy: 'user' | 'policy';

  readonly reason?: string;
  readonly decidedAt: string;

  readonly expiresAt?: string;
}

export interface ToolCall {
  readonly toolCallId: string; // ULID
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskRunId?: string;

  readonly toolName: string;
  readonly toolVersion: string;
  readonly riskClass: RiskClass;

  readonly arguments: unknown;
  readonly argumentsHash: string; // canonical hash

  readonly idempotencyKey?: string;

  readonly state: ToolCallState;

  readonly approval?: Approval;
  readonly result?: ToolResult;

  readonly proposedBy: 'model' | 'runtime';
  readonly provenance: Provenance;

  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}
