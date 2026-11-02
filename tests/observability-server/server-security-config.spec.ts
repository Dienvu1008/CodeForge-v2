// Feature: p0-security-hardening, Property 6: Configuration fails closed
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI security configuration (pure): host default, token sources, allowlists, banner.
// `resolveServerSecurityConfig` takes an injected `readFile`, so no filesystem is touched.
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 4.3, 4.4, 5.7, 8.3, 12.2**
import { describe, it, expect } from 'vitest';
import {
  resolveServerSecurityConfig,
  describeServerSecurity,
  ServerSecurityConfigError,
  AUTH_TOKEN_MIN_LENGTH,
  type ServerSecurityInput,
  type ServerSecurityConfig,
} from '@codeforge/infrastructure';

// ── seeded PRNG (same mulberry32 generators as tests/mission/clarification-generators.ts; kept
// local because tests/tsconfig.json does not include tests/mission/**) ─────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function bool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}
function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}
/** Run `body` `runs` times; on failure re-throw with iteration + seed (reproducible counterexample). */
function forAll(seed: number, runs: number, body: (rng: Rng, iteration: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

const SEED = 0x5ec0c0f6;
const RUNS = 200;
const TOKEN_FILE = '/etc/codeforge/token';

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** readFile that must never be called. */
function noRead(path: string): string {
  throw new Error(`readFile must not be called (got ${path})`);
}

/** readFile returning `content` for TOKEN_FILE only, recording every call. */
function fileReader(content: string): { readFile: (p: string) => string; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readFile: (p: string) => {
      calls.push(p);
      if (p !== TOKEN_FILE) throw new Error(`ENOENT: no such file '${p}'`);
      return content;
    },
  };
}

/** Run `fn`, return the thrown error (or fail if nothing was thrown). */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected resolveServerSecurityConfig to throw');
}

function expectConfigError(fn: () => unknown): ServerSecurityConfigError {
  const err = thrown(fn);
  expect(err).toBeInstanceOf(ServerSecurityConfigError);
  expect(err).toBeInstanceOf(Error);
  return err as ServerSecurityConfigError;
}

// ── Generators ──────────────────────────────────────────────────────────────────────────────────

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

/** Random token of exactly `len` chars. Starts with a marker so it never appears in English text. */
function genToken(rng: Rng, len: number): string {
  let s = 'Zq9';
  while (s.length < len) s += TOKEN_CHARS[int(rng, 0, TOKEN_CHARS.length - 1)];
  return s.slice(0, len);
}

const LOOPBACK_HOSTS = ['127.0.0.1', '127.0.0.2', '127.255.0.1', '::1', 'localhost'] as const;
const NON_LOOPBACK_HOSTS = [
  '0.0.0.0',
  '::',
  '192.168.1.20',
  '10.0.0.5',
  '172.16.4.1',
  'fe80::1',
  '2001:db8::7',
  'devbox.lan',
  'codeforge.example.com',
] as const;

type HostKind = 'absent' | 'empty' | 'loopback' | 'non-loopback';
type TokenKind = 'none' | 'env' | 'file' | 'both' | 'env-empty' | 'file-empty' | 'file-unreadable' | 'env-short' | 'file-short';

const VALID_ORIGINS = ['https://example.com', 'http://127.0.0.1:8080', 'https://dash.example.org:8443'] as const;
const INVALID_ORIGINS = ['*', 'ftp://example.com', 'javascript:alert(1)', 'not a url', 'file:///etc/passwd'] as const;

interface Case {
  readonly input: ServerSecurityInput;
  readonly hostKind: HostKind;
  readonly host: string | undefined;
  readonly tokenKind: TokenKind;
  /** The resolved token when the source is valid, else undefined. */
  readonly token: string | undefined;
  /** Every secret string that must never appear in an error message. */
  readonly secrets: readonly string[];
  readonly badOrigin: string | undefined;
  readonly origins: readonly string[];
  /** Independent oracle: which C3 rule (if any) is violated. */
  readonly violation: string | undefined;
}

function genCase(rng: Rng): Case {
  const hostKind = pick<HostKind>(rng, ['absent', 'empty', 'loopback', 'non-loopback']);
  const host =
    hostKind === 'absent' ? undefined
      : hostKind === 'empty' ? ''
        : hostKind === 'loopback' ? pick(rng, LOOPBACK_HOSTS)
          : pick(rng, NON_LOOPBACK_HOSTS);

  const tokenKind = pick<TokenKind>(rng, [
    'none', 'env', 'file', 'both', 'env-empty', 'file-empty', 'file-unreadable', 'env-short', 'file-short',
  ]);
  const goodToken = genToken(rng, int(rng, AUTH_TOKEN_MIN_LENGTH, 64));
  const shortToken = genToken(rng, int(rng, 6, AUTH_TOKEN_MIN_LENGTH - 1));
  const pad = (): string => pick(rng, ['', ' ', '\n', '\t', '  \r\n']);

  const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
  let authTokenFile: string | undefined;
  let readFile: (p: string) => string = noRead;
  let token: string | undefined;
  const secrets: string[] = [];
  let violation: string | undefined;

  switch (tokenKind) {
    case 'none':
      break;
    case 'env':
      env['CODEFORGE_AUTH_TOKEN'] = goodToken;
      token = goodToken;
      secrets.push(goodToken);
      break;
    case 'env-empty':
      env['CODEFORGE_AUTH_TOKEN'] = '';
      break;
    case 'env-short':
      env['CODEFORGE_AUTH_TOKEN'] = shortToken;
      secrets.push(shortToken);
      violation = 'short';
      break;
    case 'file':
      authTokenFile = TOKEN_FILE;
      readFile = fileReader(`${pad()}${goodToken}${pad()}`).readFile;
      token = goodToken;
      secrets.push(goodToken);
      break;
    case 'file-empty':
      authTokenFile = TOKEN_FILE;
      readFile = fileReader(pick(rng, ['', ' ', '\n', ' \t\r\n '])).readFile;
      violation = 'empty-file';
      break;
    case 'file-unreadable': {
      authTokenFile = TOKEN_FILE;
      // The cause text quotes "content"; the config error must not repeat it.
      const leaked = genToken(rng, 24);
      secrets.push(leaked);
      readFile = () => {
        throw new Error(`EACCES: permission denied, partial read '${leaked}'`);
      };
      violation = 'unreadable';
      break;
    }
    case 'file-short':
      authTokenFile = TOKEN_FILE;
      readFile = fileReader(`${pad()}${shortToken}${pad()}`).readFile;
      secrets.push(shortToken);
      violation = 'short';
      break;
    case 'both': {
      const fileToken = genToken(rng, int(rng, AUTH_TOKEN_MIN_LENGTH, 40));
      env['CODEFORGE_AUTH_TOKEN'] = goodToken;
      authTokenFile = TOKEN_FILE;
      readFile = fileReader(fileToken).readFile;
      secrets.push(goodToken, fileToken);
      violation = 'both';
      break;
    }
  }

  if (violation === undefined && hostKind === 'non-loopback' && token === undefined) violation = 'no-token-off-loopback';

  // Optional origin allowlist: valid entries, sometimes one invalid entry.
  const origins: string[] = bool(rng, 0.5) ? [pick(rng, VALID_ORIGINS)] : [];
  if (bool(rng, 0.3)) origins.push(pick(rng, VALID_ORIGINS));
  let badOrigin: string | undefined;
  if (bool(rng, 0.2)) {
    badOrigin = pick(rng, INVALID_ORIGINS);
    origins.splice(int(rng, 0, origins.length), 0, badOrigin);
  }
  if (violation === undefined && badOrigin !== undefined) violation = 'bad-origin';
  const uniqueOrigins = [...new Set(origins)];

  const input: ServerSecurityInput = {
    ...(host !== undefined ? { host } : {}),
    ...(authTokenFile !== undefined ? { authTokenFile } : {}),
    ...(uniqueOrigins.length > 0 ? { allowedOrigins: uniqueOrigins.join(',') } : {}),
    ...(bool(rng, 0.4) ? { allowedHosts: 'devbox.lan,codeforge.example.com' } : {}),
    env,
    readFile,
  };
  return {
    input, hostKind, host, tokenKind, token, secrets, badOrigin,
    origins: uniqueOrigins.filter((o) => o !== badOrigin), violation,
  };
}

// ── Property 6 ──────────────────────────────────────────────────────────────────────────────────

describe('Property 6: Configuration fails closed', () => {
  it('throws ServerSecurityConfigError exactly when a C3 rule is violated, never leaking the token', () => {
    let errors = 0;
    let oks = 0;
    forAll(SEED, RUNS, (rng) => {
      const c = genCase(rng);
      let cfg: ServerSecurityConfig | undefined;
      let error: unknown;
      try {
        cfg = resolveServerSecurityConfig(c.input);
      } catch (err) {
        error = err;
      }

      if (c.violation !== undefined) {
        errors++;
        expect(error, `expected error (${c.violation}) for host=${String(c.host)} token=${c.tokenKind}`)
          .toBeInstanceOf(ServerSecurityConfigError);
        const msg = (error as Error).message;
        expect(msg.length).toBeGreaterThan(0);
        for (const s of c.secrets) expect(msg.includes(s), `message leaks secret: ${msg}`).toBe(false);
        if (c.violation === 'unreadable' || c.violation === 'empty-file') expect(msg).toContain(TOKEN_FILE);
        if (c.violation === 'short') expect(msg).toContain(String(AUTH_TOKEN_MIN_LENGTH));
        if (c.violation === 'bad-origin') expect(msg).toContain(c.badOrigin);
      } else {
        oks++;
        expect(error, `unexpected error for host=${String(c.host)} token=${c.tokenKind}: ${String(error)}`)
          .toBeUndefined();
        const expectedHost = c.host === undefined || c.host === '' ? '127.0.0.1' : c.host;
        expect(cfg!.host).toBe(expectedHost);
        expect(cfg!.authToken).toBe(c.token);
        expect(cfg!.authRequired).toBe(c.token !== undefined);
        expect([...cfg!.allowedOrigins].sort()).toEqual([...c.origins].sort());
      }
    });
    // The generator must exercise both outcomes.
    expect(errors).toBeGreaterThan(20);
    expect(oks).toBeGreaterThan(20);
  });
});

// ── Examples ────────────────────────────────────────────────────────────────────────────────────

const GOOD = 'Zq9-correct-horse-battery-staple';

describe('resolveServerSecurityConfig: examples', () => {
  it('exports the 16-character minimum', () => {
    expect(AUTH_TOKEN_MIN_LENGTH).toBe(16);
  });

  it('defaults to 127.0.0.1 with auth off and does not read any file', () => {
    const cfg = resolveServerSecurityConfig({ env: {}, readFile: noRead });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.authToken).toBeUndefined();
    expect(cfg.authRequired).toBe(false);
    expect(cfg.allowedHosts).toEqual([]);
    expect(cfg.allowedOrigins).toEqual([]);
  });

  it('uses --host as given', () => {
    expect(resolveServerSecurityConfig({ host: '127.0.0.5', env: {}, readFile: noRead }).host).toBe('127.0.0.5');
    const cfg = resolveServerSecurityConfig({ host: '0.0.0.0', env: { CODEFORGE_AUTH_TOKEN: GOOD }, readFile: noRead });
    expect(cfg.host).toBe('0.0.0.0');
  });

  it('takes the token from CODEFORGE_AUTH_TOKEN', () => {
    const cfg = resolveServerSecurityConfig({ env: { CODEFORGE_AUTH_TOKEN: GOOD }, readFile: noRead });
    expect(cfg.authToken).toBe(GOOD);
    expect(cfg.authRequired).toBe(true);
  });

  it('reads the token file with surrounding whitespace trimmed', () => {
    const r = fileReader(`  \n${GOOD}\r\n\t`);
    const cfg = resolveServerSecurityConfig({ authTokenFile: TOKEN_FILE, env: {}, readFile: r.readFile });
    expect(r.calls).toEqual([TOKEN_FILE]);
    expect(cfg.authToken).toBe(GOOD);
    expect(cfg.authRequired).toBe(true);
  });

  it('rejects both token sources at once', () => {
    const err = expectConfigError(() =>
      resolveServerSecurityConfig({
        authTokenFile: TOKEN_FILE,
        env: { CODEFORGE_AUTH_TOKEN: GOOD },
        readFile: fileReader('Zq9-another-valid-token-1234').readFile,
      }),
    );
    expect(err.message).toMatch(/one token source/i);
    expect(err.message).not.toContain(GOOD);
    expect(err.message).not.toContain('Zq9-another-valid-token-1234');
  });

  it('names the path, not the content, when the token file cannot be read', () => {
    const content = 'Zq9-secret-file-content-xyz';
    const err = expectConfigError(() =>
      resolveServerSecurityConfig({
        authTokenFile: TOKEN_FILE,
        env: {},
        readFile: () => {
          throw new Error(`EACCES: cannot read, buffer was '${content}'`);
        },
      }),
    );
    expect(err.message).toContain(TOKEN_FILE);
    expect(err.message).not.toContain(content);
  });

  it('rejects an empty (whitespace-only) token file, naming the path', () => {
    const err = expectConfigError(() =>
      resolveServerSecurityConfig({ authTokenFile: TOKEN_FILE, env: {}, readFile: fileReader(' \n\t ').readFile }),
    );
    expect(err.message).toContain(TOKEN_FILE);
  });

  it('rejects a token shorter than 16 characters, stating the minimum', () => {
    const short = 'Zq9-short-tok'; // 13 chars
    const errEnv = expectConfigError(() =>
      resolveServerSecurityConfig({ env: { CODEFORGE_AUTH_TOKEN: short }, readFile: noRead }),
    );
    expect(errEnv.message).toContain('16');
    expect(errEnv.message).not.toContain(short);
    const errFile = expectConfigError(() =>
      resolveServerSecurityConfig({ authTokenFile: TOKEN_FILE, env: {}, readFile: fileReader(`${short}\n`).readFile }),
    );
    expect(errFile.message).toContain('16');
    expect(errFile.message).not.toContain(short);
  });

  it('accepts a token of exactly 16 characters', () => {
    const t = 'Zq9abcdefghjkmnp';
    expect(t).toHaveLength(16);
    expect(resolveServerSecurityConfig({ env: { CODEFORGE_AUTH_TOKEN: t }, readFile: noRead }).authToken).toBe(t);
  });

  it('rejects a non-loopback host without a token, naming the missing token', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '::', 'devbox.lan']) {
      const err = expectConfigError(() => resolveServerSecurityConfig({ host, env: {}, readFile: noRead }));
      expect(err.message).toContain(host);
      expect(err.message).toMatch(/CODEFORGE_AUTH_TOKEN|--auth-token-file/);
    }
  });

  it('allows loopback hosts without a token', () => {
    for (const host of ['127.0.0.1', '127.0.0.9', '::1', 'localhost']) {
      const cfg = resolveServerSecurityConfig({ host, env: {}, readFile: noRead });
      expect(cfg.host).toBe(host);
      expect(cfg.authRequired).toBe(false);
    }
  });

  it('rejects --allowed-origins * and non-http(s) origins, naming the entry', () => {
    for (const bad of ['*', 'ftp://example.com', 'javascript:alert(1)']) {
      const err = expectConfigError(() =>
        resolveServerSecurityConfig({ allowedOrigins: `https://ok.example.com,${bad}`, env: {}, readFile: noRead }),
      );
      expect(err.message).toContain(bad);
    }
  });

  it('accepts a comma-separated list of http(s) origins', () => {
    const cfg = resolveServerSecurityConfig({
      allowedOrigins: 'https://dash.example.com, http://127.0.0.1:8080',
      env: {},
      readFile: noRead,
    });
    expect([...cfg.allowedOrigins].sort()).toEqual(['http://127.0.0.1:8080', 'https://dash.example.com']);
  });

  it('parses --allowed-hosts as a trimmed comma list without empty entries', () => {
    const cfg = resolveServerSecurityConfig({
      allowedHosts: ' devbox.lan, 192.168.1.20 ,,codeforge.example.com ',
      env: {},
      readFile: noRead,
    });
    expect(cfg.allowedHosts).toEqual(['devbox.lan', '192.168.1.20', 'codeforge.example.com']);
  });
});

// ── Banner ──────────────────────────────────────────────────────────────────────────────────────

describe('describeServerSecurity', () => {
  it('shows host, port and auth off on the default loopback config', () => {
    const cfg = resolveServerSecurityConfig({ env: {}, readFile: noRead });
    const lines = describeServerSecurity(cfg, 9500);
    expect(Array.isArray(lines)).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('127.0.0.1');
    expect(text).toContain('9500');
    expect(text).toMatch(/auth/i);
    expect(text).toMatch(/\boff\b/i);
  });

  it('shows auth ON with a token and never prints the token', () => {
    const fromEnv = resolveServerSecurityConfig({ host: '0.0.0.0', env: { CODEFORGE_AUTH_TOKEN: GOOD }, readFile: noRead });
    const envText = describeServerSecurity(fromEnv, 9501).join('\n');
    expect(envText).toContain('0.0.0.0');
    expect(envText).toContain('9501');
    expect(envText).toMatch(/\bon\b/i);
    expect(envText).not.toContain(GOOD);

    const fromFile = resolveServerSecurityConfig({
      host: '192.168.1.20',
      authTokenFile: TOKEN_FILE,
      env: {},
      readFile: fileReader(`${GOOD}\n`).readFile,
    });
    const fileText = describeServerSecurity(fromFile, 9502).join('\n');
    expect(fileText).toContain('192.168.1.20');
    expect(fileText).toContain('9502');
    expect(fileText).toMatch(/\bon\b/i);
    expect(fileText).not.toContain(GOOD);
  });

  it('never prints the token for any generated valid config', () => {
    forAll(SEED + 1, 100, (rng) => {
      const token = genToken(rng, int(rng, AUTH_TOKEN_MIN_LENGTH, 64));
      const host = pick(rng, [...LOOPBACK_HOSTS, ...NON_LOOPBACK_HOSTS]);
      const port = int(rng, 1024, 65535);
      const cfg = resolveServerSecurityConfig({ host, env: { CODEFORGE_AUTH_TOKEN: token }, readFile: noRead });
      const text = describeServerSecurity(cfg, port).join('\n');
      expect(text).not.toContain(token);
      expect(text).toContain(String(port));
    });
  });
});
