// AdviceGate — Phase 11 (P11.3). The single deterministic chokepoint between the learning
// layer and any runtime decision. No consumer may read an advisor's raw output; it must read
// the result of AdviceGate.sanitize(), which clamps the proposal into the already-existing
// deterministic decision surface.
//
// Invariants enforced HERE:
//   LE-001: the gate returns only SafeAdvice (a bounded reordering/scoring) or null — never
//           an action, a budget, or a capability. Authority stays with the policy.
//   LE-002: sanitize() returns null for empty/invalid/degenerate advice. A null result means
//           the consumer falls back to its exact pre-learning (Phase 10) behavior — so with
//           no advice (or learning disabled) the runtime is unchanged.
//   LE-003: recovery advice is intersected with the policy's CURRENT allowed-set (subset-
//           permutation only — no new/duplicate actions); rerank deltas are clamped to a
//           bound and restricted to current candidate paths. The gate can never widen a set.
//   LE-007: the gate takes NO store/gateway/engine/model — it is a pure function of
//           (rawAdvice, deterministic context). There is no I/O path to bypass policy with.
//
// Pure + total: sanitize() never throws and performs no I/O, no clock, no randomness.
import type {
  RawAdvice,
  SafeAdvice,
  AdviceGateContext,
} from '../domain/advice.js';
import type { FailureClass, RecoveryKind } from '../domain/failure.js';

/** Default bound for context-rerank deltas when the context does not specify one. */
export const DEFAULT_MAX_RERANK_DELTA = 10;

export class AdviceGate {
  /**
   * Clamp raw advice into SafeAdvice, or return null if nothing survives. Null is the
   * fail-safe: the consumer must treat null as "no advice" and keep its deterministic default
   * (LE-002). The gate NEVER widens the deterministic bounds in `ctx`.
   */
  sanitize(raw: RawAdvice | null | undefined, ctx: AdviceGateContext = {}): SafeAdvice | null {
    if (raw === null || raw === undefined) return null;

    switch (raw.kind) {
      case 'recovery_order':
        return this.sanitizeRecoveryOrder(raw.failureClass, raw.order, ctx.allowedActions);
      case 'context_rerank':
        return this.sanitizeRerank(raw.deltas, ctx.candidatePaths, ctx.maxRerankDelta);
      case 'no_progress':
        // A boolean nudge has no bound to clamp; it passes through as a gated signal. It
        // carries zero authority — the NoProgressPolicy still decides (LE-001).
        return { kind: 'no_progress', likelyStuck: raw.likelyStuck === true };
      default:
        // Unknown advice kind → drop entirely (fail-closed).
        return null;
    }
  }

  // ── recovery order ─────────────────────────────────────────────────────────────

  /**
   * Intersect the proposed order with the policy's allowed-set: keep only allowed actions, in
   * the proposed order, de-duplicated. The result is a subset-permutation of allowedActions —
   * never a superset, never with unknown entries (LE-003). Returns null when there is no
   * allowed-set to clamp against, or nothing survives, or the order equals the allowed-set's
   * own order (no-op → null so the consumer keeps its default, LE-002).
   */
  private sanitizeRecoveryOrder(
    failureClass: FailureClass,
    proposed: readonly RecoveryKind[],
    allowedActions: readonly RecoveryKind[] | undefined,
  ): SafeAdvice | null {
    if (allowedActions === undefined || allowedActions.length === 0) return null;
    const allowed = new Set(allowedActions);

    const seen = new Set<RecoveryKind>();
    const order: RecoveryKind[] = [];
    for (const a of proposed) {
      if (!allowed.has(a)) continue;   // drop anything the advisor invented (LE-003)
      if (seen.has(a)) continue;       // drop duplicates
      seen.add(a);
      order.push(a);
    }

    if (order.length === 0) return null;

    // A proposal that is identical to the allowed-set's own order changes nothing → null, so
    // the consumer keeps its deterministic default rather than carrying a redundant advice.
    const sameAsDefault =
      order.length === allowedActions.length &&
      order.every((a, i) => a === allowedActions[i]);
    if (sameAsDefault) return null;

    return { kind: 'recovery_order', failureClass, order };
  }

  // ── context rerank ─────────────────────────────────────────────────────────────

  /**
   * Clamp each proposed delta to [-maxDelta, +maxDelta] and keep only paths in the current
   * candidate set (LE-003). Non-finite deltas and zero deltas are dropped. Returns null when
   * nothing survives.
   */
  private sanitizeRerank(
    proposed: Readonly<Record<string, number>>,
    candidatePaths: readonly string[] | undefined,
    maxRerankDelta: number | undefined,
  ): SafeAdvice | null {
    const candidates = candidatePaths !== undefined ? new Set(candidatePaths) : undefined;
    const maxDelta = this.resolveMaxDelta(maxRerankDelta);

    const deltas: Record<string, number> = {};
    // Deterministic iteration: sort the proposed paths so the output is order-stable.
    for (const path of Object.keys(proposed).sort()) {
      if (candidates !== undefined && !candidates.has(path)) continue; // outside candidate set
      const raw = proposed[path];
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw === 0) continue;
      const clamped = Math.max(-maxDelta, Math.min(maxDelta, raw));
      deltas[path] = clamped;
    }

    if (Object.keys(deltas).length === 0) return null;
    return { kind: 'context_rerank', deltas, maxDelta };
  }

  private resolveMaxDelta(maxRerankDelta: number | undefined): number {
    if (maxRerankDelta === undefined || !Number.isFinite(maxRerankDelta) || maxRerankDelta <= 0) {
      return DEFAULT_MAX_RERANK_DELTA;
    }
    return maxRerankDelta;
  }
}
