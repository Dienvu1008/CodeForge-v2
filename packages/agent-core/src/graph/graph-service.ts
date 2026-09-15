// GraphService (P1-G1) — GRAPH_PROTOCOL §2, §7.1; GI-001, GI-003.
//
// Builds versioned TaskGraph snapshots. Responsibilities in P1-G1 (structure + versioning
// + canonical hash); mutation validation (GI-002/004..009) is P1-G2, atomic commit is P1-G3.
//
//   - GI-003: version is monotonic (parent + 1); the repository rejects a duplicate.
//   - Canonical hash reflects STRUCTURE (nodes/edges), computed via injected GraphHasher.
//   - GI-001: dependencies live ONLY as graph edges (never on a Task) — the graph is the
//     single source of dependency truth. This service only accepts nodes/edges, never
//     dependency data attached to tasks.
import type { TaskGraph, GraphNode, GraphEdge } from './types.js';
import { canonicalGraphForm, type GraphHasher } from './canonical.js';

export interface GraphServiceDeps {
  readonly hasher: GraphHasher;
  readonly now: () => string;
  readonly nextId: () => string;
  /** Canonical form version this runtime produces (bump when the hash format changes). */
  readonly canonicalFormVersion: string;
  readonly schemaVersion: number;
}

export interface BuildGraphInput {
  readonly sessionId: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly createdBy: TaskGraph['createdBy'];
  /** Existing graph to base the new version on (undefined => first version, v1). */
  readonly parent?: TaskGraph;
  /** The mutation that produced this version (linked for audit). */
  readonly mutationId?: string;
  /** Stable graphId across versions (defaults to parent.graphId or a fresh id). */
  readonly graphId?: string;
}

export class GraphService {
  constructor(private readonly deps: GraphServiceDeps) {}

  /**
   * Build the next TaskGraph version from nodes/edges. Version = (parent.version ?? 0) + 1
   * (GI-003 monotonic). canonicalHash is computed from structure. Pure w.r.t. inputs +
   * injected sources — same inputs yield the same graph (modulo injected id/time).
   */
  build(input: BuildGraphInput): TaskGraph {
    const parentVersion = input.parent?.version ?? 0;
    const version = parentVersion + 1;
    const graphId = input.graphId ?? input.parent?.graphId ?? this.deps.nextId();
    const canonicalHash = this.deps.hasher.hash(input.nodes, input.edges);

    return {
      graphId,
      sessionId: input.sessionId,
      version,
      ...(input.parent !== undefined ? { parentVersion: input.parent.version } : {}),
      nodes: input.nodes,
      edges: input.edges,
      createdAt: this.deps.now(),
      createdBy: input.createdBy,
      ...(input.mutationId !== undefined ? { mutationId: input.mutationId } : {}),
      canonicalHash,
      schemaVersion: this.deps.schemaVersion,
      canonicalFormVersion: this.deps.canonicalFormVersion,
    };
  }

  /** Recompute the canonical hash of a graph's current structure (drift detection). */
  canonicalHashOf(graph: Pick<TaskGraph, 'nodes' | 'edges'>): string {
    return this.deps.hasher.hash(graph.nodes, graph.edges);
  }

  /** Whether a graph's stored canonicalHash matches its current structure (GI-001 drift). */
  isConsistent(graph: TaskGraph): boolean {
    return graph.canonicalHash === this.canonicalHashOf(graph);
  }

  /** Expose the canonical string form (for diagnostics / equality checks). */
  canonicalForm(graph: Pick<TaskGraph, 'nodes' | 'edges'>): string {
    return canonicalGraphForm(graph.nodes, graph.edges);
  }
}
