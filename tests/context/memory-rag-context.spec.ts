// P7-CR2 — memory + RAG wiring into the context Retriever.
// Verifies memory records and RAG chunks become untrusted, provenance-bearing
// ContextItems ranked below the current workspace (CX-002/003, ME-001/002/005).
import { describe, it, expect } from 'vitest';
import { Retriever, type RetrieveRequest } from '@codeforge/agent-core';
import type {
  WorkspaceRevision,
  ContextItem,
  MemoryRecord,
  RagItem,
  Provenance,
} from '@codeforge/agent-core';

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'deadbeef',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

function makeRetriever(): Retriever {
  let n = 0;
  return new Retriever({ nextId: () => `id-${++n}`, now: () => '2026-01-01T00:00:00.000Z' });
}

function baseRequest(over: Partial<RetrieveRequest> = {}): RetrieveRequest {
  return { sessionId: 'S', workspaceRevision: REVISION, buildReason: 'task_execution', ...over };
}

function provenance(id: string): Provenance {
  return { provenanceId: `p-${id}`, source: { kind: 'runtime', id: 'w' }, inputs: [], reason: 'r', at: 't' };
}

function mem(id: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryId: id, kind: 'task_outcome', scope: 'project', content: `mem-${id}`,
    tags: [], provenance: provenance(id), createdAt: 't', ...over,
  };
}

function rag(path: string, source: RagItem['source'] = 'doc'): RagItem {
  return { source, path, content: `rag-${path}`, score: 1, reason: 'relevant' };
}

const byKind = (items: readonly ContextItem[], kind: string): ContextItem[] =>
  items.filter((i) => i.kind === kind);

describe('P7-CR2 — memory injection', () => {
  it('emits memory records as untrusted memory items with provenance', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({ memoryRecords: [mem('m1'), mem('m2')] }));
    const memItems = byKind(items, 'memory');
    expect(memItems).toHaveLength(2);
    for (const m of memItems) {
      expect(m.trust).toBe('untrusted');       // ME-002
      expect(m.source.kind).toBe('memory');
      expect(m.provenance.provenanceId.length).toBeGreaterThan(0); // CX-002
    }
  });

  it('preserves caller ranking order of memory records', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({ memoryRecords: [mem('first'), mem('second')] }));
    const contents = byKind(items, 'memory').map((m) => m.content);
    expect(contents).toEqual(['mem-first', 'mem-second']);
  });

  it('emits no memory items when none provided (backward compatible)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest());
    expect(byKind(items, 'memory')).toHaveLength(0);
  });
});

describe('P7-CR2 — RAG injection', () => {
  it('emits RAG chunks as untrusted file_snippet items recording source path (ME-005)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({ ragItems: [rag('docs/a.md'), rag('src/b.ts', 'repo')] }));
    const snippets = byKind(items, 'file_snippet');
    expect(snippets).toHaveLength(2);
    for (const s of snippets) {
      expect(s.trust).toBe('untrusted');
      expect(s.source.kind).toBe('workspace_file');
      expect(s.source.path?.length).toBeGreaterThan(0); // source recorded
      expect(s.provenance.provenanceId.length).toBeGreaterThan(0);
    }
    expect(snippets.map((s) => s.source.path)).toEqual(['docs/a.md', 'src/b.ts']);
  });

  it('records the RAG source kind in the reason', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({ ragItems: [rag('src/x.ts', 'repo')] }));
    expect(byKind(items, 'file_snippet')[0]?.reason).toContain('rag:repo');
  });
});

describe('P7-CR2 — priority ordering (evidence ranks below current work)', () => {
  it('memory ranks below changed files and symbols; rag below memory', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'A']]),
      changedPaths: ['src/a.ts'],
      symbols: [{ file: 'src/a.ts', name: 'f', kind: 'function', startLine: 0, endLine: 1, exported: true }],
      memoryRecords: [mem('m1')],
      ragItems: [rag('docs/a.md')],
    }));
    const prio = (k: string): number => items.find((i) => i.kind === k)?.priority ?? -1;
    const changed = items.find((i) => i.kind === 'file_full' && i.source.path === 'src/a.ts')?.priority ?? -1;
    expect(changed).toBeGreaterThan(prio('symbol_definition'));
    expect(prio('symbol_definition')).toBeGreaterThan(prio('memory'));
    expect(prio('memory')).toBeGreaterThan(prio('file_snippet')); // rag
  });

  it('is deterministic (same request → same ordering)', () => {
    const req = baseRequest({ memoryRecords: [mem('a'), mem('b')], ragItems: [rag('x.md'), rag('y.md')] });
    const o1 = makeRetriever().retrieve(req).map((i) => `${i.kind}:${i.source.path ?? i.source.artifactId ?? ''}`);
    const o2 = makeRetriever().retrieve(req).map((i) => `${i.kind}:${i.source.path ?? i.source.artifactId ?? ''}`);
    expect(o1).toEqual(o2);
  });
});
