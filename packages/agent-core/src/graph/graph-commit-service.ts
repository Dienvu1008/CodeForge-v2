// GraphCommitService (P1-G3) — GRAPH_PROTOCOL §7. Enforces GI-002, GI-007, GI-008.
//
// Orchestrates the deterministic commit decision:
//   1. Load current graph; check mutation.baseVersion == current.version (GI-002 §4.5).
//   2. Run the GraphValidator (P1-G2). If REJECTED → record a REJECTED mutation + event.
//   3. If VALIDATED → build graph vN+1 (P1-G1), compute superseded taskIds (GI-007), and
//      hand an atomic CommitPlan to the injected GraphCommitter, which writes graph +
//      task supersessions + mutation + events in ONE transaction (GI-008: no partial commit).
//
// This service is pure of I/O: the atomic multi-table write lives behind the
// GraphCommitter contract (impl in infrastructure), keeping agent-core adapter-free.
import type { TaskGraph, GraphMutation, GraphNode, GraphEdge } from './types.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { TaskGraphRepository } from '../repositories/index.js';
import { GraphService } from './graph-service.js';
import { validateMutation, type ValidationContext, type ValidationResult } from './validator.js';

/** An atomic set of writes for one commit. Executed in a single transaction (GI-008). */
export interface CommitPlan {
  /** The new committed graph version (undefined when the mutation was rejected). */
  readonly graph?: TaskGraph;
  /** The mutation record to persist (status COMMITTED or REJECTED). */
  readonly mutation: GraphMutation;
  /** taskIds transitioning to SUPERSEDED (GI-007), each linked to its successor. */
  readonly supersededTasks: readonly { readonly oldTaskId: string; readonly newTaskId: string }[];
  /** Domain events to append inside the same transaction. */
  readonly events: readonly DomainEvent[];
}

/** Atomic committer contract — impl (SQLite, single transaction) lives in infrastructure. */
export interface GraphCommitter {
  commit(plan: CommitPlan): Promise<void>;
}

export interface GraphCommitResult {
  readonly status: 'COMMITTED' | 'REJECTED';
  readonly version?: number;
  readonly validation: ValidationResult;
}

export class GraphCommitError extends Error {
  public readonly code: 'VERSION_CONFLICT';
  constructor(message?: string) {
    super(message ?? 'VERSION_CONFLICT');
    this.name = 'GraphCommitError';
    this.code = 'VERSION_CONFLICT';
  }
}

export interface GraphCommitServiceDeps {
  readonly graphs: TaskGraphRepository;
  readonly committer: GraphCommitter;
  readonly graphService: GraphService;
  readonly now: () => string;
  readonly nextId: () => string;
}

export class GraphCommitService {
  constructor(private readonly deps: GraphCommitServiceDeps) {}

  /**
   * Commit a mutation against the session's current graph. Throws VERSION_CONFLICT if
   * baseVersion is stale (GI-002 §4.5). A validation failure is NOT an exception — it
   * records a REJECTED mutation and returns status REJECTED with the errors.
   */
  async commit(
    mutation: GraphMutation,
    ctx: ValidationContext = {},
  ): Promise<GraphCommitResult> {
    const current = await this.deps.graphs.getCurrent(mutation.sessionId);

    // GI-002 §4.5: base version must match (optimistic concurrency, no auto-rebase).
    if (mutation.baseVersion !== current.version) {
      throw new GraphCommitError(
        `baseVersion ${mutation.baseVersion} != current ${current.version}`,
      );
    }

    const validation = validateMutation(current, mutation, ctx);

    if (validation.status === 'REJECTED') {
      const rejected: GraphMutation = {
        ...mutation,
        status: 'REJECTED',
        validationErrors: validation.errors,
      };
      await this.deps.committer.commit({
        mutation: rejected,
        supersededTasks: [],
        events: [
          this.event(mutation.sessionId, 'GRAPH_MUTATION_REJECTED', {
            mutationId: mutation.mutationId,
            errorCount: validation.errors.length,
          }),
        ],
      });
      return { status: 'REJECTED', validation };
    }

    // VALIDATED → build the next graph structure from the applied operations.
    const { nodes, edges, superseded } = this.applyToStructure(current, mutation);
    const committedVersion = current.version + 1;
    const graph = this.deps.graphService.build({
      sessionId: mutation.sessionId,
      nodes,
      edges,
      createdBy: mutation.proposedBy,
      parent: current,
      mutationId: mutation.mutationId,
      graphId: current.graphId,
    });

    const committedMutation: GraphMutation = {
      ...mutation,
      status: 'COMMITTED',
      committedVersion,
      committedAt: this.deps.now(),
    };

    await this.deps.committer.commit({
      graph,
      mutation: committedMutation,
      supersededTasks: superseded,
      events: [
        this.event(mutation.sessionId, 'GRAPH_VERSION_CREATED', {
          graphId: graph.graphId,
          version: committedVersion,
        }),
        this.event(mutation.sessionId, 'GRAPH_MUTATION_COMMITTED', {
          mutationId: mutation.mutationId,
          committedVersion,
        }),
        ...superseded.map((s) =>
          this.event(mutation.sessionId, 'TASK_SUPERSEDED', {
            oldTaskId: s.oldTaskId,
            newTaskId: s.newTaskId,
          }),
        ),
      ],
    });

    return { status: 'COMMITTED', version: committedVersion, validation };
  }

  /**
   * Apply the mutation's operations to produce the next version's nodes/edges and the
   * set of superseded tasks. Runtime assigns edgeId + addedInVersion here (§8.1) — never
   * the planner. Assumes the mutation already passed validation.
   */
  private applyToStructure(
    current: TaskGraph,
    mutation: GraphMutation,
  ): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    superseded: { oldTaskId: string; newTaskId: string }[];
  } {
    const version = current.version + 1;
    const taskIds = new Set(current.nodes.map((n) => n.taskId));
    const addedInVersion = new Map<string, number>(
      current.nodes.map((n) => [n.taskId, n.addedInVersion]),
    );
    let edges: GraphEdge[] = current.edges.map((e) => ({ ...e }));
    const superseded: { oldTaskId: string; newTaskId: string }[] = [];

    const addEdge = (from: string, to: string, kind: GraphEdge['kind']): void => {
      edges.push({
        edgeId: this.deps.nextId(), // runtime-assigned (§8.1)
        fromTaskId: from,
        toTaskId: to,
        kind,
        addedInVersion: version,
      });
    };

    for (const op of mutation.operations) {
      switch (op.kind) {
        case 'ADD_TASK':
          taskIds.add(op.task.taskId);
          addedInVersion.set(op.task.taskId, version);
          break;
        case 'REMOVE_TASK':
          taskIds.delete(op.taskId);
          edges = edges.filter((e) => e.fromTaskId !== op.taskId && e.toTaskId !== op.taskId);
          break;
        case 'ADD_EDGE':
          addEdge(op.fromTaskId, op.toTaskId, op.edgeKind);
          break;
        case 'REMOVE_EDGE':
          edges = edges.filter(
            (e) => !(e.fromTaskId === op.fromTaskId && e.toTaskId === op.toTaskId),
          );
          break;
        case 'CHANGE_DEPENDENCY':
          edges = edges.map((e) =>
            e.fromTaskId === op.fromTaskId && e.toTaskId === op.toTaskId
              ? { ...e, kind: op.newKind }
              : e,
          );
          break;
        case 'REWIRE':
          edges = edges.map((e) =>
            e.fromTaskId === op.fromTaskId && e.toTaskId === op.toTaskId
              ? { ...e, toTaskId: op.targetTaskId }
              : e,
          );
          break;
        case 'SUPERSEDE_TASK': {
          taskIds.add(op.newTask.taskId);
          addedInVersion.set(op.newTask.taskId, version);
          superseded.push({ oldTaskId: op.oldTaskId, newTaskId: op.newTask.taskId });
          addEdge(op.newTask.taskId, op.oldTaskId, 'supersedes');
          if (op.rewire) {
            edges = edges.map((e) => {
              if (e.kind === 'supersedes') return e;
              const from = e.fromTaskId === op.oldTaskId ? op.newTask.taskId : e.fromTaskId;
              const to = e.toTaskId === op.oldTaskId ? op.newTask.taskId : e.toTaskId;
              return from === e.fromTaskId && to === e.toTaskId ? e : { ...e, fromTaskId: from, toTaskId: to };
            });
          }
          break;
        }
      }
    }

    const nodes: GraphNode[] = [...taskIds]
      .sort()
      .map((taskId) => ({ taskId, addedInVersion: addedInVersion.get(taskId) ?? version }));
    // Keep only edges whose endpoints still exist.
    edges = edges.filter((e) => taskIds.has(e.fromTaskId) && taskIds.has(e.toTaskId));
    return { nodes, edges, superseded };
  }

  private event(sessionId: string, type: EventType, payload: unknown): DomainEvent {
    return {
      eventId: this.deps.nextId(),
      sessionId,
      type,
      aggregate: { kind: 'graph', id: sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
  }
}
