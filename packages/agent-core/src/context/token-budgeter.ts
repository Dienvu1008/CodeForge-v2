// TokenBudgeter — CONTEXT_SPEC §8, P2-CX1.
//
// Fits ContextItems into the available token budget.
// CX-004: token budget is a HARD LIMIT — never exceeded, never silently truncated.
//
// Algorithm (§8.4):
//   1. Sort items: pinned first, then by priority desc.
//   2. Add pinned items unconditionally; if they exceed budget → throw CONTEXT_BUDGET_EXCEEDED.
//   3. Add non-pinned items greedily until budget exhausted.
//   4. If a non-pinned item overflows: truncate (head + tail) if policy allows, else skip.
import type { ContextItem } from '../domain/context.js';
import { countTokens } from './token-counter.js';

// ── BudgetConfig ──────────────────────────────────────────────────────────────

export interface BudgetConfig {
  /** Total tokens available for context items. */
  readonly availableTokens: number;
  /**
   * If true, oversized non-pinned items are truncated; if false they are skipped.
   * Default: true.
   */
  readonly allowTruncation?: boolean;
  /**
   * Max characters for a truncated item snippet (head + '...' + tail).
   * Default: 800 chars ≈ 200 tokens.
   */
  readonly truncationMaxChars?: number;
}

// ── BudgetResult ──────────────────────────────────────────────────────────────

export interface BudgetResult {
  readonly items: readonly ContextItem[];
  readonly tokenUsed: number;
  /** Items that were dropped (non-pinned, did not fit). */
  readonly dropped: readonly string[]; // itemIds
}

// ── ContextBudgetError ────────────────────────────────────────────────────────

export class ContextBudgetError extends Error {
  public readonly code: 'CONTEXT_BUDGET_EXCEEDED';
  constructor(message?: string) {
    super(message ?? 'CONTEXT_BUDGET_EXCEEDED');
    this.name = 'ContextBudgetError';
    this.code = 'CONTEXT_BUDGET_EXCEEDED';
  }
}

// ── fitToBudget ───────────────────────────────────────────────────────────────

/**
 * Fit `items` into the available token budget.
 *
 * CX-004: throws `ContextBudgetError` if pinned items alone exceed budget.
 * Deterministic: same items + same config → same result.
 */
export function fitToBudget(
  items: readonly ContextItem[],
  config: BudgetConfig,
): BudgetResult {
  const allowTruncation = config.allowTruncation ?? true;
  const truncMaxChars   = config.truncationMaxChars ?? 800;

  // Sort: pinned first, then priority desc, then itemId asc (stable).
  const sorted = [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.itemId.localeCompare(b.itemId);
  });

  let tokenUsed = 0;
  const result: ContextItem[] = [];
  const dropped: string[] = [];

  for (const item of sorted) {
    const tokens = item.tokenCount;

    if (item.pinned) {
      // Pinned items are mandatory. Overflow → fail fast (CX-004, §8.5).
      if (tokenUsed + tokens > config.availableTokens) {
        throw new ContextBudgetError(
          `Pinned items exceed token budget: ${tokenUsed + tokens} > ${config.availableTokens}`,
        );
      }
      result.push(item);
      tokenUsed += tokens;
      continue;
    }

    if (tokenUsed + tokens <= config.availableTokens) {
      // Fits without truncation.
      result.push(item);
      tokenUsed += tokens;
    } else if (allowTruncation && tokenUsed < config.availableTokens) {
      // Truncate: head + '...' + tail to fit remaining budget.
      const remaining = config.availableTokens - tokenUsed;
      const truncated = truncate(item.content, Math.min(truncMaxChars, remaining * 4));
      if (truncated.length === 0) {
        dropped.push(item.itemId);
        continue;
      }
      const truncTokens = countTokens(truncated);
      if (tokenUsed + truncTokens > config.availableTokens) {
        dropped.push(item.itemId);
        continue;
      }
      const note = `[truncated: original ${item.content.length} chars, showing ${truncated.length}]`;
      result.push({
        ...item,
        content:       truncated,
        tokenCount:    truncTokens,
        truncated:     true,
        truncationNote: note,
      });
      tokenUsed += truncTokens;
    } else {
      dropped.push(item.itemId);
    }
  }

  return { items: result, tokenUsed, dropped };
}

// ── truncate helper ───────────────────────────────────────────────────────────

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2) - 2;
  if (half <= 0) return '';
  return `${content.slice(0, half)}\n...\n${content.slice(-half)}`;
}
