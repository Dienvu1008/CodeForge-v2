// ContextSnapshot — DOMAIN_CONTRACTS §14 + CONTEXT_SPEC §2. Immutable, versioned (CX-*).
import type { WorkspaceRevision } from './workspace-revision.js';
import type { Provenance } from './provenance.js';

export type ContextItemKind =
  | 'file_snippet'
  | 'file_full'
  | 'symbol_definition'
  | 'symbol_usage'
  | 'diff_hunk'
  | 'test_result'
  | 'log_snippet'
  | 'task_definition'
  | 'acceptance_criteria'
  | 'constraint'
  | 'failure_evidence'
  | 'verification_report'
  | 'user_note'
  | 'memory'
  | 'plan_summary'
  | 'graph_summary'
  | 'policy_excerpt';

export type TrustLevel = 'trusted' | 'untrusted';

export type ContextBuilderKind =
  | 'planner'
  | 'critic'
  | 'replanner'
  | 'executor'
  | 'analyzer'
  | 'verifier_assist';

export type BuildReason =
  | 'initial_plan'
  | 'replan'
  | 'task_execution'
  | 'failure_analysis'
  | 'verification_assist'
  | 'user_request';

export type ContextSourceKind =
  | 'workspace_file'
  | 'workspace_symbol'
  | 'artifact'
  | 'task'
  | 'goal'
  | 'policy'
  | 'memory'
  | 'graph'
  | 'session';

export interface ContextSource {
  readonly kind: ContextSourceKind;
  readonly path?: string;
  readonly range?: { readonly start: number; readonly end: number };
  readonly revisionId?: string;
  readonly artifactId?: string;
  readonly externalUrl?: string;
  readonly symbolName?: string;
}

export interface ContextItem {
  readonly itemId: string; // ULID
  readonly kind: ContextItemKind;
  readonly source: ContextSource;
  readonly content: string;
  readonly tokenCount: number;
  readonly trust: TrustLevel;
  readonly reason: string;
  readonly provenance: Provenance;
  readonly priority: number;
  readonly pinned: boolean;
  readonly truncated: boolean;
  readonly truncationNote?: string;
}

export interface ContextSnapshot {
  readonly snapshotId: string; // ULID
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskRunId?: string;

  readonly workspaceRevision: WorkspaceRevision;
  readonly canonicalFormVersion: string;

  readonly items: readonly ContextItem[];

  readonly tokenBudget: number;
  readonly tokenUsed: number;

  readonly builtBy: ContextBuilderKind;
  readonly builtAt: string;

  readonly buildReason: BuildReason;
  readonly policyVersion: number;

  readonly schemaVersion: number;
}
