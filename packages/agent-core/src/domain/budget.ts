// Budget — DOMAIN_CONTRACTS §15. Hierarchical, child <= parent remaining (BU-*).
//
// Parent tree (Coding Agent Architecture Target §35, VERIFICATION_PROTOCOL §14.1):
//   session -> task -> { task_run, verification, recovery }
export type BudgetScope = 'session' | 'task' | 'task_run' | 'recovery' | 'verification';

export interface BudgetLimits {
  readonly wallClockMs: number;
  readonly modelTokens: number;
  readonly toolCalls: number;
  readonly recoveryAttempts: number;
}

export interface BudgetConsumption {
  readonly wallClockMs: number;
  readonly modelTokens: number;
  readonly toolCalls: number;
  readonly recoveryAttempts: number;
}

export interface Budget {
  readonly budgetId: string; // ULID
  readonly scope: BudgetScope;
  readonly scopeId: string; // sessionId, taskId, etc.

  readonly parentBudgetId?: string;

  readonly limits: BudgetLimits;
  readonly consumed: BudgetConsumption;

  readonly createdAt: string;
  readonly updatedAt: string;
}
