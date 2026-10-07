// LE-006 — Learning store có retention bound; không ghi không giới hạn.
//
// Enforced by LessonWriter (write-path retention, mirroring MemoryWriter/ME-006): after
// each write it evicts all but the newest `maxPerScopeKind` lessons per (scope, kind). The
// store only executes evictOldest; the policy lives in the writer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteLearningStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { LessonWriter } from '@codeforge/agent-core';
import type { Lesson } from '@codeforge/agent-core';

const BASE = Date.parse('2026-03-01T00:00:00.000Z');

let db: SqliteDatabaseAdapter;
let store: SqliteLearningStore;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-03-01T00:00:00.000Z' });
  store = new SqliteLearningStore(db);
});
afterEach(() => db.close());

function lesson(n: number): Lesson {
  // Distinct, increasing timestamps so "newest" is well-defined.
  const at = new Date(BASE + n * 1000).toISOString();
  return {
    lessonId: `L-${String(n).padStart(4, '0')}`,
    kind: 'failure_recurrence',
    scope: 'project',
    key: `sig-${n}`,
    payload: { kind: 'failure_recurrence', signature: `sig-${n}`, failureClass: 'SYNTAX', count: 2 },
    provenance: { provenanceId: `p-${n}`, source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at },
    createdAt: at,
  };
}

describe('LE-006 — learning store is retention-bounded', () => {
  it('writer caps a (scope, kind) bucket at maxPerScopeKind', async () => {
    const writer = new LessonWriter({
      store,
      now: () => '2026-03-01T00:00:00.000Z',
      nextId: () => 'x',
      retention: { maxPerScopeKind: 5 },
    });

    // Insert 12 lessons directly, then enforce retention via the writer.
    for (let i = 1; i <= 12; i++) await store.insert(lesson(i));
    expect(await store.count('project', 'failure_recurrence')).toBe(12);

    const evicted = await writer.enforceRetention('project', 'failure_recurrence');
    expect(evicted).toBe(7); // 12 - 5
    expect(await store.count('project', 'failure_recurrence')).toBe(5);

    // The retained 5 are the NEWEST (highest timestamps → L-0008..L-0012).
    const remaining = (await store.query({ limit: 100 })).map((l) => l.lessonId).sort();
    expect(remaining).toEqual(['L-0008', 'L-0009', 'L-0010', 'L-0011', 'L-0012']);
  });

  it('enforceRetention is a no-op when under the bound', async () => {
    const writer = new LessonWriter({
      store, now: () => '2026-03-01T00:00:00.000Z', nextId: () => 'x',
      retention: { maxPerScopeKind: 100 },
    });
    for (let i = 1; i <= 3; i++) await store.insert(lesson(i));
    const evicted = await writer.enforceRetention('project', 'failure_recurrence');
    expect(evicted).toBe(0);
    expect(await store.count('project', 'failure_recurrence')).toBe(3);
  });
});
