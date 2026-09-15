// SqliteTaskGraphRepository — DOMAIN_CONTRACTS §23.3, GRAPH_PROTOCOL §4, RI-3.
//
// A TaskGraph version is stored across three tables (header/nodes/edges). `commit`
// writes the new version header + nodes + edges + the mutation record in ONE
// transaction (GI-008: no partial commit). Nothing here validates the mutation —
// that is the GraphValidator's job (P1-G2); the repo only persists atomically.
import type {
  TaskGraph,
  TaskGraphRepository,
  GraphMutation,
  GraphNode,
  GraphEdge,
  EdgeKind,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface GraphHeaderRow {
  graph_id: string;
  session_id: string;
  version: number;
  parent_version: number | null;
  created_at: string;
  created_by: string;
  mutation_id: string | null;
  canonical_hash: string;
  schema_version: number;
  canonical_form_version: string;
}
interface NodeRow {
  task_id: string;
  added_in_version: number;
}
interface EdgeRow {
  edge_id: string;
  from_task_id: string;
  to_task_id: string;
  kind: string;
  added_in_version: number;
}

export class SqliteTaskGraphRepository implements TaskGraphRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async getCurrent(sessionId: string): Promise<TaskGraph> {
    const header = this.db.query<GraphHeaderRow>(
      'SELECT * FROM task_graph_versions WHERE session_id = ? ORDER BY version DESC LIMIT 1',
      [sessionId],
    )[0];
    if (!header) {
      throw new RepoError('NOT_FOUND', 'TaskGraph', sessionId, 'no graph for session');
    }
    return this.assemble(header);
  }

  async getVersion(sessionId: string, version: number): Promise<TaskGraph | null> {
    const header = this.db.query<GraphHeaderRow>(
      'SELECT * FROM task_graph_versions WHERE session_id = ? AND version = ?',
      [sessionId, version],
    )[0];
    return header ? this.assemble(header) : null;
  }

  async commit(graph: TaskGraph, mutation: GraphMutation): Promise<void> {
    this.db.transaction((tx) => {
      // Guard monotonic version (GI-003): the new version must not already exist.
      const clash = tx.query<{ c: number }>(
        'SELECT COUNT(*) AS c FROM task_graph_versions WHERE session_id = ? AND version = ?',
        [graph.sessionId, graph.version],
      );
      if ((clash[0]?.c ?? 0) > 0) {
        throw new RepoError(
          'VERSION_CONFLICT',
          'TaskGraph',
          `${graph.sessionId}@${graph.version}`,
          'graph version already exists',
        );
      }

      tx.execute(
        `INSERT INTO task_graph_versions
           (graph_id, session_id, version, parent_version, created_at, created_by,
            mutation_id, canonical_hash, schema_version, canonical_form_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          graph.graphId,
          graph.sessionId,
          graph.version,
          graph.parentVersion ?? null,
          graph.createdAt,
          graph.createdBy,
          graph.mutationId ?? null,
          graph.canonicalHash,
          graph.schemaVersion,
          graph.canonicalFormVersion,
        ],
      );

      for (const node of graph.nodes) {
        tx.execute(
          `INSERT INTO task_graph_nodes (session_id, graph_version, task_id, added_in_version)
           VALUES (?, ?, ?, ?)`,
          [graph.sessionId, graph.version, node.taskId, node.addedInVersion],
        );
      }
      for (const edge of graph.edges) {
        tx.execute(
          `INSERT INTO task_graph_edges
             (edge_id, session_id, graph_version, from_task_id, to_task_id, kind, added_in_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            edge.edgeId,
            graph.sessionId,
            graph.version,
            edge.fromTaskId,
            edge.toTaskId,
            edge.kind,
            edge.addedInVersion,
          ],
        );
      }

      // Persist the mutation record that produced this version (audit + GI-002).
      tx.execute(
        `INSERT INTO graph_mutations
           (mutation_id, session_id, base_version, operations_json, proposed_by, reason,
            provenance_json, created_at, status, validation_errors_json, committed_version, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mutation.mutationId,
          mutation.sessionId,
          mutation.baseVersion,
          JSON.stringify(mutation.operations),
          mutation.proposedBy,
          mutation.reason,
          JSON.stringify(mutation.provenance),
          mutation.createdAt,
          mutation.status,
          mutation.validationErrors === undefined
            ? null
            : JSON.stringify(mutation.validationErrors),
          mutation.committedVersion ?? null,
          mutation.committedAt ?? null,
        ],
      );
    });
  }

  private assemble(header: GraphHeaderRow): TaskGraph {
    const nodes = this.db
      .query<NodeRow>(
        'SELECT task_id, added_in_version FROM task_graph_nodes WHERE session_id = ? AND graph_version = ? ORDER BY task_id',
        [header.session_id, header.version],
      )
      .map(
        (r): GraphNode => ({ taskId: r.task_id, addedInVersion: r.added_in_version }),
      );
    const edges = this.db
      .query<EdgeRow>(
        'SELECT * FROM task_graph_edges WHERE session_id = ? AND graph_version = ? ORDER BY edge_id',
        [header.session_id, header.version],
      )
      .map(
        (r): GraphEdge => ({
          edgeId: r.edge_id,
          fromTaskId: r.from_task_id,
          toTaskId: r.to_task_id,
          kind: r.kind as EdgeKind,
          addedInVersion: r.added_in_version,
        }),
      );
    return {
      graphId: header.graph_id,
      sessionId: header.session_id,
      version: header.version,
      ...(header.parent_version === null ? {} : { parentVersion: header.parent_version }),
      nodes,
      edges,
      createdAt: header.created_at,
      createdBy: header.created_by as TaskGraph['createdBy'],
      ...(header.mutation_id === null ? {} : { mutationId: header.mutation_id }),
      canonicalHash: header.canonical_hash,
      schemaVersion: header.schema_version,
      canonicalFormVersion: header.canonical_form_version,
    };
  }
}
