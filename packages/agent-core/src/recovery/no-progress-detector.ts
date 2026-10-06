// NoProgressDetector — P5-NPD1 / P7-NPD2. Deterministic detection of "stuck" loops.
//
// Enforces RC-002 (bounded) and RC-003 (deterministic):
//   - Same input signals → same output (RC-003).
//   - Unavailable signals treated as 'unknown', never trigger false no-progress (RC-003).
//   - Threshold N configurable; default 3.
//
// Signals:
//   - Phase 5: consecutive Failure.class values from FailureRecord history.
//   - Phase 7 (P7-NPD2): `relevantFilesChanged` — the affected-file set per attempt
//     (from the import graph, IG1). When the set is identical across the last N
//     attempts, the agent is churning the same files without widening its reach,
//     an additional no-progress indicator. This signal was "unknown" before Phase 6
//     (RC-003); now the import graph makes it available. When the caller does not
//     supply it, it stays unknown and never causes a false positive.
//
// Design: pure function — no I/O, no LLM, no wall-clock.
import type { Failure, FailureClass } from '../domain/failure.js';

// ── Options ────────────────────────────────────────────────────────────────────

export interface NoProgressOptions {
  /**
   * P7-NPD2: the set of relevant (affected) files at each attempt, ordered
   * oldest → newest. Optional — when omitted the signal is "unknown" (RC-003) and
   * has no effect on the result.
   */
  readonly relevantFilesPerAttempt?: readonly ReadonlySet<string>[];
}

// ── NoProgressResult ──────────────────────────────────────────────────────────

export interface NoProgressResult {
  /** True iff the detector concludes the agent is making no progress. */
  readonly noProgress:       boolean;
  /** The repeating failure class, if detected. */
  readonly repeatingClass?:  FailureClass | undefined;
  /** Number of consecutive occurrences that triggered the detection. */
  readonly consecutiveCount: number;
  /**
   * P7-NPD2 signal: true if the relevant-file set changed across the recent
   * attempts, false if it stayed identical, undefined if the signal was unknown
   * (not supplied / too few attempts). Only `false` contributes to no-progress.
   */
  readonly relevantFilesChanged?: boolean | undefined;
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
  opts: NoProgressOptions = {},
): NoProgressResult {
  // P7-NPD2: compute the relevant-files signal (unknown-safe). `undefined` means
  // the signal is unavailable and must not influence the outcome (RC-003).
  const relevantFilesChanged = computeRelevantFilesChanged(opts.relevantFilesPerAttempt, threshold);
  const filesStatic = relevantFilesChanged === false; // definitively unchanged

  if (failures.length < threshold) {
    return {
      noProgress:       false,
      consecutiveCount: failures.length,
      relevantFilesChanged,
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
      relevantFilesChanged,
      reason:           'All recent failures are UNKNOWN — inconclusive (RC-003)',
    };
  }

  // Check if all non-unknown entries share the same class.
  const firstClass = nonUnknown[0]!.class;
  const allSame    = nonUnknown.every((f) => f.class === firstClass);

  if (allSame && nonUnknown.length >= threshold) {
    const filesNote = filesStatic ? ' + relevant files unchanged (P7-NPD2)' : '';
    return {
      noProgress:       true,
      repeatingClass:   firstClass,
      consecutiveCount: threshold,
      relevantFilesChanged,
      reason:           `${threshold} consecutive ${firstClass} failures — no progress detected (RC-002/003)${filesNote}`,
    };
  }

  // Class signal is mixed. P7-NPD2: if the affected-file set is DEFINITIVELY static
  // across the last `threshold` attempts, the agent is churning the same files
  // without changing what it touches — a no-progress indicator on its own. This
  // only fires when the signal is available (filesStatic), so an unknown signal
  // never causes a false positive (RC-003).
  if (filesStatic) {
    return {
      noProgress:       true,
      consecutiveCount: threshold,
      relevantFilesChanged: false,
      reason:           `Relevant file set unchanged across ${threshold} attempts — no progress (P7-NPD2 / RC-003)`,
    };
  }

  // Mixed classes and no static-files signal → progress (agent is trying things).
  const classes = recent.map((f) => f.class).join(', ');
  return {
    noProgress:       false,
    consecutiveCount: recent.length,
    relevantFilesChanged,
    reason:           `Mixed failure classes in last ${threshold} attempts: ${classes}`,
  };
}

// ── relevant-files signal (P7-NPD2) ─────────────────────────────────────────────

/**
 * Determine whether the relevant-file set changed across the last `threshold`
 * attempts. Returns:
 *   - undefined  if the signal is unavailable (not supplied or < threshold
 *                attempts) → "unknown" (RC-003): must not influence the outcome.
 *   - false      if the last `threshold` sets are all identical (static).
 *   - true       if any of them differ (the agent widened/changed its reach).
 * Pure + deterministic — set comparison is order-independent.
 */
function computeRelevantFilesChanged(
  perAttempt: readonly ReadonlySet<string>[] | undefined,
  threshold: number,
): boolean | undefined {
  if (perAttempt === undefined || perAttempt.length < threshold) return undefined;
  const recent = perAttempt.slice(-threshold);
  const first = recent[0]!;
  for (let i = 1; i < recent.length; i++) {
    if (!setsEqual(first, recent[i]!)) return true;
  }
  return false;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}