// VerificationPolicyBuilder (P10.1) — pure, deterministic construction of a real
// VerificationPolicy from plain-data ProjectSignals. This is what turns "task PASSED
// without running anything" into "task PASSED only when build/test/lint are green"
// (TI-005). No I/O here — an infrastructure ProjectInspector detects the signals from
// disk and feeds them in.
//
// Commands are LOGICAL (e.g. command='npm', args=['run','build']). Because the
// VerificationEngine spawns with shell:false, the runtime-side process adapter is
// responsible for (a) resolving the executable on the platform (npm -> npm.cmd on
// Windows) and (b) injecting a minimal env (PATH) + the workspace cwd. The builder
// stays platform-agnostic and pure so it is trivially testable.
import type { VerificationPolicy, CheckDefinition } from './verification-policy.js';

// ── ProjectSignals (plain data — detected by infra, consumed here) ──────────────

export interface ProjectSignals {
  /** A package.json exists at the workspace root. */
  readonly hasPackageJson: boolean;
  /** Script names present in package.json (e.g. ['build','test','lint']). */
  readonly packageScripts: readonly string[];
  /** A tsconfig.json exists at the workspace root. */
  readonly hasTsconfig: boolean;
  /** Default per-check timeout (ms). Default 180_000 (3 min). */
  readonly timeoutMs?: number;
}

// ── buildVerificationPolicy ─────────────────────────────────────────────────────

/**
 * Build a VerificationPolicy with real checks derived from the project. Pure + total:
 * same signals → same policy. Checks are ordered build → typecheck → lint → test so a
 * cheap compile failure fails fast before the (slower) test suite.
 *
 * If NO checks can be derived (empty project), returns a policy with an empty check
 * list — the CompletionGate will then refuse PASSED (0 checks never passes, the
 * adversarial guard), so an un-verifiable task is never silently marked done.
 */
export function buildVerificationPolicy(signals: ProjectSignals): VerificationPolicy {
  const timeoutMs = signals.timeoutMs ?? 180_000;
  const scripts = new Set(signals.packageScripts);
  const checks: CheckDefinition[] = [];

  const addNpmScript = (script: string, name: string, kind: CheckDefinition['kind']): void => {
    if (signals.hasPackageJson && scripts.has(script)) {
      checks.push({
        name,
        kind,
        command: 'npm',
        args: ['run', script, '--silent'],
        minScope: 'SMOKE', // run at every scope — never skipped by scope filtering
        timeoutMs,
      });
    }
  };

  // 1. build (compile) — fail fast on a broken build before anything else.
  addNpmScript('build', 'npm run build', 'build');

  // 2. typecheck — prefer an explicit script; else fall back to `npx tsc --noEmit`
  //    when a tsconfig exists (common even without a typecheck script).
  if (signals.hasPackageJson && scripts.has('typecheck')) {
    addNpmScript('typecheck', 'npm run typecheck', 'typecheck');
  } else if (signals.hasTsconfig) {
    checks.push({
      name: 'tsc --noEmit',
      kind: 'typecheck',
      command: 'npx',
      args: ['tsc', '--noEmit'],
      minScope: 'SMOKE',
      timeoutMs,
    });
  }

  // 3. lint
  addNpmScript('lint', 'npm run lint', 'lint');

  // 4. test — the authoritative "does it work" check, last (slowest).
  addNpmScript('test', 'npm test', 'test');

  return {
    policyId: 'project-derived-v1',
    version: 1,
    minimumScope: 'AFFECTED_DIRECT',
    requiredScope: 'AFFECTED_DIRECT',
    checks,
    scratchZones: [],
    failFast: true, // cheap build/typecheck failures stop before the test suite
    affectedClosureThreshold: 0.5,
    toolVersions: {},
    schemaVersion: 1,
  };
}
