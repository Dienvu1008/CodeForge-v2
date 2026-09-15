// Scheduler (P1-SC1) — GRAPH_PROTOCOL §3, STATE_MACHINE_SPEC §4. Enforces SC-001..006.
//
// PURE + DETERMINISTIC (SC-001/SC-006): computeReady() and selectNext() are total
// functions of (graph structure, task states, budget). No LLM (SC-005 — the scheduler
// never reads model output), no random, no wall-clock. Same input → same output.
//
//   - SC-003: a PENDING task becomes READY only when EVERY dependency is PASSED.
//   - SC-002: only READY tasks are schedulable (selectNext returns a READY task).
//   - SC-004: a task whose budget is exhausted is not scheduled.
//
// Dependency semantics (GRAPH_PROTOCOL §3.1/§3.2): edge `A --depends_on--> B` means B must
// PASS before A is READY. `A --blocks--> B` ≡ `B --depends_on--> A` (A must PASS before B).
// `supersedes` edges are NOT dependencies (excluded from readiness).
import type { GraphNode, GraphEdge } from '../graph/types.js';
import type { TaskState } from '../state-machine/states.js';

/** Predecessors of a task per dependency semantics: tasks that must PASS before it is READY. */
function dependencyPredecessors(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const preds = new Map<string, Set<string>>();
  const add = (task: string, mustPass: string): void => {
    const set = preds.get(task) ?? new Set<string>();
    set.add(mustPass);
    preds.set(task, set);
  };
  for (const e of edges) {
    if (e.kind === 'depends_on') {
      // from depends_on to  →  `to` must PASS before `from` is READY.
      add(e.fromTaskId, e.toTaskId);
    } else if (e.kind === 'blocks') {
      // from blocks to  ≡  to depends_on from  →  `from` must PASS before `to` is READY.
      add(e.toTaskId, e.fromTaskId);
    }
    // supersedes: not a dependency.
  }
  return preds;
}

export interface ScheduleInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Current state of each task (by taskId). Missing => treated as PENDING. */
  readonly states: ReadonlyMap<string, TaskState>;
  /**
   * Whether a task has budget to run (SC-004). Missing/true => allowed; false => blocked.
   * Deterministic predicate supplied by the BudgetEngine — the scheduler does not compute budget.
   */
  readonly budgetOk?: ReadonlyMap<string, boolean>;
}

export interface ScheduleDecision {
  /** PENDING tasks whose dependencies are all PASSED (candidates to move to READY). */
  readonly newlyReady: readonly string[];
  /** Tasks currently in READY state that are also budget-ok (schedulable now). */
  readonly schedulable: readonly string[];
  /** The single deterministic next task to schedule, or undefined if none. */
  readonly next?: string;
}

function stateOf(states: ReadonlyMap<string, TaskState>, taskId: string): TaskState {
  return states.get(taskId) ?? 'PENDING';
}

function budgetOk(input: ScheduleInput, taskId: string): boolean {
  return input.budgetOk?.get(taskId) ?? true;
}

/** SC-003: all dependencies of `taskId` are PASSED. */
export function dependenciesSatisfied(
  taskId: string,
  preds: Map<string, Set<string>>,
  states: ReadonlyMap<string, TaskState>,
): boolean {
  const deps = preds.get(taskId);
  if (!deps || deps.size === 0) return true; // no deps → root, satisfied
  for (const dep of deps) {
    if (stateOf(states, dep) !== 'PASSED') return false;
  }
  return true;
}

/**
 * Compute the deterministic schedule decision. `newlyReady` are PENDING tasks whose deps
 * are all PASSED (SC-003). `schedulable` are READY + budget-ok tasks (SC-002/SC-004).
 * `next` is the lexicographically-smallest schedulable taskId (a stable, deterministic
 * tie-break — SC-001/SC-006). Priority-based ordering can layer on later without breaking
 * determinism as long as the comparator is total.
 */
export function computeSchedule(input: ScheduleInput): ScheduleDecision {
  const preds = dependencyPredecessors(input.edges);
  const taskIds = input.nodes.map((n) => n.taskId);

  const newlyReady = taskIds
    .filter(
      (id) =>
        stateOf(input.states, id) === 'PENDING' &&
        dependenciesSatisfied(id, preds, input.states),
    )
    .sort();

  const schedulable = taskIds
    .filter((id) => stateOf(input.states, id) === 'READY' && budgetOk(input, id))
    .sort();

  const next = schedulable[0];
  return { newlyReady, schedulable, ...(next !== undefined ? { next } : {}) };
}

/** True iff a PENDING task is eligible to transition to READY now (SC-003 helper). */
export function isReadyEligible(taskId: string, input: ScheduleInput): boolean {
  const preds = dependencyPredecessors(input.edges);
  return stateOf(input.states, taskId) === 'PENDING' && dependenciesSatisfied(taskId, preds, input.states);
}
