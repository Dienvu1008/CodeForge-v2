// TaskRunStateMachine (P1-T3) — STATE_MACHINE_SPEC SM-TASK-RUN §5.
//
// PURE + DETERMINISTIC: transition() is a total function of (state, event). TaskRun
// starts RUNNING and moves to exactly one terminal state. Effects (kill tree, reconcile,
// finalize) run AFTER the transition, in the service.
//
// Enforces:
//   - EX-L12 / SM-003: terminal states are absorbing.
//   - EX-L13: INTERRUPTED is reachable ONLY via RUN_INTERRUPTED (crash recovery) — a
//     guard the service also honors (only the recovery path emits it).
import type { TaskRunState } from '../state-machine/states.js';
import { TERMINAL_TASK_RUN_STATES } from '../state-machine/states.js';
import type { TransitionResult, TransitionRule } from '../state-machine/transition.js';

export type TaskRunEvent =
  | 'RUN_SUCCEEDED'
  | 'RUN_FAILED'
  | 'RUN_TIMEOUT'
  | 'RUN_CANCELLED'
  | 'RUN_INTERRUPTED';

// SM-TASK-RUN §5.3 transition table.
export const TASK_RUN_TRANSITIONS: readonly TransitionRule<TaskRunState, TaskRunEvent>[] = [
  { from: 'RUNNING', event: 'RUN_SUCCEEDED', to: 'SUCCEEDED', effect: 'finalize' },
  { from: 'RUNNING', event: 'RUN_FAILED', to: 'FAILED', effect: 'finalize' },
  { from: 'RUNNING', event: 'RUN_TIMEOUT', to: 'TIMEOUT', effect: 'killTree' },
  { from: 'RUNNING', event: 'RUN_CANCELLED', to: 'CANCELLED', effect: 'killTree' },
  { from: 'RUNNING', event: 'RUN_INTERRUPTED', to: 'INTERRUPTED', effect: 'reconcileWorkspace' },
];

/** Map each terminal event to the run state it produces. */
export const TASK_RUN_EVENT_TO_STATE: Readonly<Record<TaskRunEvent, TaskRunState>> = {
  RUN_SUCCEEDED: 'SUCCEEDED',
  RUN_FAILED: 'FAILED',
  RUN_TIMEOUT: 'TIMEOUT',
  RUN_CANCELLED: 'CANCELLED',
  RUN_INTERRUPTED: 'INTERRUPTED',
};

export function isTaskRunTerminal(state: TaskRunState): boolean {
  return (TERMINAL_TASK_RUN_STATES as readonly string[]).includes(state);
}

/** Attempt a TaskRun transition. Returns a discriminated result (no throw for rejection). */
export function transitionTaskRun(
  state: TaskRunState,
  event: TaskRunEvent,
): TransitionResult<TaskRunState> {
  if (isTaskRunTerminal(state)) {
    return { ok: false, code: 'TERMINAL_STATE', reason: `run is terminal: ${state}` };
  }
  const rule = TASK_RUN_TRANSITIONS.find((r) => r.from === state && r.event === event);
  if (!rule) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      reason: `no transition from ${state} on ${event}`,
    };
  }
  return { ok: true, next: rule.to, event };
}
