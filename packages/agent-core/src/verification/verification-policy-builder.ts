/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

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

  // ── P12.25: multi-language manifests (each detected by the infra ProjectInspector) ──
  /** pubspec.yaml exists → Dart/Flutter project. */
  readonly hasPubspec?: boolean;
  /** The pubspec declares a Flutter dependency (→ `flutter test` instead of `dart test`). */
  readonly isFlutter?: boolean;
  /** Cargo.toml exists → Rust project. */
  readonly hasCargoToml?: boolean;
  /** go.mod exists → Go module. */
  readonly hasGoMod?: boolean;
  /** A Python project marker exists (pyproject.toml / requirements.txt / setup.py). */
  readonly hasPython?: boolean;
  /** pytest is available/configured (pytest.ini, or [tool.pytest] / tests dir). */
  readonly hasPytest?: boolean;
  /** CMakeLists.txt exists → C++ (CMake) project. */
  readonly hasCMake?: boolean;

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

  // ── P12.25: multi-language checks ──────────────────────────────────────────
  // Commands are LOGICAL; the WorkspaceProcessSupervisor resolves executables per platform
  // (e.g. launches flutter/dart .bat shims via cmd.exe on Windows). Each language orders
  // analyze/typecheck → test so a cheap static failure fails fast before the suite.
  const add = (name: string, kind: CheckDefinition['kind'], command: string, args: string[]): void => {
    checks.push({ name, kind, command, args, minScope: 'SMOKE', timeoutMs });
  };

  // Dart / Flutter
  if (signals.hasPubspec === true) {
    if (signals.isFlutter === true) {
      add('flutter analyze', 'lint', 'flutter', ['analyze']);
      add('flutter test', 'test', 'flutter', ['test']);
    } else {
      add('dart analyze', 'lint', 'dart', ['analyze']);
      add('dart test', 'test', 'dart', ['test']);
    }
  }

  // Rust (Cargo)
  if (signals.hasCargoToml === true) {
    add('cargo build', 'build', 'cargo', ['build', '--quiet']);
    add('cargo test', 'test', 'cargo', ['test', '--quiet']);
  }

  // Go
  if (signals.hasGoMod === true) {
    add('go build', 'build', 'go', ['build', './...']);
    add('go test', 'test', 'go', ['test', './...']);
  }

  // Python — compile-check all modules (cheap) then pytest when available.
  if (signals.hasPython === true) {
    add('python compile', 'build', 'python', ['-m', 'compileall', '-q', '.']);
    if (signals.hasPytest === true) {
      add('pytest', 'test', 'pytest', ['-q']);
    }
  }

  // C++ (CMake) — configure + build. No universal test runner, so build is the gate.
  if (signals.hasCMake === true) {
    add('cmake configure', 'build', 'cmake', ['-S', '.', '-B', 'build']);
    add('cmake build', 'build', 'cmake', ['--build', 'build']);
  }

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
