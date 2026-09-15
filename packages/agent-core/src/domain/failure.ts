// Failure & RecoveryAction — DOMAIN_CONTRACTS §10, §11.

export type FailureClass =
  | 'TRANSIENT'
  | 'DEPENDENCY'
  | 'SYNTAX'
  | 'LOGIC'
  | 'ENVIRONMENT'
  | 'TOOL'
  | 'PERMISSION'
  | 'TIMEOUT'
  | 'CONTEXT'
  | 'BUDGET_EXHAUSTED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_TOOL_CALL_INVALID'
  | 'UNKNOWN';

export type FailureStage = 'plan' | 'execute' | 'verify' | 'recover';

export interface FailureEvidence {
  readonly message: string;
  readonly stackTrace?: string;
  readonly exitCode?: number;
  readonly stderrArtifactId?: string;
  readonly contextSnapshotId?: string;
}

export interface Failure {
  readonly failureId: string; // ULID
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskRunId: string;

  readonly stage: FailureStage;
  readonly class: FailureClass;
  readonly signature: string; // normalized hash

  readonly evidence: FailureEvidence;
  readonly detectedAt: string;

  readonly classifiedBy: 'deterministic' | 'analyzer';

  readonly recoveryActionIds: readonly string[];
}

export type RecoveryKind =
  | 'RETRY'
  | 'FIX'
  | 'SPLIT'
  | 'REPLACE'
  | 'ROLLBACK'
  | 'REPLAN'
  | 'ESCALATE'
  | 'ABORT';

export type RecoveryOutcome = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';

export interface RecoveryAction {
  readonly actionId: string; // ULID
  readonly failureId: string;

  readonly action: RecoveryKind;
  readonly reason: string;

  readonly policyVersion: number;
  readonly budgetConsumed: import('./budget.js').BudgetConsumption;

  readonly startedAt: string;
  readonly endedAt?: string;

  readonly outcome: RecoveryOutcome;
  readonly nextFailureId?: string;
}
