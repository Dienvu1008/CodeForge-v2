// P10.3 — ContextCollector: workspace → plain-data context signals.
//
// Verifies the "last mile" that feeds agent-core's pure Retriever/ContextBuilder:
//   - reads source files, skipping noise dirs (node_modules, .codeforge, dist, .git);
//   - extracts symbols (SymbolExtractor over tree-sitter WASM);
//   - builds the import reverse-edge graph (ImportGraphBuilder);
//   - canonicalizes paths to '/'-separated project-relative form;
//   - never throws (degrades gracefully).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ContextCollector } from '@codeforge/infrastructure';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-ctx-'));
  // util.ts exports add(); math.ts imports util and exports sum(); main.ts imports math.
  await writeFile(join(root, 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n', 'utf8');
  await writeFile(join(root, 'math.ts'), "import { add } from './util';\nexport function sum(xs: number[]): number {\n  return xs.reduce((a, b) => add(a, b), 0);\n}\n", 'utf8');
  await writeFile(join(root, 'main.ts'), "import { sum } from './math';\nconsole.log(sum([1, 2, 3]));\n", 'utf8');
  // Noise that must be excluded.
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await mkdir(join(root, '.codeforge'), { recursive: true });
  await writeFile(join(root, '.codeforge', 'runtime.db'), 'BINARY\u0000DB', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('P10.3 ContextCollector', () => {
  it('collects source files and excludes node_modules + .codeforge', async () => {
    const collector = new ContextCollector({ workspaceRoot: root });
    const result = await collector.collect();

    const paths = [...result.workspaceFiles.keys()].sort();
    expect(paths).toEqual(['main.ts', 'math.ts', 'util.ts']);
    // Excluded noise.
    expect([...result.workspaceFiles.keys()].some((p) => p.includes('node_modules'))).toBe(false);
    expect([...result.workspaceFiles.keys()].some((p) => p.includes('.codeforge'))).toBe(false);
    // Canonical '/'-separated paths.
    expect(result.workspaceFiles.get('util.ts')).toContain('export function add');
  });

  it('extracts symbols tagged with their file (tree-sitter)', async () => {
    const collector = new ContextCollector({ workspaceRoot: root });
    const result = await collector.collect();

    const byName = new Map(result.symbols.map((s) => [s.name, s]));
    expect(byName.has('add')).toBe(true);
    expect(byName.has('sum')).toBe(true);
    expect(byName.get('add')?.file).toBe('util.ts');
    expect(byName.get('sum')?.file).toBe('math.ts');
    expect(byName.get('add')?.exported).toBe(true);
  });

  it('builds import reverse edges (util imported by math, math by main)', async () => {
    const collector = new ContextCollector({ workspaceRoot: root });
    const result = await collector.collect();

    // util.ts is imported by math.ts.
    const utilImporters = result.importReverseEdges.get('util.ts');
    expect(utilImporters).toBeDefined();
    expect([...(utilImporters ?? [])]).toContain('math.ts');
    // math.ts is imported by main.ts.
    const mathImporters = result.importReverseEdges.get('math.ts');
    expect([...(mathImporters ?? [])]).toContain('main.ts');
  });

  it('respects maxFiles cap', async () => {
    const collector = new ContextCollector({ workspaceRoot: root, maxFiles: 2 });
    const result = await collector.collect();
    expect(result.workspaceFiles.size).toBeLessThanOrEqual(2);
  });

  it('does not throw on a non-existent workspace (graceful)', async () => {
    const collector = new ContextCollector({ workspaceRoot: join(root, 'does-not-exist') });
    const result = await collector.collect();
    expect(result.workspaceFiles.size).toBe(0);
    expect(result.symbols).toEqual([]);
  });

  // ── P12.7: a ContextPlan bounds per-call collection ──────────────────────────

  it('a narrow (non-repository) plan tightens the file cap for that call', async () => {
    // Add more files so an unbounded collect would read > the narrow cap.
    for (let i = 0; i < 8; i++) {
      await writeFile(join(root, `extra${i}.ts`), `export const v${i} = ${i};\n`, 'utf8');
    }
    const collector = new ContextCollector({ workspaceRoot: root });
    // Narrow TASK plan: maxFiles 2 → cap ≈ max(4, 2*3)=6 files for this call.
    const narrow = await collector.collect([], { scope: 'TASK', maxFiles: 2, repositoryWide: false });
    expect(narrow.workspaceFiles.size).toBeLessThanOrEqual(6);
    // A repositoryWide plan reads broadly (all 11 source files here).
    const wide = await collector.collect([], { scope: 'REPOSITORY', maxFiles: 150, repositoryWide: true });
    expect(wide.workspaceFiles.size).toBeGreaterThan(narrow.workspaceFiles.size);
  });

  it('no plan keeps the instance default caps (unchanged behavior)', async () => {
    const collector = new ContextCollector({ workspaceRoot: root });
    const a = await collector.collect();            // no plan
    const b = await collector.collect([], undefined); // explicit undefined plan
    expect(a.workspaceFiles.size).toBe(b.workspaceFiles.size);
    expect(a.workspaceFiles.size).toBeGreaterThanOrEqual(3); // the 3 seed files at least
  });

  // ── P12.17: optional LSP augmentation of the reverse-edge graph ───────────────

  // A minimal fake LspPool: forFile() returns an adapter whose references() reports that the
  // given symbol is referenced from `refFromRel`. Enough to exercise the merge without a server.
  function fakePool(refFromRel: string, root: string): import('@codeforge/infrastructure').LspPool {
    const adapter = {
      languageId: 'typescript',
      async documentSymbol(): Promise<{ name: string; kind: number; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[]> {
        return [{ name: 'add', kind: 12, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }];
      },
      async references(): Promise<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[]> {
        return [{ uri: pathToFileURL(join(root, refFromRel)).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
      },
    };
    return { async forFile() { return adapter; }, supports() { return true; }, async stopAll() {} } as unknown as import('@codeforge/infrastructure').LspPool;
  }

  it('augments reverse edges with LSP references for a changed file', async () => {
    // Baseline (no LSP): util.ts reverse edges come only from the import graph → {math.ts}.
    const base = await new ContextCollector({ workspaceRoot: root }).collect(['util.ts']);
    expect([...(base.importReverseEdges.get('util.ts') ?? [])].sort()).toEqual(['math.ts']);

    // With a fake pool reporting that main.ts references util.ts's `add`, main.ts is added as a
    // reverse-edge neighbour — the kind of cross-file precision the import graph alone misses.
    const withLsp = new ContextCollector({ workspaceRoot: root, lspPool: fakePool('main.ts', root) });
    const r = await withLsp.collect(['util.ts']);
    const neighbours = [...(r.importReverseEdges.get('util.ts') ?? [])].sort();
    expect(neighbours).toContain('math.ts'); // tree-sitter edge preserved (additive, never removed)
    expect(neighbours).toContain('main.ts'); // LSP reference edge added
  });

  it('LSP augmentation only runs for changed files (no changed set → unchanged)', async () => {
    const withLsp = new ContextCollector({ workspaceRoot: root, lspPool: fakePool('main.ts', root) });
    const r = await withLsp.collect([]); // no changed paths → augmentation skipped
    expect([...(r.importReverseEdges.get('util.ts') ?? [])].sort()).toEqual(['math.ts']);
  });

  it('degrades silently when the pool has no server for the file (forFile → null)', async () => {
    const nullPool = { async forFile() { return null; }, supports() { return false; }, async stopAll() {} } as unknown as import('@codeforge/infrastructure').LspPool;
    const withLsp = new ContextCollector({ workspaceRoot: root, lspPool: nullPool });
    const r = await withLsp.collect(['util.ts']);
    // Identical to the tree-sitter-only edges.
    expect([...(r.importReverseEdges.get('util.ts') ?? [])].sort()).toEqual(['math.ts']);
  });

  it('a throwing pool never breaks collect() (graceful)', async () => {
    const throwingPool = { async forFile() { throw new Error('boom'); }, supports() { return true; }, async stopAll() {} } as unknown as import('@codeforge/infrastructure').LspPool;
    const withLsp = new ContextCollector({ workspaceRoot: root, lspPool: throwingPool });
    const r = await withLsp.collect(['util.ts']);
    expect(r.workspaceFiles.size).toBeGreaterThanOrEqual(3);
    expect([...(r.importReverseEdges.get('util.ts') ?? [])]).toContain('math.ts');
  });
});
