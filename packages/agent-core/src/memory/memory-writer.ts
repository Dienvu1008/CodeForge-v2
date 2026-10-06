// MemoryWriter — P7-MW1. Writes memory records with provenance (ME-003) and
// enforces a bounded retention policy (ME-006).
//
// Decoupling: persistence goes through the MemoryStore interface, so this writer
// lives in agent-core and does not depend on the infrastructure SQLite layer.
// Retention is enforced ONLY here (write-path) — the store merely executes the
// evictOldest primitive. Policy change (max-count -> TTL -> hybrid) stays local.
import type {
  MemoryStore,
  MemoryRecord,
  MemoryKind,
  MemoryScope,
} from '../domain/memory.js';
import type { Provenance, ProvenanceSourceKind } from '../domain/provenance.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  /** Max records kept per (scope, kind) bucket. Oldest beyond this are evicted. */
  readonly maxPerScopeKind: number;
}

/** v1 default (PHASE_7_ROADMAP Appendix A): max-count per (scope, kind). */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxPerScopeKind: 200,
};

export interface MemoryWriterDeps {
  readonly store:  MemoryStore;
  readonly now:    () => string;
  readonly nextId: () => string;
  /** Retention policy; defaults to DEFAULT_RETENTION_POLICY. */
  readonly retention?: RetentionPolicy;
}

// ── Write input ────────────────────────────────────────────────────────────────

export interface WriteMemoryInput {
  readonly kind:    MemoryKind;
  readonly scope:   MemoryScope;
  readonly content: string;
  readonly tags?:   readonly string[];
  /** Why this is being remembered — recorded in provenance (ME-003). */
  readonly reason:  string;
  /** Who/what produced this memory. Defaults to a runtime source. */
  readonly source?: { readonly kind: ProvenanceSourceKind; readonly id: string };
}

// ── MemoryWriter ────────────────────────────────────────────────────────────────

export class MemoryWriter {
  private readonly retention: RetentionPolicy;

  constructor(private readonly deps: MemoryWriterDeps) {
    this.retention = deps.retention ?? DEFAULT_RETENTION_POLICY;
  }

  /**
   * Append a memory record with provenance (ME-003), then enforce the retention
   * bound for its (scope, kind) bucket (ME-006). Returns the written record.
   */
  async write(input: WriteMemoryInput): Promise<MemoryRecord> {
    const at = this.deps.now();
    const provenance: Provenance = {
      provenanceId: this.deps.nextId(),
      source:       input.source ?? { kind: 'runtime', id: 'memory-writer' },
      inputs:       [],
      reason:       input.reason,
      at,
    };

    const record: MemoryRecord = {
      memoryId:   this.deps.nextId(),
      kind:       input.kind,
      scope:      input.scope,
      content:    input.content,
      tags:       input.tags ?? [],
      provenance,
      createdAt:  at,
    };

    await this.deps.store.insert(record);
    await this.enforceRetention(input.scope, input.kind);
    return record;
  }

  /**
   * Evict records beyond the retention bound for a (scope, kind) bucket. Called
   * after each write; also exposed for explicit maintenance. Idempotent: a no-op
   * when the bucket is already within bounds.
   */
  async enforceRetention(scope: MemoryScope, kind: MemoryKind): Promise<number> {
    const count = await this.deps.store.count(scope, kind);
    if (count <= this.retention.maxPerScopeKind) return 0;
    return this.deps.store.evictOldest(scope, kind, this.retention.maxPerScopeKind);
  }
}
