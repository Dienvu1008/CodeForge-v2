// EnvGuard — SECURITY_MODEL §7, P1.5-SE1.
//
// Enforces SE-004 (environment variables must follow an allowlist).
// Subprocesses spawned via ProcessSupervisor receive a filtered SafeEnv, not the
// raw process.env. This prevents secret leakage (SE-005) through env vars.
//
// Design:
//   - allowlist: exact var names always included (e.g. PATH, HOME, LANG).
//   - allowlistPrefixes: vars whose name STARTS WITH one of these are included.
//   - denylistPrefixes: vars that start with these are ALWAYS excluded, even if
//     they matched an allowlist prefix. Denylist takes priority.
//
// Pure + deterministic: no I/O, no side-effects, same input → same output.

import type { SafeEnv } from '../process/process-supervisor.js';

// ── EnvPolicy ─────────────────────────────────────────────────────────────────

export interface EnvPolicy {
  /** Exact variable names that are always allowed through. */
  readonly allowlist: readonly string[];
  /** Variable name prefixes whose vars are allowed (case-sensitive). */
  readonly allowlistPrefixes: readonly string[];
  /**
   * Prefixes that are always denied, even if they match an allowlist.
   * Denylist wins over allowlist (SECURITY_MODEL §7.1 "always excluded").
   */
  readonly denylistPrefixes: readonly string[];
}

/**
 * Default production policy (SECURITY_MODEL §7.1/§7.2).
 * Allows common runtime vars; blocks all known secret/credential prefixes.
 */
export const DEFAULT_ENV_POLICY: EnvPolicy = {
  allowlist: [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'PWD',
    'OLDPWD',
    'COLORTERM',
    'NO_COLOR',
    'FORCE_COLOR',
    'NODE_ENV',
    'NODE_PATH',
    'npm_config_cache',
  ],
  allowlistPrefixes: [
    'LANG',  // LANG, LANGUAGE, LC_*
    'LC_',
    'XDG_',  // XDG_RUNTIME_DIR etc.
  ],
  denylistPrefixes: [
    // Cloud provider credentials.
    'AWS_',
    'GCP_',
    'AZURE_',
    'GOOGLE_',
    // Token-style credentials.
    'GITHUB_TOKEN',
    'GITHUB_',
    'GITLAB_TOKEN',
    'GITLAB_',
    'NPM_TOKEN',
    'PYPI_TOKEN',
    'CARGO_',
    'SSH_',
    // Kubernetes / container orchestration.
    'KUBECONFIG',
    'KUBE_',
    'KUBERNETES_',
    // Database / message queue connection strings.
    'DATABASE_URL',
    'DB_',
    'REDIS_',
    'MONGO_',
    'POSTGRES_',
    'MYSQL_',
    // Generic secret patterns.
    'SECRET',
    'PASSWORD',
    'PASSWD',
    'TOKEN',
    'API_KEY',
    'PRIVATE_KEY',
    'SIGNING_KEY',
    'ENCRYPTION_KEY',
    // Ollama (never pass to subprocesses).
    'OLLAMA_',
  ],
};

/**
 * Minimal policy for test doubles: allows nothing except PATH.
 * Useful when you need a safe empty-ish env for unit tests.
 */
export const MINIMAL_ENV_POLICY: EnvPolicy = {
  allowlist: ['PATH'],
  allowlistPrefixes: [],
  denylistPrefixes: [],
};

// ── FilterResult ──────────────────────────────────────────────────────────────

export interface FilterResult {
  /** The filtered environment safe to pass to a subprocess. */
  readonly env: SafeEnv;
  /** Names of variables that were removed by the denylist (for audit logging). */
  readonly denied: readonly string[];
  /** Names of variables that passed the allowlist. */
  readonly allowed: readonly string[];
}

// ── filterEnv ─────────────────────────────────────────────────────────────────

/**
 * Filter a raw environment map through the policy.
 *
 * Algorithm (SE-004):
 *   1. For each key: if it matches any denylist prefix → deny (denylist wins).
 *   2. If the key is in the allowlist OR starts with an allowlist prefix → allow.
 *   3. Otherwise → deny (default-deny).
 *
 * Returns a FilterResult with the safe env + audit lists.
 */
export function filterEnv(
  rawEnv: Readonly<Record<string, string | undefined>>,
  policy: EnvPolicy = DEFAULT_ENV_POLICY,
): FilterResult {
  const env: Record<string, string> = {};
  const denied: string[] = [];
  const allowed: string[] = [];

  for (const [key, value] of Object.entries(rawEnv)) {
    if (value === undefined) continue;

    // Denylist wins (SECURITY_MODEL §7.1 "always excluded").
    if (isDenied(key, policy.denylistPrefixes)) {
      denied.push(key);
      continue;
    }

    // Exact allowlist.
    if ((policy.allowlist as readonly string[]).includes(key)) {
      env[key] = value;
      allowed.push(key);
      continue;
    }

    // Prefix allowlist.
    if (isAllowedByPrefix(key, policy.allowlistPrefixes)) {
      env[key] = value;
      allowed.push(key);
      continue;
    }

    // Default-deny.
    denied.push(key);
  }

  return { env, denied, allowed };
}

/**
 * Convenience wrapper: returns only the SafeEnv (drops the audit lists).
 * Use `filterEnv` when you need to log the denied variables.
 */
export function safeEnv(
  rawEnv: Readonly<Record<string, string | undefined>>,
  policy: EnvPolicy = DEFAULT_ENV_POLICY,
): SafeEnv {
  return filterEnv(rawEnv, policy).env;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isDenied(key: string, denylistPrefixes: readonly string[]): boolean {
  const upper = key.toUpperCase();
  return denylistPrefixes.some((prefix) => upper.startsWith(prefix.toUpperCase()));
}

function isAllowedByPrefix(key: string, allowlistPrefixes: readonly string[]): boolean {
  return allowlistPrefixes.some((prefix) => key.startsWith(prefix));
}

// ── EnvGuard class (stateful wrapper for easier testing) ─────────────────────

/**
 * Stateful EnvGuard: holds a policy and exposes filter/audit methods.
 * Prefer the pure functions `filterEnv` / `safeEnv` in production code.
 * This class is useful when you need to inject a policy via DI.
 */
export class EnvGuard {
  constructor(private readonly policy: EnvPolicy = DEFAULT_ENV_POLICY) {}

  filter(rawEnv: Readonly<Record<string, string | undefined>>): FilterResult {
    return filterEnv(rawEnv, this.policy);
  }

  safe(rawEnv: Readonly<Record<string, string | undefined>>): SafeEnv {
    return safeEnv(rawEnv, this.policy);
  }

  /** True if `key` would be denied by this policy. */
  isDenied(key: string): boolean {
    return isDenied(key, this.policy.denylistPrefixes);
  }
}
