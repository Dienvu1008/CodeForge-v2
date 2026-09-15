// SessionStateMachine (P1-S1) — STATE_MACHINE_SPEC SM-SESSION §3, DOMAIN_CONTRACTS §25.1.
//
// PURE + DETERMINISTIC (SM-001): transition() is a total function of
// (state, event, context) — no I/O, no LLM, no random, no wall-clock. Effects
// (persist, emit event, checkpoint) run AFTER a successful transition in the service.
//
// Enforces:
//   - SS-002: only declared transitions are legal (unknown from/event -> INVALID_TRANSITION).
//   - SS-003: RUNNING --ALL_TASKS_TERMINAL--> COMPLETED requires ctx.allTasksTerminal.
//   - SS-007: AWAITING_HUMAN --HUMAN_DECIDED--> RUNNING requires ctx.humanDecisionRecorded.
//   - SM-003: no transition out of a terminal state (COMPLETED/ABORTED).
import type { SessionState } from '../state-machine/states.js';
import { TERMINAL_SESSION_STATES } from '../state-machine/states.js';
import type { TransitionResult, TransitionRule } from '../state-machine/transition.js';

export type SessionEvent =
  | 'SESSION_INITIALIZED'
  | 'SESSION_READY'
  | 'HUMAN_REQUIRED'
  | 'HUMAN_DECIDED'
  | 'CANCEL_REQUESTED'
  | 'CANCEL_COMPLETED'
  | 'ALL_TASKS_TERMINAL'
  | 'ABORT';

/** Context a session transition may read (pure inputs, no side effects). */
export interface SessionTransitionContext {
  /** SS-003: true iff every task in the session is in a terminal state. */
  readonly allTasksTerminal?: boolean;
  /** SS-007: true iff a human decision has been recorded for the pending prompt. */
  readonly humanDecisionRecorded?: boolean;
}

// SM-SESSION §3.1 transition table (guards named; evaluated in transition()).
export const SESSION_TRANSITIONS: readonly TransitionRule<SessionState, SessionEvent>[] = [
  { from: 'CREATED', event: 'SESSION_INITIALIZED', to: 'INITIALIZING' },
  { from: 'INITIALIZING', event: 'SESSION_READY', to: 'RUNNING' },
  { from: 'RUNNING', event: 'HUMAN_REQUIRED', to: 'AWAITING_HUMAN' },
  { from: 'AWAITING_HUMAN', event: 'HUMAN_DECIDED', to: 'RUNNING', guards: ['humanDecisionRecorded'] },
  { from: 'AWAITING_HUMAN', event: 'CANCEL_REQUESTED', to: 'CANCELLING' },
  { from: 'RUNNING', event: 'CANCEL_REQUESTED', to: 'CANCELLING' },
  { from: 'CANCELLING', event: 'CANCEL_COMPLETED', to: 'ABORTED' },
  { from: 'RUNNING', event: 'ALL_TASKS_TERMINAL', to: 'COMPLETED', guards: ['allTasksTerminal'] },
  // ABORT is allowed from any non-terminal state (DOMAIN_CONTRACTS §25.1 "any --ABORT-->").
  { from: 'CREATED', event: 'ABORT', to: 'ABORTED' },
  { from: 'INITIALIZING', event: 'ABORT', to: 'ABORTED' },
  { from: 'RUNNING', event: 'ABORT', to: 'ABORTED' },
  { from: 'AWAITING_HUMAN', event: 'ABORT', to: 'ABORTED' },
  { from: 'CANCELLING', event: 'ABORT', to: 'ABORTED' },
];

function isTerminal(state: SessionState): boolean {
  return (TERMINAL_SESSION_STATES as readonly string[]).includes(state);
}

/**
 * Attempt a session transition. Returns a discriminated result (never throws for a
 * business-rule rejection). Guards read only the provided context.
 */
export function transitionSession(
  state: SessionState,
  event: SessionEvent,
  ctx: SessionTransitionContext = {},
): TransitionResult<SessionState> {
  if (isTerminal(state)) {
    // SM-003: terminal states are absorbing.
    return { ok: false, code: 'TERMINAL_STATE', reason: `session is terminal: ${state}` };
  }
  const rule = SESSION_TRANSITIONS.find((r) => r.from === state && r.event === event);
  if (!rule) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      reason: `no transition from ${state} on ${event}`,
    };
  }
  for (const guard of rule.guards ?? []) {
    if (guard === 'allTasksTerminal' && ctx.allTasksTerminal !== true) {
      // SS-003
      return {
        ok: false,
        code: 'GUARD_FAILED',
        reason: 'cannot complete: not all tasks are terminal',
      };
    }
    if (guard === 'humanDecisionRecorded' && ctx.humanDecisionRecorded !== true) {
      // SS-007
      return {
        ok: false,
        code: 'GUARD_FAILED',
        reason: 'cannot resume: no human decision recorded',
      };
    }
  }
  return { ok: true, next: rule.to, event };
}

/** Whether a session state is terminal (COMPLETED / ABORTED). */
export function isSessionTerminal(state: SessionState): boolean {
  return isTerminal(state);
}
