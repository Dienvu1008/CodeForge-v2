// SqliteGraphCommitter (P1-G3) — GRAPH_PROTOCOL §7, GI-008 (atomic commit).
//
// Executes a CommitPlan in ONE SQLite transaction: graph version header + nodes + edges,
// task supersessions (tasks.superseded_by + task_executions.current_state=SUPERSEDED),
// the mutation record, and the domain events (with authoritative per-session sequence
// numbers, CP-008). Any failure rolls back the whole unit — no partial commit.
//
// Events are redacted before persist (PR-003), matching SqliteEventLog behavior.
import type { CommitPlan, GraphCommitter, DomainEvent, Provenance } from '@codeforge/agent-core';
import { redactJson } from '../redaction/redactor.js';
import type { DatabaseAdapter, Transaction } from '../sqlite/types.js';

export class SqliteGraphCommitter implements GraphCommitter {
  constructor(private readonly db: DatabaseAdapter) {}

  async commit(plan: CommitPlan): Promise<void> {
    this.db.transaction((tx) => {
      if (plan.graph) {
        const g = plan.graph;
        tx.execute(
          `INSERT INTO task_graph_versions
             (graph_id, session_id, version, parent_version, created_at, created_by,
              mutation_id, canonical_hash, schema_version, canonical_form_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            g.graphId,
            g.sessionId,
            g.version,
            g.parentVersion ?? null,
            g.createdAt,
            g.createdBy,
            g.mutationId ?? null,
            g.canonicalHash,
            g.schemaVersion,
            g.canonicalFormVersion,
          ],
        );
        for (const node of g.nodes) {
          tx.execute(
            `INSERT INTO task_graph_nodes (session_id, graph_version, task_id, added_in_version)
             VALUES (?, ?, ?, ?)`,
            [g.sessionId, g.version, node.taskId, node.addedInVersion],
          );
        }
        for (const edge of g.edges) {
          tx.execute(
            `INSERT INTO task_graph_edges
               (edge_id, session_id, graph_version, from_task_id, to_task_id, kind, added_in_version)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [edge.edgeId, g.sessionId, g.version, edge.fromTaskId, edge.toTaskId, edge.kind, edge.addedInVersion],
          );
        }
        // Bump the session's current graphVersion pointer.
        tx.execute('UPDATE sessions SET graph_version = ? WHERE session_id = ?', [
          g.version,
          g.sessionId,
        ]);
      }

      // GI-007: mark superseded tasks + link successor; reflect in the execution projection.
      for (const s of plan.supersededTasks) {
        tx.execute('UPDATE tasks SET superseded_by = ? WHERE task_id = ?', [
          s.newTaskId,
          s.oldTaskId,
        ]);
        tx.execute(
          `UPDATE task_executions SET current_state = 'SUPERSEDED', updated_at = ?, version = version + 1
             WHERE task_id = ?`,
          [plan.mutation.createdAt, s.oldTaskId],
        );
      }

      // Mutation record (COMMITTED or REJECTED).
      const m = plan.mutation;
      tx.execute(
        `INSERT INTO graph_mutations
           (mutation_id, session_id, base_version, operations_json, proposed_by, reason,
            provenance_json, created_at, status, validation_errors_json, committed_version, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.mutationId,
          m.sessionId,
          m.baseVersion,
          JSON.stringify(m.operations),
          m.proposedBy,
          m.reason,
          JSON.stringify(redactJson(m.provenance)),
          m.createdAt,
          m.status,
          m.validationErrors === undefined ? null : JSON.stringify(m.validationErrors),
          m.committedVersion ?? null,
          m.committedAt ?? null,
        ],
      );

      // Events, with authoritative per-session monotonic sequence (CP-008), redacted.
      for (const ev of plan.events) {
        this.appendEvent(tx, ev);
      }
    });
  }

  private appendEvent(tx: Transaction, event: DomainEvent): void {
    const rows = tx.query<{ next: number }>(
      'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM events WHERE session_id = ?',
      [event.sessionId],
    );
    const sequenceNumber = rows[0]?.next ?? 1;
    const redactedProvenance =
      event.provenance === undefined ? undefined : (redactJson(event.provenance) as Provenance);
    tx.execute(
      `INSERT INTO events
         (event_id, session_id, type, aggregate_kind, aggregate_id, payload_json, provenance_json, at, sequence_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.sessionId,
        event.type,
        event.aggregate.kind,
        event.aggregate.id,
        JSON.stringify(redactJson(event.payload) ?? null),
        redactedProvenance === undefined ? null : JSON.stringify(redactedProvenance),
        event.at,
        sequenceNumber,
      ],
    );
  }
}
