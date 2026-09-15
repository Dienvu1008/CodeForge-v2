// VerificationReport — DOMAIN_CONTRACTS §9 + VERIFICATION_PROTOCOL §2. Append-only (VR-006).
import type { WorkspaceRevision } from './workspace-revision.js';

export type VerificationScope = 'FULL' | 'AFFECTED_CLOSURE' | 'AFFECTED_DIRECT' | 'SMOKE';

export const SCOPE_LATTICE: Record<VerificationScope, number> = {
  FULL: 4,
  AFFECTED_CLOSURE: 3,
  AFFECTED_DIRECT: 2,
  SMOKE: 1,
};

export type VerificationStatus = 'PASS' | 'FAIL' | 'INVALID' | 'ERROR';
export type CheckKind = 'test' | 'lint' | 'typecheck' | 'build' | 'format' | 'custom';
export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

export interface VerificationCheck {
  readonly checkId: string;
  readonly kind: CheckKind;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly scope: VerificationScope;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly status: CheckStatus;
  readonly outputArtifactId?: string;
  readonly stderrArtifactId?: string;
  readonly affectedPaths?: readonly string[];
  readonly executedBy: 'deterministic' | 'user_approved';
}

export interface InvariantCheck {
  readonly invariantId: string;
  readonly satisfied: boolean;
  readonly evidence?: string;
}

export interface VerificationReport {
  readonly verificationId: string; // ULID
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskRunId: string;

  readonly targetWorkspaceRevision: WorkspaceRevision;
  readonly canonicalFormVersion: string;

  readonly scope: VerificationScope;
  readonly checks: readonly VerificationCheck[];

  readonly status: VerificationStatus;

  readonly startedAt: string;
  readonly endedAt: string;

  readonly toolVersions: Readonly<Record<string, string>>;
  readonly artifacts: readonly string[];

  readonly invariantsChecked: readonly InvariantCheck[];

  readonly schemaVersion: number;
}
