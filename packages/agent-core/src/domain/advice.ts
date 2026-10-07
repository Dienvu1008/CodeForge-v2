// Advice — Phase 11 (P11.3). The ONLY shape in which the learning layer may influence a
// runtime decision. Advice is produced by advisors (P11.4+), but a consumer never reads an
// advisor's raw output: it reads a SafeAdvice that an AdviceGate has clamped into the
// already-deterministic decision surface it belongs to.
//
// Invariants this type exists to support:
//   LE-001: advice is never authority — it is a weighted input to an existing deterministic
//           decision (recovery order, context ranking, no-progress nudge).
//   LE-003: advice may only REORDER/SCORE within an already-deterministic allowed-set/ranking
//           — it can never add an action, widen a budget, or create a new capability. The
//           SafeAdvice shapes below carry nothing that could express such a thing.
//   LE-002: the absence of advice (null) must mean "behave exactly as without learning".
//
// This file is pure domain types. The gate lives in `../learning/advice-gate.ts`.
import type { FailureClass, RecoveryKind } from './failure.js';

// ── Raw advice (advisor output — UNTRUSTED until gated) ──────────────────────────

export type AdviceKind = 'recovery_order' | 'context_rerank' | 'no_progress';

/**
 * "For this failure class, prefer trying the recovery actions in this order." The order is a
 * PROPOSAL; the gate intersects it with the policy's current allowed-set, so anything the
 * advisor invents is dropped.
 */
export interface RawRecoveryOrderAdvice {
  readonly kind: 'recovery_order';
  readonly failureClass: FailureClass;
  /** Proposed ordering of actions (may contain unknown/duplicate entries — gate cleans it). */
  readonly order: readonly RecoveryKind[];
}

/**
 * "Nudge these files' relevance by these deltas." Deltas are a PROPOSAL; the gate clamps each
 * to a bounded range and drops paths outside the current candidate set.
 */
export interface RawContextRerankAdvice {
  readonly kind: 'context_rerank';
  /** Proposed per-path score deltas (path → delta). */
  readonly deltas: Readonly<Record<string, number>>;
}

/** "History suggests this run is unlikely to progress." A single advisory boolean. */
export interface RawNoProgressAdvice {
  readonly kind: 'no_progress';
  readonly likelyStuck: boolean;
}

export type RawAdvice =
  | RawRecoveryOrderAdvice
  | RawContextRerankAdvice
  | RawNoProgressAdvice;

// ── Safe advice (post-gate — the ONLY form a consumer may read) ──────────────────

/**
 * A recovery ordering that is GUARANTEED to be a subset-permutation of the policy's current
 * allowed-set for the failure class: every entry is allowed, no entry is unknown, no
 * duplicates. Consuming it can only change the ORDER actions are tried in — never the set,
 * never the count, never the budget.
 */
export interface SafeRecoveryOrderAdvice {
  readonly kind: 'recovery_order';
  readonly failureClass: FailureClass;
  readonly order: readonly RecoveryKind[];
}

/**
 * Per-path score deltas that are GUARANTEED bounded (|delta| ≤ maxDelta) and restricted to
 * paths in the current candidate set. Consuming it can only re-rank within the existing
 * deterministic candidate list — it cannot add or remove candidates.
 */
export interface SafeContextRerankAdvice {
  readonly kind: 'context_rerank';
  readonly deltas: Readonly<Record<string, number>>;
  /** The bound that was applied (for audit/provenance). */
  readonly maxDelta: number;
}

/** A gated no-progress nudge (identical payload; passing through the gate records provenance). */
export interface SafeNoProgressAdvice {
  readonly kind: 'no_progress';
  readonly likelyStuck: boolean;
}

export type SafeAdvice =
  | SafeRecoveryOrderAdvice
  | SafeContextRerankAdvice
  | SafeNoProgressAdvice;

// ── Gate context (the deterministic bounds the gate clamps against) ───────────────

/**
 * The deterministic facts the gate needs to clamp raw advice. These come from the runtime's
 * own state (policy allowed-set, current context candidates), NOT from the learning layer —
 * so the gate can never be tricked into widening them.
 */
export interface AdviceGateContext {
  /** The policy's current allowed recovery actions for the relevant failure class. */
  readonly allowedActions?: readonly RecoveryKind[];
  /** The current deterministic context candidate paths (rerank may only touch these). */
  readonly candidatePaths?: readonly string[];
  /** Max absolute score delta a rerank advice may apply. Defaults applied by the gate. */
  readonly maxRerankDelta?: number;
}
