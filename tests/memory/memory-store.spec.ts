// P7-MS1 — SqliteMemoryStore.
// Verifies schema v5 migration + append-only insert/query/count with deterministic
// ordering (ME-004). Retention/eviction is NOT tested here — that is MemoryWriter.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteMemoryStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { MemoryRecord, Provenance } from '@codeforge/agent-core';

const now = () => '2026-01-01T00:00:00.000Z';

function provenance(id: string): Provenance {
  return {
    provenanceId: `prov-${id}`,
    source: { kind: 'runtime', id: 'memory-writer' },
    inputs: [],
    reason: 'test record',
    at: '2026-01-01T00:00:00.000Z',
  };
}

function record(over: Partial<MemoryRecord> & { memoryId: string }): MemoryRecord {
  return {
    kind: 'task_outcome',
    scope: 'project',
    content: 'content',
    tags: [],
    provenance: provenance(over.memoryId),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

let db: SqliteDatabaseAdapter;
let store: SqliteMemoryStore;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now });
  store = new SqliteMemoryStore(db);
});

afterEach(() => db.close());

describe('P7-MS1 — migration', () => {
  it('migration v5 creates the memory_records table', () => {
    const names = db
      .query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    expect(names).toContain('memory_records');
    expect(db.getSchemaVersion()).toBe(6);
  });
});

describe('P7-MS1 — insert + query', () => {
  it('round-trips a record', async () => {
    await store.insert(record({ memoryId: 'm1', content: 'hello', tags: ['auth'] }));
    const out = await store.query({ limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ memoryId: 'm1', content: 'hello', tags: ['auth'] });
    expect(out[0]?.provenance.provenanceId).toBe('prov-m1');
  });

  it('rejects a duplicate memoryId (append-only identity)', async () => {
    await store.insert(record({ memoryId: 'dup' }));
    await expect(store.insert(record({ memoryId: 'dup' }))).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('filters by kind', async () => {
    await store.insert(record({ memoryId: 'a', kind: 'task_outcome' }));
    await store.insert(record({ memoryId: 'b', kind: 'failure_pattern' }));
    const out = await store.query({ kinds: ['failure_pattern'], limit: 10 });
    expect(out.map((r) => r.memoryId)).toEqual(['b']);
  });

  it('filters by scope', async () => {
    await store.insert(record({ memoryId: 'a', scope: 'project' }));
    await store.insert(record({ memoryId: 'b', scope: 'global' }));
    const out = await store.query({ scope: 'global', limit: 10 });
    expect(out.map((r) => r.memoryId)).toEqual(['b']);
  });

  it('filters by tags (must contain ALL requested tags)', async () => {
    await store.insert(record({ memoryId: 'a', tags: ['auth', 'login'] }));
    await store.insert(record({ memoryId: 'b', tags: ['auth'] }));
    const out = await store.query({ tags: ['auth', 'login'], limit: 10 });
    expect(out.map((r) => r.memoryId)).toEqual(['a']);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) await store.insert(record({ memoryId: `m${i}` }));
    const out = await store.query({ limit: 3 });
    expect(out).toHaveLength(3);
  });
});

describe('P7-MS1 — determinism (ME-004) + count', () => {
  it('orders by created_at desc, then memoryId asc (stable)', async () => {
    await store.insert(record({ memoryId: 'b', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.insert(record({ memoryId: 'a', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.insert(record({ memoryId: 'c', createdAt: '2026-01-01T00:00:00.000Z' }));
    const out = await store.query({ limit: 10 });
    // Same timestamp -> id asc (a before b); newer timestamp first (a,b before c).
    expect(out.map((r) => r.memoryId)).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic across repeated queries', async () => {
    for (const id of ['x', 'y', 'z']) await store.insert(record({ memoryId: id }));
    const first = (await store.query({ limit: 10 })).map((r) => r.memoryId);
    const second = (await store.query({ limit: 10 })).map((r) => r.memoryId);
    expect(first).toEqual(second);
  });

  it('count returns per-(scope,kind) totals', async () => {
    await store.insert(record({ memoryId: 'a', scope: 'project', kind: 'task_outcome' }));
    await store.insert(record({ memoryId: 'b', scope: 'project', kind: 'task_outcome' }));
    await store.insert(record({ memoryId: 'c', scope: 'project', kind: 'failure_pattern' }));
    expect(await store.count('project', 'task_outcome')).toBe(2);
    expect(await store.count('project', 'failure_pattern')).toBe(1);
    expect(await store.count('global', 'task_outcome')).toBe(0);
  });
});
