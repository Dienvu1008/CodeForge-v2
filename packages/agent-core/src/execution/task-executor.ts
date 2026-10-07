// TaskExecutor — P3-TE1 + P4-AP1 + P4-IK1. Orchestrates one TaskRun end-to-end.
//
// Flow for a single TaskRun:
//   1. Start TaskRun via TaskRunService (EX-004: anchor required).
//   2. Update ExecutionCoordinator projection (EX-002: single active run).
//   3. Build ContextSnapshot for the task (CX-003: workspace items marked untrusted).
//   4. Tool-call loop (bounded by maxToolCalls):
//      a. Ask model for next action (purpose='execute').
//      b. Parse model output through StructuredOutputParser (MG-002/003, SE-010).
//      c. If {type:'done'} → break loop (success).
//      d. If {type:'tool_call'} → check idempotency (TG-006):
//         - IdempotencyEngine.check() → idempotencyKey | isDuplicate.
//         - If duplicate: skip, continue loop.
//      e. Route via ToolGateway (TG-001):
//         - request() → policy check → APPROVED | DENIAL.
//         - execute() → SUCCEEDED | FAILED | TIMEOUT.
//         - ArtifactCapturePort.record() → stdoutArtifactId + stderrArtifactId (PR-001).
//         - Record toolCallId on accumulator.
//   5. Finalize TaskRun (EX-005 reconcile, EX-L14 end revision).
//   6. Update ExecutionCoordinator projection.
//
// Invariants enforced:
//   EX-001: TaskRun immutable after finalize.
//   EX-002: only one active run per task (coordinator guard).
//   EX-004: graphVersionAtStart + workspaceRevisionAtStart required.
//   EX-005: reconcile before finalize (TaskRunService delegates to ProcessReconciler).
//   EX-L14: workspaceRevisionAtEnd written by finalize.
//   MG-001: all model calls through ModelGateway.
//   TG-001: all tool execution through ToolGateway.
//   TG-006: idempotency key set on MODIFY_WORKSPACE/DESTRUCTIVE/SYSTEM tools.
//   PR-001: stdout/stderr persisted as artifacts after each tool call.
//   SE-010: model output treated as untrusted.
import type { Task, TaskRun }           from '../domain/task.js';
import type { WorkspaceRevision }       from '../domain/workspace-revision.js';
import type { ModelGateway }            from '../model/gateway.js';
import type { ToolExecutor }            from '../tool/tool-gateway.js';
import type { TaskRunService }          from '../task/task-run-service.js';
import type { ExecutionCoordinator }    from './execution-coordinator.js';
import type { ContextBuilder }          from '../context/context-builder.js';
import type { ToolGateway }             from '../tool/tool-gateway.js';
import type { ToolCall, RiskClass }     from '../domain/tool-call.js';
import type { Provenance }              from '../domain/provenance.js';
import type { BudgetConsumption }       from '../domain/budget.js';
import type { BudgetRepository }        from '../repositories/index.js';
import { BudgetError }                  from '../budget/budget-engine.js';
import { parseModelOutput, modelRequest } from '../model/structured-output-parser.js';
import { buildPrompt, BOUNDARY_SYSTEM_PREAMBLE } from '../security/prompt-boundary.js';
import { ModelError }                   from '../model/gateway.js';
import { ToolGatewayError }             from '../tool/tool-gateway.js';
import {
  TOOL_CALL_PROPOSAL_SCHEMA,
  validateExecuteSemantics,
  type RawExecuteOutput,
  type RawToolCallProposal,
} from './tool-call-schema.js';
import type { ArtifactCapturePort } from './artifact-capture-port.js';
import type { IdempotencyEngine }   from './idempotency-engine.js';
import type { ToolRegistry }        from '../tool/tool-registry.js';
import type { VerificationEngine }  from '../verification/verification-engine.js';
import type { CompletionGate }      from '../verification/completion-gate.js';
import type { VerificationPolicy }  from '../verification/verification-policy.js';
import type { VerificationStatus }  from '../domain/verification.js';
import { DEFAULT_VERIFICATION_POLICY } from '../verification/verification-policy.js';

// ── System prompt for the multi-turn tool loop ────────────────────────────────

const TASK_EXECUTOR_SYSTEM_PROMPT = `You are a coding agent executing a task step by step using tools.
You MUST respond with a single JSON object — no markdown, no explanation.

Available tools:
  read_file     {"path": "<relative-path>"}                   — read a file's contents
  write_file    {"path": "<relative-path>", "content": "..."}  — create or overwrite a file
  list_dir      {"path": "<relative-path>"}                   — list directory contents
  delete_file   {"path": "<relative-path>"}                   — delete a file
  move_file     {"path": "<from>", "to": "<to>"}               — rename/move a file
  run_command   {"command": "<shell command>"}                 — run a shell command
  git_status    {}                                             — check git status
  git_diff      {}                                             — show git diff
  git_add       {"path": "<relative-path>"}                   — stage a file
  git_commit    {"message": "<msg>"}                           — commit staged files
  git_log       {}                                             — show recent git log

Response format (pick ONE):
  To call a tool: {"type":"tool_call","toolName":"<name>","arguments":{...}}
  When done:      {"type":"done","summary":"<what was accomplished>"}

Strategy: first explore the workspace (list_dir, read_file), then make changes (write_file),
then verify your work (read_file, run_command). When everything is complete, respond with done.`;

// ── TaskExecutorError ─────────────────────────────────────────────────────────

export class TaskExecutorError extends Error {
  public readonly code:
    | 'BUDGET_EXCEEDED'    // tool call loop exhausted maxToolCalls
    | 'MODEL_FAILED'       // model call threw unrecoverable ModelError
    | 'TOOL_DENIED'        // ToolGateway denied a SYSTEM / DESTRUCTIVE call
    | 'FINALIZE_FAILED'    // TaskRunService.finalize threw
    | 'RUN_FAILED';        // executor-reported failure (exitCode != 0)

  constructor(code: TaskExecutorError['code'], message?: string) {
    super(message ?? code);
    this.name = 'TaskExecutorError';
    this.code = code;
  }
}

// ── TaskExecutorDeps ──────────────────────────────────────────────────────────

export interface TaskExecutorDeps {
  /** Creates + finalizes TaskRun records (EX-004/005). */
  readonly taskRunService:       TaskRunService;
  /** Keeps the TaskExecution projection in sync (EX-002). */
  readonly executionCoordinator: ExecutionCoordinator;
  /** Builds ContextSnapshot for model calls. */
  readonly contextBuilder:       ContextBuilder;
  /** LLM gateway — all model calls go through here (MG-001). */
  readonly gateway:              ModelGateway;
  /** ToolGateway — all tool execution goes through here (TG-001). */
  readonly toolGateway:          ToolGateway;
  /** Physical executor routed per toolName (produced by NodeToolExecutor in infra). */
  readonly executor:             ToolExecutor;
  /**
   * Optional artifact capture port (P4-AP1).
   * When provided, stdout/stderr of every tool call is persisted as artifacts (PR-001).
   * If omitted, artifacts are not stored (Phase 3 behaviour).
   */
  /**
   * Optional verification engine (P4-VW1).
   * When provided, VerificationEngine.verify() runs after a SUCCEEDED TaskRun.
   * If the report status is PASS and CompletionGate allows, the task projection
   * is promoted to PASSED (TI-005 northstar).
   * If omitted, verification is skipped (Phase 3 behaviour — projection stays VERIFYING).
   */
  readonly verificationEngine?:  VerificationEngine;
  /**
   * Optional completion gate (P4-VW1).
   * Required when verificationEngine is provided — gates VERIFYING → PASSED.
   * If omitted, no PASSED transition occurs even if verification runs.
   */
  readonly completionGate?:      CompletionGate;
  /**
   * Verification policy to use when verificationEngine is provided.
   * Defaults to DEFAULT_VERIFICATION_POLICY (checks:[], AFFECTED_DIRECT scope).
   */
  readonly verificationPolicy?:  VerificationPolicy;
  readonly artifactCapture?: ArtifactCapturePort;
  /**
   * Optional idempotency engine (P4-IK1).
   * When provided, duplicate MODIFY_WORKSPACE/DESTRUCTIVE tool calls with the same
   * content-hash idempotency key are skipped (TG-006).
   * Also sets ToolCall.idempotencyKey for non-'none' tools.
   * If omitted, all tool calls pass through without deduplication.
   */
  readonly idempotencyEngine?: IdempotencyEngine;
  /**
   * Optional tool registry (P4-IK1).
   * Required when idempotencyEngine is provided — used to look up idempotencyStrategy.
   * If idempotencyEngine is provided but toolRegistry is omitted, strategy defaults to 'none'.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * Optional budget repository (P4-BW1).
   * When provided, each tool call debits { toolCalls: 1 } before execution (BU-003).
   * Budget exhaustion stops the run with finalState='TIMEOUT' (BU-005).
   */
  readonly budgetRepository?: BudgetRepository;
  /**
   * Budget ID to debit against (session-level budget).
   * Required when budgetRepository is provided.
   */
  readonly budgetId?: string;
  /**
   * Hard upper bound on tool calls per run (prevents infinite loops).
   * Default: 25. Must be > 0.
   */
  readonly maxToolCalls?: number;
  /**
   * Optional P10.1: capture the CURRENT workspace revision right before verification, so
   * verification's R_before reflects the files THIS task's tool calls produced (its own
   * edits are the baseline, not "drift"). Check commands (npm test, tsc) must not mutate
   * the workspace, so a clean run stays fresh → PASS. When omitted, the request's
   * workspaceRevisionAtEnd is used as-is (pre-P10.1 behavior — correct for fake executors
   * that don't change files).
   */
  readonly verificationRevisionProvider?: { capture(reason: string): Promise<WorkspaceRevision> };
  readonly now:    () => string;
  readonly nextId: () => string;
}

// ── TaskExecutorRequest ───────────────────────────────────────────────────────

export interface TaskExecutorRequest {
  readonly sessionId:               string;
  readonly task:                    Task;
  readonly attemptNumber:           number;   // 1-indexed (from TaskExecution.attempts + 1)
  readonly graphVersion:            number;   // EX-004
  readonly workspaceRevisionAtStart: WorkspaceRevision;
  readonly workspaceRevisionAtEnd:   WorkspaceRevision;  // caller provides "current" for finalize
  /** Optional graph summary string to include in context. */
  readonly graphSummary?:           string;
}

// ── TaskExecutorResult ────────────────────────────────────────────────────────

export interface TaskExecutorResult {
  /** Final TaskRun state after finalization, or SUSPENDED when awaiting approval. */
  readonly finalState:  'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'SUSPENDED';
  /** Number of tool calls executed in this run. */
  readonly toolCallCount: number;
  /** Model's completion summary (from {type:'done'} signal). */
  readonly summary?: string;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
  /** Verification report ID if verification ran (P4-VW1). */
  readonly verificationId?: string | undefined;
  /** Verification status if verification ran (P4-VW1). */
  readonly verificationStatus?: VerificationStatus | undefined;
  /** Whether task reached PASSED state (TI-005). */
  readonly taskPassed?: boolean | undefined;
  /** Tool call ID awaiting human approval (when finalState='SUSPENDED'). */
  readonly pendingApprovalToolCallId?: string | undefined;
}

// ── TaskExecutor ──────────────────────────────────────────────────────────────

export class TaskExecutor {
  private readonly maxToolCalls: number;

  constructor(private readonly deps: TaskExecutorDeps) {
    this.maxToolCalls = deps.maxToolCalls ?? 25;
    if (this.maxToolCalls <= 0) {
      throw new RangeError(`maxToolCalls must be > 0, got ${this.maxToolCalls}`);
    }
  }

  /**
   * Execute one TaskRun for the given task.
   * Resolves with a TaskExecutorResult describing the outcome.
   * Throws TaskExecutorError only on infrastructure/finalization failures
   * (model failures and tool failures are internalized as FAILED/TIMEOUT runs).
   */
  async execute(req: TaskExecutorRequest): Promise<TaskExecutorResult> {
    const t0 = Date.now();

    // ── 1. Build and start TaskRun ──────────────────────────────────────────────
    const runId = this.deps.nextId();
    const startedAt = this.deps.now();

    const budgetConsumed: BudgetConsumption = {
      wallClockMs:       0,
      modelTokens:       0,
      toolCalls:         0,
      recoveryAttempts:  0,
    };

    const run: TaskRun = {
      taskRunId:                 runId,
      taskId:                    req.task.taskId,
      sessionId:                 req.sessionId,
      attemptNumber:             req.attemptNumber,
      state:                     'RUNNING',
      graphVersionAtStart:       req.graphVersion,
      workspaceRevisionAtStart:  req.workspaceRevisionAtStart,
      strategyUsed:              req.task.strategy,
      startedAt,
      toolCalls:                 [],
      failures:                  [],
      budgetConsumed,
    };

    // EX-004: TaskRunService.start() validates anchor fields.
    await this.deps.taskRunService.start(run);
    // EX-002: coordinator enforces single active run.
    await this.deps.executionCoordinator.onRunStarted(req.task.taskId, runId);

    // ── 2. Build context ─────────────────────────────────────────────────────
    const snapshot = this.deps.contextBuilder.build({
      sessionId:         req.sessionId,
      taskId:            req.task.taskId,
      taskRunId:         runId,
      workspaceRevision: req.workspaceRevisionAtStart,
      buildReason:       'task_execution',
      taskData:          req.task,
      ...(req.graphSummary !== undefined ? { graphSummary: req.graphSummary } : {}),
    });

    // ── 3. Tool-call loop ─────────────────────────────────────────────────────
    const toolCallIds: string[] = [];
    /** Accumulated tool-call transcript fed back to the model each iteration. */
    const transcript: Array<{ step: number; toolName: string; arguments: Record<string, unknown>; result: string; exitCode: number | null }> = [];
    let loopDone    = false;
    let finalState: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' = 'FAILED';
    let summary: string | undefined;
    let pendingApprovalToolCallIdRef: string | undefined;

    for (let i = 0; i < this.maxToolCalls && !loopDone; i++) {
      // ── 3a. Build model request ─────────────────────────────────────────────
      const taskPrompt = this.buildTaskPrompt(req.task, transcript);
      const modelReq = modelRequest(
        'execute',
        BOUNDARY_SYSTEM_PREAMBLE + '\n\n' + TASK_EXECUTOR_SYSTEM_PROMPT,
        taskPrompt,
        {
          responseSchema:  TOOL_CALL_PROPOSAL_SCHEMA,
          temperature:     0,
          maxOutputTokens: 2048,
        },
      );
      const requestWithCtx = { ...modelReq, contextSnapshotId: snapshot.snapshotId };

      // ── 3b. Call model + parse (MG-001/002/003, SE-010) ─────────────────────
      let output: RawExecuteOutput;
      try {
        output = await parseModelOutput<RawExecuteOutput>(
          this.deps.gateway,
          requestWithCtx,
          {
            schema:        TOOL_CALL_PROPOSAL_SCHEMA,
            semanticCheck: validateExecuteSemantics,
            retryFeedback: (msg, attempt) =>
              `[Attempt ${attempt}] Previous response invalid: ${msg}. ` +
              'Respond with exactly {"type":"tool_call","toolName":"...","arguments":{}} ' +
              'or {"type":"done","summary":"..."}.',
          },
        );
      } catch (err) {
        // Model failed unrecoverably — finalize as FAILED.
        finalState = err instanceof ModelError && err.code === 'MODEL_TIMEOUT'
          ? 'TIMEOUT'
          : 'FAILED';
        loopDone = true;
        break;
      }

      // ── 3c. Handle model response ───────────────────────────────────────────
      if (output.type === 'done') {
        summary    = output.summary;
        finalState = 'SUCCEEDED';
        loopDone   = true;
        break;
      }

      // type === 'tool_call'
      const proposal = output as RawToolCallProposal;

      // ── 3d. Build ToolCall domain record ────────────────────────────────────
      const toolCallId   = this.deps.nextId();
      const argumentsHash = this.hashArguments(proposal.arguments);

      // ── 3d-i. Idempotency check (TG-006) ────────────────────────────────────
      let idempotencyKey: string | undefined;
      if (this.deps.idempotencyEngine !== undefined) {
        const def = this.deps.toolRegistry?.get(proposal.toolName);
        const idResult = this.deps.idempotencyEngine.check(
          def ?? { toolName: proposal.toolName, version: '1.0', description: '',
                   riskClass: 'SYSTEM', argsSchema: {}, idempotencyStrategy: 'none' },
          proposal.arguments,
        );
        if (idResult.isDuplicate) {
          // Skip duplicate MODIFY call — continue loop without executing.
          continue;
        }
        idempotencyKey = idResult.idempotencyKey;
      }

      const provenance: Provenance = {
        provenanceId: this.deps.nextId(),
        source:       { kind: 'model', id: this.deps.gateway.identity.name },
        model: {
          name:     this.deps.gateway.identity.name,
          version:  this.deps.gateway.identity.version,
          endpoint: this.deps.gateway.identity.endpoint,
        },
        inputs:  [snapshot.snapshotId],
        reason:  proposal.reasoning ?? `step ${i + 1} of task execution`,
        at:      this.deps.now(),
      };

      const toolCall: ToolCall = {
        toolCallId,
        sessionId:     req.sessionId,
        taskId:        req.task.taskId,
        taskRunId:     runId,
        toolName:      proposal.toolName,
        toolVersion:   '1.0',
        riskClass:     this.resolveRiskClass(proposal.toolName),
        arguments:     proposal.arguments,
        argumentsHash,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        state:         'REQUESTED',
        proposedBy:    'model',
        provenance,
        requestedAt:   this.deps.now(),
      };

      // ── 3e-i. Budget debit (P4-BW1, BU-003) ────────────────────────────────
      if (this.deps.budgetRepository !== undefined && this.deps.budgetId !== undefined) {
        try {
          await this.deps.budgetRepository.consume(this.deps.budgetId, { toolCalls: 1 });
        } catch (err) {
          if (err instanceof BudgetError && err.code === 'BUDGET_EXHAUSTED') {
            // BU-005: exhausted budget must stop the task, not continue silently.
            finalState = 'TIMEOUT';
            loopDone   = true;
            break;
          }
          throw err; // unexpected — re-throw
        }
      }

      // ── 3e. ToolGateway.request() — policy check (TG-001/TG-007/TG-009) ────
      let requestedCall: ToolCall;
      try {
        requestedCall = await this.deps.toolGateway.request(toolCall);
      } catch (_err) {
        // Schema validation or gateway error.
        finalState = 'FAILED';
        loopDone   = true;
        break;
      }

      if (requestedCall.state === 'DENIED') {
        // Policy denied — treat as fatal for this run.
        finalState = 'FAILED';
        loopDone   = true;
        break;
      }

      if (requestedCall.state === 'APPROVAL_PENDING') {
        // P5-AH1: surface to caller — do NOT finalize as FAILED.
        // Finalize run as FAILED (best we can do without suspending the loop),
        // but signal SUSPENDED so SessionOrchestrator can escalate properly.
        finalState = 'FAILED';
        loopDone   = true;
        // Record the pending approval ID for the caller to surface.
        pendingApprovalToolCallIdRef = toolCallId;
        break;
      }

      // ── 3f. ToolGateway.execute() — run the tool ────────────────────────────
      // We wrap deps.executor with a capturing proxy so we can retrieve the
      // ExecutorResult (stdout/stderr) for artifact recording after execute() completes.
      // ToolGateway calls executor.execute() internally but only keeps exitCode/durationMs
      // in ToolResult — this proxy saves the full ExecutorResult for us.
      const capturingProxy = new CapturingExecutorProxy(this.deps.executor);
      let executedCall: ToolCall;
      try {
        executedCall = await this.deps.toolGateway.execute(toolCallId, capturingProxy);
      } catch (err) {
        if (err instanceof ToolGatewayError) {
          finalState = 'FAILED';
          loopDone   = true;
          break;
        }
        throw err; // unexpected — re-throw
      }

      // ── 3g. Artifact capture (P4-AP1, PR-001) ───────────────────────────────
      if (this.deps.artifactCapture !== undefined && capturingProxy.lastResult !== undefined) {
        try {
          await this.deps.artifactCapture.record(
            toolCallId,
            req.sessionId,
            capturingProxy.lastResult,
          );
        } catch {
          // Artifact recording failure is non-fatal — continue execution.
        }
      }

      // Mark idempotency key as executed (TG-006).
      if (this.deps.idempotencyEngine !== undefined) {
        this.deps.idempotencyEngine.markExecuted(idempotencyKey);
      }

      toolCallIds.push(toolCallId);

      // Record the result in the transcript so the model sees it next iteration.
      const execResult = capturingProxy.lastResult;
      const resultText = (execResult?.exitCode === 0 || execResult?.exitCode === null)
        ? (execResult?.stdout ?? '')
        : `ERROR (exit ${execResult?.exitCode}): ${execResult?.stderr || execResult?.stdout || 'tool failed'}`;
      transcript.push({
        step: transcript.length + 1,
        toolName: proposal.toolName,
        arguments: proposal.arguments,
        result: resultText.slice(0, 2000),
        exitCode: execResult?.exitCode ?? null,
      });

      // Propagate timeout (fatal — tool timed out).
      if (executedCall.state === 'TIMEOUT') {
        finalState = 'TIMEOUT';
        loopDone   = true;
        break;
      }
      // FAILED tool call is NON-FATAL: the model will see the failure in the transcript
      // and can retry, use a different approach, or decide the task is done. This is the
      // key ReAct behavior — feedback drives the next action.
      // (Only DENIED and TIMEOUT are fatal.)
    }

    // If loop exhausted without done signal → budget exceeded.
    if (!loopDone) {
      finalState = 'FAILED';
    }

    // ── 4. Finalize run ───────────────────────────────────────────────────────
    const event =
      finalState === 'SUCCEEDED' ? 'RUN_SUCCEEDED' :
      finalState === 'TIMEOUT'   ? 'RUN_TIMEOUT'   :
      'RUN_FAILED';

    try {
      await this.deps.taskRunService.finalize(
        runId,
        event,
        req.workspaceRevisionAtEnd,
      );
    } catch (err) {
      throw new TaskExecutorError(
        'FINALIZE_FAILED',
        `TaskRunService.finalize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 5. Update projection ──────────────────────────────────────────────────
    await this.deps.executionCoordinator.onRunEnded(req.task.taskId, runId, finalState);

    // ── 6. Verification (P4-VW1, TI-005) ─────────────────────────────────────
    // Only run verification on SUCCEEDED runs (failed/timed-out runs go to VERIFYING
    // then a future recovery cycle handles them — Phase 5).
    let verificationId:     string | undefined;
    let verificationStatus: VerificationStatus | undefined;
    let taskPassed         = false;

    if (finalState === 'SUCCEEDED' && this.deps.verificationEngine !== undefined) {
      try {
        const policy   = this.deps.verificationPolicy ?? DEFAULT_VERIFICATION_POLICY;
        // P10.1: R_before = the workspace AS IT IS NOW (after this task's tool calls), so
        // the agent's own edits are the baseline. Falls back to the request revision when
        // no provider is wired (fake executors don't change files).
        const targetRevision = this.deps.verificationRevisionProvider !== undefined
          ? await this.deps.verificationRevisionProvider.capture('pre_verify')
          : req.workspaceRevisionAtEnd;
        const report   = await this.deps.verificationEngine.verify({
          sessionId:       req.sessionId,
          taskId:          req.task.taskId,
          taskRunId:       runId,
          targetRevision,
          policy,
          reason:          'task_completion',
        });

        verificationId     = report.verificationId;
        verificationStatus = report.status;

        // If report PASS and CompletionGate allows → PASSED (TI-005).
        if (report.status === 'PASS' && this.deps.completionGate !== undefined) {
          const gate = await this.deps.completionGate.canComplete(
            req.task.taskId,
            targetRevision,
            policy.requiredScope,
          );
          if (gate.canComplete) {
            await this.deps.executionCoordinator.setState(req.task.taskId, 'PASSED');
            taskPassed = true;
          }
        }
      } catch {
        // Verification failure is non-fatal for the run — projection stays VERIFYING.
        // A future recovery cycle (Phase 5) will re-run verification.
      }
    }

    return {
      finalState,
      toolCallCount: toolCallIds.length,
      ...(summary                         !== undefined ? { summary }            : {}),
      ...(verificationId                  !== undefined ? { verificationId }     : {}),
      ...(verificationStatus              !== undefined ? { verificationStatus } : {}),
      ...(taskPassed                                   ? { taskPassed }         : {}),
      ...(pendingApprovalToolCallIdRef    !== undefined ? { pendingApprovalToolCallId: pendingApprovalToolCallIdRef } : {}),
      durationMs: Date.now() - t0,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Build the task prompt shown to the model on each loop iteration.
   * Includes: task description, acceptance criteria, and current progress.
   */
  private buildTaskPrompt(
    task: Task,
    transcript: ReadonlyArray<{ step: number; toolName: string; arguments: Record<string, unknown>; result: string; exitCode: number | null }>,
  ): string {
    const acLines = task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((ac) => `  - ${ac.description}`).join('\n')
      : '  (none specified)';

    const transcriptText = transcript.length > 0
      ? [
          '',
          'PREVIOUS STEPS (tool calls and their results):',
          ...transcript.map((t) =>
            `  Step ${t.step}: ${t.toolName}(${JSON.stringify(t.arguments)})` +
            `\n    → exit ${t.exitCode}: ${t.result.slice(0, 800)}`,
          ),
          '',
        ].join('\n')
      : '\n(No tool calls made yet — this is the first step.)\n';

    return buildPrompt([
      {
        label:   'TASK',
        content: [
          `Task: ${task.description}`,
          '',
          'Acceptance criteria:',
          acLines,
          '',
          `Progress: ${transcript.length} step(s) completed.`,
          transcriptText,
          'Decide the next action. Respond with JSON only.',
          'To use a tool: {"type":"tool_call","toolName":"<name>","arguments":{...}}',
          'When the task is complete: {"type":"done","summary":"<what was accomplished>"}',
          '',
          'Think step by step: first explore the workspace, then make changes, then verify.',
        ].join('\n'),
        trust: 'trusted',
      },
    ]);
  }

  /**
   * Resolve the RiskClass for a tool name.
   * Mirrors the definitions in FILESYSTEM_TOOL_DEFINITIONS (ToolRegistry).
   */
  private resolveRiskClass(toolName: string): RiskClass {
    switch (toolName) {
      case 'read_file':
      case 'list_dir':
      case 'git_status':
      case 'git_diff':
      case 'git_log':
        return 'READ_ONLY';
      case 'write_file':
      case 'git_add':
      case 'git_commit':
        return 'MODIFY_WORKSPACE';
      case 'delete_file':
        return 'DESTRUCTIVE';
      case 'run_command':
        return 'SYSTEM';
      default:
        return 'SYSTEM';
    }
  }

  /**
   * Produce a stable string hash of the arguments object.
   * Used as argumentsHash on ToolCall (TG-003 binding).
   * Simple deterministic JSON canonical form — not cryptographic.
   */
  private hashArguments(args: Record<string, unknown>): string {
    return `sha1:${Buffer.from(JSON.stringify(args)).toString('base64').slice(0, 40)}`;
  }
}

// ── CapturingExecutorProxy ────────────────────────────────────────────────────

/**
 * Lightweight ToolExecutor proxy that stores the last ExecutorResult so
 * TaskExecutor can retrieve stdout/stderr for artifact recording (P4-AP1).
 *
 * Created per tool-call inside TaskExecutor.execute() — no state leaks between calls.
 */
class CapturingExecutorProxy implements ToolExecutor {
  public lastResult: import('../tool/tool-gateway.js').ExecutorResult | undefined;

  constructor(private readonly inner: ToolExecutor) {}

  async execute(call: ToolCall): Promise<import('../tool/tool-gateway.js').ExecutorResult> {
    const result = await this.inner.execute(call);
    this.lastResult = result;
    return result;
  }
}
