// GraphValidator (P1-G2) — GRAPH_PROTOCOL §5. Enforces GI-002/004/005/006/007/009.
//
// PURE + DETERMINISTIC: validateMutation(graph, mutation, ctx) runs the 7 staged checks
// and returns a ValidationResult (never throws for a rule violation). It does NOT commit
// anything — commit is P1-G3 and only proceeds when status === 'VALIDATED' (GI-002).
//
// Stages (§5.2): 1 SCHEMA, 2 REFERENCE, 3 OPERATION_SEMANTICS, 4 STRUCTURAL (cycle/self-loop),
// 5 REACHABILITY (warning), 6 SUPERSESSION, 7 POLICY. Each stage appends structured
// ValidationError{stage, code, message, ...}. The validator stops promoting to later
// stages once earlier stages produced errors that make later checks meaningless (schema/
// reference), but always returns the full error list gathered so far.
import type {
  TaskGraph,
  GraphMutation,
  GraphOperation,
  GraphNode,
  GraphEdge,
  ValidationError,
  EdgeKind,
} from './types.js';
import { hasCycleOfKinds, hasSelfLoop, DEPENDS_KINDS, SUPERSEDES_KINDS } from './cycle-detector.js';

export interface ValidationResult {
  readonly status: 'VALIDATED' | 'REJECTED';
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationError[];
  readonly appliedOps: number;
}

/** Runtime facts the validator needs that live outside the graph structure. */
export interface ValidationContext {
  /** taskIds whose TaskExecution is currently RUNNING (SUPERSEDE guard §6.4). */
  readonly runningTaskIds?: ReadonlySet<string>;
  /** taskIds that are already PASSED (policy: no remove/supersede §5.9/§6.5). */
  readonly passedTaskIds?: ReadonlySet<string>;
  /** taskIds already SUPERSEDED in the current graph. */
  readonly supersededTaskIds?: ReadonlySet<string>;
  /** Max operations per mutation (§5.9). Default 100. */
  readonly maxOps?: number;
  /** Max supersede chain depth (§6.3). Default 5. */
  readonly maxSupersedeDepth?: number;
}

const DEFAULT_MAX_OPS = 100;

/** Working, mutable projection of the graph while operations are applied in order. */
interface WorkState {
  taskIds: Set<string>;
  edges: GraphEdge[];
  removed: Set<string>;
  superseded: Set<string>;
}

export function validateMutation(
  graph: TaskGraph,
  mutation: GraphMutation,
  ctx: ValidationContext = {},
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const maxOps = ctx.maxOps ?? DEFAULT_MAX_OPS;

  // ── Stage 1: SCHEMA ────────────────────────────────────────────────────────
  if (!Number.isInteger(mutation.baseVersion) || mutation.baseVersion < 0) {
    errors.push(err(1, 'SCHEMA_INVALID', 'baseVersion must be a non-negative integer'));
  }
  if (mutation.operations.length === 0) {
    errors.push(err(1, 'SCHEMA_INVALID', 'operations must not be empty'));
  }
  // Task ids introduced by this mutation must be unique within it AND not already exist.
  const addedIds = new Set<string>();
  for (let i = 0; i < mutation.operations.length; i++) {
    const op = mutation.operations[i];
    if (!op) continue;
    const added = addedTaskId(op);
    if (added !== undefined) {
      if (addedIds.has(added) || graph.nodes.some((n) => n.taskId === added)) {
        errors.push(err(1, 'TASK_ID_DUPLICATE', `duplicate taskId ${added}`, i, added));
      }
      addedIds.add(added);
    }
  }
  if (errors.length > 0) return reject(errors, warnings, 0);

  // ── Build working state, applying ops in order (stages 2 & 3 interleave) ─────
  const work: WorkState = {
    taskIds: new Set(graph.nodes.map((n) => n.taskId)),
    edges: graph.edges.map((e) => ({ ...e })),
    removed: new Set(),
    superseded: new Set(ctx.supersededTaskIds ?? []),
  };

  let applied = 0;
  for (let i = 0; i < mutation.operations.length; i++) {
    const op = mutation.operations[i];
    if (!op) continue;
    const stageErrs = applyOp(work, op, i, ctx);
    errors.push(...stageErrs);
    if (stageErrs.length === 0) applied += 1;
  }
  if (errors.length > 0) return reject(errors, warnings, applied);

  // ── Stage 4: STRUCTURAL (cycle / self-loop) ─────────────────────────────────
  const liveNodes: GraphNode[] = [...work.taskIds].map((taskId) => ({ taskId, addedInVersion: graph.version + 1 }));
  const liveEdges = work.edges.filter(
    (e) => work.taskIds.has(e.fromTaskId) && work.taskIds.has(e.toTaskId),
  );
  if (hasSelfLoop(liveEdges)) {
    errors.push(err(4, 'SELF_LOOP', 'graph contains a self-loop edge'));
  }
  if (hasCycleOfKinds(liveNodes, liveEdges, DEPENDS_KINDS)) {
    errors.push(err(4, 'CYCLE_DETECTED', 'dependency graph contains a cycle'));
  }
  if (hasCycleOfKinds(liveNodes, liveEdges, SUPERSEDES_KINDS)) {
    errors.push(err(4, 'SUPERSEDES_CYCLE', 'supersedes relation contains a cycle'));
  }
  if (errors.length > 0) return reject(errors, warnings, applied);

  // ── Stage 5: REACHABILITY (warning only, §5.7 multi-root allowed) ───────────
  for (const orphan of findOrphans(liveNodes, liveEdges)) {
    warnings.push(err(5, 'ORPHAN_TASK', `task ${orphan} has no path from a root`, undefined, orphan));
  }

  // ── Stage 6: SUPERSESSION ───────────────────────────────────────────────────
  for (let i = 0; i < mutation.operations.length; i++) {
    const op = mutation.operations[i];
    if (op?.kind !== 'SUPERSEDE_TASK') continue;
    if (ctx.runningTaskIds?.has(op.oldTaskId)) {
      errors.push(
        err(6, 'SUPERSEDE_WITH_RUNNING_EXECUTION', `cannot supersede running task ${op.oldTaskId}`, i, op.oldTaskId),
      );
    }
  }

  // ── Stage 7: POLICY ─────────────────────────────────────────────────────────
  if (mutation.operations.length > maxOps) {
    errors.push(err(7, 'MUTATION_TOO_LARGE', `mutation has ${mutation.operations.length} ops (max ${maxOps})`));
  }
  for (let i = 0; i < mutation.operations.length; i++) {
    const op = mutation.operations[i];
    if (!op) continue;
    if (op.kind === 'REMOVE_TASK' && ctx.passedTaskIds?.has(op.taskId)) {
      errors.push(err(7, 'REMOVE_PASSED_TASK', `cannot remove PASSED task ${op.taskId}`, i, op.taskId));
    }
    if (op.kind === 'SUPERSEDE_TASK' && ctx.passedTaskIds?.has(op.oldTaskId)) {
      errors.push(err(7, 'POLICY_VIOLATION', `cannot supersede PASSED task ${op.oldTaskId}`, i, op.oldTaskId));
    }
  }

  return errors.length > 0
    ? reject(errors, warnings, applied)
    : { status: 'VALIDATED', errors, warnings, appliedOps: applied };
}

// ── operation application (stages 2 REFERENCE + 3 SEMANTICS) ──────────────────
function applyOp(
  work: WorkState,
  op: GraphOperation,
  index: number,
  _ctx: ValidationContext,
): ValidationError[] {
  const e: ValidationError[] = [];
  const exists = (id: string): boolean => work.taskIds.has(id) && !work.removed.has(id);

  switch (op.kind) {
    case 'ADD_TASK':
      if (work.taskIds.has(op.task.taskId)) {
        e.push(err(3, 'TASK_ALREADY_EXISTS', `task ${op.task.taskId} exists`, index, op.task.taskId));
      } else {
        work.taskIds.add(op.task.taskId);
      }
      break;
    case 'REMOVE_TASK': {
      if (!exists(op.taskId)) {
        e.push(err(2, 'MISSING_REFERENCE', `REMOVE_TASK unknown ${op.taskId}`, index, op.taskId));
        break;
      }
      const attached = work.edges.filter(
        (edge) => edge.fromTaskId === op.taskId || edge.toTaskId === op.taskId,
      );
      if (attached.length > 0) {
        if (op.cascade === 'cascade_edges') {
          work.edges = work.edges.filter(
            (edge) => edge.fromTaskId !== op.taskId && edge.toTaskId !== op.taskId,
          );
        } else {
          // default / reject_if_edges → GI-006
          e.push(err(3, 'CASCADE_VIOLATION', `REMOVE_TASK ${op.taskId} has edges; set cascade`, index, op.taskId));
          break;
        }
      }
      work.taskIds.delete(op.taskId);
      work.removed.add(op.taskId);
      break;
    }
    case 'ADD_EDGE':
      if (!exists(op.fromTaskId)) e.push(err(2, 'MISSING_REFERENCE', `edge from unknown ${op.fromTaskId}`, index, op.fromTaskId));
      if (!exists(op.toTaskId)) e.push(err(2, 'MISSING_REFERENCE', `edge to unknown ${op.toTaskId}`, index, op.toTaskId));
      if (e.length === 0) {
        if (edgeExists(work.edges, op.fromTaskId, op.toTaskId, op.edgeKind)) {
          e.push(err(3, 'EDGE_ALREADY_EXISTS', `edge ${op.fromTaskId}->${op.toTaskId} exists`, index));
        } else {
          work.edges.push(mkEdge(op.fromTaskId, op.toTaskId, op.edgeKind));
        }
      }
      break;
    case 'REMOVE_EDGE': {
      const before = work.edges.length;
      work.edges = work.edges.filter(
        (edge) => !(edge.fromTaskId === op.fromTaskId && edge.toTaskId === op.toTaskId),
      );
      if (work.edges.length === before) {
        e.push(err(3, 'EDGE_NOT_FOUND', `no edge ${op.fromTaskId}->${op.toTaskId}`, index));
      }
      break;
    }
    case 'CHANGE_DEPENDENCY': {
      const idx = work.edges.findIndex(
        (edge) => edge.fromTaskId === op.fromTaskId && edge.toTaskId === op.toTaskId,
      );
      if (idx === -1) {
        e.push(err(3, 'EDGE_NOT_FOUND', `no edge ${op.fromTaskId}->${op.toTaskId}`, index));
      } else {
        const existing = work.edges[idx];
        if (existing) work.edges[idx] = { ...existing, kind: op.newKind };
      }
      break;
    }
    case 'SUPERSEDE_TASK': {
      if (!exists(op.oldTaskId)) {
        e.push(err(2, 'MISSING_REFERENCE', `SUPERSEDE unknown ${op.oldTaskId}`, index, op.oldTaskId));
        break;
      }
      if (work.superseded.has(op.oldTaskId)) {
        e.push(err(3, 'TASK_ALREADY_SUPERSEDED', `task ${op.oldTaskId} already superseded`, index, op.oldTaskId));
        break;
      }
      // Add the new task, mark old superseded, link supersedes edge (GI-007).
      work.taskIds.add(op.newTask.taskId);
      work.superseded.add(op.oldTaskId);
      work.edges.push(mkEdge(op.newTask.taskId, op.oldTaskId, 'supersedes'));
      if (op.rewire) {
        // Rewire edges touching oldTaskId to newTask (edges are readonly → rebuild).
        work.edges = work.edges.map((edge) => {
          if (edge.kind === 'supersedes') return edge;
          const from = edge.fromTaskId === op.oldTaskId ? op.newTask.taskId : edge.fromTaskId;
          const to = edge.toTaskId === op.oldTaskId ? op.newTask.taskId : edge.toTaskId;
          return from === edge.fromTaskId && to === edge.toTaskId ? edge : { ...edge, fromTaskId: from, toTaskId: to };
        });
      }
      break;
    }
    case 'REWIRE': {
      const idx = work.edges.findIndex(
        (edge) => edge.fromTaskId === op.fromTaskId && edge.toTaskId === op.toTaskId,
      );
      if (idx === -1) {
        e.push(err(3, 'EDGE_NOT_FOUND', `no edge ${op.fromTaskId}->${op.toTaskId}`, index));
      } else if (!exists(op.targetTaskId)) {
        e.push(err(2, 'MISSING_REFERENCE', `rewire target unknown ${op.targetTaskId}`, index, op.targetTaskId));
      } else {
        const existing = work.edges[idx];
        if (existing) work.edges[idx] = { ...existing, toTaskId: op.targetTaskId };
      }
      break;
    }
  }
  return e;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function addedTaskId(op: GraphOperation): string | undefined {
  if (op.kind === 'ADD_TASK') return op.task.taskId;
  if (op.kind === 'SUPERSEDE_TASK') return op.newTask.taskId;
  return undefined;
}

function edgeExists(edges: readonly GraphEdge[], from: string, to: string, kind: EdgeKind): boolean {
  return edges.some((e) => e.fromTaskId === from && e.toTaskId === to && e.kind === kind);
}

function mkEdge(from: string, to: string, kind: EdgeKind): GraphEdge {
  // Validator-local synthetic edgeId, derived deterministically (real ids are assigned
  // by GraphCommit, P1-G3). Not persisted — used only for in-flight structural checks.
  return { edgeId: `val:${from}->${to}:${kind}`, fromTaskId: from, toTaskId: to, kind, addedInVersion: 0 };
}

/** Tasks with no incoming dependency edge that are also not a root's target (§5.7). */
function findOrphans(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[] {
  if (nodes.length <= 1) return [];
  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'supersedes') continue;
    hasIncoming.add(e.toTaskId);
    hasOutgoing.add(e.fromTaskId);
  }
  // A node fully disconnected (no edges at all) is an orphan candidate in a multi-node graph.
  return nodes
    .map((n) => n.taskId)
    .filter((id) => !hasIncoming.has(id) && !hasOutgoing.has(id))
    .sort();
}

function err(
  stage: number,
  code: string,
  message: string,
  operationIndex?: number,
  taskId?: string,
): ValidationError {
  return {
    stage,
    code,
    message,
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

function reject(
  errors: ValidationError[],
  warnings: ValidationError[],
  appliedOps: number,
): ValidationResult {
  return { status: 'REJECTED', errors, warnings, appliedOps };
}
