// ExecutionCoordinator (P1-T2) — DOMAIN_CONTRACTS §5, EX-002/EX-003.
//
// TaskExecution is a PROJECTION of a Task's run history, NOT an authority (EX-003):
// its `currentState`/`currentRunId`/`attempts` are derived by applying run-lifecycle
// events in order. Authority lives in the immutable TaskRun records + the state machine.
//
// EX-002: at most ONE active TaskRun per TaskExecution. `onRunStarted` rejects a new
// run while `currentRunId` still points at a live run.
//
// This coordinator is the ONLY writer of the projection; callers feed it ordered
// lifecycle signals (which themselves derive from committed TaskRun transitions).
import type { TaskExecution } from '../domain/task.js';
import type { TaskState, TaskRunState } from '../state-machine/states.js';
import type { TaskExecutionRepository } from '../repositories/index.js';

export class ExecutionError extends Error {
  public readonly code: 'MULTIPLE_ACTIVE_RUNS' | 'NOT_FOUND' | 'NO_ACTIVE_RUN';
  constructor(code: ExecutionError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export interface ExecutionCoordinatorDeps {
  readonly executions: TaskExecutionRepository;
  readonly now: () => string;
}

/** Map a finished run state to the projected task state after the run ends. */
function projectedStateAfterRun(runState: TaskRunState): TaskState {
  switch (runState) {
    case 'SUCCEEDED':
    case 'FAILED':
      // Run finished normally → verification decides PASS/FAIL; projection shows VERIFYING.
      return 'VERIFYING';
    case 'TIMEOUT':
    case 'INTERRUPTED':
      return 'FAILED';
    case 'CANCELLED':
      return 'ABORTED';
    default:
      return 'FAILED';
  }
}

export class ExecutionCoordinator {
  constructor(private readonly deps: ExecutionCoordinatorDeps) {}

  /** Initialize the projection for a task (state PENDING, no runs). */
  async init(taskId: string): Promise<TaskExecution> {
    const now = this.deps.now();
    const execution: TaskExecution = {
      taskId,
      currentState: 'PENDING',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.executions.upsert(execution);
    return execution;
  }

  /**
   * Record that a new TaskRun started. EX-002: rejects if the projection already has
   * an active run. Bumps attempts, sets currentRunId, projects state RUNNING.
   */
  async onRunStarted(taskId: string, runId: string): Promise<TaskExecution> {
    const current = await this.require(taskId);
    if (current.currentRunId !== undefined && current.currentState === 'RUNNING') {
      // EX-002: a second concurrent run is not allowed.
      throw new ExecutionError(
        'MULTIPLE_ACTIVE_RUNS',
        `task ${taskId} already has active run ${current.currentRunId}`,
      );
    }
    const next: TaskExecution = {
      ...current,
      currentState: 'RUNNING',
      currentRunId: runId,
      attempts: current.attempts + 1,
      updatedAt: this.deps.now(),
    };
    await this.deps.executions.upsert(next);
    return next;
  }

  /**
   * Record that the active TaskRun ended with `runState`. Clears currentRunId and
   * projects the resulting task state. Optionally records latestVerification/failure ids.
   */
  async onRunEnded(
    taskId: string,
    runId: string,
    runState: TaskRunState,
    refs: { verificationId?: string; failureId?: string } = {},
  ): Promise<TaskExecution> {
    const current = await this.require(taskId);
    if (current.currentRunId !== runId) {
      throw new ExecutionError('NO_ACTIVE_RUN', `run ${runId} is not the active run for ${taskId}`);
    }
    // currentRunId is cleared (no active run); build the next projection immutably.
    // Note: currentRunId is intentionally omitted (optional) — the run is no longer active.
    const next: TaskExecution = {
      taskId: current.taskId,
      currentState: projectedStateAfterRun(runState),
      attempts: current.attempts,
      createdAt: current.createdAt,
      updatedAt: this.deps.now(),
      ...(refs.verificationId !== undefined ? { latestVerificationId: refs.verificationId } : {}),
      ...(refs.failureId !== undefined ? { latestFailureId: refs.failureId } : {}),
    };
    await this.deps.executions.upsert(next);
    return next;
  }

  /** Set a terminal/derived task state directly (e.g. PASSED after verification). */
  async setState(taskId: string, state: TaskState): Promise<TaskExecution> {
    const current = await this.require(taskId);
    const next: TaskExecution = { ...current, currentState: state, updatedAt: this.deps.now() };
    await this.deps.executions.upsert(next);
    return next;
  }

  async get(taskId: string): Promise<TaskExecution | null> {
    return this.deps.executions.getByTask(taskId);
  }

  /** Whether the projection currently has an active run (EX-002 helper). */
  async hasActiveRun(taskId: string): Promise<boolean> {
    const e = await this.deps.executions.getByTask(taskId);
    return e?.currentRunId !== undefined && e.currentState === 'RUNNING';
  }

  private async require(taskId: string): Promise<TaskExecution> {
    const e = await this.deps.executions.getByTask(taskId);
    if (!e) {
      throw new ExecutionError('NOT_FOUND', taskId);
    }
    return e;
  }
}
