// P10.1 — buildVerificationPolicy: derive real checks from project signals.
import { describe, it, expect } from 'vitest';
import { buildVerificationPolicy, type ProjectSignals } from '@codeforge/agent-core';

function signals(over: Partial<ProjectSignals> = {}): ProjectSignals {
  return { hasPackageJson: true, packageScripts: [], hasTsconfig: false, ...over };
}

describe('P10.1 buildVerificationPolicy — check derivation', () => {
  it('derives build / typecheck / lint / test from package scripts in order', () => {
    const p = buildVerificationPolicy(signals({ packageScripts: ['build', 'typecheck', 'lint', 'test'] }));
    expect(p.checks.map((c) => c.kind)).toEqual(['build', 'typecheck', 'lint', 'test']);
    expect(p.checks.map((c) => c.name)).toEqual([
      'npm run build', 'npm run typecheck', 'npm run lint', 'npm test',
    ]);
    // npm scripts spawn `npm run <script> --silent` (or `npm test`).
    expect(p.checks[0]).toMatchObject({ command: 'npm', args: ['run', 'build', '--silent'] });
    expect(p.checks[3]).toMatchObject({ command: 'npm', args: ['run', 'test', '--silent'] });
  });

  it('falls back to npx tsc --noEmit when a tsconfig exists but no typecheck script', () => {
    const p = buildVerificationPolicy(signals({ packageScripts: ['build'], hasTsconfig: true }));
    const tc = p.checks.find((c) => c.kind === 'typecheck');
    expect(tc).toMatchObject({ command: 'npx', args: ['tsc', '--noEmit'] });
  });

  it('prefers an explicit typecheck script over the tsc fallback', () => {
    const p = buildVerificationPolicy(signals({ packageScripts: ['typecheck'], hasTsconfig: true }));
    const typechecks = p.checks.filter((c) => c.kind === 'typecheck');
    expect(typechecks).toHaveLength(1);
    expect(typechecks[0]).toMatchObject({ command: 'npm', args: ['run', 'typecheck', '--silent'] });
  });

  it('all checks have minScope SMOKE so they are never skipped by scope filtering', () => {
    const p = buildVerificationPolicy(signals({ packageScripts: ['build', 'test'] }));
    expect(p.checks.every((c) => c.minScope === 'SMOKE')).toBe(true);
  });

  it('uses the provided timeout, defaulting to 180s', () => {
    expect(buildVerificationPolicy(signals({ packageScripts: ['test'] })).checks[0]!.timeoutMs).toBe(180_000);
    expect(buildVerificationPolicy(signals({ packageScripts: ['test'], timeoutMs: 5000 })).checks[0]!.timeoutMs).toBe(5000);
  });

  it('ignores package scripts when there is no package.json', () => {
    const p = buildVerificationPolicy(signals({ hasPackageJson: false, packageScripts: ['build', 'test'] }));
    expect(p.checks).toEqual([]);
  });

  it('an empty project yields NO checks (CompletionGate then refuses PASSED)', () => {
    const p = buildVerificationPolicy(signals({ hasPackageJson: false, hasTsconfig: false }));
    expect(p.checks).toEqual([]);
    // policy still has required scope + metadata so it is a valid policy object.
    expect(p.requiredScope).toBe('AFFECTED_DIRECT');
  });

  it('failFast is on so a build failure stops before the test suite', () => {
    expect(buildVerificationPolicy(signals({ packageScripts: ['build', 'test'] })).failFast).toBe(true);
  });

  it('is deterministic — same signals yield the same policy', () => {
    const s = signals({ packageScripts: ['build', 'test'], hasTsconfig: true });
    expect(buildVerificationPolicy(s)).toEqual(buildVerificationPolicy(s));
  });

  it('only includes a check when its script is present (partial projects)', () => {
    const p = buildVerificationPolicy(signals({ packageScripts: ['test'] }));
    expect(p.checks.map((c) => c.kind)).toEqual(['test']);
  });
});

describe('P12.25 buildVerificationPolicy — multi-language checks', () => {
  const noJs = (over: Partial<ProjectSignals> = {}): ProjectSignals =>
    signals({ hasPackageJson: false, ...over });

  it('Flutter: flutter analyze + flutter test', () => {
    const p = buildVerificationPolicy(noJs({ hasPubspec: true, isFlutter: true }));
    expect(p.checks.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'flutter analyze', 'flutter test',
    ]);
  });

  it('plain Dart (no flutter): dart analyze + dart test', () => {
    const p = buildVerificationPolicy(noJs({ hasPubspec: true, isFlutter: false }));
    expect(p.checks.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'dart analyze', 'dart test',
    ]);
  });

  it('Rust: cargo build then cargo test', () => {
    const p = buildVerificationPolicy(noJs({ hasCargoToml: true }));
    expect(p.checks.map((c) => c.kind)).toEqual(['build', 'test']);
    expect(p.checks[0]).toMatchObject({ command: 'cargo', args: ['build', '--quiet'] });
  });

  it('Go: go build then go test over ./...', () => {
    const p = buildVerificationPolicy(noJs({ hasGoMod: true }));
    expect(p.checks.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'go build ./...', 'go test ./...',
    ]);
  });

  it('Python: compileall, plus pytest only when available', () => {
    const noPytest = buildVerificationPolicy(noJs({ hasPython: true, hasPytest: false }));
    expect(noPytest.checks.map((c) => c.command)).toEqual(['python']);
    const withPytest = buildVerificationPolicy(noJs({ hasPython: true, hasPytest: true }));
    expect(withPytest.checks.map((c) => c.command)).toEqual(['python', 'pytest']);
  });

  it('C++ (CMake): configure then build', () => {
    const p = buildVerificationPolicy(noJs({ hasCMake: true }));
    expect(p.checks.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'cmake -S . -B build', 'cmake --build build',
    ]);
  });

  it('a mixed workspace derives checks for every detected language', () => {
    const p = buildVerificationPolicy(signals({
      packageScripts: ['test'], hasPubspec: true, isFlutter: true, hasGoMod: true,
    }));
    const cmds = p.checks.map((c) => c.command);
    expect(cmds).toContain('npm');
    expect(cmds).toContain('flutter');
    expect(cmds).toContain('go');
  });

  it('all multi-language checks are SMOKE-scoped and use the default timeout', () => {
    const p = buildVerificationPolicy(noJs({ hasCargoToml: true, timeoutMs: 9000 }));
    expect(p.checks.every((c) => c.minScope === 'SMOKE')).toBe(true);
    expect(p.checks.every((c) => c.timeoutMs === 9000)).toBe(true);
  });

  it('stays empty when no language is detected', () => {
    expect(buildVerificationPolicy(noJs()).checks).toEqual([]);
  });
});
