/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI security configuration (P0 security hardening, design C3) — PURE, fail closed.
//
// `resolveServerSecurityConfig` turns the runtime CLI flags (`--host`, `--auth-token-file`,
// `--allowed-hosts`, `--allowed-origins`) and the `CODEFORGE_AUTH_TOKEN` env var into the options
// HttpTransport needs. The file read is injected, so the function has no I/O of its own. Rules
// (first failing rule wins):
//
//   host absent / empty                                  → 127.0.0.1
//   CODEFORGE_AUTH_TOKEN non-empty AND --auth-token-file → error: one token source only
//   --auth-token-file unreadable                         → error naming the path (never the cause)
//   token file content (trimmed) empty                   → error naming the path
//   token shorter than AUTH_TOKEN_MIN_LENGTH             → error stating the minimum
//   host not loopback and no token                       → error naming the host + token sources
//   --allowed-origins entry `*` / not an http(s) origin  → error naming the entry
//
// No error message ever contains the token or the token file content (Requirement 8.3).
import { isLoopbackAddress, normalizeOrigin } from './http-security.js';

export interface ServerSecurityInput {
  /** `--host` */
  readonly host?: string;
  /** `--auth-token-file` */
  readonly authTokenFile?: string;
  /** `--allowed-hosts a,b` */
  readonly allowedHosts?: string;
  /** `--allowed-origins https://x,https://y` */
  readonly allowedOrigins?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected reader; the real CLI passes `(p) => fs.readFileSync(p, 'utf8')`. */
  readonly readFile: (path: string) => string;
}

export interface ServerSecurityConfig {
  /** Bind address. Default `127.0.0.1`. */
  readonly host: string;
  readonly authToken?: string;
  /** Where the token came from (for the banner; never the value). */
  readonly authTokenSource?: 'env' | 'file';
  /** Extra Host header hostnames (trimmed, no empty entries). */
  readonly allowedHosts: readonly string[];
  /** Normalized http(s) origins allowed cross-origin (no empty entries, no duplicates). */
  readonly allowedOrigins: readonly string[];
  /** `authToken !== undefined`. */
  readonly authRequired: boolean;
}

/** Misconfiguration of the server security flags. The message never contains the token. */
export class ServerSecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerSecurityConfigError';
  }
}

export const AUTH_TOKEN_MIN_LENGTH = 16;

export const DEFAULT_BIND_HOST = '127.0.0.1';

const TOKEN_ENV = 'CODEFORGE_AUTH_TOKEN';

/** Split a comma list, trim entries, drop empty ones. */
function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function checkToken(token: string, source: string): void {
  if (token.length < AUTH_TOKEN_MIN_LENGTH) {
    throw new ServerSecurityConfigError(
      `auth token from ${source} is too short: at least ${AUTH_TOKEN_MIN_LENGTH} characters required`,
    );
  }
  if (/\s/.test(token)) {
    throw new ServerSecurityConfigError(`auth token from ${source} must not contain whitespace`);
  }
}

function resolveToken(input: ServerSecurityInput): { token: string; source: 'env' | 'file' } | undefined {
  const envToken = input.env[TOKEN_ENV];
  const hasEnv = envToken !== undefined && envToken !== '';
  const file = input.authTokenFile;
  const hasFile = file !== undefined && file !== '';

  if (hasEnv && hasFile) {
    throw new ServerSecurityConfigError(
      `use one token source only: set either ${TOKEN_ENV} or --auth-token-file, not both`,
    );
  }

  if (hasFile) {
    let content: string;
    try {
      content = input.readFile(file);
    } catch {
      // The cause text is deliberately dropped: it can quote file content.
      throw new ServerSecurityConfigError(`cannot read auth token file: ${file}`);
    }
    const token = content.trim();
    if (token === '') throw new ServerSecurityConfigError(`auth token file is empty: ${file}`);
    checkToken(token, `--auth-token-file ${file}`);
    return { token, source: 'file' };
  }

  if (hasEnv) {
    const token = envToken.trim();
    checkToken(token, TOKEN_ENV);
    return { token, source: 'env' };
  }
  return undefined;
}

/** Resolve the CLI security flags into a config, or throw `ServerSecurityConfigError`. */
export function resolveServerSecurityConfig(input: ServerSecurityInput): ServerSecurityConfig {
  const rawHost = input.host?.trim() ?? '';
  const host = rawHost === '' ? DEFAULT_BIND_HOST : rawHost;

  const resolved = resolveToken(input);

  if (resolved === undefined && !isLoopbackAddress(host)) {
    throw new ServerSecurityConfigError(
      `--host ${host} requires an auth token (${TOKEN_ENV} or --auth-token-file)`,
    );
  }

  const allowedOrigins: string[] = [];
  for (const entry of splitList(input.allowedOrigins)) {
    const normalized = normalizeOrigin(entry);
    if (normalized === null) {
      throw new ServerSecurityConfigError(
        `--allowed-origins entry is not an http(s) origin: ${entry}`,
      );
    }
    if (!allowedOrigins.includes(normalized)) allowedOrigins.push(normalized);
  }

  const allowedHosts = splitList(input.allowedHosts);

  return resolved === undefined
    ? { host, allowedHosts, allowedOrigins, authRequired: false }
    : {
        host,
        authToken: resolved.token,
        authTokenSource: resolved.source,
        allowedHosts,
        allowedOrigins,
        authRequired: true,
      };
}

/** Startup banner lines: bind address, auth state and allowlists. Never includes the token. */
export function describeServerSecurity(cfg: ServerSecurityConfig, port: number): string[] {
  const loopback = isLoopbackAddress(cfg.host);
  const bindHost = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
  const lines = [`  Bind:       ${bindHost}:${port} (${loopback ? 'loopback' : 'network'})`];
  if (cfg.authRequired) {
    const source = cfg.authTokenSource === 'file' ? '--auth-token-file' : cfg.authTokenSource === 'env' ? TOKEN_ENV : 'configured';
    lines.push(`  Auth:       ON (bearer token from ${source})`);
  } else {
    lines.push('  Auth:       off (loopback only)');
  }
  if (cfg.allowedHosts.length > 0) lines.push(`  Hosts:      ${cfg.allowedHosts.join(', ')}`);
  if (cfg.allowedOrigins.length > 0) lines.push(`  Origins:    ${cfg.allowedOrigins.join(', ')}`);
  return lines;
}
