// BudgetEngine (P1-B1) — DOMAIN_CONTRACTS §15. Enforces BU-001/002/005 (pure part).
//
// PURE + DETERMINISTIC: remaining/exhausted/hierarchy checks are total functions of the
// budget values. No LLM (BU-006: the engine never reads model output; budgets come from
// policy), no wall-clock, no random. Atomic decrement (BU-003) is the repository's job;
// this module computes the deterministic decisions the repository enforces.
//
// A budget has 4 dimensions (wallClockMs, modelTokens, toolCalls, recoveryAttempts).
// remaining = limit - consumed per dimension (floored at 0). A budget is EXHAUSTED when
// ANY dimension is fully consumed (BU-005: exhausted must stop the task, never continue).
import type { Budget, BudgetLimits, BudgetConsumption } from '../domain/budget.js';

export type BudgetDimension = keyof BudgetLimits; // 'wallClockMs' | 'modelTokens' | 'toolCalls' | 'recoveryAttempts'

export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  'wallClockMs',
  'modelTokens',
  'toolCalls',
  'recoveryAttempts',
];

/** Remaining budget per dimension (floored at 0). */
export function remaining(budget: Budget): BudgetConsumption {
  const r = {} as Record<BudgetDimension, number>;
  for (const d of BUDGET_DIMENSIONS) {
    r[d] = Math.max(0, budget.limits[d] - budget.consumed[d]);
  }
  return r as BudgetConsumption;
}

/** BU-005: exhausted when ANY dimension has no remaining budget. */
export function isExhausted(budget: Budget): boolean {
  return BUDGET_DIMENSIONS.some((d) => budget.consumed[d] >= budget.limits[d]);
}

/** The dimensions that are exhausted (for diagnostics / stop reason). */
export function exhaustedDimensions(budget: Budget): BudgetDimension[] {
  return BUDGET_DIMENSIONS.filter((d) => budget.consumed[d] >= budget.limits[d]);
}

/**
 * BU-001: a child budget's LIMITS must not exceed the parent's REMAINING budget in any
 * dimension. Returns the violating dimensions (empty => allowed).
 */
export function childLimitViolations(
  parent: Budget,
  childLimits: BudgetLimits,
): BudgetDimension[] {
  const rem = remaining(parent);
  return BUDGET_DIMENSIONS.filter((d) => childLimits[d] > rem[d]);
}

export function canAllocateChild(parent: Budget, childLimits: BudgetLimits): boolean {
  return childLimitViolations(parent, childLimits).length === 0;
}

/**
 * Whether consuming `delta` would fit within the budget's remaining allowance. BU-005:
 * a consumption that would push any dimension past its limit is NOT allowed (the caller
 * must stop rather than silently overrun).
 */
export function canConsume(budget: Budget, delta: Partial<BudgetConsumption>): boolean {
  for (const d of BUDGET_DIMENSIONS) {
    const want = delta[d] ?? 0;
    if (want < 0) return false; // BU-006 spirit: no negative consumption (would "add" budget)
    if (budget.consumed[d] + want > budget.limits[d]) return false;
  }
  return true;
}

/** Pure application of a consumption delta (returns the new consumed vector). */
export function applyConsumption(
  consumed: BudgetConsumption,
  delta: Partial<BudgetConsumption>,
): BudgetConsumption {
  const next = {} as Record<BudgetDimension, number>;
  for (const d of BUDGET_DIMENSIONS) {
    next[d] = consumed[d] + (delta[d] ?? 0);
  }
  return next as BudgetConsumption;
}

/** BU-002: recovery is bounded — attempts must not exceed the recoveryAttempts limit. */
export function recoveryExhausted(budget: Budget): boolean {
  return budget.consumed.recoveryAttempts >= budget.limits.recoveryAttempts;
}

/** Raised when a consume/allocate would overrun the budget (BU-001/BU-005). */
export class BudgetError extends Error {
  public readonly code: 'BUDGET_EXHAUSTED' | 'BUDGET_OVERFLOW' | 'NOT_FOUND';
  public readonly dimensions: readonly BudgetDimension[];
  constructor(code: BudgetError['code'], dimensions: readonly BudgetDimension[] = [], message?: string) {
    super(message ?? `${code}: ${dimensions.join(',')}`);
    this.name = 'BudgetError';
    this.code = code;
    this.dimensions = dimensions;
  }
}
