// WorkspaceRevision factory (C2) — WORKSPACE_SPEC §5.
//
// Computes an immutable WorkspaceRevision by hashing the workspace (C1) and stamping
// identity/metadata. Filesystem access lives here (infrastructure), not in the domain type.
//
// Time and randomness are INJECTABLE so revision creation can be made deterministic in tests
// (PHASE_0_ACCEPTANCE anti-criteria: no wall-clock / no random dependence in tests).

import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  generateUlid,
  CANONICAL_FORM_VERSION,
  type UlidSources,
  type WorkspaceRevision,
  type WorkspaceRevisionCreatedBy,
  type WorkspaceGitMetadata,
  type WorkspaceHashAlgorithm,
} from '@codeforge/agent-core';
import { computeWorkspaceHash } from '../workspace-hash/index.js';

export interface ComputeRevisionOptions {
  /** canonical workspace root, '/'-separated */
  readonly root: string;
  /** scratch prefixes (canonical relative paths) to exclude from the hash */
  readonly scratchPrefixes?: readonly string[];
  /** who/why this revision is created */
  readonly createdBy: WorkspaceRevisionCreatedBy;
  /** overall hash algorithm; default blake3 */
  readonly algorithm?: WorkspaceHashAlgorithm;
  /** informational only — never used for freshness (WS-009) */
  readonly gitMetadata?: WorkspaceGitMetadata;
  /** injectable clock/randomness; defaults to system time + crypto RNG */
  readonly sources?: UlidSources;
  readonly onWarn?: (message: string) => void;
}

const defaultSources: UlidSources = {
  now: () => Date.now(),
  randomBytes: (n) => Uint8Array.from(nodeRandomBytes(n)),
};

export async function computeWorkspaceRevision(
  opts: ComputeRevisionOptions,
): Promise<WorkspaceRevision> {
  const sources = opts.sources ?? defaultSources;
  const algorithm: WorkspaceHashAlgorithm = opts.algorithm ?? 'blake3';
  const scratch = opts.scratchPrefixes ?? [];

  const hashResult = await computeWorkspaceHash({
    root: opts.root,
    scratchPrefixes: scratch,
    algorithm,
    ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
  });

  const revisionId = generateUlid(sources);
  const createdAt = new Date(sources.now()).toISOString();

  const included = [...hashResult.includedPaths].sort();
  const excluded = [...scratch].sort();

  return {
    revisionId,
    canonicalFormVersion: CANONICAL_FORM_VERSION,
    root: opts.root,
    includedPaths: included,
    excludedScratchPaths: excluded,
    hashAlgorithm: algorithm,
    hash: hashResult.hash,
    fileCount: hashResult.fileCount,
    totalBytes: hashResult.totalBytes,
    createdAt,
    createdBy: opts.createdBy,
    ...(opts.gitMetadata ? { gitMetadata: opts.gitMetadata } : {}),
  };
}
