// P6-AS1 — computeAffectedClosureFromGraph.
// Real transitive affected closure over an import graph's reverse edges (§4.4).
import { describe, it, expect, beforeAll } from 'vitest';
import { computeAffectedClosureFromGraph } from '@codeforge/agent-core';
import { TreeSitterAdapter, ImportGraphBuilder } from '@codeforge/infrastructure';

/** Build a reverse-edge map from a plain object of file -> importers. */
function reverse(obj: Record<string, string[]>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [file, importers] of Object.entries(obj)) {
    m.set(file, new Set(importers));
  }
  return m;
}

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

describe('P6-AS1 computeAffectedClosureFromGraph — unit', () => {
  it('returns the direct set itself when nothing imports it', () => {
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts']), reverse({}));
    expect(sorted(closure)).toEqual(['src/a.ts']);
  });

  it('includes direct importers (1 hop)', () => {
    // b imports a  =>  reverseEdges[a] = {b}
    const rev = reverse({ 'src/a.ts': ['src/b.ts'] });
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('walks transitively (multi-hop)', () => {
    // c imports b, b imports a
    const rev = reverse({
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/c.ts'],
    });
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('handles diamond dependencies without duplication', () => {
    // b and c both import a; d imports both b and c
    const rev = reverse({
      'src/a.ts': ['src/b.ts', 'src/c.ts'],
      'src/b.ts': ['src/d.ts'],
      'src/c.ts': ['src/d.ts'],
    });
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('terminates on cycles (a <-> b)', () => {
    const rev = reverse({
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
    });
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('includes all seeds and their closures when direct set has several files', () => {
    const rev = reverse({
      'src/a.ts': ['src/x.ts'],
      'src/b.ts': ['src/y.ts'],
    });
    const closure = computeAffectedClosureFromGraph(new Set(['src/a.ts', 'src/b.ts']), rev);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts', 'src/x.ts', 'src/y.ts']);
  });

  it('is deterministic regardless of Set insertion order (VR-010)', () => {
    const rev1 = reverse({ 'src/a.ts': ['src/b.ts', 'src/c.ts'] });
    const rev2 = reverse({ 'src/a.ts': ['src/c.ts', 'src/b.ts'] }); // different insertion order
    const c1 = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev1);
    const c2 = computeAffectedClosureFromGraph(new Set(['src/a.ts']), rev2);
    expect(sorted(c1)).toEqual(sorted(c2));
  });

  it('returns an empty set for an empty direct set', () => {
    const closure = computeAffectedClosureFromGraph(new Set(), reverse({ 'src/a.ts': ['src/b.ts'] }));
    expect(sorted(closure)).toEqual([]);
  });

  it('ignores affected files absent from the graph (no importers)', () => {
    const rev = reverse({ 'src/other.ts': ['src/z.ts'] });
    const closure = computeAffectedClosureFromGraph(new Set(['src/lonely.ts']), rev);
    expect(sorted(closure)).toEqual(['src/lonely.ts']);
  });
});

describe('P6-AS1 — integration with ImportGraphBuilder (IG1 + AS1)', () => {
  let builder: ImportGraphBuilder;

  beforeAll(async () => {
    const adapter = new TreeSitterAdapter();
    await adapter.initialize();
    builder = new ImportGraphBuilder(adapter);
  });

  it('computes the real closure from a graph built out of TS sources', async () => {
    // Dependency shape:
    //   entry.ts -> a.ts -> util.ts
    //   b.ts     -> util.ts
    // Changing util.ts should affect util, a, b, entry (everything that reaches it).
    const graph = await builder.build({
      files: new Map([
        ['src/entry.ts', "import './a';"],
        ['src/a.ts', "import './util';"],
        ['src/b.ts', "import './util';"],
        ['src/util.ts', 'export const u = 1;'],
      ]),
    });

    const closure = computeAffectedClosureFromGraph(new Set(['src/util.ts']), graph.reverseEdges);
    expect(sorted(closure)).toEqual(['src/a.ts', 'src/b.ts', 'src/entry.ts', 'src/util.ts']);
  });

  it('a leaf change affects only itself when nothing imports it', async () => {
    const graph = await builder.build({
      files: new Map([
        ['src/entry.ts', "import './a';"],
        ['src/a.ts', 'export const a = 1;'],
        ['src/orphan.ts', 'export const o = 1;'],
      ]),
    });
    // entry.ts is imported by no one -> changing it affects only entry.ts.
    const closure = computeAffectedClosureFromGraph(new Set(['src/entry.ts']), graph.reverseEdges);
    expect(sorted(closure)).toEqual(['src/entry.ts']);
  });
});
