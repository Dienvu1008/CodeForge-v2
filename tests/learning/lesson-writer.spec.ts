// P11.2 unit — distill() + LessonWriter + SqliteLearningStore round-trip.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteLearningStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { LessonWriter, distill, SelfModelBuilder } from '@codeforge/agent-core';
import type { Failure, RecoveryAction } from '@codeforge/agent-core';

const now = () => '2026-04-04T00:00:00.000Z';

function failure(id: string, sessionId: string, cls: Failure['class'], sig: string): Failure {
  return {
    failureId: id, sessionId, taskId: `t-${id}`, taskRunId: `r-${id}`,
    stage: 'verify', class: cls, signature: sig, evidence: { message: 'x' },
    detectedAt: now(), classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}
function recovery(id: string, failureId: string, action: RecoveryAction['action'], outcome: RecoveryAction['outcome']): RecoveryAction {
  return {
    actionId: id, failureId, action, reason: 'r', policyVersion: 1,
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    startedAt: now(), outcome,
  };
}

describe('distill', () => {
  it('emits a recovery_outcome lesson per (class, action) and recurring signatures only', () => {
    const failures = [
      failure('f1', 's1', 'SYNTAX', 'recurring'),
      failure('f2', 's1', 'SYNTAX', 'recurring'),
      failure('f3', 's1', 'LOGIC', 'oneoff'),
    ];
    const recoveries = [
      recovery('a1', 'f1', 'FIX', 'SUCCEEDED'),
      recovery('a2', 'f2', 'FIX', 'FAILED'),
    ];
    const model = new SelfModelBuilder().build({ events: [], failures, recoveryActions: recoveries });
    const payloads = distill(model);

    const recovery_outcomes = payloads.filter((p) => p.kind === 'recovery_outcome');
    const recurrences = payloads.filter((p) => p.kind === 'failure_recurrence');

    expect(recovery_outcomes).toHaveLength(1);
    expect(recovery_outcomes[0]).toMatchObject({ failureClass: 'SYNTAX', action: 'FIX', total: 2, succeeded: 1, failed: 1 });
    // Only the recurring signature (count 2) becomes a lesson; the one-off is dropped.
    expect(recurrences).toHaveLength(1);
    expect(recurrences[0]).toMatchObject({ signature: 'recurring', count: 2, failureClass: 'SYNTAX' });
  });

  it('is deterministic (pure function of the model)', () => {
    const model = new SelfModelBuilder().build({
      events: [],
      failures: [failure('f1', 's1', 'TOOL', 's')],
      recoveryActions: [recovery('a1', 'f1', 'FIX', 'SUCCEEDED')],
    });
    expect(JSON.stringify(distill(model))).toEqual(JSON.stringify(distill(model)));
  });
});

describe('LessonWriter + SqliteLearningStore', () => {
  let db: SqliteDatabaseAdapter;
  let store: SqliteLearningStore;
  let idN = 0;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now });
    store = new SqliteLearningStore(db);
    idN = 0;
  });
  afterEach(() => db.close());

  it('persists distilled lessons and round-trips them', async () => {
    const writer = new LessonWriter({ store, now, nextId: () => `id-${++idN}` });
    const model = new SelfModelBuilder().build({
      events: [],
      failures: [failure('f1', 's1', 'SYNTAX', 'dup'), failure('f2', 's1', 'SYNTAX', 'dup')],
      recoveryActions: [recovery('a1', 'f1', 'FIX', 'SUCCEEDED')],
    });
    const written = await writer.writeFromModel(model, 'project');
    expect(written.length).toBe(2); // 1 recovery_outcome + 1 recurring signature

    const back = await store.query({ limit: 100 });
    expect(back.map((l) => l.kind).sort()).toEqual(['failure_recurrence', 'recovery_outcome']);
    // Keys are deterministic and stable.
    const ro = back.find((l) => l.kind === 'recovery_outcome')!;
    expect(ro.key).toBe('recovery_outcome\u0001SYNTAX\u0001FIX');
  });

  it('filters by scope and kind on query', async () => {
    const writer = new LessonWriter({ store, now, nextId: () => `id-${++idN}` });
    const model = new SelfModelBuilder().build({
      events: [],
      failures: [failure('f1', 's1', 'LOGIC', 'x')],
      recoveryActions: [recovery('a1', 'f1', 'FIX', 'SUCCEEDED')],
    });
    await writer.writeFromModel(model, 'session');
    expect(await store.query({ scope: 'project', limit: 100 })).toHaveLength(0);
    expect((await store.query({ scope: 'session', kinds: ['recovery_outcome'], limit: 100 })).length).toBe(1);
  });

  it('writes nothing for an empty model', async () => {
    const writer = new LessonWriter({ store, now, nextId: () => `id-${++idN}` });
    const empty = new SelfModelBuilder().build({ events: [], failures: [], recoveryActions: [] });
    const written = await writer.writeFromModel(empty, 'project');
    expect(written).toEqual([]);
    expect(await store.query({ limit: 100 })).toEqual([]);
  });
});
