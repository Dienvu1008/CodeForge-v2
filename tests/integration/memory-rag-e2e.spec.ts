// P7-I1 — Memory / RAG E2E (PHASE_7_ROADMAP §4.9).
//
// Full Phase 7 chain:
//   MemoryWriter.write  (outcomes + failure patterns, provenance + retention)
//     -> SqliteMemoryStore (schema v5, persistence)
//     -> MemoryRetriever.retrieve (deterministic relevance ranking)
//     -> context Retriever (untrusted `memory` context items)
//   DocRetriever + RepoRetriever (local RAG, SX1/IG1)
//     -> context Retriever (untrusted RAG snippets recording their source)
//   ME-001: memory/RAG are evidence only — every item is untrusted, never authority.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MemoryWriter,
  MemoryRetriever,
  Retriever,
  type WorkspaceRevision,
  type ContextItem,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteMemoryStore,
  DocRetriever,
  RepoRetriever,
  TreeSitterAdapter,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-e2e',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'e2e',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

const byKind = (items: readonly ContextItem[], kind: string): ContextItem[] =>
  items.filter((i) => i.kind === kind);

describe('P7-I1 Memory / RAG E2E', () => {
  let db: SqliteDatabaseAdapter;
  let store: SqliteMemoryStore;
  let writer: MemoryWriter;
  let memoryRetriever: MemoryRetriever;
  let docRetriever: DocRetriever;
  let repoRetriever: RepoRetriever;
  let clock = 0;

  beforeAll(async () => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    store = new SqliteMemoryStore(db);
    let n = 0;
    clock = 0;
    writer = new MemoryWriter({
      store,
      now: () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      nextId: () => `id-${++n}`,
      retention: { maxPerScopeKind: 50 },
    });
    memoryRetriever = new MemoryRetriever();
    docRetriever = new DocRetriever();
    const adapter = new TreeSitterAdapter();
    await adapter.initialize();
    repoRetriever = new RepoRetriever(adapter);
  });

  afterAll(() => db.close());

  it('writes outcomes + failure patterns with provenance (ME-003), then retrieves them', async () => {
    await writer.write({
      kind: 'task_outcome', scope: 'project', tags: ['auth', 'login'],
      content: 'implemented login flow; tests pass', reason: 'record outcome',
    });
    await writer.write({
      kind: 'failure_pattern', scope: 'project', tags: ['auth'],
      content: 'login fails when token missing', reason: 'record failure pattern',
    });

    // Store round-trip + retriever ranking.
    const records = await store.query({ scope: 'project', limit: 50 });
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(r.provenance.reason.length).toBeGreaterThan(0); // ME-003
    }

    const ranked = memoryRetriever.retrieve({ tags: ['auth', 'login'], limit: 10 }, records);
    // The login outcome matches both tags → ranks first.
    expect(ranked[0]?.content).toContain('login flow');
  });

  it('surfaces memory as untrusted context (ME-001/002) — never authority', async () => {
    const records = await store.query({ scope: 'project', limit: 50 });
    const ranked = memoryRetriever.retrieve({ tags: ['auth'], limit: 10 }, records);

    let n = 0;
    const retriever = new Retriever({ nextId: () => `c-${++n}`, now: () => 't' });
    const items = retriever.retrieve({
      sessionId: 'S', workspaceRevision: REVISION, buildReason: 'task_execution',
      memoryRecords: ranked,
    });

    const memItems = byKind(items, 'memory');
    expect(memItems.length).toBe(ranked.length);
    for (const m of memItems) {
      expect(m.trust).toBe('untrusted');           // ME-001/002: evidence, not authority
      expect(m.source.kind).toBe('memory');
      expect(m.provenance.provenanceId.length).toBeGreaterThan(0); // CX-002
    }
  });

  it('retrieves local docs (RAG) into untrusted context recording the source', async () => {
    const docs = new Map<string, string>([
      ['docs/auth.md', 'Authentication: login, logout, token refresh and session handling.'],
      ['docs/db.md', 'The database layer uses SQLite with migrations.'],
    ]);
    const ragItems = docRetriever.retrieve({ text: 'authentication session', limit: 5 }, docs);
    expect(ragItems.map((r) => r.path)).toContain('docs/auth.md');

    let n = 0;
    const retriever = new Retriever({ nextId: () => `c-${++n}`, now: () => 't' });
    const items = retriever.retrieve({
      sessionId: 'S', workspaceRevision: REVISION, buildReason: 'task_execution',
      ragItems,
    });
    const snippets = byKind(items, 'file_snippet');
    expect(snippets.length).toBeGreaterThan(0);
    for (const s of snippets) {
      expect(s.trust).toBe('untrusted');          // ME-005
      expect(s.source.path?.length).toBeGreaterThan(0); // source recorded
    }
  });

  it('retrieves relevant repo code (RAG via SX1/IG1) into untrusted context', async () => {
    const files = new Map<string, string>([
      ['src/util.ts', 'export const helper = () => 1;'],
      ['src/a.ts', "import { helper } from './util';\nexport const a = helper;"],
    ]);
    const ragItems = await repoRetriever.retrieve({ seeds: ['src/util.ts'], limit: 10 }, files);
    expect(ragItems.map((r) => r.path)).toContain('src/a.ts'); // importer of the seed

    let n = 0;
    const retriever = new Retriever({ nextId: () => `c-${++n}`, now: () => 't' });
    const items = retriever.retrieve({
      sessionId: 'S', workspaceRevision: REVISION, buildReason: 'task_execution',
      ragItems,
    });
    for (const s of byKind(items, 'file_snippet')) {
      expect(s.trust).toBe('untrusted');
    }
  });

  it('ME-001: no memory/RAG context item is ever trusted (authority check)', async () => {
    const records = await store.query({ scope: 'project', limit: 50 });
    const ranked = memoryRetriever.retrieve({ limit: 10 }, records);
    const ragItems = docRetriever.retrieve(
      { text: 'login', limit: 5 },
      new Map([['docs/auth.md', 'login and token refresh']]),
    );

    let n = 0;
    const retriever = new Retriever({ nextId: () => `c-${++n}`, now: () => 't' });
    const items = retriever.retrieve({
      sessionId: 'S', workspaceRevision: REVISION, buildReason: 'task_execution',
      memoryRecords: ranked, ragItems,
    });

    // Every memory/RAG-derived item is untrusted. No path makes memory authoritative.
    const evidence = items.filter((i) => i.kind === 'memory' || i.kind === 'file_snippet');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((i) => i.trust === 'untrusted')).toBe(true);
  });

  it('is deterministic end-to-end', async () => {
    const records = await store.query({ scope: 'project', limit: 50 });
    const run = () => memoryRetriever.retrieve({ tags: ['auth'], limit: 10 }, records).map((r) => r.memoryId);
    expect(run()).toEqual(run());
  });
});
