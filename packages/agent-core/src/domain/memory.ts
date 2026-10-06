// Memory — Phase 7 (P7-MS1). Long-term memory records (project/outcomes/patterns).
//
// Memory is EVIDENCE, never authority (ME-001). Records are append-only (ME-003)
// and surfaced to the model only as untrusted context (ME-002). The store/query
// contract lives here in agent-core (domain); the SQLite implementation lives in
// infrastructure — the same layering as the other repositories.
import type { Provenance } from './provenance.js';

// ── Record ──────────────────────────────────────────────────────────────────

export type MemoryKind =
  | 'task_outcome'
  | 'failure_pattern'
  | 'project_note'
  | 'user_preference'
  | 'architecture_note';

export type MemoryScope = 'project' | 'session' | 'global';

export interface MemoryRecord {
  readonly memoryId:   string;              // ULID
  readonly kind:       MemoryKind;
  readonly scope:      MemoryScope;
  readonly content:    string;
  readonly tags:       readonly string[];
  readonly provenance: Provenance;          // reason + at + source (ME-003)
  readonly createdAt:  string;              // ISO 8601
}

// ── Query ─────────────────────────────────────────────────────────────────────

/**
 * Filter for retrieving memory records. All fields are optional except `limit`.
 *
 * `text` is a forward-compatible semantic hint (PHASE_7_ROADMAP §4.10): v1 stores
 * and retrievers ignore it; a future embedding retriever (Phase 7.5) consumes it
 * WITHOUT changing this shape or any consumer.
 */
export interface MemoryQuery {
  readonly scope?: MemoryScope;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?:  readonly string[];
  readonly text?:  string;
  readonly limit:  number;
}

// ── Store ──────────────────────────────────────────────────────────────────────

/**
 * Persistence contract for memory records. Append-only: there is no update or
 * delete-by-id in the base contract (ME-003). Retention/eviction is a write-path
 * concern handled by MemoryWriter (ME-006), not the store.
 */
export interface MemoryStore {
  /** Append a record. Fails if memoryId already exists (append-only identity). */
  insert(record: MemoryRecord): Promise<void>;

  /** Retrieve records matching the filter, deterministically ordered (ME-004). */
  query(query: MemoryQuery): Promise<readonly MemoryRecord[]>;

  /** Count records in a (scope, kind) bucket — used by MemoryWriter for retention. */
  count(scope: MemoryScope, kind: MemoryKind): Promise<number>;

  /**
   * Retention primitive: delete all but the newest `keep` records in a
   * (scope, kind) bucket, by the same deterministic order as query() (recency
   * desc, memoryId asc). Returns the number of records evicted. The store only
   * executes this; the WHEN/HOW-MANY policy lives in MemoryWriter (ME-006).
   * This is the only non-insert mutation — records are never updated (ME-003).
   */
  evictOldest(scope: MemoryScope, kind: MemoryKind, keep: number): Promise<number>;
}

// ── RAG ─────────────────────────────────────────────────────────────────────

export type RagSource = 'doc' | 'repo';

/**
 * A retrieval-augmented-generation item: a chunk of local documentation or
 * repository code surfaced as context. It is ALWAYS untrusted evidence (ME-005)
 * and always records where it came from (`path`). Produced by the RAG retrievers
 * (infrastructure) as plain data and mapped into an untrusted ContextItem by the
 * context Retriever (agent-core) — the retriever never trusts it as authority.
 */
export interface RagItem {
  readonly source:  RagSource;
  /** Canonical project-relative path the chunk came from (provenance, ME-005). */
  readonly path:    string;
  readonly content: string;
  /** Relevance score (higher = more relevant); for ranking/diagnostics. */
  readonly score:   number;
  /** Human-readable reason recorded in provenance when mapped to a ContextItem. */
  readonly reason:  string;
}
