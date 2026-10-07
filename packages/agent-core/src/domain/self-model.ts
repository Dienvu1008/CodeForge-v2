// SelfModel — Phase 11 (P11.1). A read-only, DETERMINISTIC projection of a session's (or
// a set of sessions') run history, used by the Intelligence Plane as ADVISORY evidence
// only. It holds no authority (LE-001) and is a total function of its inputs (LE-004):
// the same events + failures + recovery actions always produce the same SelfModel.
//
// LE-008 (redaction): the builder derives the SelfModel ONLY from classification fields
// (failure class, recovery kind/outcome, counts, normalized signature hashes). It never
// copies raw payloads, evidence messages, stderr, or file contents into the model, so no
// secret/PII can leak through this projection even if an upstream event were under-redacted.
//
// This file is pure domain types. The builder lives in `../learning/self-model-builder.ts`.
import type { FailureClass, RecoveryKind } from './failure.js';

// ── Recovery outcome statistics ────────────────────────────────────────────────

/**
 * Outcome tally for one (failureClass, recoveryAction) pair. This is the core signal the
 * RecoveryAdvisor (P11.4) will read: "for this failure class, how has this action fared?"
 */
export interface RecoveryOutcomeStat {
  readonly failureClass: FailureClass;
  readonly action: RecoveryKind;
  /** Recovery actions of this (class, action) that reached a terminal outcome. */
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly aborted: number;
  /** succeeded / total, or 0 when total === 0. A convenience derived field. */
  readonly successRate: number;
}

// ── Failure frequency ────────────────────────────────────────────────────────

/** How often each failure class occurred. */
export interface FailureClassStat {
  readonly failureClass: FailureClass;
  readonly count: number;
}

/**
 * How often each distinct normalized failure SIGNATURE recurred. The signature is already a
 * normalized hash (Failure.signature) — safe to surface. Recurring signatures are the
 * strongest "we have been here before" signal.
 */
export interface FailureSignatureStat {
  readonly signature: string;
  readonly count: number;
  /** Failure class associated with this signature (first seen). */
  readonly failureClass: FailureClass;
}

// ── Convergence ────────────────────────────────────────────────────────────────

/**
 * Per-session convergence summary derived from the event stream. Advisory input for the
 * NoProgressAdvisor (P11.5) and for human-facing self-reflection.
 */
export interface ConvergenceStat {
  readonly sessionId: string;
  /** Count of DECISION_COMPLETED events (model decisions taken). */
  readonly decisions: number;
  /** Count of TASK_RUN_STARTED. */
  readonly taskRunsStarted: number;
  /** Count of TASK_RUN_ENDED. */
  readonly taskRunsEnded: number;
  /** Retries inferred from repeated TASK_RUN_STARTED on the same task. */
  readonly taskRetries: number;
  /** Terminal session outcome if observed. */
  readonly outcome?: 'COMPLETED' | 'ABORTED';
}

// ── SelfModel ────────────────────────────────────────────────────────────────

/**
 * The aggregate read-only projection. Every array is in a DETERMINISTIC order (sorted by a
 * stable key) so that equal inputs serialize identically (LE-004).
 */
export interface SelfModel {
  /** Schema/version of the projection shape (bump when the shape changes). */
  readonly version: number;
  /** Sessions this model was built from, sorted ascending. */
  readonly sessionIds: readonly string[];

  /** Totals across all input. */
  readonly totals: {
    readonly events: number;
    readonly failures: number;
    readonly recoveryActions: number;
    readonly sessions: number;
  };

  /** Recovery outcome stats, sorted by (failureClass, action). */
  readonly recoveryOutcomes: readonly RecoveryOutcomeStat[];
  /** Failure-class frequency, sorted by failureClass. */
  readonly failureClasses: readonly FailureClassStat[];
  /** Recurring failure signatures, sorted by count desc then signature asc. */
  readonly failureSignatures: readonly FailureSignatureStat[];
  /** Per-session convergence, sorted by sessionId. */
  readonly convergence: readonly ConvergenceStat[];
}

/** Current SelfModel shape version. */
export const SELF_MODEL_VERSION = 1;
