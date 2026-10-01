// ProvenanceTracker — CONTEXT_SPEC §10, P2-CX1.
//
// Builds a Provenance record for each ContextItem so the chain
// model-output → context → workspace revision is traceable (CX-002, PR-002).
//
// Every item must have provenance (CX-002). No anonymous context.
// Provenance is append-only and never contains secrets (PR-004 — redaction is
// applied at source; ProvenanceTracker only records metadata, not raw content).
import type { Provenance } from '../domain/provenance.js';
import type { ContextSource } from '../domain/context.js';

export type RetrievedBy = 'retriever' | 'file_selector' | 'compactor' | 'user';

export interface ContextItemProvenance {
  readonly provenanceId: string;
  readonly snapshotId: string;
  readonly itemId: string;
  readonly source: ContextSource;
  readonly retrievedBy: RetrievedBy;
  readonly reason: string;
  readonly at: string;
  readonly originalTokenCount?: number;
  readonly finalTokenCount: number;
  readonly truncated: boolean;
  readonly compactionMethod?: string;
}

export interface ProvenanceTrackerDeps {
  readonly sessionId: string;
  readonly now: () => string;
  readonly nextId: () => string;
}

export class ProvenanceTracker {
  constructor(private readonly deps: ProvenanceTrackerDeps) {}

  /**
   * Build a Provenance record for the snapshot itself (links builder to session).
   * Used as the snapshot-level provenance (CX-002).
   */
  snapshotProvenance(reason: string): Provenance {
    return {
      provenanceId: this.deps.nextId(),
      source:       { kind: 'runtime', id: 'context-builder' },
      inputs:       [],
      reason,
      at:           this.deps.now(),
    };
  }

  /**
   * Build a per-item provenance record (CX-002: every item must have provenance).
   * Stores metadata only — no raw content (PR-004 spirit: no secrets in provenance).
   */
  itemProvenance(
    snapshotId: string,
    itemId: string,
    source: ContextSource,
    opts: {
      retrievedBy: RetrievedBy;
      reason: string;
      originalTokenCount?: number;
      finalTokenCount: number;
      truncated: boolean;
      compactionMethod?: string;
    },
  ): ContextItemProvenance {
    return {
      provenanceId:      this.deps.nextId(),
      snapshotId,
      itemId,
      source,
      retrievedBy:       opts.retrievedBy,
      reason:            opts.reason,
      at:                this.deps.now(),
      ...(opts.originalTokenCount !== undefined ? { originalTokenCount: opts.originalTokenCount } : {}),
      finalTokenCount:   opts.finalTokenCount,
      truncated:         opts.truncated,
      ...(opts.compactionMethod !== undefined ? { compactionMethod: opts.compactionMethod } : {}),
    };
  }

  /**
   * Build a lightweight Provenance for context items that is stored on the item itself.
   */
  itemInlineProvenance(reason: string, sourceKind: ContextSource['kind']): Provenance {
    return {
      provenanceId: this.deps.nextId(),
      source:       { kind: 'runtime', id: sourceKind },
      inputs:       [],
      reason,
      at:           this.deps.now(),
    };
  }
}
