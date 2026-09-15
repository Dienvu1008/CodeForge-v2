// TaskStateMachine (P1-SM1) — STATE_MACHINE_SPEC SM-TASK §4. Enforces SM-001..003, SM-005.
//
// PURE + DETERMINISTIC (SM-001): transitionTask(state, event, ctx) is a total function of
// (state, event, context) — no I/O, no LLM, no random, no wall-clock (SM-006: never reads
// raw model output; guards read only structured context). Effects (emit event, start run,
// verification) run AFTER the transition in the runtime; SM-004 (state+event atomic) is a
// commit concern (event log write in the same transaction).
//
// Key rules:
//   - SM-002 / SM-L1: no RUNNING -> PASSED. PASSED is reachable only from VERIFYING with a
//     valid+fresh report, or from AWAITING_HUMAN via HUMAN_OVERRIDE_PASSED.
//   - SM-003 / SM-L3: terminal states (PASSED, SUPERSEDED, ABORTED) are absorbing.
//   - SM-005 / SM-L5: AWAITING_HUMAN exits only via HUMAN_DECIDED / HUMAN_OVERRIDE_PASSED /
//     CANCEL_REQUESTED, and only when the human decision has been recorded.
import type { TaskState } from '../state-machine/states.js';
import { TERMINAL_TASK_STATES } from '../state-machine/states.js';
import type { TransitionResult } from '../state-machine/transition.js';

export type TaskEvent =
  | 'DEPS_SATISFIED'
  | 'DEP_UNREACHABLE'
  | 'SCHEDULED'
  | 'RUN_ENDED_OK'
  | 'RUN_ENDED_ABNORMAL'
  | 'EXTERNAL_MUTATION_DETECTED'
  | 'VERIFICATION_PASSED'
  | 'VERIFICATION_FAILED'
  | 'FAILURE_ANALYZED'
  | 'RECOVERY_CHOSEN'
  | 'RECOVERY_ENDED'
  | 'HUMAN_REQUIRED'
  | 'HUMAN_DECIDED'
  | 'HUMAN_OVERRIDE_PASSED'
  | 'CANCEL_REQUESTED'
  | 'SUPERSEDE'
  | 'ABORT';

/** Structured decision inputs a transition may read (SM-006: never raw LLM output). */
export interface TaskTransitionContext {
  /** VERIFICATION_*: the VerificationReport is well-formed (status PASS/FAIL). */
  readonly reportValid?: boolean;
  /** VERIFICATION_*: report.targetWorkspaceRevision == current revision. */
  readonly fresh?: boolean;
  /** HUMAN_DECIDED: a human decision has been recorded (SM-005). */
  readonly humanDecisionRecorded?: boolean;
  /** HUMAN_DECIDED: the recorded decision resumes (RUNNING) vs aborts (ABORTED). */
  readonly humanDecision?: 'resume' | 'abort';
  /** HUMAN_OVERRIDE_PASSED: override committed + HUMAN_OVERRIDE_COMPLETED marker linked. */
  readonly overrideCommitted?: boolean;
  /** SUPERSEDE: new task valid + graph validator passed + no RUNNING TaskRun. */
  readonly supersedeValid?: boolean;
}

function isTerminal(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

function ok(next: TaskState, event: TaskEvent): TransitionResult<TaskState> {
  return { ok: true, next, event };
}
function guardFail(reason: string): TransitionResult<TaskState> {
  return { ok: false, code: 'GUARD_FAILED', reason };
}
function invalid(state: TaskState, event: TaskEvent): TransitionResult<TaskState> {
  return { ok: false, code: 'INVALID_TRANSITION', reason: `no transition from ${state} on ${event}` };
}

/**
 * Attempt a Task transition. Returns a discriminated result (never throws for a rule
 * violation). SUPERSEDE/ABORT are allowed from any non-terminal state.
 */
export function transitionTask(
  state: TaskState,
  event: TaskEvent,
  ctx: TaskTransitionContext = {},
): TransitionResult<TaskState> {
  if (isTerminal(state)) {
    return { ok: false, code: 'TERMINAL_STATE', reason: `task is terminal: ${state}` };
  }

  // Universal (any non-terminal) transitions.
  if (event === 'ABORT') return ok('ABORTED', event);
  if (event === 'SUPERSEDE') {
    return ctx.supersedeValid === true ? ok('SUPERSEDED', event) : guardFail('supersede not valid (running run or invalid new task)');
  }

  switch (state) {
    case 'PENDING':
      if (event === 'DEPS_SATISFIED') return ok('READY', event);
      if (event === 'DEP_UNREACHABLE') return ok('ABORTED', event); // SM-L8: no infinite PENDING
      return invalid(state, event);

    case 'READY':
      if (event === 'SCHEDULED') return ok('RUNNING', event);
      return invalid(state, event);

    case 'RUNNING':
      if (event === 'RUN_ENDED_OK') return ok('VERIFYING', event); // SM-L1: never direct to PASSED
      if (event === 'RUN_ENDED_ABNORMAL') return ok('FAILED', event); // SM-L9: skip verify
      if (event === 'EXTERNAL_MUTATION_DETECTED') return ok('FAILED', event);
      if (event === 'HUMAN_REQUIRED') return ok('AWAITING_HUMAN', event);
      if (event === 'CANCEL_REQUESTED') return ok('ABORTED', event);
      return invalid(state, event);

    case 'VERIFYING':
      if (event === 'VERIFICATION_PASSED') {
        // SM-002: only pass with a valid + fresh report.
        if (ctx.reportValid !== true) return guardFail('verification report not valid');
        if (ctx.fresh !== true) return guardFail('verification report not fresh (revision drift)');
        return ok('PASSED', event);
      }
      if (event === 'VERIFICATION_FAILED') {
        if (ctx.reportValid !== true) return guardFail('verification report not valid');
        if (ctx.fresh !== true) return guardFail('verification report not fresh');
        return ok('FAILED', event);
      }
      if (event === 'EXTERNAL_MUTATION_DETECTED') return ok('FAILED', event);
      if (event === 'CANCEL_REQUESTED') return ok('ABORTED', event);
      return invalid(state, event);

    case 'FAILED':
      if (event === 'FAILURE_ANALYZED') return ok('FAILURE_ANALYZED', event);
      return invalid(state, event);

    case 'FAILURE_ANALYZED':
      if (event === 'RECOVERY_CHOSEN') return ok('RECOVERY', event);
      if (event === 'HUMAN_REQUIRED') return ok('AWAITING_HUMAN', event);
      return invalid(state, event);

    case 'RECOVERY':
      if (event === 'RECOVERY_ENDED') return ok('RUNNING', event); // SM-L6
      return invalid(state, event);

    case 'AWAITING_HUMAN':
      // SM-005 / SM-L5: only these three exits, and only with a recorded decision.
      if (event === 'CANCEL_REQUESTED') return ok('ABORTED', event);
      if (event === 'HUMAN_DECIDED') {
        if (ctx.humanDecisionRecorded !== true) return guardFail('no human decision recorded');
        return ok(ctx.humanDecision === 'abort' ? 'ABORTED' : 'RUNNING', event);
      }
      if (event === 'HUMAN_OVERRIDE_PASSED') {
        // SM-L2/L10: the only non-verification path to PASSED; requires the override marker.
        if (ctx.overrideCommitted !== true) return guardFail('override not committed / marker missing');
        return ok('PASSED', event);
      }
      return invalid(state, event);

    default:
      return invalid(state, event);
  }
}

export function isTaskTerminal(state: TaskState): boolean {
  return isTerminal(state);
}
