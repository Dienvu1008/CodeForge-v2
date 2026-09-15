// TaskService (P1-T1) — DOMAIN_CONTRACTS §4, TI-001..TI-004.
//
// Task is intent, immutable after commit. This service enforces:
//   - TI-001: identity immutable — a new task always gets a fresh taskId (never reuse).
//   - TI-002: content (description/acceptanceCriteria/constraints) immutable — no update();
//     change is expressed by SUPERSEDE (below), never in-place mutation.
//   - TI-003: no dependency data lives on a Task — validated structurally + a runtime
//     guard that rejects any leaked dependency-like field on the raw input.
//   - TI-004: a Task is never rebound to another; supersede creates a NEW task and links
//     the old one (TaskRepository.supersede is atomic).
// TI-006 (terminal state immutable) is a TaskExecution/StateMachine concern (P1-SM1/T2).
//
// Effects run over injected CONTRACTS (TaskRepository, EventLog) — no infra import.
import type { Task } from '../domain/task.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { TaskRepository, EventLog } from '../repositories/index.js';

export class TaskError extends Error {
  public readonly code:
    | 'EMPTY_DESCRIPTION'
    | 'DEP_IN_TASK' // TI-003
    | 'IDENTITY_REUSE' // TI-001
    | 'NOT_FOUND';
  constructor(code: TaskError['code'], message?: string) {
    super(message ?? code);
    this.name = 'TaskError';
    this.code = code;
  }
}

export interface TaskServiceDeps {
  readonly tasks: TaskRepository;
  readonly events: EventLog;
  readonly sessionId: string;
  readonly now: () => string;
  readonly nextId: () => string;
}

// Field names that would smuggle dependency/scheduling data into a Task (TI-003).
const FORBIDDEN_TASK_FIELDS = ['dependencies', 'deps', 'dependsOn', 'blockedBy', 'edges', 'state'];

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  /** Create a new task after validation. TASK_CREATED is emitted. */
  async create(task: Task): Promise<Task> {
    this.validate(task);
    // TI-001: reject reusing an existing identity.
    if (await this.deps.tasks.getById(task.taskId)) {
      throw new TaskError('IDENTITY_REUSE', `task ${task.taskId} already exists`);
    }
    await this.deps.tasks.create(task);
    await this.emit('TASK_CREATED', task.taskId, { taskId: task.taskId });
    return task;
  }

  /**
   * Supersede an existing task with a new one (TI-004). The new task MUST have a
   * distinct identity (TI-001); content is validated (TI-002/003). The repository
   * inserts the new task and links the old one atomically; TASK_SUPERSEDED is emitted.
   */
  async supersede(oldTaskId: string, newTask: Task): Promise<Task> {
    this.validate(newTask);
    if (newTask.taskId === oldTaskId) {
      // TI-004/TI-001: supersession must produce a NEW identity, not rebind the old.
      throw new TaskError('IDENTITY_REUSE', 'superseding task must have a new taskId');
    }
    if (!(await this.deps.tasks.getById(oldTaskId))) {
      throw new TaskError('NOT_FOUND', oldTaskId);
    }
    await this.deps.tasks.supersede(oldTaskId, newTask);
    await this.emit('TASK_SUPERSEDED', oldTaskId, {
      oldTaskId,
      newTaskId: newTask.taskId,
    });
    return newTask;
  }

  private validate(task: Task): void {
    if (task.description.trim().length === 0) {
      throw new TaskError('EMPTY_DESCRIPTION', 'task description must be non-empty');
    }
    // TI-003: defensively reject any dependency-like field that a caller might have
    // attached to the raw object (the Task type has none, but inputs may be untyped).
    const raw = task as unknown as Record<string, unknown>;
    for (const field of FORBIDDEN_TASK_FIELDS) {
      if (field in raw) {
        throw new TaskError('DEP_IN_TASK', `Task must not carry a "${field}" field (TI-003)`);
      }
    }
  }

  private async emit(type: EventType, taskId: string, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId: this.deps.sessionId,
      type,
      aggregate: { kind: 'task', id: taskId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
