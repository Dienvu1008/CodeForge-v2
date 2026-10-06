// ME-006 — Memory store có retention bound; không ghi không giới hạn.
//
// Enforced by MemoryWriter (P7-MW1): v1 policy is max-count per (scope, kind).
// Writing beyond the bound evicts the oldest; retention lives ONLY in the writer
// (the store merely executes evictOldest).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteMemoryStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { MemoryWriter } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let store: SqliteMemoryStore;
let writer: MemoryWriter;
let clock = 0;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  store = new SqliteMemoryStore(db);
  clock = 0;
  let n = 0;
  writer = new MemoryWriter({
    store,
    // Monotonic clock so eviction order (recency) is well-defined.
    now: () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    nextId: () => `id-${++n}`,
    retention: { maxPerScopeKind: 3 },
  });
});

afterEach(() => db.close());

describe('ME-006 — memory retention is bounded', () => {
  it('writing beyond the per-(scope,kind) max evicts the oldest', async () => {
    for (let i = 0; i < 5; i++) {
      await writer.write({ kind: 'task_outcome', scope: 'project', content: `c${i}`, reason: 'r' });
    }
    // Only the 3 newest survive (c2, c3, c4).
    expect(await store.count('project', 'task_outcome')).toBe(3);
    const survivors = (await store.query({ limit: 10 })).map((r) => r.content).sort();
    expect(survivors).toEqual(['c2', 'c3', 'c4']);
  });

  it('keeps the newest records (oldest are the ones dropped)', async () => {
    for (let i = 0; i < 4; i++) {
      await writer.write({ kind: 'project_note', scope: 'global', content: `n${i}`, reason: 'r' });
    }
    const survivors = (await store.query({ limit: 10 })).map((r) => r.content);
    expect(survivors).not.toContain('n0'); // oldest evicted
    expect(survivors).toContain('n3');     // newest kept
  });

  it('buckets are independent — each (scope,kind) bounded separately', async () => {
    for (let i = 0; i < 4; i++) {
      await writer.write({ kind: 'task_outcome', scope: 'project', content: `o${i}`, reason: 'r' });
      await writer.write({ kind: 'failure_pattern', scope: 'project', content: `f${i}`, reason: 'r' });
    }
    expect(await store.count('project', 'task_outcome')).toBe(3);
    expect(await store.count('project', 'failure_pattern')).toBe(3);
  });

  it('enforceRetention is a no-op when under the bound', async () => {
    await writer.write({ kind: 'user_preference', scope: 'global', content: 'p', reason: 'r' });
    const evicted = await writer.enforceRetention('global', 'user_preference');
    expect(evicted).toBe(0);
    expect(await store.count('global', 'user_preference')).toBe(1);
  });
});
