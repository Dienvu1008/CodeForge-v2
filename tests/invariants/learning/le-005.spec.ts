// LE-005 — Mọi lesson có provenance (session/run nguồn) + reason + timestamp; append-only.
//
// Enforced by LessonWriter (provenance on every write, referencing source sessions) +
// SqliteLearningStore (insert-only; no update/delete-by-id; duplicate id rejected).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteLearningStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { LessonWriter, SelfModelBuilder } from '@codeforge/agent-core';
import type { Failure, RecoveryAction, Lesson } from '@codeforge/agent-core';

const now = () => '2026-02-02T00:00:00.000Z';

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

let db: SqliteDatabaseAdapter;
let store: SqliteLearningStore;
let writer: LessonWriter;
let idN = 0;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now });
  store = new SqliteLearningStore(db);
  idN = 0;
  writer = new LessonWriter({ store, now, nextId: () => `id-${++idN}` });
});
afterEach(() => db.close());

function model() {
  const failures = [failure('f1', 's1', 'SYNTAX', 'sig'), failure('f2', 's2', 'SYNTAX', 'sig')];
  const recoveries = [recovery('a1', 'f1', 'FIX', 'SUCCEEDED')];
  return new SelfModelBuilder().build({ events: [], failures, recoveryActions: recoveries });
}

describe('LE-005 — lessons have provenance and are append-only', () => {
  it('every written lesson has provenance with reason, timestamp, and source sessions', async () => {
    const written = await writer.writeFromModel(model(), 'project');
    expect(written.length).toBeGreaterThan(0);
    for (const l of written) {
      expect(l.provenance.reason.length).toBeGreaterThan(0);
      expect(l.provenance.at).toBe(now());
      // Source sessions (inputs) traced from the model (s1, s2).
      expect([...l.provenance.inputs].sort()).toEqual(['s1', 's2']);
      expect(l.createdAt).toBe(now());
    }
  });

  it('the store rejects a duplicate lessonId (append-only identity)', async () => {
    const lesson: Lesson = {
      lessonId: 'dup', kind: 'failure_recurrence', scope: 'project', key: 'k',
      payload: { kind: 'failure_recurrence', signature: 'sig', failureClass: 'SYNTAX', count: 2 },
      provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: now() },
      createdAt: now(),
    };
    await store.insert(lesson);
    await expect(store.insert(lesson)).rejects.toBeTruthy();
  });

  it('writing twice appends (never updates) — older snapshot is retained', async () => {
    await writer.writeFromModel(model(), 'project');
    const afterFirst = await store.query({ limit: 100 });
    await writer.writeFromModel(model(), 'project');
    const afterSecond = await store.query({ limit: 100 });
    // Append-only: the second write adds rows rather than mutating the first.
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });
});
