// P7-MW1 — MemoryWriter.
// Write-path behavior: provenance attachment, record shape, source override,
// default retention, and retention eviction via the store primitive.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteMemoryStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { MemoryWriter, DEFAULT_RETENTION_POLICY } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let store: SqliteMemoryStore;
let clock: number;

function makeWriter(maxPerScopeKind?: number): MemoryWriter {
  let n = 0;
  return new MemoryWriter({
    store,
    now: () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    nextId: () => `id-${++n}`,
    ...(maxPerScopeKind !== undefined ? { retention: { maxPerScopeKind } } : {}),
  });
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  store = new SqliteMemoryStore(db);
  clock = 0;
});

afterEach(() => db.close());

describe('P7-MW1 MemoryWriter — write', () => {
  it('returns a fully-formed record and persists it', async () => {
    const writer = makeWriter();
    const rec = await writer.write({
      kind: 'task_outcome',
      scope: 'project',
      content: 'tests passed',
      tags: ['ci'],
      reason: 'record outcome',
    });
    expect(rec).toMatchObject({
      kind: 'task_outcome',
      scope: 'project',
      content: 'tests passed',
      tags: ['ci'],
    });
    expect(rec.memoryId).toMatch(/^id-/);
    const stored = await store.query({ limit: 10 });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.memoryId).toBe(rec.memoryId);
  });

  it('defaults the provenance source to runtime/memory-writer', async () => {
    const writer = makeWriter();
    const rec = await writer.write({
      kind: 'project_note', scope: 'project', content: 'x', reason: 'r',
    });
    expect(rec.provenance.source).toEqual({ kind: 'runtime', id: 'memory-writer' });
  });

  it('honors an explicit provenance source', async () => {
    const writer = makeWriter();
    const rec = await writer.write({
      kind: 'user_preference', scope: 'global', content: 'dark mode', reason: 'user said so',
      source: { kind: 'user', id: 'U1' },
    });
    expect(rec.provenance.source).toEqual({ kind: 'user', id: 'U1' });
  });

  it('defaults tags to empty array', async () => {
    const writer = makeWriter();
    const rec = await writer.write({ kind: 'project_note', scope: 'project', content: 'x', reason: 'r' });
    expect(rec.tags).toEqual([]);
  });
});

describe('P7-MW1 MemoryWriter — retention', () => {
  it('does not evict while within the default bound', async () => {
    const writer = makeWriter(); // default 200
    expect(DEFAULT_RETENTION_POLICY.maxPerScopeKind).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      await writer.write({ kind: 'task_outcome', scope: 'project', content: `c${i}`, reason: 'r' });
    }
    expect(await store.count('project', 'task_outcome')).toBe(10);
  });

  it('evicts down to the bound after each write', async () => {
    const writer = makeWriter(2);
    for (let i = 0; i < 6; i++) {
      await writer.write({ kind: 'failure_pattern', scope: 'session', content: `c${i}`, reason: 'r' });
    }
    expect(await store.count('session', 'failure_pattern')).toBe(2);
    const survivors = (await store.query({ limit: 10 })).map((r) => r.content).sort();
    expect(survivors).toEqual(['c4', 'c5']); // two newest
  });

  it('enforceRetention is callable standalone and idempotent', async () => {
    const writer = makeWriter(2);
    for (let i = 0; i < 5; i++) {
      await writer.write({ kind: 'architecture_note', scope: 'global', content: `a${i}`, reason: 'r' });
    }
    expect(await store.count('global', 'architecture_note')).toBe(2);
    const again = await writer.enforceRetention('global', 'architecture_note');
    expect(again).toBe(0); // already at bound
  });
});
