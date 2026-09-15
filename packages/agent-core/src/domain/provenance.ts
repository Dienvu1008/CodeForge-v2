// Provenance — DOMAIN_CONTRACTS §19. Append-only; no unredacted secrets (PR-*).

export type ProvenanceSourceKind = 'model' | 'user' | 'runtime' | 'tool' | 'workspace';

export interface ProvenanceModel {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
}

export interface Provenance {
  readonly provenanceId: string;
  readonly source: {
    readonly kind: ProvenanceSourceKind;
    readonly id: string;
  };
  readonly model?: ProvenanceModel;
  readonly contextSnapshotId?: string;
  readonly inputs: readonly string[]; // reference IDs
  readonly reason: string;
  readonly at: string; // ISO 8601
}
