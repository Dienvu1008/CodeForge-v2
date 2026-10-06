// RuntimeProjection (P9.2) — pure, deterministic read-model of "what is the agent
// doing now", derived from already-fetched authoritative snapshots. Enforces OB-005.
//
// NOT AUTHORITY: computeRuntimeProjection() takes PLAIN DATA (a RuntimeInput the caller
// assembled from repositories) and returns a read-model DTO. It holds no repository
// handle, exposes no mutator, performs no I/O. The dashboard consumes the DTO; it can
// never write authoritative state through this layer. Authoritative state remains the
// Session / TaskExecution / TaskRun / TaskGraph / Budget / Verification aggregates +
// EventLog — this projection only derives a view of them.
import type { SessionState, TaskState } from '../state-machine/states.js';
import type { BudgetLimits, BudgetConsumption } from '../domain/budget.js';

// ── Input (plain data — assembled by the caller from repositories) ─────────────

/** One task's current execution state, projected for the dashboard task tree. */
export interface TaskStateInput {
  readonly taskId: string;
  readonly state: TaskState;
  readonly attempts: number;
  readonly currentRunId?: string;
  readonly latestVerificationId?: string;
  readonly latestFailureId?: string;
}

/** A dependency edge (from depends_on to), for rendering the task tree. */
export interface EdgeInput {
  readonly fromTaskId: string;
  readonly toTaskId: string;
}

/** A currently-RUNNING task run (from TaskRunRepository.findRunning). */
export interface ActiveRunInput {
  readonly taskRunId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly startedAt: string;
}

export interface BudgetInput {
  readonly limits: BudgetLimits;
  readonly consumed: BudgetConsumption;
  readonly state: 'ACTIVE' | 'EXHAUSTED' | 'CLOSED';
}

export interface RuntimeInput {
  readonly sessionId: string;
  readonly sessionState: SessionState;
  readonly goalId: string;
  readonly graphVersion: number;
  readonly workspaceRevisionId: string;
  readonly model?: string;
  readonly provider?: string;
  readonly tasks: readonly TaskStateInput[];
  readonly edges: readonly EdgeInput[];
  readonly activeRuns: readonly ActiveRunInput[];
  readonly budget?: BudgetInput;
}

// ── Output (read-model) ─────────────────────────────────────────────────────

export interface TaskProjection {
  readonly taskId: string;
  readonly state: TaskState;
  readonly attempts: number;
  readonly isTerminal: boolean;
  readonly isActive: boolean;
  readonly isBlocked: boolean;
  readonly blockedBy: readonly string[]; // dependency taskIds not yet PASSED
  readonly dependsOn: readonly string[];
}

export interface BudgetProjection {
  readonly state: 'ACTIVE' | 'EXHAUSTED' | 'CLOSED';
  readonly limits: BudgetLimits;
  readonly consumed: BudgetConsumption;
  readonly remaining: BudgetLimits;
  /** Max consumed/limit ratio across dimensions, 0..1 (the tightest dimension). */
  readonly pressure: number;
}

export interface RuntimeProjection {
  readonly sessionId: string;
  readonly sessionState: SessionState;
  readonly goalId: string;
  readonly graphVersion: number;
  readonly workspaceRevisionId: string;
  readonly model?: string;
  readonly provider?: string;

  readonly tasks: readonly TaskProjection[];
  readonly activeTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly passedTaskIds: readonly string[];
  readonly activeRunCount: number;

  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly active: number;
    readonly blocked: number;
    readonly failed: number;
    readonly pending: number;
  };

  readonly budget?: BudgetProjection;
}

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['PASSED', 'SUPERSEDED', 'ABORTED']);

// ── computeRuntimeProjection ───────────────────────────────────────────────────

/**
 * Reduce authoritative snapshots into the dashboard read-model. Pure + total: same
 * input → same projection. Deterministic ordering (tasks + id lists sorted).
 */
export function computeRuntimeProjection(input: RuntimeInput): RuntimeProjection {
  // Dependency predecessors: task → set of tasks that must PASS before it is READY.
  const dependsOn = new Map<string, Set<string>>();
  for (const e of input.edges) {
    const set = dependsOn.get(e.fromTaskId) ?? new Set<string>();
    set.add(e.toTaskId);
    dependsOn.set(e.fromTaskId, set);
  }

  const stateById = new Map<string, TaskState>();
  for (const t of input.tasks) stateById.set(t.taskId, t.state);
  const activeRunTaskIds = new Set(input.activeRuns.map((r) => r.taskId));

  const tasks: TaskProjection[] = [...input.tasks]
    .sort((a, b) => compareStr(a.taskId, b.taskId))
    .map((t) => {
      const deps = [...(dependsOn.get(t.taskId) ?? [])].sort(compareStr);
      const blockedBy = deps.filter((d) => stateById.get(d) !== 'PASSED');
      const isTerminal = TERMINAL_TASK_STATES.has(t.state);
      // Blocked = pending/ready-ish but has an unsatisfied dependency.
      const isBlocked = !isTerminal && t.state !== 'RUNNING' && blockedBy.length > 0;
      return {
        taskId: t.taskId,
        state: t.state,
        attempts: t.attempts,
        isTerminal,
        isActive: activeRunTaskIds.has(t.taskId) || t.state === 'RUNNING',
        isBlocked,
        blockedBy,
        dependsOn: deps,
      };
    });

  const activeTaskIds = tasks.filter((t) => t.isActive).map((t) => t.taskId);
  const blockedTaskIds = tasks.filter((t) => t.isBlocked).map((t) => t.taskId);
  const passedTaskIds = tasks.filter((t) => t.state === 'PASSED').map((t) => t.taskId);

  const counts = {
    total: tasks.length,
    passed: passedTaskIds.length,
    active: activeTaskIds.length,
    blocked: blockedTaskIds.length,
    failed: tasks.filter((t) => t.state === 'FAILED' || t.state === 'FAILURE_ANALYZED').length,
    pending: tasks.filter((t) => t.state === 'PENDING').length,
  };

  return {
    sessionId: input.sessionId,
    sessionState: input.sessionState,
    goalId: input.goalId,
    graphVersion: input.graphVersion,
    workspaceRevisionId: input.workspaceRevisionId,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    tasks,
    activeTaskIds,
    blockedTaskIds,
    passedTaskIds,
    activeRunCount: input.activeRuns.length,
    counts,
    ...(input.budget !== undefined ? { budget: projectBudget(input.budget) } : {}),
  };
}

function projectBudget(b: BudgetInput): BudgetProjection {
  const remaining: BudgetLimits = {
    wallClockMs: Math.max(0, b.limits.wallClockMs - b.consumed.wallClockMs),
    modelTokens: Math.max(0, b.limits.modelTokens - b.consumed.modelTokens),
    toolCalls: Math.max(0, b.limits.toolCalls - b.consumed.toolCalls),
    recoveryAttempts: Math.max(0, b.limits.recoveryAttempts - b.consumed.recoveryAttempts),
  };
  const ratios = [
    ratio(b.consumed.wallClockMs, b.limits.wallClockMs),
    ratio(b.consumed.modelTokens, b.limits.modelTokens),
    ratio(b.consumed.toolCalls, b.limits.toolCalls),
    ratio(b.consumed.recoveryAttempts, b.limits.recoveryAttempts),
  ];
  return { state: b.state, limits: b.limits, consumed: b.consumed, remaining, pressure: Math.max(...ratios) };
}

function ratio(consumed: number, limit: number): number {
  if (limit <= 0) return consumed > 0 ? 1 : 0;
  return Math.min(1, consumed / limit);
}

/** Total, locale-independent string order (deterministic across platforms). */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
