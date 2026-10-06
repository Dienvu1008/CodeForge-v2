// AuditTimeline (P9.10) — pure, deterministic REPLAY/AUDIT view over the event log.
// Enforces OB-004/OB-007.
//
// Where ActivityTrace answers "what happened", the audit timeline answers "why, and under
// whose authority" — WITHOUT raw chain-of-thought. buildAuditTimeline() is a total
// function of the (already-redacted, sequence-ordered) events: each entry is tagged with a
// pipeline PHASE (goal -> plan -> schedule -> tool -> verify -> recovery -> complete) and
// an AUTHORITY PATH (the kernel authority that produced/admitted the event). Replaying the
// same events always yields the same timeline (deterministic, auditable).
import type { DomainEvent, EventType } from '../domain/event.js';
import { buildActivityTrace, type ReasonCategory } from './activity-trace.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Coarse pipeline phase an event belongs to (the "Goal -> ... -> Completion" spine). */
export type AuditPhase =
  | 'goal'
  | 'plan'
  | 'schedule'
  | 'tool'
  | 'verify'
  | 'recovery'
  | 'control'
  | 'checkpoint'
  | 'lifecycle';

/**
 * The kernel authority responsible for an event — the "authority path" §13 asks for.
 * This is derived from the event type; it documents WHICH authority admitted/produced the
 * effect, so an auditor can see no effect bypassed its authority.
 */
export type AuthorityPath =
  | 'Planner->GraphCommit'      // graph mutations: proposed by planner, committed by GI-009
  | 'Scheduler'                 // task readiness / run start
  | 'ToolGateway->Policy'       // tool calls: gated by TG-001/Policy
  | 'VerificationEngine->CompletionGate' // verification: TI-005
  | 'RecoveryEngine'            // failure analysis / recovery actions
  | 'ControlPlane->Policy'      // external control (OB-006)
  | 'ApprovalEngine'            // human approval / override
  | 'SessionStateMachine'       // session lifecycle transitions
  | 'CheckpointService'
  | 'Budget'
  | 'none';

export interface AuditEntry {
  readonly sequenceNumber: number;
  readonly at: string;
  readonly eventType: EventType;
  readonly phase: AuditPhase;
  readonly category: ReasonCategory;
  /** Which kernel authority produced/admitted this event (never bypassed). */
  readonly authorityPath: AuthorityPath;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly action: string;
  readonly evidenceRefs: readonly string[];
}

export interface AuditTimeline {
  readonly sessionId: string;
  readonly entries: readonly AuditEntry[];
  /** Count of entries per phase (deterministic summary for the audit header). */
  readonly phaseCounts: Readonly<Record<AuditPhase, number>>;
}

// ── Phase + authority mapping (deterministic, derived from event type) ──────────

function phaseOf(type: EventType): AuditPhase {
  const t = String(type);
  if (t.startsWith('GOAL_')) return 'goal';
  if (t.startsWith('GRAPH_')) return 'plan';
  if (t.startsWith('TASK_RUN_') || t === 'TASK_STATE_CHANGED') return 'schedule';
  if (t.startsWith('TOOL_CALL_')) return 'tool';
  if (t.startsWith('VERIFICATION_')) return 'verify';
  if (t.startsWith('FAILURE_') || t.startsWith('RECOVERY_')) return 'recovery';
  if (t.startsWith('CONTROL_') || t.startsWith('HUMAN_')) return 'control';
  if (t.startsWith('CHECKPOINT_')) return 'checkpoint';
  return 'lifecycle';
}

function authorityOf(type: EventType): AuthorityPath {
  const t = String(type);
  if (t.startsWith('GRAPH_')) return 'Planner->GraphCommit';
  if (t.startsWith('TASK_RUN_')) return 'Scheduler';
  if (t === 'TASK_STATE_CHANGED' || t === 'TASK_CREATED' || t === 'TASK_SUPERSEDED') return 'Scheduler';
  if (t.startsWith('TOOL_CALL_')) return 'ToolGateway->Policy';
  if (t.startsWith('VERIFICATION_')) return 'VerificationEngine->CompletionGate';
  if (t.startsWith('FAILURE_') || t.startsWith('RECOVERY_')) return 'RecoveryEngine';
  if (t.startsWith('HUMAN_APPROVAL_') || t === 'HUMAN_OVERRIDE_COMPLETED') return 'ApprovalEngine';
  if (t.startsWith('CONTROL_')) return 'ControlPlane->Policy';
  if (t.startsWith('SESSION_')) return 'SessionStateMachine';
  if (t.startsWith('CHECKPOINT_')) return 'CheckpointService';
  if (t.startsWith('BUDGET_')) return 'Budget';
  return 'none';
}

const ALL_PHASES: readonly AuditPhase[] = [
  'goal', 'plan', 'schedule', 'tool', 'verify', 'recovery', 'control', 'checkpoint', 'lifecycle',
];

// ── buildAuditTimeline ──────────────────────────────────────────────────────────

/**
 * Build a replayable audit timeline from a session's events. Pure + total: it reuses the
 * (redacted, no-CoT) ActivityTrace entries and augments each with phase + authority path.
 * Replaying the same events yields the same timeline, so an auditor can reconstruct "why
 * CodeForge did this" without any private reasoning trace.
 */
export function buildAuditTimeline(sessionId: string, events: readonly DomainEvent[]): AuditTimeline {
  const trace = buildActivityTrace(sessionId, events);
  const phaseCounts: Record<AuditPhase, number> = Object.fromEntries(
    ALL_PHASES.map((p) => [p, 0]),
  ) as Record<AuditPhase, number>;

  const entries: AuditEntry[] = trace.entries.map((e) => {
    const phase = phaseOf(e.eventType);
    phaseCounts[phase] += 1;
    return {
      sequenceNumber: e.sequenceNumber,
      at: e.at,
      eventType: e.eventType,
      phase,
      category: e.category,
      authorityPath: authorityOf(e.eventType),
      aggregateKind: e.aggregateKind,
      aggregateId: e.aggregateId,
      action: e.action,
      evidenceRefs: e.evidenceRefs,
    };
  });

  return { sessionId, entries, phaseCounts };
}
