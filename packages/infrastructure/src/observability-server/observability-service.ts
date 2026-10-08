// ObservabilityService (P9.3) — PROTOCOL-AGNOSTIC facade that assembles the read-models
// and routes control, so any transport (HTTP, Telegram, VS Code, CLI) is a thin shell
// over the same logic. No HTTP here.
//
// Reads (OB-005/009/010): assembles a RuntimeInput from repositories and runs the PURE
// agent-core reducers (computeRuntimeProjection, buildActivityTrace, computeContext
// telemetry via the EventLog). It never writes authoritative state on a read path.
//
// Control (OB-006): submitControl() admits a ControlRequest through the PURE ControlPlane
// and, only if admitted, performs the exact kernel action it returns (SessionService
// transition / ToolGateway approve-deny). The service does not invent authority — it is
// a courier between the transport and the kernel, gated by ControlPlane admission.
import type {
  SessionRepository,
  TaskGraphRepository,
  TaskExecutionRepository,
  TaskRunRepository,
  EventLog,
  DomainEvent,
  RuntimeProjection,
  ActivityTrace,
  AuditTimeline,
  SessionMetrics,
  ControlRequest,
  ControlStateInput,
  AdmissionResult,
  InterventionRecord,
  SessionState,
  ToolCallState,
  TaskState,
  EdgeInput,
  TaskStateInput,
  ActiveRunInput,
} from '@codeforge/agent-core';
import {
  computeRuntimeProjection,
  buildActivityTrace,
  buildAuditTimeline,
  computeSessionMetrics,
  ControlPlane,
  buildInterventionRecord,
} from '@codeforge/agent-core';

// ── Kernel ports the service needs to EXECUTE an admitted control action ────────
// (Narrow structural interfaces so the service does not import concrete classes.)

export interface SessionControlPort {
  transition(sessionId: string, event: string, ctx?: Record<string, unknown>): Promise<unknown>;
}
export interface ToolControlPort {
  approve(toolCallId: string, decidedBy: 'user', expiresAt?: string): Promise<unknown>;
  deny(toolCallId: string, decidedBy: 'user', reason?: string): Promise<unknown>;
}
/** Reads a tool call's current state (for approve/deny admission). Optional. */
export interface ToolStateReader {
  getState(toolCallId: string): Promise<ToolCallState | null>;
}
/** Accepts a new goal submitted at runtime (P10.9). Optional. */
export interface GoalIngressPort {
  submitGoal(input: { description: string; acceptanceCriteria?: readonly string[] }):
    { goalId: string; position: number };
}

/** Progress update for a model pull (mirrors OllamaModelAdmin.PullProgress structurally). */
export interface ModelPullProgress {
  readonly status: string;
  readonly total?: number;
  readonly completed?: number;
  readonly percent?: number;
  readonly done: boolean;
  readonly error?: string;
}
/** Model management port (list installed models + pull a new one). Optional, no authority. */
export interface ModelAdminPort {
  listModels(): Promise<readonly { readonly name: string; readonly sizeBytes?: number; readonly parameterSize?: string; readonly quantization?: string }[]>;
  pullModel(name: string, onProgress: (p: ModelPullProgress) => void): Promise<void>;
}

export interface ObservabilityServiceDeps {
  readonly sessions: SessionRepository;
  readonly graphs: TaskGraphRepository;
  readonly executions: TaskExecutionRepository;
  readonly taskRuns: TaskRunRepository;
  readonly events: EventLog;
  readonly controlPlane: ControlPlane;
  /** Executes an admitted session transition (SessionService). */
  readonly sessionControl: SessionControlPort;
  /** Executes an admitted tool approve/deny (ToolGateway). Optional. */
  readonly toolControl?: ToolControlPort;
  /** Reads tool-call state for approve/deny admission. Optional. */
  readonly toolStateReader?: ToolStateReader;
  /** P10.9: accepts goals submitted at runtime (POST /goal). Optional. */
  readonly goalIngress?: GoalIngressPort;
  /** Model management (list + pull local Ollama models). Optional; no runtime authority. */
  readonly modelAdmin?: ModelAdminPort;
  readonly now: () => string;
  readonly nextId: () => string;
}

export interface SubmitControlResult {
  readonly admission: AdmissionResult;
  readonly record: InterventionRecord;
}

export class ObservabilityServiceError extends Error {
  public readonly code: 'SESSION_NOT_FOUND' | 'CONTROL_UNSUPPORTED' | 'CONTROL_FAILED' | 'GOAL_INGRESS_UNSUPPORTED' | 'MODEL_ADMIN_UNSUPPORTED';
  constructor(code: ObservabilityServiceError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ObservabilityServiceError';
    this.code = code;
  }
}

export class ObservabilityService {
  constructor(private readonly deps: ObservabilityServiceDeps) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Current runtime read-model for the session (OB-005). Null if the session is unknown. */
  async getState(sessionId: string): Promise<RuntimeProjection | null> {
    const session = await this.deps.sessions.getById(sessionId);
    if (session === null) return null;

    const graph = await this.deps.graphs.getCurrent(sessionId);
    const tasks: TaskStateInput[] = [];
    for (const node of graph.nodes) {
      const exec = await this.deps.executions.getByTask(node.taskId);
      tasks.push({
        taskId: node.taskId,
        state: (exec?.currentState ?? 'PENDING') as TaskState,
        attempts: exec?.attempts ?? 0,
        ...(exec?.currentRunId !== undefined ? { currentRunId: exec.currentRunId } : {}),
        ...(exec?.latestVerificationId !== undefined ? { latestVerificationId: exec.latestVerificationId } : {}),
        ...(exec?.latestFailureId !== undefined ? { latestFailureId: exec.latestFailureId } : {}),
      });
    }
    const edges: EdgeInput[] = graph.edges
      .filter((e) => e.kind === 'depends_on' || e.kind === 'blocks')
      .map((e) => (e.kind === 'depends_on'
        ? { fromTaskId: e.fromTaskId, toTaskId: e.toTaskId }
        : { fromTaskId: e.toTaskId, toTaskId: e.fromTaskId })); // blocks ≡ reversed depends_on
    const running = await this.deps.taskRuns.findRunning(sessionId);
    const activeRuns: ActiveRunInput[] = running.map((r) => ({
      taskRunId: r.taskRunId, taskId: r.taskId, attemptNumber: r.attemptNumber, startedAt: r.startedAt,
    }));

    return computeRuntimeProjection({
      sessionId,
      sessionState: session.state,
      goalId: session.goalId,
      graphVersion: graph.version,
      workspaceRevisionId: `graph-v${graph.version}`,
      model: session.metadata.ollamaModels.executor,
      provider: 'ollama',
      tasks,
      edges,
      activeRuns,
    });
  }

  /** Structured activity trace for the session (OB-007), from the redacted event log. */
  async getTrace(sessionId: string): Promise<ActivityTrace> {
    const events = await this.deps.events.query({ sessionId });
    return buildActivityTrace(sessionId, events);
  }

  /** Replayable audit timeline (phase + authority path) for the session (OB-004/007). */
  async getAuditTimeline(sessionId: string): Promise<AuditTimeline> {
    const events = await this.deps.events.query({ sessionId });
    return buildAuditTimeline(sessionId, events);
  }

  /** Per-session behavior metrics for dogfood measurement (P9.12). */
  async getMetrics(sessionId: string): Promise<SessionMetrics> {
    const events = await this.deps.events.query({ sessionId });
    return computeSessionMetrics(sessionId, events);
  }

  /** Raw ordered events for replay/audit (OB-004). */
  async getEvents(sessionId: string, fromSequence = 0): Promise<readonly DomainEvent[]> {
    return this.deps.events.query({ sessionId, fromSequence });
  }

  /**
   * Stream events for the session in sequence order, starting after `fromSequence`
   * (OB-009: read-only tail — never a second write path).
   */
  async *streamEvents(sessionId: string, fromSequence = 0): AsyncIterable<DomainEvent> {
    yield* this.deps.events.stream(sessionId, fromSequence);
  }

  // ── Control ──────────────────────────────────────────────────────────────────

  /**
   * Admit a control request and, if admitted, perform the exact kernel action it returns.
   * Always produces an InterventionRecord (OB-006). A rejected request performs nothing.
   */
  async submitControl(request: ControlRequest): Promise<SubmitControlResult> {
    const session = await this.deps.sessions.getById(request.sessionId);
    if (session === null) throw new ObservabilityServiceError('SESSION_NOT_FOUND', request.sessionId);

    const stateInput: ControlStateInput = {
      sessionId: request.sessionId,
      sessionState: session.state as SessionState,
      ...(await this.toolStateFor(request)),
    };

    const admission = this.deps.controlPlane.admit(request, stateInput);
    const interventionId = this.deps.nextId();

    if (!admission.admitted) {
      return {
        admission,
        record: buildInterventionRecord({ interventionId, request, admission, at: this.deps.now() }),
      };
    }

    let outcome: 'applied' | 'failed' = 'applied';
    try {
      await this.perform(admission);
    } catch {
      outcome = 'failed';
    }
    return {
      admission,
      record: buildInterventionRecord({ interventionId, request, admission, at: this.deps.now(), executionOutcome: outcome }),
    };
  }

  /**
   * P10.9: submit a NEW goal at runtime. Delegates to the GoalIngressService (which builds
   * a user-origin Goal and queues it). This is a Decision Gate — it only records intent;
   * the runtime worker still routes the goal through Planner → GraphCommit → orchestrator
   * (GI-009), so no authority is bypassed. Throws if goal ingress is not wired.
   */
  submitGoal(input: { description: string; acceptanceCriteria?: readonly string[] }): { goalId: string; position: number } {
    if (this.deps.goalIngress === undefined) {
      throw new ObservabilityServiceError('GOAL_INGRESS_UNSUPPORTED', 'goal ingress not wired');
    }
    return this.deps.goalIngress.submitGoal(input);
  }

  // ── Model management (optional; list + pull local models) ──────────────────────

  /** List locally-installed models. Throws MODEL_ADMIN_UNSUPPORTED when not wired. */
  async listModels(): Promise<readonly { name: string; sizeBytes?: number; parameterSize?: string; quantization?: string }[]> {
    if (this.deps.modelAdmin === undefined) {
      throw new ObservabilityServiceError('MODEL_ADMIN_UNSUPPORTED', 'model admin not wired');
    }
    return this.deps.modelAdmin.listModels();
  }

  /** Pull (download) a model, reporting progress. Throws MODEL_ADMIN_UNSUPPORTED when not wired. */
  async pullModel(name: string, onProgress: (p: ModelPullProgress) => void): Promise<void> {
    if (this.deps.modelAdmin === undefined) {
      throw new ObservabilityServiceError('MODEL_ADMIN_UNSUPPORTED', 'model admin not wired');
    }
    return this.deps.modelAdmin.pullModel(name, onProgress);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private async toolStateFor(request: ControlRequest): Promise<{ toolCallState?: ToolCallState }> {
    if ((request.intent !== 'approve' && request.intent !== 'deny') || request.toolCallId === undefined) return {};
    if (this.deps.toolStateReader === undefined) return {};
    const st = await this.deps.toolStateReader.getState(request.toolCallId);
    return st !== null ? { toolCallState: st } : {};
  }

  private async perform(admission: Extract<AdmissionResult, { admitted: true }>): Promise<void> {
    const a = admission.action;
    switch (a.kind) {
      case 'session_transition':
        await this.deps.sessionControl.transition(a.sessionId, a.event);
        return;
      case 'tool_decision': {
        if (this.deps.toolControl === undefined) throw new ObservabilityServiceError('CONTROL_UNSUPPORTED', 'tool control not wired');
        if (a.decision === 'approve') await this.deps.toolControl.approve(a.toolCallId, a.decidedBy);
        else await this.deps.toolControl.deny(a.toolCallId, a.decidedBy, a.reason);
        return;
      }
      case 'retry_task':
      case 'checkpoint':
        // Retry/checkpoint execution is owned by the orchestrator/checkpoint service; the
        // admitted record is the signal. A dedicated port can be wired later (P9.10+).
        return;
      default:
        return;
    }
  }
}
