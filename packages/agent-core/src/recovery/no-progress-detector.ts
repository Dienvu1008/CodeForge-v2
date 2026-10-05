// NoProgressDetector — P5-NPD1. Deterministic detection of "stuck" recovery loops.
//
// Enforces RC-002 (bounded) and RC-003 (deterministic):
//   - Same input signals → same output (RC-003).
//   - Unavailable signals treated as 'unknown', never trigger false no-progress (RC-003).
//   - Threshold N configurable; default 3.
//
// Phase 5 signals available: consecutive Failure.class values from FailureRecord history.
// A richer signal set (stackTrace similarity, metric regression) is deferred to Phase 6.
//
// Design: pure function — no I/O, no LLM, no wall-clock.
import type { Failure, FailureClass } from '../domain/failure.js';

// ── NoProgressResult ──────────────────────────────────────────────────────────

export interface NoProgressResult {
  /** True iff the detector concludes the agent is making no progress. */
  readonly noProgress:       boolean;
  /** The repeating failure class, if detected. */
  readonly repeatingClass?:  FailureClass | undefined;
  /** Number of consecutive occurrences that triggered the detection. */
  readonly consecutiveCount: number;
  /** Human-readable explanation (RC-003: deterministic, can be logged). */
  readonly reason:           string;
}

// ── detectNoProgress ─────────────────────────────────────────────────────────

/**
 * Analyze a task's failure history and determine whether the agent is stuck.
 *
 * Algorithm (RC-003: deterministic):
 *   1. Take the last `threshold` entries from `failures` (ordered oldest → newest).
 *   2. If all entries share the same FailureClass → no progress detected.
 *   3. Special case: UNKNOWN class is NOT used to trigger no-progress (RC-003:
 *      UNKNOWN is an unavailable-signal proxy, not a confirmed pattern).
 *
 * @param failures  Failure records for a task, ordered oldest → newest.
 * @param threshold Consecutive same-class count to trigger detection. Default 3.
 */
export function detectNoProgress(
  failures: readonly Failure[],
  threshold = 3,
): NoProgressResult {
  if (failures.length < threshold) {
    return {
      noProgress:       false,
      consecutiveCount: failures.length,
      reason:           `Only ${failures.length} failure(s); need ${threshold} to detect no-progress`,
    };
  }

  // Take the last `threshold` entries.
  const recent = failures.slice(-threshold);

  // RC-003: UNKNOWN signals are inconclusive — skip if all are UNKNOWN.
  const nonUnknown = recent.filter((f) => f.class !== 'UNKNOWN');
  if (nonUnknown.length === 0) {
    return {
      noProgress:       false,
      consecutiveCount: threshold,
      reason:           'All recent failures are UNKNOWN — inconclusive (RC-003)',
    };
  }

  // Check if all non-unknown entries share the same class.
  const firstClass = nonUnknown[0]!.class;
  const allSame    = nonUnknown.every((f) => f.class === firstClass);

  if (allSame && nonUnknown.length >= threshold) {
    return {
      noProgress:       true,
      repeatingClass:   firstClass,
      consecutiveCount: threshold,
      reason:           `${threshold} consecutive ${firstClass} failures — no progress detected (RC-002/003)`,
    };
  }

  // Mixed classes → progress (agent is trying different things).
  const classes = recent.map((f) => f.class).join(', ');
  return {
    noProgress:       false,
    consecutiveCount: recent.length,
    reason:           `Mixed failure classes in last ${threshold} attempts: ${classes}`,
  };
}