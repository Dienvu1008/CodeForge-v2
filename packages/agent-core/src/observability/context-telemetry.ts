// ContextTelemetry (P9.2) — pure, deterministic rollup of a ContextSnapshot into
// observable context-usage telemetry. Enforces OB-010.
//
// This is a READ-ONLY DERIVATION: computeContextTelemetry() is a total function of an
// immutable ContextSnapshot (plus an optional discarded-id list the TokenBudgeter
// already produces). It performs no I/O, holds no builder/selector handle, and never
// feeds back into context selection — selection stays with ContextBuilder + the
// TokenBudgeter (CX-004). Telemetry observes; it does not decide what enters context.
import type { ContextSnapshot, ContextItemKind, ContextItem } from '../domain/context.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Token usage attributed to one context category (a ContextItemKind). */
export interface CategoryUsage {
  readonly kind: ContextItemKind;
  readonly tokens: number;
  readonly itemCount: number;
  /** Share of the snapshot's used tokens, 0..1 (0 when the snapshot used 0 tokens). */
  readonly fraction: number;
}

export interface ContextTelemetry {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly taskId?: string;

  readonly tokenBudget: number;
  readonly tokenUsed: number;
  /** tokenUsed / tokenBudget, 0..1 (0 when budget is 0). The "pressure" signal. */
  readonly pressure: number;
  readonly tokensRemaining: number;

  /** Per-category breakdown, sorted by tokens desc then kind asc (deterministic). */
  readonly byCategory: readonly CategoryUsage[];
  /** The single largest contributor by tokens, if any item is present. */
  readonly largestCategory?: ContextItemKind;

  readonly itemCount: number;
  readonly pinnedCount: number;
  readonly truncatedCount: number;
  readonly untrustedCount: number;

  /** Item ids the TokenBudgeter dropped (did not fit). Observational only. */
  readonly discardedItemIds: readonly string[];
}

// ── computeContextTelemetry ────────────────────────────────────────────────────

/**
 * Derive telemetry from a ContextSnapshot. Pure + total: same snapshot → same
 * telemetry. `discardedItemIds` are the ids the TokenBudgeter reported as dropped
 * (BudgetResult.dropped); pass [] when not tracked.
 */
export function computeContextTelemetry(
  snapshot: ContextSnapshot,
  discardedItemIds: readonly string[] = [],
): ContextTelemetry {
  const byKind = new Map<ContextItemKind, { tokens: number; itemCount: number }>();
  let pinnedCount = 0;
  let truncatedCount = 0;
  let untrustedCount = 0;

  for (const item of snapshot.items) {
    const acc = byKind.get(item.kind) ?? { tokens: 0, itemCount: 0 };
    acc.tokens += item.tokenCount;
    acc.itemCount += 1;
    byKind.set(item.kind, acc);
    if (item.pinned) pinnedCount += 1;
    if (item.truncated) truncatedCount += 1;
    if (item.trust === 'untrusted') untrustedCount += 1;
  }

  const used = snapshot.tokenUsed;
  const byCategory: CategoryUsage[] = [...byKind.entries()]
    .map(([kind, v]) => ({
      kind,
      tokens: v.tokens,
      itemCount: v.itemCount,
      fraction: used > 0 ? v.tokens / used : 0,
    }))
    .sort((a, b) => (b.tokens !== a.tokens ? b.tokens - a.tokens : compareStr(a.kind, b.kind)));

  const budget = snapshot.tokenBudget;
  return {
    snapshotId: snapshot.snapshotId,
    sessionId: snapshot.sessionId,
    ...(snapshot.taskId !== undefined ? { taskId: snapshot.taskId } : {}),
    tokenBudget: budget,
    tokenUsed: used,
    pressure: budget > 0 ? used / budget : 0,
    tokensRemaining: Math.max(0, budget - used),
    byCategory,
    ...(byCategory.length > 0 ? { largestCategory: byCategory[0]!.kind } : {}),
    itemCount: snapshot.items.length,
    pinnedCount,
    truncatedCount,
    untrustedCount,
    discardedItemIds: [...discardedItemIds].sort(compareStr),
  };
}

/** Convenience: the token total of a set of items (used by callers/tests). */
export function sumItemTokens(items: readonly ContextItem[]): number {
  return items.reduce((n, it) => n + it.tokenCount, 0);
}

/** Total, locale-independent string order (deterministic across platforms). */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
