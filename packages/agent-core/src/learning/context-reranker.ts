// ContextReranker — Phase 11 (P11.5). Applies gated learning advice to re-rank context items
// WITHIN the existing deterministic candidate list. It is a pure, standalone post-step: it
// never calls the Retriever, never changes the candidate SET, and never touches pinned items.
//
// Invariants:
//   LE-001 / CX-005: context stays context. Rerank only changes ORDER among non-pinned items;
//           it cannot add, drop, or re-trust an item, and the kernel still treats every item
//           as data. Pinned items (task/goal/failure/graph) never move.
//   LE-002: with no advice (null), rerank returns the input list UNCHANGED (same reference) —
//           so without learning the context order is exactly the Retriever's deterministic one.
//   LE-003: deltas are already clamped by AdviceGate to a bound and to current candidate paths;
//           the reranker applies them to a copy of `priority` only and never beyond.
//
// Determinism: pure function — stable sort by (pinned desc, effectivePriority desc, path asc,
// itemId asc). Equal inputs → equal output.
import type { ContextItem } from '../domain/context.js';
import type { SafeContextRerankAdvice } from '../domain/advice.js';

export class ContextReranker {
  /**
   * Return a re-ranked copy of `items` with the advice's bounded deltas applied to the
   * `priority` of matching NON-PINNED items, then stably re-sorted. With null/empty advice the
   * ORIGINAL array reference is returned unchanged (LE-002). The returned items are unmodified
   * objects from the input (same identities, same content) — only their order can differ.
   */
  rerank(items: readonly ContextItem[], advice: SafeContextRerankAdvice | null | undefined): readonly ContextItem[] {
    if (advice === null || advice === undefined) return items;
    const deltas = advice.deltas;
    if (Object.keys(deltas).length === 0) return items;

    // Effective priority = priority + (delta for its path, if non-pinned and matched).
    const effective = new Map<string, number>();
    let anyApplied = false;
    for (const item of items) {
      let p = item.priority;
      if (!item.pinned) {
        const path = item.source.path;
        if (path !== undefined && Object.prototype.hasOwnProperty.call(deltas, path)) {
          p += deltas[path]!;
          anyApplied = true;
        }
      }
      effective.set(item.itemId, p);
    }

    // No matching non-pinned item → nothing to do; keep the original reference (LE-002 spirit).
    if (!anyApplied) return items;

    // Stable, deterministic re-sort. Pinned items always precede non-pinned (CX-005: pinned
    // authority ordering is preserved); then by effective priority desc; then path asc; then
    // itemId asc as a total tiebreaker.
    return [...items].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const pa = effective.get(a.itemId)!;
      const pb = effective.get(b.itemId)!;
      if (pa !== pb) return pb - pa;
      const patha = a.source.path ?? '';
      const pathb = b.source.path ?? '';
      if (patha !== pathb) return patha < pathb ? -1 : 1;
      return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
    });
  }
}
