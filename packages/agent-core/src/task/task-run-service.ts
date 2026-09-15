// TaskRunService (P1-T3) — DOMAIN_CONTRACTS §6, STATE_MACHINE_SPEC SM-TASK-RUN §5.
//
// TaskRun factory + finalize orchestration. Enforces:
//   - EX-004: a new run MUST record graphVersionAtStart AND workspaceRevisionAtStart
//     (the run's anchor). The factory refuses to create a run missing either.
//   - EX-005: finalize is BLOCKED until the process tree is reconciled — the service
//     calls ProcessReconciler and rejects finalize if any orphan remains.
//   - EX-L13: INTERRUPTED is produced ONLY via finalizeInterrupted (crash-recovery path).
//   - EX-L14: a normal finalize writes workspaceRevisionAtEnd.
//   - EX-001: immutability after finalize is enforced by TaskRunRepository.finalize.
// Effects run over injected CONTRACTS (TaskRunRepository, EventLog, ProcessReconciler).
import type { TaskRun } from '../domain/task.js';
import type { TaskRunState } from '../state-machine/states.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { TaskRunRepository, EventLog } from '../repositories/index.js';
import type { ProcessReconciler } from './process-reconciler.js';
import {
  transitionTaskRun,
  TASK_RUN_EVENT_TO_STATE,
  type TaskRunEvent,
} from './task-run-machine.js';

export class TaskRunError extends Error {
  public readonly code:
    | 'MISSING_ANCHOR' // EX-004
    | 'UNRECONCILED_FINALIZE' // EX-005
    | 'MISSING_END_REVISION' // EX-L14
    | 'INVALID_TRANSITION'
    | 'NOT_FOUND';
  constructor(code: TaskRunError['code'], message?: string) {
    super(message ?? code);
    this.name = 'TaskRunError';
    this.code = code;
  }
}

export interface TaskRunServiceDeps {
  readonly runs: TaskRunRepository;
  readonly events: EventLog;
  readonly reconciler: ProcessReconciler;
  readonly now: () => string;
  readonly nextId: () => string;
}

/** A normal (non-interrupted) terminal event. INTERRUPTED goes through its own path. */
export type NormalRunEvent = Exclude<TaskRunEvent, 'RUN_INTERRUPTED'>;

export class TaskRunService {
  constructor(private readonly deps: TaskRunServiceDeps) {}

  /**
   * Create and persist a RUNNING TaskRun. EX-004: rejects if graphVersionAtStart or
   * workspaceRevisionAtStart is missing. Emits TASK_RUN_STARTED.
   */
  async start(run: TaskRun): Promise<TaskRun> {
    if (
      run.graphVersionAtStart === undefined ||
      run.graphVersionAtStart === null ||
      run.workspaceRevisionAtStart === undefined
    ) {
      throw new TaskRunError('MISSING_ANCHOR', 'TaskRun must record graphVersion + revision at start');
    }
    if (run.state !== 'RUNNING') {
      throw new TaskRunError('INVALID_TRANSITION', 'a new TaskRun must start in RUNNING');
    }
    await this.deps.runs.create(run);
    await this.emit(run, 'TASK_RUN_STARTED', { taskRunId: run.taskRunId, state: 'RUNNING' });
    return run;
  }

  /**
   * Finalize a run with a normal terminal event (SUCCEEDED/FAILED/TIMEOUT/CANCELLED).
   * EX-005: reconcile the process tree first; refuse if any orphan remains.
   * EX-L14: workspaceRevisionAtEnd is required.
   */
  async finalize(
    runId: string,
    event: NormalRunEvent,
    workspaceRevisionAtEnd: WorkspaceRevision,
    refs: { verificationId?: string } = {},
  ): Promise<TaskRunState> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new TaskRunError('NOT_FOUND', runId);
    }
    const result = transitionTaskRun(run.state, event);
    if (!result.ok) {
      throw new TaskRunError('INVALID_TRANSITION', result.reason);
    }
    // EX-005: process tree must be reconciled before we seal the run.
    const rec = await this.deps.reconciler.reconcile(runId);
    if (!rec.reconciled || rec.orphanPids.length > 0) {
      throw new TaskRunError(
        'UNRECONCILED_FINALIZE',
        `cannot finalize ${runId}: ${rec.orphanPids.length} orphan process(es) remain`,
      );
    }
    const nextState = TASK_RUN_EVENT_TO_STATE[event];
    await this.deps.runs.finalize(runId, {
      state: nextState,
      endedAt: this.deps.now(),
      workspaceRevisionAtEnd, // EX-L14
      ...(refs.verificationId !== undefined ? { verificationId: refs.verificationId } : {}),
    });
    await this.emit(run, 'TASK_RUN_ENDED', { taskRunId: runId, state: nextState });
    return nextState;
  }

  /**
   * Finalize a run as INTERRUPTED — the crash-recovery-only path (EX-L13). Still
   * requires reconciliation (EX-005) and writes the end revision (EX-L14).
   */
  async finalizeInterrupted(
    runId: string,
    workspaceRevisionAtEnd: WorkspaceRevision,
  ): Promise<TaskRunState> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new TaskRunError('NOT_FOUND', runId);
    }
    const result = transitionTaskRun(run.state, 'RUN_INTERRUPTED');
    if (!result.ok) {
      throw new TaskRunError('INVALID_TRANSITION', result.reason);
    }
    const rec = await this.deps.reconciler.reconcile(runId);
    if (!rec.reconciled || rec.orphanPids.length > 0) {
      throw new TaskRunError('UNRECONCILED_FINALIZE', `cannot finalize ${runId}: orphans remain`);
    }
    await this.deps.runs.finalize(runId, {
      state: 'INTERRUPTED',
      endedAt: this.deps.now(),
      workspaceRevisionAtEnd,
    });
    await this.emit(run, 'TASK_RUN_ENDED', { taskRunId: runId, state: 'INTERRUPTED' });
    return 'INTERRUPTED';
  }

  private async emit(run: TaskRun, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId: run.sessionId,
      type,
      aggregate: { kind: 'task_run', id: run.taskRunId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
