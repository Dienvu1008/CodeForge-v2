// ToolCallStateMachine — STATE_MACHINE_SPEC SM-TOOLCALL §7, P1.5-TG1.
//
// PURE + DETERMINISTIC: transitionToolCall(state, event) is a total function of its
// inputs only. No side effects, no I/O, no wall-clock, no LLM.
//
// Enforces:
//   - TG-002: ToolCall state transitions follow the declared lifecycle.
//   - TG-005: a DENIED call never reaches RUNNING (DENIED is terminal).
//   - TG-010: TIMEOUT is a first-class terminal state (not RUNNING-forever).
//   - SM-003: terminal states are absorbing.
import type { ToolCallState } from '../state-machine/states.js';
import { TERMINAL_TOOLCALL_STATES } from '../state-machine/states.js';
import type { TransitionResult, TransitionRule } from '../state-machine/transition.js';

export type ToolCallEvent =
  | 'SCHEMA_VALID'          // REQUESTED → APPROVAL_PENDING (policy requires approval)
  | 'AUTO_APPROVED'         // REQUESTED → APPROVED (policy allows auto-approve)
  | 'DENIED_BY_POLICY'      // REQUESTED | APPROVAL_PENDING → DENIED
  | 'HUMAN_APPROVED'        // APPROVAL_PENDING → APPROVED
  | 'HUMAN_DENIED'          // APPROVAL_PENDING → DENIED
  | 'APPROVAL_EXPIRED'      // APPROVAL_PENDING → DENIED (timeout on human decision)
  | 'EXECUTION_STARTED'     // APPROVED → RUNNING
  | 'EXECUTION_SUCCEEDED'   // RUNNING → SUCCEEDED
  | 'EXECUTION_FAILED'      // RUNNING → FAILED
  | 'EXECUTION_TIMEOUT'     // RUNNING → TIMEOUT (SE-007 / TG-010)
  | 'CANCELLED';            // any non-terminal → CANCELLED

// SM-TOOLCALL §7.3 transition table.
export const TOOL_CALL_TRANSITIONS: readonly TransitionRule<ToolCallState, ToolCallEvent>[] = [
  { from: 'REQUESTED',        event: 'AUTO_APPROVED',       to: 'APPROVED' },
  { from: 'REQUESTED',        event: 'SCHEMA_VALID',        to: 'APPROVAL_PENDING' },
  { from: 'REQUESTED',        event: 'DENIED_BY_POLICY',    to: 'DENIED' },
  { from: 'APPROVAL_PENDING', event: 'HUMAN_APPROVED',      to: 'APPROVED' },
  { from: 'APPROVAL_PENDING', event: 'HUMAN_DENIED',        to: 'DENIED' },
  { from: 'APPROVAL_PENDING', event: 'APPROVAL_EXPIRED',    to: 'DENIED' },
  { from: 'APPROVAL_PENDING', event: 'DENIED_BY_POLICY',    to: 'DENIED' },
  { from: 'APPROVED',         event: 'EXECUTION_STARTED',   to: 'RUNNING' },
  { from: 'APPROVED',         event: 'CANCELLED',           to: 'CANCELLED' },
  { from: 'RUNNING',          event: 'EXECUTION_SUCCEEDED', to: 'SUCCEEDED' },
  { from: 'RUNNING',          event: 'EXECUTION_FAILED',    to: 'FAILED' },
  { from: 'RUNNING',          event: 'EXECUTION_TIMEOUT',   to: 'TIMEOUT' },
  { from: 'RUNNING',          event: 'CANCELLED',           to: 'CANCELLED' },
  { from: 'REQUESTED',        event: 'CANCELLED',           to: 'CANCELLED' },
  { from: 'APPROVAL_PENDING', event: 'CANCELLED',           to: 'CANCELLED' },
];

export function isToolCallTerminal(state: ToolCallState): boolean {
  return (TERMINAL_TOOLCALL_STATES as readonly string[]).includes(state);
}

/**
 * Attempt a ToolCall transition. Returns a discriminated result (never throws for
 * a business-rule violation — only the service layer may throw). TG-002: enforces
 * the declared lifecycle. TG-005: DENIED is terminal (absorbing).
 */
export function transitionToolCall(
  state: ToolCallState,
  event: ToolCallEvent,
): TransitionResult<ToolCallState> {
  if (isToolCallTerminal(state)) {
    return { ok: false, code: 'TERMINAL_STATE', reason: `tool call is terminal: ${state}` };
  }
  const rule = TOOL_CALL_TRANSITIONS.find((r) => r.from === state && r.event === event);
  if (!rule) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      reason: `no transition from ${state} on ${event}`,
    };
  }
  return { ok: true, next: rule.to, event };
}

/** Map a terminal ToolCallEvent to the ToolCallState it produces (for patch construction). */
export const TOOL_CALL_EVENT_TO_STATE: Partial<Record<ToolCallEvent, ToolCallState>> = {
  AUTO_APPROVED:       'APPROVED',
  SCHEMA_VALID:        'APPROVAL_PENDING',
  DENIED_BY_POLICY:    'DENIED',
  HUMAN_APPROVED:      'APPROVED',
  HUMAN_DENIED:        'DENIED',
  APPROVAL_EXPIRED:    'DENIED',
  EXECUTION_STARTED:   'RUNNING',
  EXECUTION_SUCCEEDED: 'SUCCEEDED',
  EXECUTION_FAILED:    'FAILED',
  EXECUTION_TIMEOUT:   'TIMEOUT',
  CANCELLED:           'CANCELLED',
};
