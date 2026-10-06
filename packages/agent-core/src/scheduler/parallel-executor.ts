// ParallelExecutor (P8-PX1) — deterministic parallel-batch planner. Enforces AU-001/003/004.
//
// This is a PLANNER, not an executor: planParallelBatch() is a pure function of
// (schedulable task ids, concurrency cap, per-task budget cost, parent remaining
// budget). It decides WHICH ready tasks may run concurrently; it never touches the
// filesystem, model, or tools. Actual execution of each admitted task still goes
// through the existing ExecutionCoordinator / ToolGateway / Policy — so parallelism
// opens no new path into the kernel (AU-001: no bypass).
//
// Independence (AU-001): inputs are tasks the Scheduler already marked `schedulable`
// (i.e. READY — all dependencies PASSED, SC-003). READY tasks are mutually
// independent by construction, so a batch of them is safe to run concurrently.
//
// Determinism (AU-003): admission is a total function of the inputs — schedulable
// ids are processed in sorted order, no clock, no randomness. Same input → same batch.
//
// Budget (AU-004): parallelism must not escape the hierarchical cap. Admission stops
// when the CUMULATIVE estimated cost of the batch would exceed the parent's remaining
// budget — a parallel batch can never consume more than one sequential run could.
import type { BudgetConsumption, BudgetLimits } from '../domain/budget.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Estimated cost of running one task (same shape as a budget consumption delta). */
export type TaskCost = BudgetConsumption;

export type DeferReason = 'concurrency' | 'budget';

export interface ParallelBatchInput {
  /** READY + budget-ok task ids (from Scheduler.computeSchedule().schedulable). */
  readonly schedulable: readonly string[];
  /** Max tasks allowed to run concurrently (>= 1). */
  readonly maxConcurrency: number;
  /** Per-task estimated cost. Missing entry → treated as zero cost. */
  readonly cost?: ReadonlyMap<string, TaskCost>;
  /** Parent budget remaining (limits - consumed). When omitted, budget is not a constraint. */
  readonly parentRemaining?: BudgetLimits;
}

export interface DeferredTask {
  readonly taskId: string;
  readonly reason: DeferReason;
}

export interface ParallelBatch {
  /** Task ids admitted to run concurrently, in deterministic order. */
  readonly admitted: readonly string[];
  /** Tasks held back this round, with why. */
  readonly deferred: readonly DeferredTask[];
}

// ── planParallelBatch ────────────────────────────────────────────────────────

const ZERO_COST: TaskCost = { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 };

/**
 * Deterministically select the batch of schedulable tasks that may run in parallel
 * this round, respecting the concurrency cap (AU-003) and the parent budget (AU-004).
 *
 * Algorithm (pure, total): process schedulable ids in sorted order; admit a task iff
 *   (a) the batch has fewer than maxConcurrency members, AND
 *   (b) adding its cost keeps the batch's cumulative cost within parentRemaining.
 * Otherwise defer it with the binding reason. Concurrency is checked before budget,
 * so a task blocked purely by the cap is reported as 'concurrency'.
 */
export function planParallelBatch(input: ParallelBatchInput): ParallelBatch {
  const cap = Math.max(0, Math.floor(input.maxConcurrency));
  const ids = [...input.schedulable].sort();
  const admitted: string[] = [];
  const deferred: DeferredTask[] = [];
  // Mutable accumulator for the batch's cumulative cost (TaskCost is readonly).
  const running = { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 };

  for (const taskId of ids) {
    if (admitted.length >= cap) {
      deferred.push({ taskId, reason: 'concurrency' });
      continue;
    }
    const c = input.cost?.get(taskId) ?? ZERO_COST;
    if (input.parentRemaining !== undefined && !fitsWithin(running, c, input.parentRemaining)) {
      deferred.push({ taskId, reason: 'budget' });
      continue;
    }
    admitted.push(taskId);
    running.wallClockMs      += c.wallClockMs;
    running.modelTokens      += c.modelTokens;
    running.toolCalls        += c.toolCalls;
    running.recoveryAttempts += c.recoveryAttempts;
  }

  return { admitted, deferred };
}

/** True iff running + next stays within every dimension of the remaining budget (AU-004, BU-001). */
function fitsWithin(
  running: { wallClockMs: number; modelTokens: number; toolCalls: number; recoveryAttempts: number },
  next: TaskCost,
  remaining: BudgetLimits,
): boolean {
  return (
    running.wallClockMs     + next.wallClockMs     <= remaining.wallClockMs &&
    running.modelTokens     + next.modelTokens     <= remaining.modelTokens &&
    running.toolCalls       + next.toolCalls       <= remaining.toolCalls &&
    running.recoveryAttempts + next.recoveryAttempts <= remaining.recoveryAttempts
  );
}
