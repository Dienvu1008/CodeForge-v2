// Repository interfaces (C7) — DOMAIN_CONTRACTS §23. RI-1..RI-8.
//
// Immutable entities have NO update() (RI-7). Every repo has getById() (RI-8).
// These are CONTRACTS only; concrete SQLite adapters live in infrastructure (Phase 1).
import type { Session } from '../domain/session.js';
import type { Goal } from '../domain/goal.js';
import type { Budget, BudgetConsumption } from '../domain/budget.js';
import type { Checkpoint } from '../domain/checkpoint.js';
import type { Task } from '../domain/task.js';
import type { TaskExecution } from '../domain/task.js';
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

// §3 — Goal is immutable + versioned (GL-001). No update(); a change creates a NEW
// version via supersede. `getById` returns the latest version; `getVersion` a specific one.
export interface GoalRepository {
  create(goal: Goal): Promise<void>;
  getById(goalId: string): Promise<Goal | null>; // latest version
  getVersion(goalId: string, version: number): Promise<Goal | null>;
  supersede(goalId: string, newGoal: Goal): Promise<void>;
}

// §23.2 — Task is immutable: no update(), only supersede.
export interface TaskRepository {
  create(task: Task): Promise<void>;
  getById(taskId: string): Promise<Task | null>;
  supersede(oldTaskId: string, newTask: Task): Promise<void>;
}

// §5 — TaskExecution is a MUTABLE projection (EX-003: not authority). It is derived
// from Task + TaskRun; upsert() replaces the projected row. `getByTask` reads it.
export interface TaskExecutionRepository {
  upsert(execution: TaskExecution): Promise<void>;
  getByTask(taskId: string): Promise<TaskExecution | null>;
}

// §16 — Checkpoint is immutable + written atomically (CP-002). `create` persists all
// metadata in ONE transaction. `getLatest` returns the newest checkpoint for a session.
export interface CheckpointRepository {
  create(checkpoint: Checkpoint): Promise<void>;
  getById(checkpointId: string): Promise<Checkpoint | null>;
  getLatest(sessionId: string): Promise<Checkpoint | null>;
}

// §15 — Budget hierarchy. `consume` decrements atomically (BU-003) and rejects an
// overrun (BU-005). `create` may be gated by the parent's remaining budget (BU-001).
export interface BudgetRepository {
  create(budget: Budget): Promise<void>;
  getById(budgetId: string): Promise<Budget | null>;
  getChildren(parentBudgetId: string): Promise<readonly Budget[]>;
  /**
   * Atomically add `delta` to the budget's consumed vector iff it does not overrun any
   * dimension. Returns the updated budget. Throws (BUDGET_EXHAUSTED) if it would overrun.
   */
  consume(budgetId: string, delta: Partial<BudgetConsumption>): Promise<Budget>;
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
  /** Runs still in RUNNING for a session — the unfinished set at crash recovery (CP-004). */
  findRunning(sessionId: string): Promise<readonly TaskRun[]>;
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
