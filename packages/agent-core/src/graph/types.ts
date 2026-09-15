// Graph types — GRAPH_PROTOCOL §2, §4 (canonical source). GR-1..GR-5.
import type { Task } from '../domain/task.js';
import type { Provenance } from '../domain/provenance.js';

// §2.1
export type EdgeKind =
  | 'depends_on' // (from) depends_on (to): to must PASS before from READY
  | 'blocks' // (from) blocks (to): from must PASS before to READY == (to) depends_on (from)
  | 'supersedes'; // from replaces to

export interface GraphNode {
  readonly taskId: string; // reference to Task
  readonly addedInVersion: number;
}

export interface GraphEdge {
  readonly edgeId: string; // ULID (assigned by runtime at GraphCommit, not by planner)
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly kind: EdgeKind;
  readonly addedInVersion: number;
}

export interface TaskGraph {
  readonly graphId: string; // ULID, stable across versions
  readonly sessionId: string;
  readonly version: number; // 1-indexed, monotonic
  readonly parentVersion?: number;

  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];

  readonly createdAt: string;
  readonly createdBy: 'planner' | 'replanner' | 'user';
  readonly mutationId?: string;
  readonly canonicalHash: string;

  readonly schemaVersion: number;
  readonly canonicalFormVersion: string;
}

// §4.2 GraphOperation (7 ops)
export interface AddTaskOp {
  readonly kind: 'ADD_TASK';
  readonly task: Task;
}
export interface RemoveTaskOp {
  readonly kind: 'REMOVE_TASK';
  readonly taskId: string;
  readonly cascade?: 'reject_if_edges' | 'cascade_edges';
}
export interface AddEdgeOp {
  readonly kind: 'ADD_EDGE';
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly edgeKind: EdgeKind;
}
export interface RemoveEdgeOp {
  readonly kind: 'REMOVE_EDGE';
  readonly fromTaskId: string;
  readonly toTaskId: string;
}
export interface SupersedeTaskOp {
  readonly kind: 'SUPERSEDE_TASK';
  readonly oldTaskId: string;
  readonly newTask: Task;
  readonly rewire: boolean; // default true
}
export interface ChangeDependencyOp {
  readonly kind: 'CHANGE_DEPENDENCY';
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly newKind: EdgeKind;
}
export interface RewireOp {
  readonly kind: 'REWIRE';
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly targetTaskId: string;
}

export type GraphOperation =
  | AddTaskOp
  | RemoveTaskOp
  | AddEdgeOp
  | RemoveEdgeOp
  | SupersedeTaskOp
  | ChangeDependencyOp
  | RewireOp;

export type MutationStatus = 'PROPOSED' | 'VALIDATED' | 'REJECTED' | 'COMMITTED';

// §5.10 structured validation error
export interface ValidationError {
  readonly stage: number;
  readonly code: string;
  readonly message: string;
  readonly operationIndex?: number;
  readonly taskId?: string;
  readonly edgeId?: string;
}

// §4.1 GraphMutation
export interface GraphMutation {
  readonly mutationId: string; // ULID
  readonly sessionId: string;
  readonly baseVersion: number;

  readonly operations: readonly GraphOperation[];

  readonly proposedBy: 'planner' | 'replanner' | 'user';
  readonly reason: string;
  readonly provenance: Provenance;

  readonly createdAt: string;

  readonly status: MutationStatus;
  readonly validationErrors?: readonly ValidationError[];
  readonly committedVersion?: number;
  readonly committedAt?: string;
}

// §5.2 validator stages (GR-5)
export const VALIDATOR_STAGES = [
  'SCHEMA',
  'REFERENCE',
  'OPERATION_SEMANTICS',
  'STRUCTURAL',
  'REACHABILITY',
  'SUPERSESSION',
  'POLICY',
] as const;
export type ValidatorStage = (typeof VALIDATOR_STAGES)[number];

// §5.6 cycle detection interface (GR-4). Impl in Phase 1.
export interface CycleDetector {
  hasCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean;
}
