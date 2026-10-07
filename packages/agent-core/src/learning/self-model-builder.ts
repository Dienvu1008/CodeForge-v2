// SelfModelBuilder — Phase 11 (P11.1). Builds a read-only SelfModel from run history.
//
// Guarantees:
//   LE-004: build() is a TOTAL, DETERMINISTIC function of its inputs. No wall-clock, no
//           randomness, no I/O. Inputs in any order produce the same output (we sort every
//           output key with a stable comparator). Equal inputs → byte-identical JSON.
//   LE-008: the model is derived ONLY from classification fields (failure class, recovery
//           kind/outcome, counts, the already-normalized Failure.signature). Raw payloads,
//           evidence messages, stderr, and file contents are never read into the model, so
//           no secret/PII can leak through this projection.
//   LE-001: this is a projection with zero authority — it decides nothing and mutates
//           nothing. It only summarizes what already happened.
import type { DomainEvent } from '../domain/event.js';
import type { Failure, RecoveryAction, FailureClass } from '../domain/failure.js';
import type {
  SelfModel,
  RecoveryOutcomeStat,
  FailureClassStat,
  FailureSignatureStat,
  ConvergenceStat,
} from '../domain/self-model.js';
import { SELF_MODEL_VERSION } from '../domain/self-model.js';

// ── Input ──────────────────────────────────────────────────────────────────────

export interface SelfModelInput {
  /** Redacted domain events (as returned by EventLog.query). May span multiple sessions. */
  readonly events: readonly DomainEvent[];
  /** Failures recorded for the covered sessions. */
  readonly failures: readonly Failure[];
  /** Recovery actions recorded for the covered failures. */
  readonly recoveryActions: readonly RecoveryAction[];
}

// ── Builder ──────────────────────────────────────────────────────────────────────

export class SelfModelBuilder {
  /**
   * Build the SelfModel. Pure + total: never throws on well-typed input, never performs
   * I/O, and is independent of input ordering.
   */
  build(input: SelfModelInput): SelfModel {
    const { events, failures, recoveryActions } = input;

    const sessionIds = this.sessionIds(events, failures);
    const recoveryOutcomes = this.recoveryOutcomes(failures, recoveryActions);
    const failureClasses = this.failureClasses(failures);
    const failureSignatures = this.failureSignatures(failures);
    const convergence = this.convergence(events, sessionIds);

    return {
      version: SELF_MODEL_VERSION,
      sessionIds,
      totals: {
        events: events.length,
        failures: failures.length,
        recoveryActions: recoveryActions.length,
        sessions: sessionIds.length,
      },
      recoveryOutcomes,
      failureClasses,
      failureSignatures,
      convergence,
    };
  }

  // ── session ids (sorted, de-duplicated) ───────────────────────────────────────

  private sessionIds(
    events: readonly DomainEvent[],
    failures: readonly Failure[],
  ): readonly string[] {
    const set = new Set<string>();
    for (const e of events) set.add(e.sessionId);
    for (const f of failures) set.add(f.sessionId);
    return [...set].sort(compareStr);
  }

  // ── recovery outcome stats, keyed by (failureClass, action) ───────────────────

  private recoveryOutcomes(
    failures: readonly Failure[],
    recoveryActions: readonly RecoveryAction[],
  ): readonly RecoveryOutcomeStat[] {
    // failureId → class, so each recovery action can be attributed to a failure class.
    const classOf = new Map<string, FailureClass>();
    for (const f of failures) classOf.set(f.failureId, f.class);

    // (class \u0001 action) → tally
    const buckets = new Map<
      string,
      { failureClass: FailureClass; action: RecoveryAction['action']; total: number; succeeded: number; failed: number; aborted: number }
    >();

    for (const a of recoveryActions) {
      const failureClass = classOf.get(a.failureId);
      if (failureClass === undefined) continue; // orphan action (no known failure) — skip
      // Only terminal outcomes count toward success-rate; PENDING is ignored (not yet known).
      if (a.outcome === 'PENDING') continue;

      const key = `${failureClass}\u0001${a.action}`;
      let b = buckets.get(key);
      if (b === undefined) {
        b = { failureClass, action: a.action, total: 0, succeeded: 0, failed: 0, aborted: 0 };
        buckets.set(key, b);
      }
      b.total += 1;
      if (a.outcome === 'SUCCEEDED') b.succeeded += 1;
      else if (a.outcome === 'FAILED') b.failed += 1;
      else if (a.outcome === 'ABORTED') b.aborted += 1;
    }

    return [...buckets.values()]
      .map((b) => ({
        failureClass: b.failureClass,
        action: b.action,
        total: b.total,
        succeeded: b.succeeded,
        failed: b.failed,
        aborted: b.aborted,
        successRate: b.total > 0 ? b.succeeded / b.total : 0,
      }))
      .sort((x, y) => compareStr(x.failureClass, y.failureClass) || compareStr(x.action, y.action));
  }

  // ── failure class frequency ────────────────────────────────────────────────────

  private failureClasses(failures: readonly Failure[]): readonly FailureClassStat[] {
    const counts = new Map<FailureClass, number>();
    for (const f of failures) counts.set(f.class, (counts.get(f.class) ?? 0) + 1);
    return [...counts.entries()]
      .map(([failureClass, count]) => ({ failureClass, count }))
      .sort((x, y) => compareStr(x.failureClass, y.failureClass));
  }

  // ── recurring failure signatures ─────────────────────────────────────────────────

  private failureSignatures(failures: readonly Failure[]): readonly FailureSignatureStat[] {
    const counts = new Map<string, { count: number; failureClass: FailureClass }>();
    for (const f of failures) {
      const existing = counts.get(f.signature);
      if (existing === undefined) counts.set(f.signature, { count: 1, failureClass: f.class });
      else existing.count += 1;
    }
    return [...counts.entries()]
      .map(([signature, v]) => ({ signature, count: v.count, failureClass: v.failureClass }))
      // Most recurring first; stable tie-break by signature asc.
      .sort((x, y) => y.count - x.count || compareStr(x.signature, y.signature));
  }

  // ── per-session convergence ────────────────────────────────────────────────────

  private convergence(
    events: readonly DomainEvent[],
    sessionIds: readonly string[],
  ): readonly ConvergenceStat[] {
    return sessionIds
      .map((sessionId) => {
        const own = events.filter((e) => e.sessionId === sessionId);
        const count = (type: string): number => own.filter((e) => e.type === type).length;

        // Retries: a task with >1 TASK_RUN_STARTED contributes (n-1) retries.
        const runStartsByTask = new Map<string, number>();
        for (const e of own) {
          if (e.type === 'TASK_RUN_STARTED') {
            const taskId = taskIdOf(e.payload) ?? e.aggregate.id;
            runStartsByTask.set(taskId, (runStartsByTask.get(taskId) ?? 0) + 1);
          }
        }
        let taskRetries = 0;
        for (const n of runStartsByTask.values()) if (n > 1) taskRetries += n - 1;

        const outcome: ConvergenceStat['outcome'] =
          count('SESSION_COMPLETED') > 0 ? 'COMPLETED'
          : count('SESSION_ABORTED') > 0 ? 'ABORTED'
          : undefined;

        return {
          sessionId,
          decisions: count('DECISION_COMPLETED'),
          taskRunsStarted: count('TASK_RUN_STARTED'),
          taskRunsEnded: count('TASK_RUN_ENDED'),
          taskRetries,
          ...(outcome !== undefined ? { outcome } : {}),
        };
      })
      .sort((x, y) => compareStr(x.sessionId, y.sessionId));
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function taskIdOf(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)['taskId'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
