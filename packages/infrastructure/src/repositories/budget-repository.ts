// SqliteBudgetRepository — DOMAIN_CONTRACTS §15, BU-001/003/005.
//
// `consume` is the atomic decrement (BU-003): read → check overrun → write, all in ONE
// transaction so a decrement and its overrun check can't race. An overrun throws
// BudgetError('BUDGET_EXHAUSTED') and writes nothing (BU-005: stop, never silent continue).
// `create` enforces BU-001 (child limits <= parent remaining) when a parent is set.
import type {
  Budget,
  BudgetRepository,
  BudgetConsumption,
  BudgetLimits,
} from '@codeforge/agent-core';
import { BudgetError, BUDGET_DIMENSIONS, childLimitViolations } from '@codeforge/agent-core';
import type { DatabaseAdapter, Transaction } from '../sqlite/types.js';

interface BudgetRow {
  budget_id: string;
  scope: string;
  scope_id: string;
  parent_budget_id: string | null;
  limits_json: string;
  consumed_json: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export class SqliteBudgetRepository implements BudgetRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(budget: Budget): Promise<void> {
    this.db.transaction((tx) => {
      // BU-001: if there is a parent, the child limits must fit the parent's remaining.
      if (budget.parentBudgetId !== undefined) {
        const parent = this.readInTx(tx, budget.parentBudgetId);
        if (!parent) {
          throw new BudgetError('NOT_FOUND', [], `parent budget ${budget.parentBudgetId} not found`);
        }
        const violations = childLimitViolations(parent, budget.limits);
        if (violations.length > 0) {
          throw new BudgetError('BUDGET_OVERFLOW', violations, 'child budget exceeds parent remaining');
        }
      }
      tx.execute(
        `INSERT INTO budgets
           (budget_id, scope, scope_id, parent_budget_id, limits_json, consumed_json,
            created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          budget.budgetId,
          budget.scope,
          budget.scopeId,
          budget.parentBudgetId ?? null,
          JSON.stringify(budget.limits),
          JSON.stringify(budget.consumed),
          budget.createdAt,
          budget.updatedAt,
        ],
      );
    });
  }

  async getById(budgetId: string): Promise<Budget | null> {
    const rows = this.db.query<BudgetRow>('SELECT * FROM budgets WHERE budget_id = ?', [budgetId]);
    return rows[0] ? rowToBudget(rows[0]) : null;
  }

  async getChildren(parentBudgetId: string): Promise<readonly Budget[]> {
    return this.db
      .query<BudgetRow>('SELECT * FROM budgets WHERE parent_budget_id = ? ORDER BY budget_id', [
        parentBudgetId,
      ])
      .map(rowToBudget);
  }

  async consume(budgetId: string, delta: Partial<BudgetConsumption>): Promise<Budget> {
    return this.db.transaction((tx): Budget => {
      const budget = this.readInTx(tx, budgetId);
      if (!budget) {
        throw new BudgetError('NOT_FOUND', [], budgetId);
      }
      // BU-005: check overrun BEFORE writing; reject rather than silently overrun.
      const overrun: (typeof BUDGET_DIMENSIONS)[number][] = [];
      const nextConsumed = { ...budget.consumed } as Record<string, number>;
      for (const d of BUDGET_DIMENSIONS) {
        const want = delta[d] ?? 0;
        if (want < 0) {
          throw new BudgetError('BUDGET_OVERFLOW', [d], 'negative consumption not allowed');
        }
        const after = budget.consumed[d] + want;
        if (after > budget.limits[d]) overrun.push(d);
        nextConsumed[d] = after;
      }
      if (overrun.length > 0) {
        throw new BudgetError('BUDGET_EXHAUSTED', overrun, `budget ${budgetId} exhausted`);
      }
      tx.execute(
        `UPDATE budgets SET consumed_json = ?, version = version + 1 WHERE budget_id = ?`,
        [JSON.stringify(nextConsumed), budgetId],
      );
      return { ...budget, consumed: nextConsumed as unknown as BudgetConsumption };
    });
  }

  private readInTx(tx: Transaction, budgetId: string): Budget | null {
    const rows = tx.query<BudgetRow>('SELECT * FROM budgets WHERE budget_id = ?', [budgetId]);
    return rows[0] ? rowToBudget(rows[0]) : null;
  }
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    budgetId: row.budget_id,
    scope: row.scope as Budget['scope'],
    scopeId: row.scope_id,
    ...(row.parent_budget_id === null ? {} : { parentBudgetId: row.parent_budget_id }),
    limits: JSON.parse(row.limits_json) as BudgetLimits,
    consumed: JSON.parse(row.consumed_json) as BudgetConsumption,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
