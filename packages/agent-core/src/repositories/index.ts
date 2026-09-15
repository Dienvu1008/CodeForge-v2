// Repository interfaces (C7) — DOMAIN_CONTRACTS §23. RI-1..RI-8.
//
// Immutable entities have NO update() (RI-7). Every repo has getById() (RI-8).
// These are CONTRACTS only; concrete SQLite adapters live in infrastructure (Phase 1).
import type { Session } from '../domain/session.js';
import type { Task } from '../domain/task.js';
import type { TaskRun } from '../domain/task.js';
import type { VerificationReport } from '../domain/verification.js';
import type { DomainEvent } from '../domain/event.js';
import type { TaskGraph, GraphMutation } from '../graph/types.js';

// §23.1
export interface SessionRepository {
  create(session: Session): Promise<void>;
  getById(sessionId: string): Promise<Session | null>;
  getActiveByWorkspace(workspaceId: string): Promise<Session | null>;
  update(session: Session): Promise<void>; // Session is a mutable-state aggregate
}

// §23.2 — Task is immutable: no update(), only supersede.
export interface TaskRepository {
  create(task: Task): Promise<void>;
  getById(taskId: string): Promise<Task | null>;
  supersede(oldTaskId: string, newTask: Task): Promise<void>;
}

// §23.3
export interface TaskGraphRepository {
  getCurrent(sessionId: string): Promise<TaskGraph>;
  getVersion(sessionId: string, version: number): Promise<TaskGraph | null>;
  commit(graph: TaskGraph, mutation: GraphMutation): Promise<void>;
}

// §23.4 — TaskRun is immutable after finalize: no update() after finalize.
export interface TaskRunPatch {
  readonly state: TaskRun['state'];
  readonly endedAt: string;
  readonly workspaceRevisionAtEnd?: TaskRun['workspaceRevisionAtEnd'];
  readonly verificationId?: string;
}

export interface TaskRunRepository {
  create(run: TaskRun): Promise<void>;
  getById(runId: string): Promise<TaskRun | null>;
  finalize(runId: string, patch: TaskRunPatch): Promise<void>;
}

// §23.5
export interface VerificationRepository {
  create(report: VerificationReport): Promise<void>;
  getById(id: string): Promise<VerificationReport | null>;
  getByTask(taskId: string): Promise<readonly VerificationReport[]>;
  getLatestForRevision(revisionId: string): Promise<VerificationReport | null>;
}

// §23.6
export interface EventFilter {
  readonly sessionId?: string;
  readonly aggregateId?: string;
  readonly type?: string;
  readonly fromSequence?: number;
}

export interface EventLog {
  append(event: DomainEvent): Promise<void>;
  stream(sessionId: string, fromSequence?: number): AsyncIterable<DomainEvent>;
  query(filter: EventFilter): Promise<readonly DomainEvent[]>;
}
