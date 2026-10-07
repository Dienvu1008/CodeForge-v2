// NoProgressAdvisor — Phase 11 (P11.5). Proposes an EARLY "likely stuck" nudge from history,
// so a session that keeps hitting a recurring failure signature can be flagged sooner.
//
// Strictly advisory (LE-001 / RC-003): the deterministic NoProgressDetector remains the
// authority. This advisor only emits a RawNoProgressAdvice boolean; a consumer passes it
// through AdviceGate and may use `combineNoProgress` to ATTACH an advisory flag to the
// detector's result. The combiner can NEVER flip the detector's deterministic verdict — it
// only adds an `advisoryStuck` hint. With no advice, the result is unchanged (LE-002).
//
// Pure + deterministic: advise() is a total function of the SelfModel.
import type { SelfModel } from '../domain/self-model.js';
import type { RawNoProgressAdvice, SafeNoProgressAdvice } from '../domain/advice.js';
import type { NoProgressResult } from '../recovery/no-progress-detector.js';

export interface NoProgressAdvisorOptions {
  /**
   * A failure signature recurring at least this many times is treated as an early "likely
   * stuck" signal. Default 3 — the same normalized failure three times is a strong hint.
   */
  readonly recurrenceThreshold?: number;
}

const DEFAULT_RECURRENCE_THRESHOLD = 3;

export class NoProgressAdvisor {
  private readonly recurrenceThreshold: number;

  constructor(opts: NoProgressAdvisorOptions = {}) {
    this.recurrenceThreshold =
      opts.recurrenceThreshold !== undefined && opts.recurrenceThreshold >= 2
        ? opts.recurrenceThreshold
        : DEFAULT_RECURRENCE_THRESHOLD;
  }

  /**
   * Emit an early "likely stuck" nudge iff any failure signature in the model recurred at
   * least `recurrenceThreshold` times. Returns null (no advice) otherwise — null means the
   * consumer keeps the detector's verdict as-is (LE-002).
   */
  advise(model: SelfModel): RawNoProgressAdvice | null {
    const maxRecurrence = model.failureSignatures.reduce((m, s) => Math.max(m, s.count), 0);
    if (maxRecurrence >= this.recurrenceThreshold) {
      return { kind: 'no_progress', likelyStuck: true };
    }
    return null;
  }
}

/**
 * Attach a gated advisory "likely stuck" flag to a deterministic NoProgressResult WITHOUT
 * changing its authoritative `noProgress` verdict (RC-003 preserved). Pure. With null advice
 * the result is returned unchanged (LE-002). The `advisoryStuck` field is purely informational
 * — a NoProgressPolicy may choose to act on it, but the deterministic detector stays the source
 * of truth and the hard stop still requires `noProgress === true`.
 */
export function combineNoProgress(
  result: NoProgressResult,
  advice: SafeNoProgressAdvice | null | undefined,
): NoProgressResult & { readonly advisoryStuck?: boolean } {
  if (advice === null || advice === undefined) return result;
  return { ...result, advisoryStuck: advice.likelyStuck === true };
}
