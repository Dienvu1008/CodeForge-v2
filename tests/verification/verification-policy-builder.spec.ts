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
