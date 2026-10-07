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
});
