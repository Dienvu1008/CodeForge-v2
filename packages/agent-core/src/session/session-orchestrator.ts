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
import type { ContextPlan }             from '../mission/mission-context-strategy.js';
import type { PromptPlan }              from '../mission/prompt-composer.js';
import { computeSchedule }              from '../scheduler/scheduler.js';
import { isTerminalTaskState }          from '../state-machine/states.js';
import type { FailureAnalyzer }          from '../recovery/failure-analyzer.js';
import type { RecoveryEngine }          from '../recovery/recovery-engine.js';
import type { FailureRepository, RecoveryActionRepository } from '../repositories/index.js';
import { decide, DEFAULT_RECOVERY_POLICY, type RecoveryPolicyConfig } from '../recovery/recovery-policy.js';
import { detectNoProgress }             from '../recovery/no-progress-detector.js';
import type { VerificationReport }      from '../domain/verification.js';
// P11.6: OPTIONAL learning plane. When all three are wired, the orchestrator builds a
// read-only SelfModel from this task's failure/recovery history and asks the RecoveryAdvisor
// for a try-order, clamped by the AdviceGate into decide()'s own allowed-set. When ANY is
// absent, no advice is produced and recovery behaves EXACTLY as before (LE-002 fail-safe).
import type { SelfModelBuilder }        from '../learning/self-model-builder.js';
import type { RecoveryAdvisor }         from '../learning/recovery-advisor.js';
import { selfModelFromLessons }         from '../learning/recovery-advisor.js';
import type { AdviceGate }              from '../learning/advice-gate.js';
import type { SafeRecoveryOrderAdvice } from '../domain/advice.js';
import type { Failure, RecoveryAction } from '../domain/failure.js';
import type { LearningStore }           from '../domain/learning.js';

// P9.7: cooperative control signal polled once per loop iteration. A no-op gate (the
// default) always returns 'none', so the loop behaves exactly as before. The real gate
// is fed by the ControlPlane: an admitted pause/cancel surfaces here as a signal, so an
// in-flight autonomous run becomes responsive to pause/resume/cancel between iterations
// WITHOUT a second authority path (the gate only reports; the orchestrator drives the
// session machine through SessionService as always).
export type ControlSignalKind = 'none' | 'pause' | 'cancel';
export interface ControlSignal {
  readonly kind: ControlSignalKind;
}
export interface ControlGate {
  /** Report the pending control signal for this session (does not mutate state). */
  poll(sessionId: string): Promise<ControlSignal>;
  /**
   * Block until the session should leave PAUSED. Resolves with 'resume' (continue the
   * loop) or 'cancel' (abort). Implementations typically poll an admitted-control store.
   */
  awaitResume(sessionId: string): Promise<'resume' | 'cancel'>;
}

/** Default gate: never pauses or cancels — preserves pre-P9.7 orchestrator behavior. */
export const NOOP_CONTROL_GATE: ControlGate = {
  async poll(): Promise<ControlSignal> { return { kind: 'none' }; },
  async awaitResume(): Promise<'resume' | 'cancel'> { return 'resume'; },
};

// ── P12.7: optional Mission Intelligence stage (advisory; MI-001/002/004) ─────────
// Structural contract only — the orchestrator never hard-depends on the concrete
// MissionIntelligence class (DC-002). When the dep is absent (`--mission off`), the stage never
// runs and the orchestrator behaves EXACTLY as Phase 11 (MI-002 fail-safe parity). When present,
// it runs ONCE between RUNNING and planning: it emits advisory MISSION_* events and may report
// `proceed:false` (ArchitectureGate BLOCK) — the ONLY way the stage affects control flow, and
// even then it only causes the orchestrator to drive the session to AWAITING_HUMAN (MI-007). The
// stage never mutates the Goal and never creates Tasks/Graph (MI-004).
export interface MissionStageDecision {
  /** false ONLY on an ArchitectureGate BLOCK → orchestrator stops before planning (MI-007). */
  readonly proceed: boolean;
  readonly blockers: readonly string[];
  /**
   * Tier B2: assumptions the stage stated when the goal was under-specified (option (ii):
   * assume-and-state). Advisory and read-only w.r.t. the Goal (MI-004): the orchestrator
   * only threads these strings into each TaskExecutorRequest so the agent proceeds under the
   * assumed interpretation. Absent/empty ⇒ no behavior change (fail-safe parity).
   */
  readonly assumptions?: readonly string[];
  /**
   * P12.7 context wiring: the flattened context plan (scope + maxFiles + repositoryWide) the
   * stage derived from the mission. Advisory (MI-001): the orchestrator threads it into each
   * TaskExecutorRequest so the context pipeline is bounded per the mission. Absent ⇒ the executor
   * uses its default context policy (fail-safe parity). Never affects the Goal/Graph (MI-004).
   */
  readonly contextPlan?: ContextPlan;
  /**
   * P12.8 prompt shaping: deterministic prompt-guidance hints composed from the mission. Threaded
   * into each TaskExecutorRequest so the executor prompt adapts to the task/model. Advisory
   * (MI-008); absent ⇒ the executor uses its static default prompt (fail-safe parity).
   */
  readonly promptPlan?: PromptPlan;
}
export interface MissionStage {
  /** Analyze the goal for a specific session (sessionId scopes the MISSION_* audit events). */
  analyze(sessionId: string, goal: Goal): Promise<MissionStageDecision>;
}

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
  /**
   * Optional P11.6 — the learning plane for recovery ordering. ALL THREE must be wired for
   * any advice to be produced; otherwise recovery is byte-identical to Phase 10 (LE-002).
   * The advisor only PROPOSES a try-order; the AdviceGate clamps it into decide()'s current
   * allowed-set; decide() stays the authority (set/count/maxAttempts/budget unchanged).
   */
  readonly selfModelBuilder?:        SelfModelBuilder;
  readonly recoveryAdvisor?:         RecoveryAdvisor;
  readonly adviceGate?:              AdviceGate;
  /** Needed by the learning plane to read recovery outcomes for the SelfModel. */
  readonly recoveryActionRepository?: RecoveryActionRepository;
  /**
   * Optional cross-session accumulated lessons. When present, the recovery advisor is seeded
   * from persisted lessons (prior sessions) MERGED with the current task's live history — this
   * is where learning gains real value, since a single short task rarely has enough signal.
   * Read-only here; still clamped by the AdviceGate (LE-001/003). Absent → current-task only.
   */
  readonly learningStore?:           LearningStore;
  /**
   * Optional P10.2: pull detailed evidence (the red check output) for the most recent
   * verification run, so the recovery retry prompt shows the model WHAT failed. The
   * VerificationEngine (frozen) does not persist check stdout/stderr, so the runtime
   * supervies this out-of-band (e.g. WorkspaceProcessSupervisor buffers the last failing
   * spawn). Returns '' when no detail is available — the report summary is still used.
   */
  readonly verificationEvidenceProvider?: { lastFailureOutput(): string };
  /**
   * Optional P9.7: cooperative control gate polled once per loop iteration. When omitted,
   * NOOP_CONTROL_GATE is used and the loop behaves exactly as before (no pause/cancel
   * checkpoints). The gate only REPORTS signals; the orchestrator drives the session
   * machine through SessionService, so no new authority path is introduced (OB-006).
   */
  readonly controlGate?:         ControlGate;
  /**
   * Optional P12.7: the advisory Mission Intelligence stage, run ONCE between RUNNING and
   * planning. When omitted (`--mission off`), the orchestrator behaves byte-identically to
   * Phase 11 (MI-002 fail-safe). When present, it emits MISSION_* events and may BLOCK before
   * planning (ArchitectureGate), in which case the session goes to AWAITING_HUMAN (MI-007). It
   * is advisory only — it never mutates the Goal and never creates Tasks/Graph (MI-004).
   */
  readonly missionStage?:        MissionStage;
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
  /**
   * Terminal-for-this-run session state. 'AWAITING_HUMAN' (P10.2) is NOT terminal for the
   * session machine — the run returns control to the caller/human, who resolves the
   * approval and may resume. COMPLETED/ABORTED are terminal.
   */
  readonly sessionState:     'COMPLETED' | 'ABORTED' | 'AWAITING_HUMAN';
  readonly taskRunCount:     number;
  readonly passedTaskIds:    readonly string[];
  readonly nonPassedTaskIds: readonly string[];
  readonly durationMs:       number;
}

export class SessionOrchestrator {
  private readonly maxIterations: number;
  private readonly controlGate: ControlGate;
  constructor(private readonly deps: SessionOrchestratorDeps) {
    this.maxIterations = deps.maxIterations ?? 100;
    this.controlGate = deps.controlGate ?? NOOP_CONTROL_GATE;
  }

  async run(input: SessionOrchestratorRunInput): Promise<SessionOrchestratorResult> {
    const t0 = Date.now();
    let taskRunCount = 0;
    const passedIds:    string[] = [];
    const nonPassedIds: string[] = [];

    // 1. CREATED -> RUNNING
    await this.deps.sessionService.transition(input.sessionId, 'SESSION_INITIALIZED');
    await this.deps.sessionService.transition(input.sessionId, 'SESSION_READY');

    // 1b. P12.7: OPTIONAL Mission Intelligence stage (advisory). Runs ONCE between RUNNING and
    // planning. Absent → skipped entirely (MI-002 parity: no events, no behavior change). The
    // stage is advisory (MI-001/MI-004): the ONLY control-flow effect it can have is reporting
    // proceed:false on an ArchitectureGate BLOCK, which drives the session to AWAITING_HUMAN
    // (MI-007) and returns BEFORE any planning/commit. It never mutates the Goal or the Graph.
    // Tier B2: assumptions stated by the Mission Intelligence stage (if any), threaded into
    // every TaskExecutorRequest below so the agent proceeds under the assumed interpretation.
    // Run-scoped and read-only w.r.t. the Goal (MI-004); empty ⇒ prompts unchanged (fail-safe).
    let goalAssumptions: readonly string[] = [];
    // P12.7: context plan from the stage (if any), threaded into every TaskExecutorRequest below
    // so the context pipeline is bounded per the mission. Undefined ⇒ executor default policy
    // (fail-safe). Read-only w.r.t. the Goal/Graph (MI-004).
    let contextPlan: ContextPlan | undefined;
    // P12.8: prompt-shaping hints from the stage (if any), threaded to each TaskExecutorRequest.
    let promptPlan: PromptPlan | undefined;
    if (this.deps.missionStage !== undefined) {
      let decision: MissionStageDecision | undefined;
      try {
        decision = await this.deps.missionStage.analyze(input.sessionId, input.goal);
      } catch {
        // The advisory stage must never break the run (MI-002 spirit). On any error, fall
        // through to normal planning as if the stage were not wired.
        decision = undefined;
      }
      if (decision !== undefined && Array.isArray(decision.assumptions)) {
        goalAssumptions = decision.assumptions;
      }
      if (decision !== undefined && decision.contextPlan !== undefined) {
        contextPlan = decision.contextPlan;
      }
      if (decision !== undefined && decision.promptPlan !== undefined) {
        promptPlan = decision.promptPlan;
      }
      if (decision !== undefined && decision.proceed === false) {
        // ArchitectureGate BLOCKed: stop before planning and hand control to a human (MI-007).
        // The session leaves RUNNING for AWAITING_HUMAN; no Graph is created (MI-004). A human
        // decision resumes or aborts later (SS-007), exactly like a recovery escalation (P10.2).
        try { await this.deps.sessionService.transition(input.sessionId, 'HUMAN_REQUIRED'); }
        catch { /* best-effort: if not RUNNING, leave state as-is */ }
        return {
          sessionState: 'AWAITING_HUMAN',
          taskRunCount: 0,
          passedTaskIds: [],
          nonPassedTaskIds: [],
          durationMs: Date.now() - t0,
        };
      }
    }

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
    let cancelledByControl = false;
    // P10.2: set when recovery escalates a task to a human (session → AWAITING_HUMAN). The
    // completion path must then leave the session in AWAITING_HUMAN, not drive it to
    // COMPLETED/ABORTED (that would clobber the escalation).
    let escalatedToHuman = false;
    // P10.2: evidence from a task's prior failed attempt, injected into its retry prompt
    // so the model fixes the specific failure instead of guessing. Keyed by taskId.
    const priorFailureEvidence = new Map<string, string>();
    // P11.6+: a RETRY/FIX recovery action is recorded PENDING (its success is unknown until
    // the retried run is verified). We remember the actionId per task and finalize its outcome
    // once we see the next result: SUCCEEDED if the retried run PASSED, FAILED if it failed
    // again. This makes RecoveryAction.outcome a truthful signal for the learning layer.
    // Evidence-only: setOutcome records what happened; it never changes a decision.
    const pendingRecoveryAction = new Map<string, string>();
    while (iterations < this.maxIterations) {
      iterations++;

      // P9.7: cooperative control checkpoint — poll BEFORE scheduling the next task so an
      // admitted pause/cancel takes effect between iterations (never mid-task). The gate
      // only reports; the session machine is driven through SessionService as always.
      const control = await this.handleControl(input.sessionId);
      if (control === 'cancelled') { cancelledByControl = true; break; }

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
        // Nothing is schedulable. Classify the non-terminal, non-VERIFYING tasks that remain:
        //   - "blocked": a PENDING task whose dependency can NEVER pass (a dependency FAILED /
        //     is AWAITING_HUMAN / escalated). This is NOT a deadlock to abort on — the plan is
        //     partially unachievable (common with weak-model plans). We finish the session
        //     gracefully, counting those tasks as non-passed, and PRESERVE the work that did
        //     succeed, rather than throwing away the whole run.
        //   - "cyclic": a PENDING task stuck behind other non-terminal tasks with no failed
        //     dependency — a genuine dependency cycle (a planner bug). Still finish gracefully
        //     (don't discard completed work), but it is surfaced via the non-passed tally.
        const remaining = g.nodes
          .map((n) => n.taskId)
          .filter((id) => {
            const s = updatedStates.get(id) ?? 'PENDING';
            return !isTerminalTaskState(s) && s !== 'VERIFYING';
          });
        if (remaining.length > 0) {
          // SM-L8 ("no infinite PENDING"): a task that can never become schedulable (its
          // dependency failed / escalated, or a planner-produced cycle) is driven to the
          // terminal ABORTED state (PENDING --DEP_UNREACHABLE--> ABORTED). This replaces the
          // old hard DEADLOCK-abort that discarded the WHOLE run: now the graph becomes fully
          // terminal, the session COMPLETES normally, and the work that DID succeed (passed
          // tasks + files already written) is preserved. The aborted tasks are counted as
          // non-passed in the tally (step 6), which truthfully reports the partial outcome.
          for (const id of remaining) {
            try { await this.deps.executionCoordinator.setState(id, 'ABORTED'); }
            catch { /* best-effort: a projection write must not crash the finish path */ }
          }
        }
        break;
      }

      const task = await this.deps.taskRepository.getById(readySched.next);
      if (task === null) continue;

      const proj = await this.deps.executionRepository.getByTask(task.taskId);
      const defaultSummary = 'Graph v' + g.version + ': ' + g.nodes.length + ' task(s).';
      const evidence = priorFailureEvidence.get(task.taskId);
      const req: TaskExecutorRequest = {
        sessionId: input.sessionId, task,
        attemptNumber:            (proj?.attempts ?? 0) + 1,
        graphVersion:             g.version,
        workspaceRevisionAtStart: input.revision,
        workspaceRevisionAtEnd:   input.revision,
        graphSummary:             input.graphSummary ?? defaultSummary,
        ...(evidence !== undefined ? { priorFailureEvidence: evidence } : {}),
        ...(goalAssumptions.length > 0 ? { goalAssumptions } : {}),
        ...(contextPlan !== undefined ? { contextPlan } : {}),
        ...(promptPlan !== undefined ? { promptPlan } : {}),
      };
      const result = await this.deps.taskExecutor.execute(req);
      taskRunCount++;
      if (result.taskPassed === true) {
        passedIds.push(task.taskId);
        // P11.6+: this run PASSED. If a prior RETRY/FIX for this task was awaiting its verdict,
        // the retry WORKED → finalize that recovery action as SUCCEEDED (truthful signal).
        await this.finalizePendingRecovery(task.taskId, pendingRecoveryAction, 'SUCCEEDED');
      }

      // ── P10.2: Recovery loop ────────────────────────────────────────────
      // Trigger whenever the task did NOT reach PASSED and we can act on it. Two paths:
      //   (1) run FAILED/TIMEOUT (pre-P10.1 behavior), or
      //   (2) run SUCCEEDED but verification FAIL/INVALID/ERROR — the agent *thinks* it
      //       is done but the checks are red (P10.1 made this real; P10.2 makes the agent
      //       fix it). Without this, a red task silently settles in VERIFYING forever.
      const verFailed = result.verificationStatus === 'FAIL'
        || result.verificationStatus === 'INVALID'
        || result.verificationStatus === 'ERROR';
      const needsRecovery = result.taskPassed !== true
        && (result.finalState === 'FAILED' || result.finalState === 'TIMEOUT' || verFailed);

      if (needsRecovery
          && this.deps.failureAnalyzer !== undefined
          && this.deps.recoveryEngine  !== undefined) {
        try {
          const runState = result.finalState === 'TIMEOUT' ? 'TIMEOUT' as const : 'FAILED' as const;
          // P10.2: build failure evidence — the red check output (detailed, from the
          // supervisor buffer when available) plus a report summary. Feeds BOTH the
          // deterministic classifier (lastStderr) AND the retry prompt (priorFailureEvidence).
          const detail = this.deps.verificationEvidenceProvider?.lastFailureOutput() ?? '';
          const reportSummary = result.verificationReport !== undefined
            ? summarizeFailingChecks(result.verificationReport)
            : '';
          const evidenceText = [reportSummary, detail].filter((s) => s.length > 0).join('\n\n');

          // Pass the verification report + stderr to the analyzer so it classifies the
          // failure precisely (test→LOGIC, build→SYNTAX, lint→TOOL) instead of UNKNOWN.
          const failure = await this.deps.failureAnalyzer.analyze({
            sessionId: input.sessionId,
            taskRun:   undefined,
            taskId:    task.taskId,
            runState,
            ...(result.verificationReport !== undefined ? { verificationReport: result.verificationReport } : {}),
            ...(evidenceText.length > 0 ? { lastStderr: evidenceText } : {}),
          });

          // P11.6+: this NEW failure confirms the PRIOR RETRY/FIX for this task did not work →
          // finalize that pending recovery action as FAILED, linking this failure as its
          // nextFailureId (truthful signal for learning; evidence-only, no decision changed).
          await this.finalizePendingRecovery(task.taskId, pendingRecoveryAction, 'FAILED', failure.failureId);

          // No-progress guard (RC-002/RC-003): same failure class repeating → ESCALATE.
          const history = this.deps.failureRepository !== undefined
            ? await this.deps.failureRepository.getByTask(task.taskId)
            : [];
          const npResult = detectNoProgress([...history], 3);
          // P11.6: optional learning advice (clamped). undefined when the plane is not wired
          // or yields nothing → decide() behaves exactly as Phase 10 (LE-002).
          const advice = await this.buildRecoveryAdvice(input.sessionId, failure.class, history);
          const decision = npResult.noProgress
            ? { action: 'ESCALATE' as const, policyVersion: 1, reason: `No progress: ${npResult.reason}` }
            : decide({ failureClass: failure.class, attemptsSoFar: history.length,
                       policy: this.deps.recoveryPolicy, advice });
          const reResult = await this.deps.recoveryEngine.execute({
            failure, action: decision.action,
            reason: decision.reason,
            policyVersion: decision.policyVersion,
            sessionId: input.sessionId,
          });
          if (reResult.sessionEscalated) {
            // Session is now AWAITING_HUMAN — exit loop and leave it there (P10.2).
            escalatedToHuman = true;
            break;
          }
          if (reResult.shouldRetry) {
            // RETRY/FIX: reset the task projection to READY so the scheduler picks it up
            // again next iteration, and stash the evidence for the retry prompt (P10.2).
            if (evidenceText.length > 0) priorFailureEvidence.set(task.taskId, evidenceText);
            await this.deps.executionCoordinator.setState(task.taskId, 'READY');
            // P11.6+: remember this RETRY/FIX action (recorded PENDING) so its outcome is
            // finalized when the next run of this task is known (PASSED → SUCCEEDED;
            // failed again → FAILED above).
            pendingRecoveryAction.set(task.taskId, reResult.recoveryAction.actionId);
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

    // 7. Complete session (SS-003) — unless control cancelled the run, in which case the
    // session has already been driven to CANCELLING; finish the abort to ABORTED.
    let sessionState: 'COMPLETED' | 'ABORTED' | 'AWAITING_HUMAN';
    if (escalatedToHuman) {
      // P10.2: recovery escalated a task to a human. The session is already in
      // AWAITING_HUMAN; leave it there (do NOT complete/abort, which would clobber it).
      // The run hands control back; a human decision resumes or aborts later (SS-005).
      sessionState = 'AWAITING_HUMAN';
    } else if (cancelledByControl) {
      await this.finishCancel(input.sessionId);
      sessionState = 'ABORTED';
    } else {
      try {
        await this.deps.sessionService.complete(input.sessionId, this.allTerminal(fg, fs));
        sessionState = 'COMPLETED';
      } catch {
        await this.abortSession(input.sessionId);
        sessionState = 'ABORTED';
      }
    }

    return { sessionState, taskRunCount, passedTaskIds: passedIds, nonPassedTaskIds: nonPassedIds, durationMs: Date.now() - t0 };
  }

  /**
   * P11.6 — produce an AdviceGate-clamped recovery try-order from this task's history, or
   * undefined when the learning plane is not fully wired or yields nothing (LE-002). The
   * SelfModel is built from the SAME failure history already fetched plus the recovery actions
   * for those failures; the advisor proposes an order, the gate intersects it with decide()'s
   * current allowed-set. decide() stays the authority — this only reorders within that set.
   */
  private async buildRecoveryAdvice(
    _sessionId: string,
    failureClass: Failure['class'],
    history: readonly Failure[],
  ): Promise<SafeRecoveryOrderAdvice | undefined> {
    const builder = this.deps.selfModelBuilder;
    const advisor = this.deps.recoveryAdvisor;
    const gate    = this.deps.adviceGate;
    const recRepo = this.deps.recoveryActionRepository;
    if (builder === undefined || advisor === undefined || gate === undefined || recRepo === undefined) {
      return undefined; // plane not wired → no advice (Phase 10 behavior)
    }

    try {
      // Gather the recovery actions for the failures we have in THIS task (read-only).
      const recoveryActions: RecoveryAction[] = [];
      for (const f of history) {
        const actions = await recRepo.getByFailure(f.failureId);
        recoveryActions.push(...actions);
      }
      const liveModel = builder.build({ events: [], failures: [...history], recoveryActions });

      // Prefer CROSS-SESSION accumulated lessons when a LearningStore is wired — a single
      // short task rarely has enough signal. The lessons model carries recovery outcomes
      // distilled from prior sessions; fall back to the live (current-task) model.
      let raw = null;
      if (this.deps.learningStore !== undefined) {
        const lessons = await this.deps.learningStore.query({ kinds: ['recovery_outcome'], limit: 500 });
        const lessonModel = selfModelFromLessons(lessons);
        raw = advisor.advise(lessonModel, failureClass);
      }
      if (raw === null) raw = advisor.advise(liveModel, failureClass);
      if (raw === null) return undefined;

      const allowed = (this.deps.recoveryPolicy ?? DEFAULT_RECOVERY_POLICY)[failureClass].actions;
      const safe = gate.sanitize(raw, { allowedActions: allowed });
      return safe !== null && safe.kind === 'recovery_order' ? safe : undefined;
    } catch {
      // Advisory path must never break recovery — on any error, fall back to no advice.
      return undefined;
    }
  }

  /**
   * P11.6+ — finalize the outcome of a task's PENDING RETRY/FIX recovery action once its
   * verdict is known. SUCCEEDED when the retried run PASSED; FAILED (with the next failure id)
   * when it failed again. Evidence-only (RC-006 provenance already set at creation); never
   * changes a decision. No-op when nothing is pending or the repository is not wired. A
   * failure to persist is swallowed — the recovery loop must not break on a bookkeeping write.
   */
  private async finalizePendingRecovery(
    taskId: string,
    pending: Map<string, string>,
    outcome: 'SUCCEEDED' | 'FAILED',
    _nextFailureId?: string,
  ): Promise<void> {
    const actionId = pending.get(taskId);
    if (actionId === undefined) return;
    pending.delete(taskId);
    const repo = this.deps.recoveryActionRepository;
    if (repo === undefined) return;
    try {
      await repo.setOutcome(actionId, outcome, this.deps.now());
    } catch { /* bookkeeping write — non-fatal */ }
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

  /**
   * P9.7 cooperative control checkpoint. Polls the gate; drives the session machine via
   * SessionService in response. Returns 'cancelled' if the run must abort, else 'continue'
   * (including after a pause→resume cycle). Never mutates authoritative state except
   * through SessionService transitions (no second authority path, OB-006).
   */
  private async handleControl(sessionId: string): Promise<'continue' | 'cancelled'> {
    const signal = await this.controlGate.poll(sessionId);
    if (signal.kind === 'none') return 'continue';
    if (signal.kind === 'cancel') { await this.abortSession(sessionId); return 'cancelled'; }

    // signal.kind === 'pause': transition RUNNING -> PAUSED, then park until the gate
    // reports resume or cancel. Pause suspends scheduling only; it changes no authority.
    try { await this.deps.sessionService.transition(sessionId, 'PAUSE_REQUESTED'); }
    catch { /* if not RUNNING (e.g. already resumed), fall through to await */ }

    const outcome = await this.controlGate.awaitResume(sessionId);
    if (outcome === 'cancel') { await this.abortSession(sessionId); return 'cancelled'; }

    try { await this.deps.sessionService.transition(sessionId, 'RESUME_REQUESTED'); }
    catch { /* best-effort: if already RUNNING, continue */ }
    return 'continue';
  }

  /** Finish a control-initiated cancel: CANCELLING -> ABORTED (best-effort). */
  private async finishCancel(sessionId: string): Promise<void> {
    try { await this.deps.sessionService.transition(sessionId, 'CANCEL_COMPLETED'); }
    catch {
      // Not in CANCELLING (e.g. abort already applied) — try a direct ABORT.
      try { await this.deps.sessionService.transition(sessionId, 'ABORT'); } catch { /* best-effort */ }
    }
  }

  /**
   * Find the most recent TaskRun for a task (for FailureAnalyzer).
   * findRunning(sessionId) returns all RUNNING runs for the session;
   * after TaskRunService.finalize(), the run is terminal but currentRunId
   * on the projection was cleared. We build a minimal TaskRun from what we know.
   */
  private async findLastRun(taskId: string, sessionId: string): Promise<import('../domain/task.js').TaskRun | null> {
    if (this.deps.taskRunRepository === undefined) return null;
    // Try any running runs for the session that match this task.
    const allRunning = await this.deps.taskRunRepository.findRunning(sessionId);
    const match = allRunning.find((r) => r.taskId === taskId);
    if (match !== undefined) return match;
    return null;
  }
}

/**
 * P10.2: build a short, deterministic summary of the FAILED/ERROR checks in a
 * verification report. The VerificationEngine does not persist check stdout/stderr, so
 * this is the always-available fallback evidence (the supervisor buffer adds detail when
 * wired). Used both to classify the failure and to tell the model what to fix.
 */
function summarizeFailingChecks(report: VerificationReport): string {
  const failing = report.checks.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  if (failing.length === 0) {
    return report.status === 'INVALID'
      ? 'Verification INVALID: the workspace changed during verification (non-deterministic or external mutation).'
      : `Verification ${report.status} with no failing checks reported.`;
  }
  const lines = failing.map((c) =>
    `- [${c.kind}] "${c.name}": \`${c.command} ${c.args.join(' ')}\` exited ${c.exitCode} (${c.status}).`,
  );
  return [`Verification FAILED — ${failing.length} check(s) failed:`, ...lines].join('\n');
}
