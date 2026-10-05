// SessionOrchestrator — P4-SO1. Full autonomous session loop.
// GI-009: Planner returns GraphMutation; handed to GraphCommitService.
// SC-003: task only READY when every dependency is PASSED.
// SS-003: session only COMPLETED when all tasks are terminal.
// EX-002: TaskExecutor enforces single active run per task.
import type { Goal }                    from '../domain/goal.js';
import type { WorkspaceRevision }       from '../domain/workspace-revision.js';
import type { TaskState, BudgetState }  from '../state-machine/states.js';
import type { TaskGraph }               from '../graph/types.js';
import type { SessionService }          from './session-service.js';
import type { Planner }                 from '../planning/planner.js';
import type { GraphCommitService }      from '../graph/graph-commit-service.js';
import type { TaskGraphRepository, TaskRepository, TaskExecutionRepository, TaskRunRepository } from '../repositories/index.js';
import type { ExecutionCoordinator }    from '../execution/execution-coordinator.js';
import type { TaskExecutor, TaskExecutorRequest } from '../execution/task-executor.js';
import type { CheckpointService, CaptureInput }   from '../checkpoint/checkpoint-service.js';
import { computeSchedule }              from '../scheduler/scheduler.js';
import { isTerminalTaskState }          from '../state-machine/states.js';
import type { FailureAnalyzer }          from '../recovery/failure-analyzer.js';
import type { RecoveryEngine }          from '../recovery/recovery-engine.js';
import type { FailureRepository }       from '../repositories/index.js';
import { decide, type RecoveryPolicyConfig } from '../recovery/recovery-policy.js';
import { detectNoProgress }             from '../recovery/no-progress-detector.js';

export class SessionOrchestratorError extends Error {
  public readonly code: 'PLAN_FAILED' | 'COMMIT_FAILED' | 'DEADLOCK' | 'SESSION_FAILED';
  constructor(code: SessionOrchestratorError['code'], message?: string) {
    super(message ?? code);
    this.name = 'SessionOrchestratorError';
    this.code = code;
  }
}

export interface SessionOrchestratorDeps {
  readonly sessionService:       SessionService;
  readonly planner:              Planner;
  readonly graphCommitService:   GraphCommitService;
  readonly graphRepository:      TaskGraphRepository;
  readonly taskRepository:       TaskRepository;
  readonly executionRepository:  TaskExecutionRepository;
  readonly executionCoordinator: ExecutionCoordinator;
  readonly taskExecutor:         TaskExecutor;
  readonly checkpointService:    CheckpointService;
  readonly maxIterations?:       number;
  /**
   * Optional P5-SO2: FailureAnalyzer to classify failed task runs.
   * When omitted, failed tasks are not analyzed and recovery is skipped.
   */
  /** Required for P5-SO2 recovery: look up the last TaskRun for a task. */
  readonly taskRunRepository?:   TaskRunRepository;
  readonly failureAnalyzer?:     FailureAnalyzer;
  /** Optional P5-SO2: RecoveryEngine to execute recovery actions. */
  readonly recoveryEngine?:      RecoveryEngine;
  /** Optional P5-SO2: FailureRepository for NoProgressDetector history. */
  readonly failureRepository?:   FailureRepository;
  /** Optional P5-SO2: custom recovery policy config. */
  readonly recoveryPolicy?:      RecoveryPolicyConfig;
  readonly now:    () => string;
  readonly nextId: () => string;
}

export interface SessionOrchestratorRunInput {
  readonly sessionId:     string;
  readonly goal:          Goal;
  readonly revision:      WorkspaceRevision;
  readonly graphVersion:  number;
  readonly graphSummary?: string;
}

export interface SessionOrchestratorResult {
  readonly sessionState:     'COMPLETED' | 'ABORTED';
  readonly taskRunCount:     number;
  readonly passedTaskIds:    readonly string[];
  readonly nonPassedTaskIds: readonly string[];
  readonly durationMs:       number;
}

export class SessionOrchestrator {
  private readonly maxIterations: number;
  constructor(private readonly deps: SessionOrchestratorDeps) {
    this.maxIterations = deps.maxIterations ?? 100;
  }

  async run(input: SessionOrchestratorRunInput): Promise<SessionOrchestratorResult> {
    const t0 = Date.now();
    let taskRunCount = 0;
    const passedIds:    string[] = [];
    const nonPassedIds: string[] = [];

    // 1. CREATED -> RUNNING
    await this.deps.sessionService.transition(input.sessionId, 'SESSION_INITIALIZED');
    await this.deps.sessionService.transition(input.sessionId, 'SESSION_READY');

    // 2. Plan
    const baseGraph = await this.deps.graphRepository.getCurrent(input.sessionId);
    let mutation;
    try {
      mutation = await this.deps.planner.plan(input.sessionId, input.goal, baseGraph, input.revision);
    } catch (err) {
      await this.abortSession(input.sessionId);
      throw new SessionOrchestratorError('PLAN_FAILED',
        'Planner failed: ' + (err instanceof Error ? err.message : String(err)));
    }

    // 3. Commit graph
    const commitResult = await this.deps.graphCommitService.commit(mutation);
    if (commitResult.status === 'REJECTED') {
      await this.abortSession(input.sessionId);
      throw new SessionOrchestratorError('COMMIT_FAILED',
        'Mutation rejected: ' + (commitResult.validation.errors?.map((e) => e.message).join('; ') ?? 'unknown'));
    }

    // 4a. Persist task records for ADD_TASK ops (tasks table FK).
    for (const op of mutation.operations) {
      if (op.kind === 'ADD_TASK') {
        try { await this.deps.taskRepository.create(op.task); } catch { /* already exists */ }
      }
    }

    // 4b. Init projections for new tasks
    const committedGraph = await this.deps.graphRepository.getCurrent(input.sessionId);
    for (const node of committedGraph.nodes) {
      const existing = await this.deps.executionRepository.getByTask(node.taskId);
      if (existing === null) await this.deps.executionCoordinator.init(node.taskId);
    }

    // 5. Main execution loop
    let iterations = 0;
    while (iterations < this.maxIterations) {
      iterations++;
      const g      = await this.deps.graphRepository.getCurrent(input.sessionId);
      const states = await this.buildStatesMap(g);
      if (this.allTerminal(g, states)) break;

      const sched = computeSchedule({ nodes: g.nodes, edges: g.edges, states });
      // Transition newly-ready tasks to READY FIRST, then recompute for schedulable.
      for (const tid of sched.newlyReady) {
        await this.deps.executionCoordinator.setState(tid, 'READY');
      }
      // Rebuild states to include newly-READY tasks, then re-schedule.
      const updatedStates = await this.buildStatesMap(g);
      const readySched = computeSchedule({ nodes: g.nodes, edges: g.edges, states: updatedStates });
      if (readySched.next === undefined) {
        const stuck = g.nodes.some((n) => {
          const s = updatedStates.get(n.taskId) ?? 'PENDING';
          return !isTerminalTaskState(s) && s !== 'VERIFYING';
        });
        if (stuck) {
          await this.abortSession(input.sessionId);
          throw new SessionOrchestratorError('DEADLOCK', 'No schedulable tasks but non-terminal tasks remain');
        }
        break;
      }

      const task = await this.deps.taskRepository.getById(readySched.next);
      if (task === null) continue;

      const proj = await this.deps.executionRepository.getByTask(task.taskId);
      const defaultSummary = 'Graph v' + g.version + ': ' + g.nodes.length + ' task(s).';
      const req: TaskExecutorRequest = {
        sessionId: input.sessionId, task,
        attemptNumber:            (proj?.attempts ?? 0) + 1,
        graphVersion:             g.version,
        workspaceRevisionAtStart: input.revision,
        workspaceRevisionAtEnd:   input.revision,
        graphSummary:             input.graphSummary ?? defaultSummary,
      };
      const result = await this.deps.taskExecutor.execute(req);
      taskRunCount++;
      if (result.taskPassed === true) passedIds.push(task.taskId);

      // ── P5-SO2: Recovery loop after FAILED/TIMEOUT ──────────────────────
      if ((result.finalState === 'FAILED' || result.finalState === 'TIMEOUT')
          && this.deps.failureAnalyzer !== undefined
          && this.deps.recoveryEngine  !== undefined) {
        try {
          const lastRun = await this.findLastRun(task.taskId);
          if (lastRun !== null) {
            const failure = await this.deps.failureAnalyzer.analyze({
              sessionId: input.sessionId,
              taskRun:   lastRun,
            });
            // Check for no-progress before deciding action.
            const history = this.deps.failureRepository !== undefined
              ? await this.deps.failureRepository.getByTask(task.taskId)
              : [];
            const npResult = detectNoProgress([...history], 3);
            const decision = npResult.noProgress
              ? { action: 'ESCALATE' as const, policyVersion: 1, reason: 'No progress detected' }
              : decide({ failureClass: failure.class, attemptsSoFar: history.length,
                         policy: this.deps.recoveryPolicy });
            const reResult = await this.deps.recoveryEngine.execute({
              failure, action: decision.action,
              reason: decision.reason,
              policyVersion: decision.policyVersion,
              sessionId: input.sessionId,
            });
            if (reResult.sessionEscalated) {
              // Session is now AWAITING_HUMAN — exit loop.
              break;
            }
            // shouldRetry=true: loop will pick the task up again on next iteration.
          }
        } catch { /* recovery failure is non-fatal — continue */ }
      }

      try {
        const ug = await this.deps.graphRepository.getCurrent(input.sessionId);
        const us = await this.buildStatesMap(ug);
        await this.checkpoint(input, ug, us);
      } catch { /* non-fatal */ }
    }

    // 6. Tally non-passed
    const fg = await this.deps.graphRepository.getCurrent(input.sessionId);
    const fs = await this.buildStatesMap(fg);
    for (const n of fg.nodes) {
      const s = fs.get(n.taskId) ?? 'PENDING';
      // VERIFYING: ran and awaiting Phase 5 re-verification — not counted as non-passed.
      if (s !== 'PASSED' && s !== 'VERIFYING' && !passedIds.includes(n.taskId)) {
        nonPassedIds.push(n.taskId);
      }
    }

    // 7. Complete session (SS-003)
    let sessionState: 'COMPLETED' | 'ABORTED';
    try {
      await this.deps.sessionService.complete(input.sessionId, this.allTerminal(fg, fs));
      sessionState = 'COMPLETED';
    } catch {
      await this.abortSession(input.sessionId);
      sessionState = 'ABORTED';
    }

    return { sessionState, taskRunCount, passedTaskIds: passedIds, nonPassedTaskIds: nonPassedIds, durationMs: Date.now() - t0 };
  }

  private async buildStatesMap(g: TaskGraph): Promise<Map<string, TaskState>> {
    const map = new Map<string, TaskState>();
    for (const n of g.nodes) {
      const p = await this.deps.executionRepository.getByTask(n.taskId);
      if (p !== null) map.set(n.taskId, p.currentState as TaskState);
    }
    return map;
  }

  private allTerminal(g: TaskGraph, states: Map<string, TaskState>): boolean {
    // VERIFYING: verification ran but gate blocked (e.g. 0 checks, Phase 4).
    // Treated as 'done for scheduling' — Phase 5 recovery will re-run verification.
    return g.nodes.every((n) => {
      const s = states.get(n.taskId) ?? 'PENDING';
      return isTerminalTaskState(s) || s === 'VERIFYING';
    });
  }

  private async checkpoint(input: SessionOrchestratorRunInput, g: TaskGraph, states: Map<string, TaskState>): Promise<void> {
    const taskStates: Record<string, TaskState> = {};
    for (const [id, s] of states) taskStates[id] = s;
    const ci: CaptureInput = {
      sessionId: input.sessionId, graphVersion: g.version,
      workspaceRevision: input.revision, agentChangeSet: [],
      sessionState: 'RUNNING', taskStates,
      budgetState: 'ACTIVE' as BudgetState,
      lastEventId: this.deps.nextId(), capturedAt: this.deps.now(), schemaVersion: 1,
    };
    await this.deps.checkpointService.capture(ci);
  }

  private async abortSession(sessionId: string): Promise<void> {
    try { await this.deps.sessionService.transition(sessionId, 'CANCEL_REQUESTED'); } catch { /* best-effort */ }
  }

  /** Find the most recent TaskRun for a task (for FailureAnalyzer). */
  private async findLastRun(taskId: string): Promise<import('../domain/task.js').TaskRun | null> {
    if (this.deps.taskRunRepository === undefined) return null;
    // findRunning returns currently-running runs; we look for the latest by scanning
    // via the projection which has the currentRunId after a completed run.
    const proj = await this.deps.executionRepository.getByTask(taskId);
    if (proj?.currentRunId === undefined) return null;
    return this.deps.taskRunRepository.getById(proj.currentRunId);
  }
}
