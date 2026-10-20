// ProjectInspector (P10.1) — detects ProjectSignals from a workspace on disk, so the
// pure buildVerificationPolicy() can derive real build/test/lint checks. This is the I/O
// side (infrastructure); the policy logic stays pure in agent-core.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectSignals } from '@codeforge/agent-core';

/**
 * Inspect a workspace root and return the signals the VerificationPolicyBuilder needs.
 * Reads package.json (scripts) and checks for tsconfig.json. Never throws — a malformed
 * or missing package.json yields empty signals (the builder then produces no checks and
 * the CompletionGate refuses PASSED, which is the safe outcome).
 */
export function inspectProject(workspaceRoot: string, timeoutMs?: number): ProjectSignals {
  const has = (rel: string): boolean => existsSync(join(workspaceRoot, rel));
  const pkgPath = join(workspaceRoot, 'package.json');
  const hasPackageJson = has('package.json');
  const hasTsconfig = has('tsconfig.json');

  let packageScripts: string[] = [];
  if (hasPackageJson) {
    try {
      const raw = readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      if (pkg.scripts !== null && typeof pkg.scripts === 'object') {
        packageScripts = Object.keys(pkg.scripts).filter((k) => typeof pkg.scripts![k] === 'string');
      }
    } catch {
      // Malformed package.json → treat as no scripts (safe).
      packageScripts = [];
    }
  }

  // ── P12.25: multi-language manifests ────────────────────────────────────────
  // Dart/Flutter: pubspec.yaml; a Flutter project declares `flutter:` under dependencies.
  const hasPubspec = has('pubspec.yaml');
  let isFlutter = false;
  if (hasPubspec) {
    try {
      const pub = readFileSync(join(workspaceRoot, 'pubspec.yaml'), 'utf8');
      // A Flutter app/plugin references the flutter SDK. Match `  flutter:` or `sdk: flutter`.
      isFlutter = /(^|\n)\s*flutter\s*:/.test(pub) || /sdk:\s*flutter/.test(pub);
    } catch { isFlutter = false; }
  }

  // Python markers (any one is enough). pytest when a pytest config or a tests/ dir exists.
  const hasPython = has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('Pipfile');
  let hasPytest = has('pytest.ini') || has('tox.ini') || has('tests') || has('test');
  if (!hasPytest && has('pyproject.toml')) {
    try { hasPytest = /\[tool\.pytest/.test(readFileSync(join(workspaceRoot, 'pyproject.toml'), 'utf8')); }
    catch { /* leave as-is */ }
  }

  return {
    hasPackageJson,
    packageScripts,
    hasTsconfig,
    hasPubspec,
    isFlutter,
    hasCargoToml: has('Cargo.toml'),
    hasGoMod: has('go.mod'),
    hasPython,
    hasPytest,
    hasCMake: has('CMakeLists.txt'),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
