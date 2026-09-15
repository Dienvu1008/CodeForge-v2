// SqliteEventLog (P1-F4) — DOMAIN_CONTRACTS §18, implements agent-core EventLog.
//
// Enforces:
//   - CP-008: per-session sequenceNumber is monotonic with NO gaps/duplicates. The
//     ADAPTER is the sequence authority — it computes the next number inside the same
//     transaction as the insert, so concurrent appends can't collide (the UNIQUE
//     (session_id, sequence_number) index is the last line of defense).
//   - OB-001: every event is persisted append-only (no update/delete path).
//   - PR-003: payload + provenance are redacted BEFORE persist (SECURITY_MODEL §7.3).
//
// Deterministic replay: stream()/query() return events ordered by sequenceNumber, so
// replaying a session yields the exact same order every time (no wall-clock ordering).
import type {
  DatabaseAdapter,
  // (types only)
} from '../sqlite/types.js';
import type {
  DomainEvent,
  EventLog,
  EventFilter,
  EventAggregateKind,
  EventType,
  Provenance,
} from '@codeforge/agent-core';
import { redactJson } from '../redaction/redactor.js';

interface EventRow {
  event_id: string;
  session_id: string;
  type: string;
  aggregate_kind: string;
  aggregate_id: string;
  payload_json: string;
  provenance_json: string | null;
  at: string;
  sequence_number: number;
}

/**
 * SQLite-backed append-only event log. `append` assigns the authoritative sequence
 * number; the caller's `event.sequenceNumber` is ignored (the adapter owns CP-008).
 */
export class SqliteEventLog implements EventLog {
  constructor(private readonly db: DatabaseAdapter) {}

  /**
   * Append an event. Redacts payload/provenance, assigns the next per-session
   * sequence number atomically, and returns the persisted event (with the assigned
   * sequence). Satisfies the EventLog interface (Promise<void>) via the async wrapper.
   */
  async append(event: DomainEvent): Promise<void> {
    this.appendSync(event);
  }

  /** Synchronous append that returns the persisted event (with assigned sequence). */
  appendSync(event: DomainEvent): DomainEvent {
    const redactedPayload = redactJson(event.payload);
    const redactedProvenance =
      event.provenance === undefined
        ? undefined
        : (redactJson(event.provenance) as Provenance);

    return this.db.transaction((tx): DomainEvent => {
      const rows = tx.query<{ next: number }>(
        'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM events WHERE session_id = ?',
        [event.sessionId],
      );
      const sequenceNumber = rows[0]?.next ?? 1;

      tx.execute(
        `INSERT INTO events
           (event_id, session_id, type, aggregate_kind, aggregate_id,
            payload_json, provenance_json, at, sequence_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.eventId,
          event.sessionId,
          event.type,
          event.aggregate.kind,
          event.aggregate.id,
          JSON.stringify(redactedPayload ?? null),
          redactedProvenance === undefined ? null : JSON.stringify(redactedProvenance),
          event.at,
          sequenceNumber,
        ],
      );

      return {
        ...event,
        payload: redactedPayload,
        ...(redactedProvenance === undefined ? {} : { provenance: redactedProvenance }),
        sequenceNumber,
      };
    });
  }

  /** Stream a session's events in sequence order (deterministic replay). */
  async *stream(sessionId: string, fromSequence = 0): AsyncIterable<DomainEvent> {
    const rows = this.db.query<EventRow>(
      'SELECT * FROM events WHERE session_id = ? AND sequence_number > ? ORDER BY sequence_number ASC',
      [sessionId, fromSequence],
    );
    for (const row of rows) {
      yield rowToEvent(row);
    }
  }

  async query(filter: EventFilter): Promise<readonly DomainEvent[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.aggregateId !== undefined) {
      clauses.push('aggregate_id = ?');
      params.push(filter.aggregateId);
    }
    if (filter.type !== undefined) {
      clauses.push('type = ?');
      params.push(filter.type);
    }
    if (filter.fromSequence !== undefined) {
      clauses.push('sequence_number >= ?');
      params.push(filter.fromSequence);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Order by (session, sequence) for deterministic output across all filters.
    const rows = this.db.query<EventRow>(
      `SELECT * FROM events ${where} ORDER BY session_id ASC, sequence_number ASC`,
      params,
    );
    return rows.map(rowToEvent);
  }
}

function rowToEvent(row: EventRow): DomainEvent {
  const provenance =
    row.provenance_json === null
      ? undefined
      : (JSON.parse(row.provenance_json) as Provenance);
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type as EventType,
    aggregate: {
      kind: row.aggregate_kind as EventAggregateKind,
      id: row.aggregate_id,
    },
    payload: JSON.parse(row.payload_json) as unknown,
    ...(provenance === undefined ? {} : { provenance }),
    at: row.at,
    sequenceNumber: row.sequence_number,
  };
}
