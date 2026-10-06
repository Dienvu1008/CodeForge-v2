// P6-I1 — Code Intelligence E2E (PHASE_6_ROADMAP §4.7).
//
// Full Phase 6 chain on a realistic small TypeScript project:
//   TreeSitterAdapter (TS1)  -> parse real TS files
//   SymbolExtractor   (SX1)  -> extract function/class/etc. symbols
//   ImportGraphBuilder (IG1) -> build import edges + reverse edges
//   computeAffectedClosureFromGraph (AS1) -> transitive affected set
//   Retriever         (CR1)  -> symbols + import-distance-ranked context
//   computeScope             -> AFFECTED_DIRECT promoted to AFFECTED_CLOSURE (VR-004)
//
// This is the Phase 6 exit-criteria test (roadmap §6, item 8).
import { describe, it, expect, beforeAll } from 'vitest';
import {
  Retriever,
  computeAffectedClosureFromGraph,
  computeScope,
  DEFAULT_VERIFICATION_POLICY,
  SCOPE_LATTICE,
  type RetrievedSymbol,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  TreeSitterAdapter,
  SymbolExtractor,
  ImportGraphBuilder,
} from '@codeforge/infrastructure';

// A small but realistic project: a util used by two features, both used by entry.
//   entry.ts -> feature-a.ts -> util.ts
//   entry.ts -> feature-b.ts -> util.ts
// Plus an unrelated standalone.ts that imports nothing local.
const PROJECT: ReadonlyMap<string, string> = new Map([
  ['src/util.ts',
    'export function clamp(n: number, lo: number, hi: number): number {\n' +
    '  return Math.max(lo, Math.min(hi, n));\n' +
    '}\n' +
    'export const ZERO = 0;\n'],
  ['src/feature-a.ts',
    "import { clamp } from './util';\n" +
    'export function featureA(x: number): number {\n' +
    '  return clamp(x, 0, 10);\n' +
    '}\n'],
  ['src/feature-b.ts',
    "import { clamp, ZERO } from './util';\n" +
    'export class FeatureB {\n' +
    '  run(x: number): number { return clamp(x, ZERO, 100); }\n' +
    '}\n'],
  ['src/entry.ts',
    "import { featureA } from './feature-a';\n" +
    "import { FeatureB } from './feature-b';\n" +
    'export const main = (n: number): number => featureA(n) + new FeatureB().run(n);\n'],
  ['src/standalone.ts',
    'export const UNRELATED = 42;\n'],
]);

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-e2e',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [...PROJECT.keys()],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'e2ehash',
  fileCount: PROJECT.size,
  totalBytes: 1000,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

describe('P6-I1 Code Intelligence E2E', () => {
  let adapter: TreeSitterAdapter;
  let extractor: SymbolExtractor;
  let graphBuilder: ImportGraphBuilder;

  beforeAll(async () => {
    adapter = new TreeSitterAdapter();
    await adapter.initialize();
    extractor = new SymbolExtractor(adapter);
    graphBuilder = new ImportGraphBuilder(adapter);
  });

  it('TS1: parses every TS file in the project', async () => {
    for (const [path, content] of PROJECT) {
      const tree = await adapter.parse(path, content, 'typescript');
      expect(tree.root.type).toBe('program');
      expect(tree.root.namedChildren.length).toBeGreaterThan(0);
    }
  });

  it('SX1: extracts the expected symbols from a real file', async () => {
    // SX1 extracts functions/classes/interfaces/types/enums/arrow-consts. A plain
    // value binding (export const ZERO = 0) is intentionally NOT a symbol kind in
    // the current query set, so we assert the function is captured and exported.
    const syms = await extractor.extract(PROJECT.get('src/util.ts')!, 'typescript');
    const names = syms.map((s) => s.name);
    expect(names).toContain('clamp');
    expect(syms.find((s) => s.name === 'clamp')?.exported).toBe(true);

    // The class in feature-b is captured as a 'class' symbol.
    const bSyms = await extractor.extract(PROJECT.get('src/feature-b.ts')!, 'typescript');
    expect(bSyms.find((s) => s.name === 'FeatureB')?.kind).toBe('class');
  });

  it('IG1: builds correct import edges for the project', async () => {
    const graph = await graphBuilder.build({ files: PROJECT });
    expect([...(graph.edges.get('src/feature-a.ts') ?? [])]).toEqual(['src/util.ts']);
    expect([...(graph.edges.get('src/feature-b.ts') ?? [])]).toEqual(['src/util.ts']);
    expect([...(graph.edges.get('src/entry.ts') ?? [])].sort())
      .toEqual(['src/feature-a.ts', 'src/feature-b.ts']);
    // standalone imports nothing local.
    expect([...(graph.edges.get('src/standalone.ts') ?? [])]).toEqual([]);
    // Reverse: util is imported by both features.
    expect([...(graph.reverseEdges.get('src/util.ts') ?? [])].sort())
      .toEqual(['src/feature-a.ts', 'src/feature-b.ts']);
  });

  it('AS1: computes the transitive affected set from one changed file', async () => {
    const graph = await graphBuilder.build({ files: PROJECT });
    // Changing util.ts affects both features and the entry (everything reaching it),
    // but NOT standalone.ts.
    const closure = computeAffectedClosureFromGraph(new Set(['src/util.ts']), graph.reverseEdges);
    expect([...closure].sort()).toEqual([
      'src/entry.ts', 'src/feature-a.ts', 'src/feature-b.ts', 'src/util.ts',
    ]);
    expect(closure.has('src/standalone.ts')).toBe(false);
  });

  it('CR1: retriever surfaces symbols + distance-ranked context for the change', async () => {
    const graph = await graphBuilder.build({ files: PROJECT });

    // Gather symbols across the whole project (SX1 -> CR1 mapping).
    const symbols: RetrievedSymbol[] = [];
    for (const [file, content] of PROJECT) {
      for (const s of await extractor.extract(content, 'typescript')) {
        symbols.push({
          file, name: s.name, kind: s.kind,
          startLine: s.startLine, endLine: s.endLine, exported: s.exported,
        });
      }
    }

    let n = 0;
    const retriever = new Retriever({
      nextId: () => `id-${++n}`,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const items = retriever.retrieve({
      sessionId: 'S',
      workspaceRevision: REVISION,
      buildReason: 'task_execution',
      workspaceFiles: PROJECT,
      changedPaths: ['src/util.ts'],
      symbols,
      importReverseEdges: graph.reverseEdges,
    });

    // Symbols from util (changed) and its affected importers are injected.
    const symItems = items.filter((i) => i.kind === 'symbol_definition');
    const symNames = symItems.map((i) => i.source.symbolName);
    expect(symNames).toContain('clamp');       // util
    expect(symNames).toContain('featureA');    // feature-a (affected)
    expect(symNames).toContain('FeatureB');    // feature-b (affected)
    // All symbol items are untrusted (CX-003) with provenance (CX-002).
    for (const s of symItems) {
      expect(s.trust).toBe('untrusted');
      expect(s.source.kind).toBe('workspace_symbol');
      expect(s.provenance.provenanceId.length).toBeGreaterThan(0);
    }

    // Distance ranking: features (import util, distance 1) rank above entry (distance 2),
    // and standalone (unrelated) ranks below both.
    const fileItems = items.filter((i) => i.kind === 'file_full');
    const prio = (p: string): number =>
      fileItems.find((i) => i.source.path === p)?.priority ?? -1;
    expect(prio('src/feature-a.ts')).toBeGreaterThan(prio('src/entry.ts'));
    expect(prio('src/entry.ts')).toBeGreaterThan(prio('src/standalone.ts'));
  });

  it('VR-004: real closure promotes final-graph scope AFFECTED_DIRECT -> AFFECTED_CLOSURE', async () => {
    const graph = await graphBuilder.build({ files: PROJECT });
    const closure = computeAffectedClosureFromGraph(new Set(['src/util.ts']), graph.reverseEdges);

    // Final graph verification must be at least AFFECTED_CLOSURE (VR-004).
    const scope = computeScope({
      policy: DEFAULT_VERIFICATION_POLICY,   // minimumScope = AFFECTED_DIRECT
      affectedClosureSize: closure.size,     // real AS1 output (4)
      totalTestablePaths: PROJECT.size,      // 5
      isFinalGraph: true,
    });
    // 4/5 = 0.8 > 0.5 threshold → promotes all the way to FULL (still ≥ CLOSURE).
    expect(SCOPE_LATTICE[scope]).toBeGreaterThanOrEqual(SCOPE_LATTICE['AFFECTED_CLOSURE']);

    // With a small closure under threshold, final-graph still lands on AFFECTED_CLOSURE.
    const smallScope = computeScope({
      policy: DEFAULT_VERIFICATION_POLICY,
      affectedClosureSize: 1,
      totalTestablePaths: 100,
      isFinalGraph: true,
    });
    expect(smallScope).toBe('AFFECTED_CLOSURE');
  });

  it('determinism: the whole chain yields identical results across runs', async () => {
    const run = async () => {
      const graph = await graphBuilder.build({ files: PROJECT });
      const closure = computeAffectedClosureFromGraph(new Set(['src/util.ts']), graph.reverseEdges);
      return [...closure].sort().join(',');
    };
    expect(await run()).toBe(await run());
  });
});
