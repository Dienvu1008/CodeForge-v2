// State enums for all 10 state machines — STATE_MACHINE_SPEC §2 registry.
// String literal unions (not numeric) so states are readable/loggable/migratable (§23.1).
// SM-1..SM-4, SM-7: enums + terminal sets.

// SM-SESSION §3.1
export type SessionState =
  | 'CREATED'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'AWAITING_HUMAN'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'ABORTED';

// SM-TASK §4.1
export type TaskState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'PASSED'
  | 'FAILED'
  | 'FAILURE_ANALYZED'
  | 'RECOVERY'
  | 'AWAITING_HUMAN'
  | 'SUPERSEDED'
  | 'ABORTED';

// SM-TASK-RUN §5.1
export type TaskRunState =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED';

// SM-GRAPH §6.1
export type GraphState = 'CURRENT' | 'SUPERSEDED' | 'REJECTED';

// SM-TOOLCALL §7.1
export type ToolCallState =
  | 'REQUESTED'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'DENIED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

// SM-APPROVAL §8.1
export type ApprovalState = 'PENDING' | 'GRANTED' | 'DENIED' | 'EXPIRED';

// SM-VERIFICATION §9.1
export type VerificationState = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'INVALID' | 'ERROR';

// SM-RECOVERY §10.1
export type RecoveryState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';

// SM-BUDGET §11.1
export type BudgetState = 'ACTIVE' | 'EXHAUSTED' | 'CLOSED';

// SM-LOCK §12.1
export type LockState = 'ACQUIRING' | 'HELD' | 'STALE' | 'RELEASED';

// Terminal state sets (SM-3, §4.6, §5.x, etc.) — immutable tuples.
export const TERMINAL_SESSION_STATES = ['COMPLETED', 'ABORTED'] as const;
export const TERMINAL_TASK_STATES = ['PASSED', 'SUPERSEDED', 'ABORTED'] as const;
export const TERMINAL_TASK_RUN_STATES = [
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
] as const;
export const TERMINAL_TOOLCALL_STATES = [
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'DENIED',
] as const;
export const TERMINAL_APPROVAL_STATES = ['GRANTED', 'DENIED', 'EXPIRED'] as const;
export const TERMINAL_VERIFICATION_STATES = ['PASS', 'FAIL', 'INVALID', 'ERROR'] as const;
export const TERMINAL_RECOVERY_STATES = ['SUCCEEDED', 'FAILED', 'ABORTED'] as const;

export function isTerminalTaskState(s: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(s);
}
export function isTerminalSessionState(s: SessionState): boolean {
  return (TERMINAL_SESSION_STATES as readonly string[]).includes(s);
}
