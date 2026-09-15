// T7 — State machine conformance (SM-1..SM-8). STATE_MACHINE_SPEC §2-§12.
//
// Verifies the exported state unions and terminal sets match the spec registry.
// Compile-time: state literals below must be assignable to the exported unions.
import { describe, it, expect } from 'vitest';
import type {
  SessionState,
  TaskState,
  TaskRunState,
  GraphState,
  ToolCallState,
  ApprovalState,
  VerificationState,
  RecoveryState,
  BudgetState,
  LockState,
  TransitionResult,
} from '@codeforge/agent-core';
import {
  TERMINAL_SESSION_STATES,
  TERMINAL_TASK_STATES,
  TERMINAL_TASK_RUN_STATES,
  TERMINAL_TOOLCALL_STATES,
  TERMINAL_APPROVAL_STATES,
  TERMINAL_VERIFICATION_STATES,
  TERMINAL_RECOVERY_STATES,
  isTerminalTaskState,
  isTerminalSessionState,
} from '@codeforge/agent-core';

// Exhaustive literal lists — TypeScript verifies each is a valid member of its union.
const sessionStates: readonly SessionState[] = [
  'CREATED',
  'INITIALIZING',
  'RUNNING',
  'AWAITING_HUMAN',
  'CANCELLING',
  'COMPLETED',
  'ABORTED',
];
const taskStates: readonly TaskState[] = [
  'PENDING',
  'READY',
  'RUNNING',
  'VERIFYING',
  'PASSED',
  'FAILED',
  'FAILURE_ANALYZED',
  'RECOVERY',
  'AWAITING_HUMAN',
  'SUPERSEDED',
  'ABORTED',
];
const taskRunStates: readonly TaskRunState[] = [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
  'INTERRUPTED',
];
const graphStates: readonly GraphState[] = ['CURRENT', 'SUPERSEDED', 'REJECTED'];
const toolCallStates: readonly ToolCallState[] = [
  'REQUESTED',
  'APPROVAL_PENDING',
  'APPROVED',
  'DENIED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
];
const approvalStates: readonly ApprovalState[] = ['PENDING', 'GRANTED', 'DENIED', 'EXPIRED'];
const verificationStates: readonly VerificationState[] = [
  'PENDING',
  'RUNNING',
  'PASS',
  'FAIL',
  'INVALID',
  'ERROR',
];
const recoveryStates: readonly RecoveryState[] = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'ABORTED',
];
const budgetStates: readonly BudgetState[] = ['ACTIVE', 'EXHAUSTED', 'CLOSED'];
const lockStates: readonly LockState[] = ['ACQUIRING', 'HELD', 'STALE', 'RELEASED'];

describe('state machine conformance (T7 / SM-1..SM-8)', () => {
  it('SM-1: registry has 10 state machines with the expected state counts', () => {
    expect(sessionStates).toHaveLength(7);
    expect(taskStates).toHaveLength(11);
    expect(taskRunStates).toHaveLength(6);
    expect(graphStates).toHaveLength(3);
    expect(toolCallStates).toHaveLength(9);
    expect(approvalStates).toHaveLength(4);
    expect(verificationStates).toHaveLength(6);
    expect(recoveryStates).toHaveLength(5);
    expect(budgetStates).toHaveLength(3);
    expect(lockStates).toHaveLength(4);
  });

  it('SM-3: terminal sets are subsets of their state unions', () => {
    const sub = (terminal: readonly string[], all: readonly string[]) =>
      terminal.every((t) => all.includes(t));
    expect(sub(TERMINAL_SESSION_STATES, sessionStates)).toBe(true);
    expect(sub(TERMINAL_TASK_STATES, taskStates)).toBe(true);
    expect(sub(TERMINAL_TASK_RUN_STATES, taskRunStates)).toBe(true);
    expect(sub(TERMINAL_TOOLCALL_STATES, toolCallStates)).toBe(true);
    expect(sub(TERMINAL_APPROVAL_STATES, approvalStates)).toBe(true);
    expect(sub(TERMINAL_VERIFICATION_STATES, verificationStates)).toBe(true);
    expect(sub(TERMINAL_RECOVERY_STATES, recoveryStates)).toBe(true);
  });

  it('SM-3: task terminal set is exactly {PASSED, SUPERSEDED, ABORTED} (§4.6)', () => {
    expect([...TERMINAL_TASK_STATES].sort()).toEqual(['ABORTED', 'PASSED', 'SUPERSEDED']);
  });

  it('SM-3: session terminal set is exactly {COMPLETED, ABORTED} (§3.x)', () => {
    expect([...TERMINAL_SESSION_STATES].sort()).toEqual(['ABORTED', 'COMPLETED']);
  });

  it('SM-3: terminal predicates agree with the terminal sets', () => {
    for (const s of taskStates) {
      expect(isTerminalTaskState(s)).toBe((TERMINAL_TASK_STATES as readonly string[]).includes(s));
    }
    for (const s of sessionStates) {
      expect(isTerminalSessionState(s)).toBe(
        (TERMINAL_SESSION_STATES as readonly string[]).includes(s),
      );
    }
  });

  it('SM-8: TransitionResult is a discriminated union (ok true/false)', () => {
    const ok: TransitionResult<TaskState> = { ok: true, next: 'PASSED', event: 'VERIFY_PASSED' };
    const err: TransitionResult<TaskState> = {
      ok: false,
      code: 'INVALID_TRANSITION',
      reason: 'no rule',
    };
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
    if (ok.ok) expect(ok.next).toBe('PASSED');
    if (!err.ok) expect(err.code).toBe('INVALID_TRANSITION');
  });
});
