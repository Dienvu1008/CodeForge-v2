// SA-001 — The kernel shadow-ablation instrument (`@codeforge/testing/shadow-ablation`) is
// measurement-only and unreachable from production.
//
// Production_Surface = `packages/agent-core`, `packages/infrastructure`,
// `packages/vscode-extension` (+ their bundles `dist-cli/codeforge.cjs` and
// `packages/vscode-extension/dist/extension.cjs`). This spec fails WHEN (Requirement 6.3, 12.4):
//   1. a Production_Surface source file imports `@codeforge/testing`, any `shadow-ablation`
//      path, or any module under `packages/testing`;
//   2. a Production_Surface `package.json` declares `@codeforge/testing`;
//   3. a script under `scripts/` other than the Shadow_Runner (`run-shadow-ablation.mjs`) and
//      the Progressive_Runner (`run-progressive.mjs`) references `shadow-ablation`;
//   4. the Progressive_Runner imports anything from `shadow-ablation` other than
//      `RecordingModelGateway` and `writeTraceFile`, or names any other shadow class
//      (importing nothing at all is valid);
//   5. an existing bundle contains a class name exported by the shadow-ablation subpath.
// The dependency-cruiser rule `no-production-to-testing` guards the same direction at the
// module-graph level (Requirement 6.2); this spec is the text-level backstop that also covers
// package manifests, scripts and built bundles.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shadow from '@codeforge/testing/shadow-ablation';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..', '..', '..'); // tests/invariants/shadow -> workspace root

const PRODUCTION_PACKAGES = ['agent-core', 'infrastructure', 'vscode-extension'] as const;
const TESTING_PACKAGE_DIR = join(rootDir, 'packages', 'testing');
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const ALLOWED_SCRIPTS = new Set(['run-shadow-ablation.mjs', 'run-progressive.mjs']);
const PROGRESSIVE_ALLOWED_IMPORTS = new Set(['RecordingModelGateway', 'writeTraceFile']);

/** Recursively lists files under `dir` (skipping node_modules/dist/.git); [] if absent. */
function listFiles(dir: string, filter: (p: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...listFiles(p, filter));
    } else if (filter(p)) {
      out.push(p);
    }
  }
  return out;
}

/** Module specifiers of static/dynamic imports, re-exports and require() calls. */
function moduleSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]+)\1/g;
  for (const m of text.matchAll(re)) specs.push(m[2]!);
  return specs;
}

/** Why `spec` (imported from `file`) is forbidden on the Production_Surface, or null. */
function forbiddenReason(file: string, spec: string): string | null {
  if (spec === '@codeforge/testing' || spec.startsWith('@codeforge/testing/')) {
    return 'imports @codeforge/testing';
  }
  if (spec.includes('shadow-ablation')) return 'imports a shadow-ablation module';
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec);
    if (target === TESTING_PACKAGE_DIR || target.startsWith(TESTING_PACKAGE_DIR + sep)) {
      return 'imports a module under packages/testing';
    }
  }
  return null;
}

/** Class names exported by the shadow-ablation subpath (read from the module at runtime). */
function exportedClassNames(): string[] {
  return Object.entries(shadow)
    .filter(
      ([name, value]) =>
        typeof value === 'function' &&
        /^[A-Z]/.test(name) &&
        /^class\b/.test(Function.prototype.toString.call(value)),
    )
    .map(([name]) => name)
    .sort();
}

const rel = (p: string): string => relative(rootDir, p).split(sep).join('/');
const wordRe = (name: string): RegExp => new RegExp(`\\b${name}\\b`);

describe('SA-001 — shadow-ablation is unreachable from production', () => {
  it('the subpath exports the instrument classes (sanity: the scan below has names to look for)', () => {
    const names = exportedClassNames();
    for (const expected of [
      'RecordingModelGateway',
      'ReplayModelGateway',
      'DecisionLedger',
      'AblationWorkspaceManager',
      'AblationToolGateway',
      'ShadowApprovalCoordinator',
      'AblationToolExecutor',
      'ContainedProcessSupervisor',
      'AblationVerificationEngine',
      'AblationCompletionGate',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('no Production_Surface source file imports @codeforge/testing, shadow-ablation or packages/testing', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const pkg of PRODUCTION_PACKAGES) {
      const srcDir = join(rootDir, 'packages', pkg, 'src');
      for (const file of listFiles(srcDir, (p) => SOURCE_EXT.test(p))) {
        scanned++;
        const text = readFileSync(file, 'utf8');
        for (const spec of moduleSpecifiers(text)) {
          const reason = forbiddenReason(file, spec);
          if (reason) violations.push(`${rel(file)}: ${reason} ('${spec}')`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('no Production_Surface package.json declares @codeforge/testing', () => {
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const violations: string[] = [];
    for (const pkg of PRODUCTION_PACKAGES) {
      const manifestPath = join(rootDir, 'packages', pkg, 'package.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      for (const field of fields) {
        const deps = manifest[field];
        if (deps && typeof deps === 'object' && '@codeforge/testing' in deps) {
          violations.push(`${rel(manifestPath)}: ${field} declares @codeforge/testing`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('only run-shadow-ablation.mjs and run-progressive.mjs under scripts/ reference shadow-ablation', () => {
    const scriptsDir = join(rootDir, 'scripts');
    const offenders = listFiles(scriptsDir, () => true)
      .filter((file) => !(dirname(file) === scriptsDir && ALLOWED_SCRIPTS.has(file.slice(scriptsDir.length + 1))))
      .filter((file) => readFileSync(file, 'utf8').includes('shadow-ablation'))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('run-progressive.mjs imports at most RecordingModelGateway and writeTraceFile from shadow-ablation', () => {
    const file = join(rootDir, 'scripts', 'run-progressive.mjs');
    if (!existsSync(file)) return; // absent runner: nothing to check
    const text = readFileSync(file, 'utf8');

    // Every quoted shadow-ablation specifier must belong to a recognized named-import form.
    const allSpecs = [...text.matchAll(/(['"`])([^'"`\n]*shadow-ablation[^'"`\n]*)\1/g)].length;
    const namedForms = [
      // import { A, B } from '...shadow-ablation...'
      /\bimport\s*\{([^}]*)\}\s*from\s*(['"])[^'"\n]*shadow-ablation[^'"\n]*\2/g,
      // const { A, B } = await import('...shadow-ablation...')
      /\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*(['"`])[^'"`\n]*shadow-ablation[^'"`\n]*\2\s*\)/g,
    ];
    const imported: string[] = [];
    let recognized = 0;
    for (const re of namedForms) {
      for (const m of text.matchAll(re)) {
        recognized++;
        for (const part of m[1]!.split(',')) {
          const name = part.trim().split(/\s+as\s+|\s*:\s*/)[0]!.trim();
          if (name) imported.push(name);
        }
      }
    }
    expect(recognized, 'shadow-ablation must be imported with named bindings only').toBe(allSpecs);
    expect(imported.filter((n) => !PROGRESSIVE_ALLOWED_IMPORTS.has(n))).toEqual([]);

    // No shadow decorator (any other exported class) is referenced by name.
    const decorators = exportedClassNames().filter((n) => n !== 'RecordingModelGateway');
    expect(decorators.filter((n) => wordRe(n).test(text))).toEqual([]);
  });

  it('existing production bundles contain no shadow-ablation class name', () => {
    const names = exportedClassNames();
    expect(names.length).toBeGreaterThan(0);
    const bundles = [
      join(rootDir, 'dist-cli', 'codeforge.cjs'),
      join(rootDir, 'packages', 'vscode-extension', 'dist', 'extension.cjs'),
    ].filter((p) => existsSync(p));
    const violations: string[] = [];
    for (const bundle of bundles) {
      const text = readFileSync(bundle, 'utf8');
      for (const name of names) {
        if (wordRe(name).test(text)) violations.push(`${rel(bundle)} contains ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
