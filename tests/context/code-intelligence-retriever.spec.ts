// P6-CR1 — CodeIntelligenceRetriever (Retriever upgrade).
// Verifies symbol-definition injection + import-distance ranking, preserving
// CX-002 (provenance) and CX-003 (untrusted workspace content).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  Retriever,
  assignTrust,
  type RetrieveRequest,
  type RetrievedSymbol,
} from '@codeforge/agent-core';
import type { WorkspaceRevision, ContextItem } from '@codeforge/agent-core';
import { TreeSitterAdapter, SymbolExtractor, ImportGraphBuilder } from '@codeforge/infrastructure';

// ── fixtures ───────────────────────────────────────────────────────────────────

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
  return new Retriever({
    nextId: () => `id-${++n}`,
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

function baseRequest(over: Partial<RetrieveRequest> = {}): RetrieveRequest {
  return {
    sessionId: 'S',
    workspaceRevision: REVISION,
    buildReason: 'task_execution',
    ...over,
  };
}

const byKind = (items: readonly ContextItem[], kind: string): ContextItem[] =>
  items.filter((i) => i.kind === kind);

// ── reverse-edge fixture builder ────────────────────────────────────────────────

function reverse(obj: Record<string, string[]>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [file, importers] of Object.entries(obj)) m.set(file, new Set(importers));
  return m;
}

describe('P6-CR1 — symbol definition injection', () => {
  const symbols: RetrievedSymbol[] = [
    { file: 'src/a.ts', name: 'alpha', kind: 'function', startLine: 0, endLine: 2, exported: true },
    { file: 'src/a.ts', name: 'Beta', kind: 'class', startLine: 4, endLine: 10, exported: false },
    { file: 'src/other.ts', name: 'gamma', kind: 'function', startLine: 0, endLine: 1, exported: true },
  ];

  it('emits symbol_definition items only for symbols in changed files', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'x'], ['src/other.ts', 'y']]),
      changedPaths: ['src/a.ts'],
      symbols,
    }));
    const syms = byKind(items, 'symbol_definition');
    expect(syms.map((s) => s.source.symbolName).sort()).toEqual(['Beta', 'alpha']);
    // gamma lives in a non-changed, non-affected file → not injected.
    expect(syms.some((s) => s.source.symbolName === 'gamma')).toBe(false);
  });

  it('symbol items are untrusted and carry workspace_symbol source (CX-003)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'x']]),
      changedPaths: ['src/a.ts'],
      symbols,
    }));
    for (const s of byKind(items, 'symbol_definition')) {
      expect(s.source.kind).toBe('workspace_symbol');
      expect(s.trust).toBe('untrusted');
      expect(assignTrust('workspace_symbol')).toBe('untrusted');
    }
  });

  it('every symbol item has provenance (CX-002)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'x']]),
      changedPaths: ['src/a.ts'],
      symbols,
    }));
    for (const s of byKind(items, 'symbol_definition')) {
      expect(s.provenance).toBeDefined();
      expect(s.provenance.provenanceId.length).toBeGreaterThan(0);
    }
  });

  it('injects symbols from affected (importing) files when a graph is given', () => {
    // b.ts imports a.ts; changing a.ts affects b.ts → b.ts symbols injected too.
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'x'], ['src/b.ts', 'y']]),
      changedPaths: ['src/a.ts'],
      symbols: [
        { file: 'src/a.ts', name: 'alpha', kind: 'function', startLine: 0, endLine: 1, exported: true },
        { file: 'src/b.ts', name: 'bravo', kind: 'function', startLine: 0, endLine: 1, exported: true },
      ],
      importReverseEdges: reverse({ 'src/a.ts': ['src/b.ts'] }),
    }));
    expect(byKind(items, 'symbol_definition').map((s) => s.source.symbolName).sort())
      .toEqual(['alpha', 'bravo']);
  });

  it('emits no symbol items when none provided (backward compatible)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'x']]),
      changedPaths: ['src/a.ts'],
    }));
    expect(byKind(items, 'symbol_definition')).toHaveLength(0);
  });
});

describe('P6-CR1 — import-distance ranking', () => {
  it('ranks files that import the changed set above unrelated files', () => {
    // b imports a (changed); c imports b; z unrelated.
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([
        ['src/a.ts', 'A'],
        ['src/b.ts', 'B'],
        ['src/c.ts', 'C'],
        ['src/z.ts', 'Z'],
      ]),
      changedPaths: ['src/a.ts'],
      importReverseEdges: reverse({ 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/c.ts'] }),
    }));
    const files = byKind(items, 'file_full');
    const b = files.find((f) => f.source.path === 'src/b.ts');
    const c = files.find((f) => f.source.path === 'src/c.ts');
    const z = files.find((f) => f.source.path === 'src/z.ts');
    // b (distance 1) ranks above c (distance 2), which ranks above z (unrelated).
    expect(b!.priority).toBeGreaterThan(c!.priority);
    expect(c!.priority).toBeGreaterThan(z!.priority);
  });

  it('distance ranking never outranks the changed files themselves', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'A'], ['src/b.ts', 'B']]),
      changedPaths: ['src/a.ts'],
      importReverseEdges: reverse({ 'src/a.ts': ['src/b.ts'] }),
    }));
    const files = byKind(items, 'file_full');
    const changed = files.find((f) => f.source.path === 'src/a.ts');
    const importer = files.find((f) => f.source.path === 'src/b.ts');
    expect(changed!.priority).toBeGreaterThan(importer!.priority);
  });

  it('falls back to alphabetical ranking without a graph (backward compatible)', () => {
    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: new Map([['src/z.ts', 'Z'], ['src/a.ts', 'A'], ['src/m.ts', 'M']]),
      changedPaths: [],
    }));
    const files = byKind(items, 'file_full').map((f) => f.source.path);
    expect(files).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('is deterministic (same request → same ordering)', () => {
    const r1 = makeRetriever();
    const r2 = makeRetriever();
    const req = baseRequest({
      workspaceFiles: new Map([['src/a.ts', 'A'], ['src/b.ts', 'B'], ['src/c.ts', 'C']]),
      changedPaths: ['src/a.ts'],
      importReverseEdges: reverse({ 'src/a.ts': ['src/b.ts', 'src/c.ts'] }),
    });
    const o1 = r1.retrieve(req).map((i) => `${i.kind}:${i.source.path ?? ''}:${i.priority}`);
    const o2 = r2.retrieve(req).map((i) => `${i.kind}:${i.source.path ?? ''}:${i.priority}`);
    expect(o1).toEqual(o2);
  });
});

describe('P6-CR1 — integration with SymbolExtractor + ImportGraphBuilder', () => {
  let extractor: SymbolExtractor;
  let graphBuilder: ImportGraphBuilder;

  beforeAll(async () => {
    const adapter = new TreeSitterAdapter();
    await adapter.initialize();
    extractor = new SymbolExtractor(adapter);
    graphBuilder = new ImportGraphBuilder(adapter);
  });

  it('retrieves real symbols + distance-ranked files from live TS analysis', async () => {
    const files = new Map<string, string>([
      ['src/util.ts', 'export function helper() { return 1; }'],
      ['src/a.ts', "import { helper } from './util';\nexport function a() { return helper(); }"],
      ['src/entry.ts', "import { a } from './a';\nexport const run = a;"],
    ]);

    // Build the import graph (IG1).
    const graph = await graphBuilder.build({ files });

    // Extract symbols per file (SX1) and tag each with its file (CR1 mapping).
    const symbols: RetrievedSymbol[] = [];
    for (const [file, content] of files) {
      const language = file.endsWith('.ts') ? 'typescript' : 'javascript';
      for (const s of await extractor.extract(content, language)) {
        symbols.push({
          file,
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          endLine: s.endLine,
          exported: s.exported,
        });
      }
    }

    const r = makeRetriever();
    const items = r.retrieve(baseRequest({
      workspaceFiles: files,
      changedPaths: ['src/util.ts'],
      symbols,
      importReverseEdges: graph.reverseEdges,
    }));

    // Symbols from util (changed) and its importers (a, entry) are injected.
    const symNames = byKind(items, 'symbol_definition').map((s) => s.source.symbolName);
    expect(symNames).toContain('helper');
    expect(symNames).toContain('a');

    // a.ts (imports util, distance 1) ranks above entry.ts (distance 2).
    const files2 = byKind(items, 'file_full');
    const a = files2.find((f) => f.source.path === 'src/a.ts');
    const entry = files2.find((f) => f.source.path === 'src/entry.ts');
    expect(a!.priority).toBeGreaterThan(entry!.priority);
  });
});
