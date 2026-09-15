// Transition machinery types — STATE_MACHINE_SPEC §1, §16, §18. SM-5, SM-6, SM-8.
//
// Transition is a DETERMINISTIC, PURE function of (state, event, context) — no LLM, no I/O,
// no random, no wall-clock (§14.1). Effects run AFTER commit. This file defines the TYPES;
// concrete machines are implemented in Phase 1.

export type TransitionErrorCode =
  | 'INVALID_TRANSITION'
  | 'GUARD_FAILED'
  | 'TERMINAL_STATE'
  | 'CONCURRENT_TRANSITION'
  | 'TRANSACTION_FAILED'
  | 'EFFECT_FAILED';

export interface TransitionContext {
  readonly [key: string]: unknown;
}

/** A guard is a pure predicate over the transition context (§16.1). */
export interface Guard<Ctx extends TransitionContext = TransitionContext> {
  readonly name: string;
  evaluate(ctx: Ctx): boolean;
  reasonIfFalse(): string;
}

/** One row of a transition table (§4.3 shape): from + event + guards -> to. */
export interface TransitionRule<State extends string, Event extends string> {
  readonly from: State;
  readonly event: Event;
  readonly to: State;
  readonly guards?: readonly string[];
  readonly effect?: string;
}

/** A result type for a transition attempt (pure). */
export type TransitionResult<State extends string> =
  | { readonly ok: true; readonly next: State; readonly event: string }
  | { readonly ok: false; readonly code: TransitionErrorCode; readonly reason: string };

/**
 * Deterministic transition function signature (SM-8).
 * Same (state, event, context) MUST yield the same result.
 */
export type TransitionFn<State extends string, Event extends string> = (
  state: State,
  event: Event,
  ctx: TransitionContext,
) => TransitionResult<State>;

/** A state machine definition: states, terminal set, and its transition rules. */
export interface StateMachineDef<State extends string, Event extends string> {
  readonly id: string;
  readonly states: readonly State[];
  readonly terminal: readonly State[];
  readonly rules: readonly TransitionRule<State, Event>[];
}
