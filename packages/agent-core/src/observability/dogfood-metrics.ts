// DogfoodMetrics (P9.12) — pure, deterministic measurement of a session's autonomous
// behavior, derived from the (already-redacted) event log. This is the EMPIRICAL
// substrate the master prompt asks for: once CodeForge runs real tasks, these metrics
// make its behavior measurable so future intelligence changes can be evaluated with
// evidence rather than claims (§15, §33).
//
// Observational only: computeSessionMetrics() is a total function of the events (plus an
// optional context snapshot). It counts lifecycle events, pairs started/ended events for
// durations, and summarizes verification/failure/recovery/intervention activity. It holds
// no authority and never mutates anything.
import type { DomainEvent, EventType } from '../domain/event.js';
import type { ContextSnapshot } from '../domain/context.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolMetrics {
  readonly requested: number;
  readonly approved: number;
  readonly denied: number;
  readonly started: number;
  readonly ended: number;
}

export interface VerificationMetrics {
  readonly started: number;
  readonly ended: number;
  readonly passed: number;
  readonly failed: number;
}

export interface RecoveryMetrics {
  readonly failuresDetected: number;
  readonly recoveryActions: number;
  /** Retry attempts inferred from repeated TASK_RUN_STARTED on the same task. */
  readonly taskRetries: number;
}

export interface InterventionMetrics {
  readonly approvalsRequested: number;
  readonly approvalsGranted: number;
  readonly approvalsDenied: number;
  readonly overrides: number;
  readonly controlActions: number;
}

export interface SessionMetrics {
  readonly sessionId: string;
  readonly eventCount: number;
  /** Wall-clock span from the first to the last event, in ms (0 if < 2 events). */
  readonly spanMs: number;
  /** terminal session outcome if observed (COMPLETED/ABORTED), else undefined. */
  readonly outcome?: 'COMPLETED' | 'ABORTED';

  readonly taskRunsStarted: number;
  readonly taskRunsEnded: number;
  readonly tasksCreated: number;

  readonly tools: ToolMetrics;
  readonly verification: VerificationMetrics;
  readonly recovery: RecoveryMetrics;
  readonly intervention: InterventionMetrics;

  readonly graphMutationsCommitted: number;
  readonly checkpointsCreated: number;

  /** Context usage snapshot, if a ContextSnapshot was supplied. */
  readonly context?: {
    readonly tokenBudget: number;
    readonly tokenUsed: number;
    readonly pressure: number;
    readonly itemCount: number;
  };

  /** Deterministic histogram of event types (sorted by type). */
  readonly eventTypeCounts: ReadonlyArray<{ readonly type: string; readonly count: number }>;
}

// ── computeSessionMetrics ────────────────────────────────────────────────────

/**
 * Compute behavior metrics for a session from its events. Pure + total: same events (and
 * optional context) → same metrics. Events must belong to one session; others are ignored.
 */
export function computeSessionMetrics(
  sessionId: string,
  events: readonly DomainEvent[],
  context?: ContextSnapshot,
): SessionMetrics {
  const own = events.filter((e) => e.sessionId === sessionId);
  const count = (type: EventType): number => own.filter((e) => e.type === type).length;

  // Task retries: a task with >1 TASK_RUN_STARTED retried (sum of extra starts).
  const runStartsByTask = new Map<string, number>();
  for (const e of own) {
    if (e.type === 'TASK_RUN_STARTED') {
      const taskId = taskIdOf(e.payload) ?? e.aggregate.id;
      runStartsByTask.set(taskId, (runStartsByTask.get(taskId) ?? 0) + 1);
    }
  }
  let taskRetries = 0;
  for (const n of runStartsByTask.values()) if (n > 1) taskRetries += n - 1;

  // Event-type histogram (deterministic order).
  const histogram = new Map<string, number>();
  for (const e of own) histogram.set(String(e.type), (histogram.get(String(e.type)) ?? 0) + 1);
  const eventTypeCounts = [...histogram.entries()]
    .map(([type, c]) => ({ type, count: c }))
    .sort((a, b) => compareStr(a.type, b.type));

  // Session span (events are sequence-ordered; use first/last timestamps).
  const spanMs = own.length >= 2
    ? Math.max(0, Date.parse(own[own.length - 1]!.at) - Date.parse(own[0]!.at))
    : 0;

  const outcome: SessionMetrics['outcome'] =
    count('SESSION_COMPLETED') > 0 ? 'COMPLETED'
    : count('SESSION_ABORTED') > 0 ? 'ABORTED'
    : undefined;

  return {
    sessionId,
    eventCount: own.length,
    spanMs,
    ...(outcome !== undefined ? { outcome } : {}),
    taskRunsStarted: count('TASK_RUN_STARTED'),
    taskRunsEnded: count('TASK_RUN_ENDED'),
    tasksCreated: count('TASK_CREATED'),
    tools: {
      requested: count('TOOL_CALL_REQUESTED'),
      approved: count('TOOL_CALL_APPROVED'),
      denied: count('TOOL_CALL_DENIED'),
      started: count('TOOL_CALL_STARTED'),
      ended: count('TOOL_CALL_ENDED'),
    },
    verification: {
      started: count('VERIFICATION_STARTED'),
      ended: count('VERIFICATION_ENDED'),
      passed: own.filter((e) => e.type === 'VERIFICATION_ENDED' && statusOf(e.payload) === 'PASS').length,
      failed: own.filter((e) => e.type === 'VERIFICATION_ENDED' && isFailStatus(statusOf(e.payload))).length,
    },
    recovery: {
      failuresDetected: count('FAILURE_DETECTED') + count('TASK_FAILED'),
      recoveryActions: count('RECOVERY_ACTION_CHOSEN') + count('RECOVERY_ACTION_TAKEN') + count('RECOVERY_ACTION_ENDED'),
      taskRetries,
    },
    intervention: {
      approvalsRequested: count('HUMAN_APPROVAL_REQUESTED'),
      approvalsGranted: count('HUMAN_APPROVAL_GRANTED'),
      approvalsDenied: count('HUMAN_APPROVAL_DENIED'),
      overrides: count('HUMAN_OVERRIDE_COMPLETED'),
      controlActions: own.filter((e) => String(e.type).startsWith('CONTROL_')).length,
    },
    graphMutationsCommitted: count('GRAPH_MUTATION_COMMITTED'),
    checkpointsCreated: count('CHECKPOINT_CREATED'),
    ...(context !== undefined
      ? {
          context: {
            tokenBudget: context.tokenBudget,
            tokenUsed: context.tokenUsed,
            pressure: context.tokenBudget > 0 ? context.tokenUsed / context.tokenBudget : 0,
            itemCount: context.items.length,
          },
        }
      : {}),
    eventTypeCounts,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function taskIdOf(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)['taskId'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
function statusOf(payload: unknown): string | undefined {
  if (payload !== null && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)['status'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
function isFailStatus(status: string | undefined): boolean {
  return status === 'FAIL' || status === 'INVALID' || status === 'ERROR';
}
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
