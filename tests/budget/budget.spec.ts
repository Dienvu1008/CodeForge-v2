// P1-B1 Budget — BudgetEngine (pure) + SqliteBudgetRepository (BU-001/002/003/005).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  remaining,
  isExhausted,
  canAllocateChild,
  childLimitViolations,
  canConsume,
  applyConsumption,
  recoveryExhausted,
  BudgetError,
} from '@codeforge/agent-core';
import type { Budget, BudgetLimits, BudgetConsumption } from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteBudgetRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';

function limits(over: Partial<BudgetLimits> = {}): BudgetLimits {
  return { wallClockMs: 1000, modelTokens: 500, toolCalls: 10, recoveryAttempts: 3, ...over };
}
function consumed(over: Partial<BudgetConsumption> = {}): BudgetConsumption {
  return { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0, ...over };
}
function budget(over: Partial<Budget> = {}): Budget {
  return {
    budgetId: 'B',
    scope: 'session',
    scopeId: 'S',
    limits: limits(),
    consumed: consumed(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('BudgetEngine — remaining / exhausted (BU-005)', () => {
  it('remaining = limits - consumed, floored at 0', () => {
    const r = remaining(budget({ consumed: consumed({ toolCalls: 4, modelTokens: 600 }) }));
    expect(r.toolCalls).toBe(6);
    expect(r.modelTokens).toBe(0); // floored, not negative
  });
  it('isExhausted true when ANY dimension is fully consumed', () => {
    expect(isExhausted(budget({ consumed: consumed({ toolCalls: 10 }) }))).toBe(true);
    expect(isExhausted(budget({ consumed: consumed({ toolCalls: 9 }) }))).toBe(false);
  });
});

describe('BudgetEngine — BU-001 child <= parent remaining', () => {
  it('rejects a child whose limit exceeds parent remaining in any dimension', () => {
    const parent = budget({ consumed: consumed({ modelTokens: 400 }) }); // remaining modelTokens = 100
    expect(canAllocateChild(parent, limits({ modelTokens: 200 }))).toBe(false);
    expect(childLimitViolations(parent, limits({ modelTokens: 200 }))).toContain('modelTokens');
  });
  it('allows a child that fits parent remaining', () => {
    const parent = budget();
    expect(canAllocateChild(parent, limits({ modelTokens: 100, toolCalls: 2 }))).toBe(true);
  });
});

describe('BudgetEngine — canConsume / applyConsumption / recovery (BU-002)', () => {
  it('canConsume rejects an overrun and negatives', () => {
    const b = budget({ consumed: consumed({ toolCalls: 8 }) });
    expect(canConsume(b, { toolCalls: 2 })).toBe(true);
    expect(canConsume(b, { toolCalls: 3 })).toBe(false); // 8+3 > 10
    expect(canConsume(b, { toolCalls: -1 })).toBe(false);
  });
  it('applyConsumption adds per dimension (pure)', () => {
    const next = applyConsumption(consumed({ toolCalls: 1 }), { toolCalls: 2, modelTokens: 10 });
    expect(next.toolCalls).toBe(3);
    expect(next.modelTokens).toBe(10);
  });
  it('recoveryExhausted bounds recovery (BU-002)', () => {
    expect(recoveryExhausted(budget({ consumed: consumed({ recoveryAttempts: 3 }) }))).toBe(true);
    expect(recoveryExhausted(budget({ consumed: consumed({ recoveryAttempts: 2 }) }))).toBe(false);
  });
});

describe('SqliteBudgetRepository — atomic consume (BU-003) + exhaustion (BU-005)', () => {
  let db: SqliteDatabaseAdapter;
  let repo: SqliteBudgetRepository;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    repo = new SqliteBudgetRepository(db);
  });
  afterEach(() => db.close());

  it('creates and consumes atomically, updating remaining', async () => {
    await repo.create(budget());
    const after = await repo.consume('B', { toolCalls: 3, modelTokens: 100 });
    expect(after.consumed.toolCalls).toBe(3);
    expect(remaining(after).modelTokens).toBe(400);
  });

  it('rejects a consume that would overrun (BU-005), writes nothing', async () => {
    await repo.create(budget({ consumed: consumed({ toolCalls: 9 }) }));
    await expect(repo.consume('B', { toolCalls: 2 })).rejects.toBeInstanceOf(BudgetError);
    await expect(repo.consume('B', { toolCalls: 2 })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
    // Unchanged (no silent overrun).
    expect((await repo.getById('B'))?.consumed.toolCalls).toBe(9);
  });

  it('enforces BU-001 on create with a parent budget', async () => {
    await repo.create(budget({ budgetId: 'P', consumed: consumed({ modelTokens: 450 }) })); // remaining 50
    await expect(
      repo.create(
        budget({ budgetId: 'C', parentBudgetId: 'P', scope: 'task', limits: limits({ modelTokens: 100 }) }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_OVERFLOW' });
    // A fitting child is accepted.
    await repo.create(
      budget({ budgetId: 'C2', parentBudgetId: 'P', scope: 'task', limits: limits({ modelTokens: 40, toolCalls: 1, wallClockMs: 10, recoveryAttempts: 1 }) }),
    );
    expect((await repo.getChildren('P')).map((b) => b.budgetId)).toEqual(['C2']);
  });

  it('consume on a missing budget throws NOT_FOUND', async () => {
    await expect(repo.consume('NOPE', { toolCalls: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
