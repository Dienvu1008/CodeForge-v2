// DomainEvent — DOMAIN_CONTRACTS §18. Append-only, per-session monotonic sequence (OB-*, CP-008).
import type { Provenance } from './provenance.js';

export type EventAggregateKind =
  | 'session'
  | 'task'
  | 'task_run'
  | 'graph'
  | 'tool_call'
  | 'verification'
  | 'budget'
  | 'workspace'
  | 'failure'
  | 'recovery';

// Known event types (§18.2). Not exhaustive; kept as a union of common types plus string
// for forward-compatibility with new event kinds added in later phases.
export type KnownEventType =
  | 'SESSION_CREATED'
  | 'SESSION_STATE_CHANGED'
  | 'SESSION_COMPLETED'
  | 'SESSION_ABORTED'
  | 'GOAL_CREATED'
  | 'GOAL_SUPERSEDED'
  | 'TASK_CREATED'
  | 'TASK_STATE_CHANGED'
  | 'TASK_SUPERSEDED'
  | 'GRAPH_VERSION_CREATED'
  | 'GRAPH_MUTATION_PROPOSED'
  | 'GRAPH_MUTATION_COMMITTED'
  | 'GRAPH_MUTATION_REJECTED'
  | 'TASK_RUN_STARTED'
  | 'TASK_RUN_ENDED'
  | 'TOOL_CALL_REQUESTED'
  | 'TOOL_CALL_APPROVED'
  | 'TOOL_CALL_DENIED'
  | 'TOOL_CALL_STARTED'
  | 'TOOL_CALL_ENDED'
  | 'VERIFICATION_STARTED'
  | 'VERIFICATION_ENDED'
  | 'FAILURE_DETECTED'
  | 'RECOVERY_ACTION_CHOSEN'
  | 'RECOVERY_ACTION_ENDED'
  | 'BUDGET_ALLOCATED'
  | 'BUDGET_CONSUMED'
  | 'BUDGET_EXHAUSTED'
  | 'CHECKPOINT_CREATED'
  | 'CHECKPOINT_DIRTY_AT_CAPTURE'
  | 'CHECKPOINT_LOADED'
  | 'WORKSPACE_REVISION_COMPUTED'
  | 'WORKSPACE_CHANGE_RECORDED'
  | 'WORKSPACE_EXTERNAL_MUTATION'
  | 'HUMAN_APPROVAL_REQUESTED'
  | 'HUMAN_APPROVAL_GRANTED'
  | 'HUMAN_APPROVAL_DENIED'
  | 'HUMAN_OVERRIDE_COMPLETED'
  | 'TRANSITION_REJECTED'
  | 'EFFECT_FAILED';

export type EventType = KnownEventType | (string & {});

export interface DomainEvent {
  readonly eventId: string; // ULID
  readonly sessionId: string;

  readonly type: EventType;
  readonly aggregate: {
    readonly kind: EventAggregateKind;
    readonly id: string;
  };

  readonly payload: unknown;
  readonly provenance?: Provenance;

  readonly at: string;
  readonly sequenceNumber: number; // per-session monotonic
}
