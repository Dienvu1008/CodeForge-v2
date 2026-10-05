// P6-IG1 — ImportGraphBuilder.
// Verifies import-graph construction + relative specifier resolution on TS/JS.
import { describe, it, expect, beforeAll } from 'vitest';
import { TreeSitterAdapter, ImportGraphBuilder } from '@codeforge/infrastructure';

let adapter: TreeSitterAdapter;
let builder: ImportGraphBuilder;

beforeAll(async () => {
  adapter = new TreeSitterAdapter();
  await adapter.initialize();
  builder = new ImportGraphBuilder(adapter);
});

/** Convenience: build from a plain object of relpath -> content. */
async function buildFrom(files: Record<string, string>) {
  return builder.build({ files: new Map(Object.entries(files)) });
}

describe('P6-IG1 ImportGraphBuilder — resolution', () => {
  it('resolves a relative import with explicit extension', async () => {
    const g = await buildFrom({
      'src/a.ts': "import { b } from './b.ts';",
      'src/b.ts': 'export const b = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });

  it('resolves a relative import without extension (tries .ts)', async () => {
    const g = await buildFrom({
      'src/a.ts': "import { b } from './b';",
      'src/b.ts': 'export const b = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });

  it('resolves a parent-directory import', async () => {
    const g = await buildFrom({
      'src/feature/a.ts': "import { u } from '../util';",
      'src/util.ts': 'export const u = 1;',
    });
    expect([...(g.edges.get('src/feature/a.ts') ?? [])]).toEqual(['src/util.ts']);
  });

  it('resolves a directory import to its index file', async () => {
    const g = await buildFrom({
      'src/a.ts': "import { x } from './lib';",
      'src/lib/index.ts': 'export const x = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/lib/index.ts']);
  });

  it('resolves require() calls', async () => {
    const g = await buildFrom({
      'src/a.js': "const b = require('./b');",
      'src/b.js': 'module.exports = {};',
    });
    expect([...(g.edges.get('src/a.js') ?? [])]).toEqual(['src/b.js']);
  });

  it('resolves dynamic import() calls', async () => {
    const g = await buildFrom({
      'src/a.ts': "const b = () => import('./b');",
      'src/b.ts': 'export const b = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });

  it('resolves re-export (export ... from)', async () => {
    const g = await buildFrom({
      'src/a.ts': "export { b } from './b';",
      'src/b.ts': 'export const b = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });

  it('resolves star re-export (export * from)', async () => {
    const g = await buildFrom({
      'src/a.ts': "export * from './b';",
      'src/b.ts': 'export const b = 1;',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });

  it('prefers .ts over .js when both exist', async () => {
    const g = await buildFrom({
      'src/a.ts': "import './b';",
      'src/b.ts': 'export const b = 1;',
      'src/b.js': 'module.exports = {};',
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
  });
});

describe('P6-IG1 ImportGraphBuilder — exclusion & diagnostics', () => {
  it('does not create an edge for bare/package specifiers', async () => {
    const g = await buildFrom({
      'src/a.ts': "import React from 'react';\nimport { readFile } from 'node:fs';",
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual([]);
    // Bare specifiers still appear in allEdges as unresolved.
    const unresolved = g.allEdges.filter((e) => e.from === 'src/a.ts' && e.to === null);
    expect(unresolved.map((e) => e.specifier).sort()).toEqual(['node:fs', 'react']);
  });

  it('records an unresolved edge when the target file is not in the set', async () => {
    const g = await buildFrom({
      'src/a.ts': "import './missing';",
    });
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual([]);
    expect(g.allEdges).toContainEqual({ from: 'src/a.ts', specifier: './missing', to: null });
  });

  it('does not resolve an import that escapes the project root', async () => {
    const g = await buildFrom({
      'a.ts': "import '../outside';",
    });
    expect([...(g.edges.get('a.ts') ?? [])]).toEqual([]);
  });

  it('includes every known file as a node even with no edges', async () => {
    const g = await buildFrom({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 1;',
    });
    expect(g.edges.has('src/a.ts')).toBe(true);
    expect(g.edges.has('src/b.ts')).toBe(true);
  });

  it('skips files in an unsupported language (Dart) gracefully', async () => {
    const g = await buildFrom({
      'lib/main.dart': "import '../models/user.dart';",
      'lib/app.ts': "import './b';",
      'lib/b.ts': 'export const b = 1;',
    });
    // Dart file yields no edges (grammar unavailable), TS still works.
    expect([...(g.edges.get('lib/main.dart') ?? [])]).toEqual([]);
    expect([...(g.edges.get('lib/app.ts') ?? [])]).toEqual(['lib/b.ts']);
  });
});

describe('P6-IG1 ImportGraphBuilder — reverse edges & resolve()', () => {
  it('builds reverse edges (importers of a file)', async () => {
    const g = await buildFrom({
      'src/a.ts': "import './shared';",
      'src/b.ts': "import './shared';",
      'src/shared.ts': 'export const s = 1;',
    });
    expect([...(g.reverseEdges.get('src/shared.ts') ?? [])].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('resolve() resolves a specifier against the known file set', async () => {
    const g = await buildFrom({
      'src/a.ts': 'export const a = 1;',
      'src/b.ts': 'export const b = 1;',
    });
    expect(g.resolve('src/a.ts', './b')).toBe('src/b.ts');
    expect(g.resolve('src/a.ts', 'react')).toBeNull();
    expect(g.resolve('src/a.ts', './missing')).toBeNull();
  });

  it('builds a multi-file transitive graph correctly', async () => {
    const g = await buildFrom({
      'src/entry.ts': "import './a';\nimport './b';",
      'src/a.ts': "import './c';",
      'src/b.ts': "import './c';",
      'src/c.ts': 'export const c = 1;',
    });
    expect([...(g.edges.get('src/entry.ts') ?? [])].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect([...(g.edges.get('src/a.ts') ?? [])]).toEqual(['src/c.ts']);
    expect([...(g.reverseEdges.get('src/c.ts') ?? [])].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
