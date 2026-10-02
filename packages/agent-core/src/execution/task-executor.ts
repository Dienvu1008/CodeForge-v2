// TaskExecutor — P3-TE1. Orchestrates one TaskRun end-to-end.
//
// Flow for a single TaskRun:
//   1. Start TaskRun via TaskRunService (EX-004: anchor required).
//   2. Update ExecutionCoordinator projection (EX-002: single active run).
//   3. Build ContextSnapshot for the task (CX-003: workspace items marked untrusted).
//   4. Tool-call loop (bounded by maxToolCalls):
//      a. Ask model for next action (purpose='execute').
//      b. Parse model output through StructuredOutputParser (MG-002/003, SE-010).
//      c. If {type:'done'} → break loop (success).
//      d. If {type:'tool_call'} → route via ToolGateway (TG-001):
//         - request() → policy check → APPROVED | DENIAL.
//         - execute() → SUCCEEDED | FAILED | TIMEOUT.
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
   * Hard upper bound on tool calls per run (prevents infinite loops).
   * Default: 25. Must be > 0.
   */
  readonly maxToolCalls?: number;
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
  /** Final TaskRun state after finalization. */
  readonly finalState:  'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
  /** Number of tool calls executed in this run. */
  readonly toolCallCount: number;
  /** Model's completion summary (from {type:'done'} signal). */
  readonly summary?: string;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
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
    let loopDone    = false;
    let finalState: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' = 'FAILED';
    let summary: string | undefined;

    for (let i = 0; i < this.maxToolCalls && !loopDone; i++) {
      // ── 3a. Build model request ─────────────────────────────────────────────
      const taskPrompt = this.buildTaskPrompt(req.task, toolCallIds.length, summary);
      const modelReq = modelRequest(
        'execute',
        BOUNDARY_SYSTEM_PREAMBLE + '\n\nYou are executing a task step by step using tools.\n' +
          'Respond with JSON: either {"type":"tool_call","toolName":"...","arguments":{...}} ' +
          'or {"type":"done","summary":"..."}.',
        taskPrompt,
        {
          responseSchema:  TOOL_CALL_PROPOSAL_SCHEMA,
          temperature:     0,
          maxOutputTokens: 1024,
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
        state:         'REQUESTED',
        proposedBy:    'model',
        provenance,
        requestedAt:   this.deps.now(),
      };

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
        // Human approval required — cannot proceed autonomously; fail the run.
        // In a future phase, this would surface to the UI and pause.
        finalState = 'FAILED';
        loopDone   = true;
        break;
      }

      // ── 3f. ToolGateway.execute() — run the tool ────────────────────────────
      let executedCall: ToolCall;
      try {
        executedCall = await this.deps.toolGateway.execute(toolCallId, this.deps.executor);
      } catch (err) {
        if (err instanceof ToolGatewayError) {
          finalState = 'FAILED';
          loopDone   = true;
          break;
        }
        throw err; // unexpected — re-throw
      }

      toolCallIds.push(toolCallId);

      // Propagate timeout.
      if (executedCall.state === 'TIMEOUT') {
        finalState = 'TIMEOUT';
        loopDone   = true;
        break;
      }
      // FAILED tool call is not necessarily fatal — loop can continue
      // (model will see the failure in context on next iteration).
      // For now, conservatively fail the run on any tool failure.
      if (executedCall.state === 'FAILED') {
        finalState = 'FAILED';
        loopDone   = true;
        break;
      }
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

    return {
      finalState,
      toolCallCount: toolCallIds.length,
      ...(summary !== undefined ? { summary } : {}),
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
    stepsSoFar: number,
    _lastSummary?: string,
  ): string {
    const acLines = task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((ac) => `  - ${ac.description}`).join('\n')
      : '  (none specified)';

    return buildPrompt([
      {
        label:   'TASK',
        content: [
          `Task: ${task.description}`,
          '',
          'Acceptance criteria:',
          acLines,
          '',
          `Progress: ${stepsSoFar} tool call(s) completed so far.`,
          '',
          'Decide the next action. Respond with JSON only.',
          'To use a tool: {"type":"tool_call","toolName":"<name>","arguments":{...}}',
          'When done:     {"type":"done","summary":"<what was accomplished>"}',
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
