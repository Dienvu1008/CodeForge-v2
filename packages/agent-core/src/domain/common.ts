// Shared value objects — DOMAIN_CONTRACTS §3, §4.
// All domain types are readonly (DT-20: immutable types have `readonly`).

export interface Constraint {
  readonly kind: 'performance' | 'compatibility' | 'scope' | 'style' | 'other';
  readonly description: string;
  readonly enforceable: boolean;
}

export interface AcceptanceCriterion {
  readonly criterionId: string;
  readonly description: string;
  readonly verificationHint?: string; // suggestion, not authority
  readonly mandatory: boolean;
}

export interface TaskStrategy {
  readonly kind: 'generate' | 'refactor' | 'fix' | 'test' | 'migrate' | 'custom';
  readonly notes?: string;
  readonly preferredTools?: readonly string[]; // hint only
}
