// Goal — DOMAIN_CONTRACTS §3. Immutable/versioned user intent.
import type { Constraint, AcceptanceCriterion } from './common.js';

export interface Goal {
  readonly goalId: string; // ULID
  readonly version: number; // starts at 1
  readonly description: string; // user input

  readonly constraints: readonly Constraint[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];

  readonly createdAt: string;
  readonly createdBy: 'user' | 'import';

  readonly supersededBy?: string; // goalId of newer version
}
