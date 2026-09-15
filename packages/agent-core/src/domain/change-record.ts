// ChangeRecord — DOMAIN_CONTRACTS §17 + WORKSPACE_SPEC §9. Append-only (WS-L1).
export interface ChangeRecord {
  readonly changeId: string; // ULID
  readonly sessionId: string;
  readonly taskRunId?: string;
  readonly toolCallId?: string;

  readonly kind: 'create' | 'modify' | 'delete' | 'rename';

  readonly relpath: string; // canonical
  readonly beforeHash?: string;
  readonly afterHash?: string;

  readonly ownedBy: 'agent' | 'verification' | 'user';
  readonly inScratchZone: boolean;

  readonly at: string;
}
