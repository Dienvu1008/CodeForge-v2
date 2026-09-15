// Artifact — DOMAIN_CONTRACTS §20. Immutable; provenance required; no unredacted secrets.
import type { Provenance } from './provenance.js';

export type ArtifactKind =
  | 'log'
  | 'patch'
  | 'test_result'
  | 'screenshot'
  | 'report'
  | 'compiler_output'
  | 'other';

export interface Artifact {
  readonly artifactId: string; // ULID
  readonly sessionId: string;

  readonly kind: ArtifactKind;

  readonly contentType: string; // MIME
  readonly sizeBytes: number;
  readonly sha256: string;

  readonly storagePath: string; // relative to ArtifactStore
  readonly provenance: Provenance;

  readonly createdAt: string;
  readonly expiresAt?: string;
}
