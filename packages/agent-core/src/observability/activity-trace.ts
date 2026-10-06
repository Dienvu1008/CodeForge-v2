// ActivityTrace (P9.4) — pure, deterministic derivation of a STRUCTURED activity trace
// from the (already-redacted) event stream. Enforces OB-007.
//
// This is NOT a reasoning log. buildActivityTrace() maps each DomainEvent to a
// structured entry — action + decision category + evidence references + result — never a
// free-form "chain of thought". It is a total function of the events it is given; the
// events were redacted at persist time (PR-003/PR-004), so no secret can re-enter here,
// and there is no field in which raw model reasoning could be carried.
import type { DomainEvent, EventType } from '../domain/event.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** A coarse, enumerated category of why an action happened — NOT free-form reasoning. */
export type ReasonCategory =
  | 'lifecycle'      // session/task lifecycle transitions
  | 'planning'       // graph mutation / planning
  | 'scheduling'     // task became ready / selected
  | 'tool_use'       // tool call lifecycle
  | 'verification'   // verification lifecycle
  | 'approval'       // human approval / override
  | 'recovery'       // failure analysis / recovery
  | 'budget'         // budget allocation / exhaustion
  | 'checkpoint'     // checkpoint capture / load
  | 'control'        // external control (pause/resume/cancel)
  | 'other';

export interface ActivityEntry {
  readonly sequenceNumber: number;
  readonly at: string;
  readonly eventType: EventType;
  /** Which aggregate the activity concerns (session/task/tool_call/...). */
  readonly aggregateKind: string;
  readonly aggregateId: string;
  /** A short, enumerated category — never raw reasoning. */
  readonly category: ReasonCategory;
  /** Human-readable one-line description of the action (structured, redacted). */
  readonly action: string;
  /** References to supporting evidence (ids present in the event), not the raw content. */
  readonly evidenceRefs: readonly string[];
}

export interface ActivityTrace {
  readonly sessionId: string;
  readonly entries: readonly ActivityEntry[];
}

// ── Category mapping (deterministic) ───────────────────────────────────────────

function categoryOf(type: EventType): ReasonCategory {
  const t = String(type);
  if (t.startsWith('SESSION_') || t.startsWith('TASK_STATE') || t === 'TASK_CREATED' || t === 'TASK_SUPERSEDED') return 'lifecycle';
  if (t.startsWith('GRAPH_') || t === 'GOAL_CREATED' || t === 'GOAL_SUPERSEDED') return 'planning';
  if (t.startsWith('TASK_RUN_')) return 'scheduling';
  if (t.startsWith('TOOL_CALL_')) return 'tool_use';
  if (t.startsWith('VERIFICATION_')) return 'verification';
  if (t.startsWith('HUMAN_APPROVAL_') || t === 'HUMAN_OVERRIDE_COMPLETED') return 'approval';
  if (t.startsWith('FAILURE_') || t.startsWith('RECOVERY_')) return 'recovery';
  if (t.startsWith('BUDGET_')) return 'budget';
  if (t.startsWith('CHECKPOINT_')) return 'checkpoint';
  if (t.startsWith('CONTROL_')) return 'control';
  return 'other';
}

/** Keys in a payload that are safe, structured evidence references (ids), not content. */
const EVIDENCE_KEYS = [
  'taskId', 'taskRunId', 'toolCallId', 'approvalId', 'verificationId', 'reportId',
  'failureId', 'recoveryActionId', 'checkpointId', 'mutationId', 'revisionId',
  'graphVersion', 'from', 'to', 'state', 'status', 'scope',
] as const;

function evidenceRefsOf(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== 'object') return [];
  const refs: string[] = [];
  const rec = payload as Record<string, unknown>;
  for (const key of EVIDENCE_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' || typeof v === 'number') refs.push(`${key}=${v}`);
  }
  return refs;
}

// ── buildActivityTrace ────────────────────────────────────────────────────────

/**
 * Build a structured activity trace from a session's events. Pure + total: the entries
 * mirror the events (which are already ordered by sequenceNumber and redacted). Entry
 * order follows event order. No raw reasoning is ever included (OB-007).
 */
export function buildActivityTrace(sessionId: string, events: readonly DomainEvent[]): ActivityTrace {
  const entries: ActivityEntry[] = events
    .filter((e) => e.sessionId === sessionId)
    .map((e) => ({
      sequenceNumber: e.sequenceNumber,
      at: e.at,
      eventType: e.type,
      aggregateKind: e.aggregate.kind,
      aggregateId: e.aggregate.id,
      category: categoryOf(e.type),
      action: describe(e),
      evidenceRefs: evidenceRefsOf(e.payload),
    }));
  return { sessionId, entries };
}

/** A short structured description of the event — derived from type + aggregate, no reasoning. */
function describe(e: DomainEvent): string {
  return `${String(e.type)} on ${e.aggregate.kind}:${e.aggregate.id}`;
}
