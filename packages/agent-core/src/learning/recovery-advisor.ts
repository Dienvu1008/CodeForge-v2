// RecoveryAdvisor — Phase 11 (P11.4). Reads a SelfModel and PROPOSES a recovery try-order for
// a failure class, ranking actions this class has historically succeeded with first.
//
// This is advisory output ONLY (LE-001): it is RawAdvice and must pass through an AdviceGate
// before any consumer (decide()) may use it. The advisor itself never touches policy, budget,
// or the allowed-set — it only emits a preference. decide() stays the authority: it clamps the
// gated advice to a reordering of its own allowed-set and keeps maxAttempts/guards/budget.
//
// Pure + deterministic: advise() is a total function of the SelfModel (LE-004 lineage) — no
// I/O, no clock, no randomness. Stable sort so equal inputs give equal advice.
import type { SelfModel, RecoveryOutcomeStat } from '../domain/self-model.js';
import { SELF_MODEL_VERSION } from '../domain/self-model.js';
import type { RawRecoveryOrderAdvice } from '../domain/advice.js';
import type { FailureClass, RecoveryKind } from '../domain/failure.js';

export interface RecoveryAdvisorOptions {
  /**
   * Minimum number of terminal outcomes for a (class, action) pair before its success rate is
   * trusted enough to influence ordering. Below this, the pair keeps its natural position.
   * Default 2 — a single data point is not a trend.
   */
  readonly minSamples?: number;
}

const DEFAULT_MIN_SAMPLES = 2;

export class RecoveryAdvisor {
  private readonly minSamples: number;

  constructor(opts: RecoveryAdvisorOptions = {}) {
    this.minSamples = opts.minSamples !== undefined && opts.minSamples >= 1 ? opts.minSamples : DEFAULT_MIN_SAMPLES;
  }

  /**
   * Propose a recovery try-order for `failureClass` from the model's recovery-outcome stats.
   * Returns null when there is no trustworthy signal (no stats, or none meeting minSamples) —
   * null means "no advice", so the consumer keeps its default order (LE-002).
   *
   * The returned order lists actions by success rate (desc), then by sample count (desc), then
   * alphabetically — a stable, deterministic ranking. It is a PROPOSAL spanning only actions
   * actually observed; AdviceGate + decide() intersect it with the real allowed-set, so an
   * action that is not currently allowed is simply ignored downstream (LE-003).
   */
  advise(model: SelfModel, failureClass: FailureClass): RawRecoveryOrderAdvice | null {
    const stats = model.recoveryOutcomes.filter(
      (s) => s.failureClass === failureClass && s.total >= this.minSamples,
    );
    if (stats.length === 0) return null;

    const order = [...stats].sort(compareStat).map((s) => s.action);
    if (order.length === 0) return null;

    return { kind: 'recovery_order', failureClass, order: order as readonly RecoveryKind[] };
  }
}

/** Rank: higher success rate first, then more samples, then action name (stable + total). */
function compareStat(a: RecoveryOutcomeStat, b: RecoveryOutcomeStat): number {
  if (a.successRate !== b.successRate) return b.successRate - a.successRate;
  if (a.total !== b.total) return b.total - a.total;
  return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
}

/**
 * Reconstruct the `recoveryOutcomes` slice of a SelfModel from persisted `recovery_outcome`
 * lessons (across prior sessions). This lets the advisor benefit from accumulated history that
 * is no longer in the live failure repository. Pure + deterministic; non-recovery_outcome
 * lessons are ignored. Returns a minimal SelfModel (only recoveryOutcomes populated) suitable
 * for `advise()`. Lessons for the same (class, action) are collapsed to the NEWEST by taking
 * the first occurrence (the store returns recency-desc), matching lesson supersession.
 */
export function selfModelFromLessons(
  lessons: ReadonlyArray<import('../domain/learning.js').Lesson>,
): SelfModel {
  const seen = new Set<string>();
  const recoveryOutcomes: RecoveryOutcomeStat[] = [];
  for (const l of lessons) {
    if (l.payload.kind !== 'recovery_outcome') continue;
    const key = `${l.payload.failureClass}\u0001${l.payload.action}`;
    if (seen.has(key)) continue; // keep newest (store is recency-desc)
    seen.add(key);
    const { failureClass, action, total, succeeded, failed, aborted } = l.payload;
    recoveryOutcomes.push({
      failureClass, action, total, succeeded, failed, aborted,
      successRate: total > 0 ? succeeded / total : 0,
    });
  }
  recoveryOutcomes.sort((a, b) =>
    a.failureClass < b.failureClass ? -1 : a.failureClass > b.failureClass ? 1
      : a.action < b.action ? -1 : a.action > b.action ? 1 : 0,
  );
  return {
    version: SELF_MODEL_VERSION,
    sessionIds: [],
    totals: { events: 0, failures: 0, recoveryActions: recoveryOutcomes.length, sessions: 0 },
    recoveryOutcomes,
    failureClasses: [],
    failureSignatures: [],
    convergence: [],
  };
}
