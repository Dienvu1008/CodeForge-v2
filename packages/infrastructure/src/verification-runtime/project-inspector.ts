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
  const pkgPath = join(workspaceRoot, 'package.json');
  const hasPackageJson = existsSync(pkgPath);
  const hasTsconfig = existsSync(join(workspaceRoot, 'tsconfig.json'));

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

  return {
    hasPackageJson,
    packageScripts,
    hasTsconfig,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
