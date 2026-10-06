// ME-003 — Mọi memory write có provenance + reason + timestamp; append-only.
//
// Enforced by MemoryWriter (P7-MW1): every written record carries a Provenance
// with reason + at + source, and records are never mutated (append-only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteMemoryStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { MemoryWriter } from '@codeforge/agent-core';

const now = () => '2026-01-01T00:00:00.000Z';

let db: SqliteDatabaseAdapter;
let writer: MemoryWriter;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now });
  let n = 0;
  writer = new MemoryWriter({
    store: new SqliteMemoryStore(db),
    now,
    nextId: () => `id-${++n}`,
  });
});

afterEach(() => db.close());

describe('ME-003 — memory writes are provenance-tracked + append-only', () => {
  it('every written record carries provenance with reason + at + source', async () => {
    const rec = await writer.write({
      kind: 'task_outcome',
      scope: 'project',
      content: 'built ok',
      reason: 'record task outcome',
    });
    expect(rec.provenance.reason).toBe('record task outcome');
    expect(rec.provenance.at).toBe('2026-01-01T00:00:00.000Z');
    expect(rec.provenance.source.kind).toBe('runtime');
    expect(rec.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes are append-only — two writes produce two distinct records', async () => {
    const store = new SqliteMemoryStore(db);
    await writer.write({ kind: 'project_note', scope: 'project', content: 'a', reason: 'r' });
    await writer.write({ kind: 'project_note', scope: 'project', content: 'b', reason: 'r' });
    const all = await store.query({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.memoryId)).size).toBe(2);
    // Both original contents are preserved — nothing was overwritten.
    expect(all.map((r) => r.content).sort()).toEqual(['a', 'b']);
  });
});
