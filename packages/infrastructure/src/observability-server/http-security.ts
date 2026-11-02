/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// HTTP security gate (P0 security hardening, design C1) — PURE policy, no I/O.
//
// `evaluateRequest` decides, from request metadata only (no body), whether a request may reach
// the routes of HttpTransport. Checks run in a fixed order and the first failing check wins
// (Requirement 7.3):
//
//   1. Host header ∈ allowedHosts (case-insensitive)          → 403 'host not allowed'
//   2. method ∈ {GET, POST, OPTIONS}                          → 405 'method not allowed'
//   3. OPTIONS: Origin ∈ allowedOrigins → preflight           → 403 'origin not allowed'
//   4. public route (GET /, /app.js, /health) → allow
//   5. Origin absent | same-origin (`http://<Host>`) | allowlisted (→ corsOrigin)
//                                                             → 403 'origin not allowed'
//   6. authToken set → `Authorization: Bearer <token>`        → 401 'unauthorized' (+ WWW-Authenticate)
//   7. POST → content type application/json                  → 415 'content-type must be application/json'
//   8. allow
//
// Only `node:` built-ins are used, so dependency-cruiser boundaries are unchanged.
import { createHash, timingSafeEqual } from 'node:crypto';

export interface SecurityPolicy {
  /** Exact `host:port` values accepted in the Host header (lowercased). */
  readonly allowedHosts: ReadonlySet<string>;
  /** Exact origins (scheme://host[:port], lowercased) allowed cross-origin. Empty by default. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** When defined, Protected_Route requests need `Authorization: Bearer <authToken>`. */
  readonly authToken?: string;
}

export interface RequestMeta {
  readonly method: string;
  /** Parsed path without the query string. */
  readonly path: string;
  /** `req.headers.host` */
  readonly host: string | undefined;
  /** `req.headers.origin` */
  readonly origin: string | undefined;
  /** `req.headers.authorization` */
  readonly authorization: string | undefined;
  /** `req.headers['content-type']` */
  readonly contentType: string | undefined;
}

export type GateDecision =
  /** Route the request. `corsOrigin` → `Access-Control-Allow-Origin: <corsOrigin>` + `Vary: Origin`. */
  | { readonly kind: 'allow'; readonly corsOrigin?: string }
  /** Answer the CORS preflight with 204 + allow headers for `corsOrigin`. */
  | { readonly kind: 'preflight'; readonly corsOrigin: string }
  | {
      readonly kind: 'reject';
      readonly status: 401 | 403 | 405 | 415;
      readonly error: string;
      readonly wwwAuthenticate?: boolean;
    };

/** `METHOD path` pairs served without Origin/auth checks (constant assets + liveness only). */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['GET /', 'GET /app.js', 'GET /health']);

const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'OPTIONS']);

/** Strip one pair of IPv6 brackets: `[::1]` → `::1`. */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Wrap an IPv6 literal in brackets for a `host:port` value; other hosts unchanged. */
function bracketIfIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return false;
  }
  return parts[0] === '127';
}

/** 127.0.0.0/8, `::1` (also bracketed / IPv4-mapped), and `localhost`. */
export function isLoopbackAddress(host: string): boolean {
  const h = unbracket(host.trim().toLowerCase());
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isIpv4Loopback(h.slice('::ffff:'.length));
  return isIpv4Loopback(h);
}

/** `0.0.0.0` and `::` (all interfaces). */
export function isWildcardAddress(host: string): boolean {
  const h = unbracket(host.trim().toLowerCase());
  return h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0';
}

/**
 * Host header allowlist for a bound server: loopback names with the port always; the bind host
 * itself when it is a specific address; each `extra` hostname with the port. A wildcard bind adds
 * nothing implicit (DNS-rebinding defence, design D4).
 */
export function buildAllowedHosts(bindHost: string, port: number, extra: readonly string[]): ReadonlySet<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const bind = bindHost.trim().toLowerCase();
  if (bind !== '' && !isWildcardAddress(bind)) hosts.add(`${bracketIfIpv6(bind)}:${port}`);
  for (const e of extra) {
    const name = e.trim().toLowerCase();
    if (name !== '') hosts.add(`${bracketIfIpv6(name)}:${port}`);
  }
  return hosts;
}

/**
 * Normalize an http(s) origin to `scheme://host[:port]` (lowercase, default port dropped).
 * Returns null for anything else (`null`, `file://`, paths, credentials, `*`, garbage).
 */
export function normalizeOrigin(value: string): string | null {
  const raw = value.trim();
  if (raw === '' || raw === '*' || raw.toLowerCase() === 'null') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.host === '' || url.username !== '' || url.password !== '') return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return null;
  return `${url.protocol}//${url.host}`;
}

/** True when the media type (before `;`, trimmed, lowercased) is exactly `application/json`. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const media = (value.split(';')[0] ?? '').trim().toLowerCase();
  return media === 'application/json';
}

const BEARER_RE = /^bearer ([^\s]+)$/i;

/**
 * Extract the token from `Bearer <token>` (scheme case-insensitive, exactly one space, token
 * without whitespace). Anything else → null. The query string is never consulted.
 */
export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const m = BEARER_RE.exec(header);
  return m === null ? null : (m[1] ?? null);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time token comparison. Both sides are hashed to 32-byte SHA-256 digests first, which
 * removes the length side channel and the RangeError `timingSafeEqual` throws on unequal lengths.
 * The final `===` guards against (theoretical) digest collisions without leaking timing.
 */
export function tokensEqual(presented: string, expected: string): boolean {
  const same = timingSafeEqual(sha256(presented), sha256(expected));
  return same && presented.length === expected.length && presented === expected;
}

/** Resolve the request Origin against the policy: allowlisted → normalized origin, else null. */
function allowlistedOrigin(origin: string, policy: SecurityPolicy): string | null {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && policy.allowedOrigins.has(normalized) ? normalized : null;
}

function reject(
  status: 401 | 403 | 405 | 415,
  error: string,
  wwwAuthenticate = false,
): GateDecision {
  return wwwAuthenticate ? { kind: 'reject', status, error, wwwAuthenticate: true } : { kind: 'reject', status, error };
}

/** The pre-routing gate. Pure: metadata in, decision out (design C1 decision table). */
export function evaluateRequest(meta: RequestMeta, policy: SecurityPolicy): GateDecision {
  // 1. Host (DNS rebinding). Absent, empty, port-less and unknown hosts are not in the set.
  if (meta.host === undefined || !policy.allowedHosts.has(meta.host.toLowerCase())) {
    return reject(403, 'host not allowed');
  }

  // 2. Method.
  if (!ALLOWED_METHODS.has(meta.method)) return reject(405, 'method not allowed');

  // 3. CORS preflight: only for allowlisted origins.
  if (meta.method === 'OPTIONS') {
    const cors = meta.origin === undefined ? null : allowlistedOrigin(meta.origin, policy);
    return cors === null ? reject(403, 'origin not allowed') : { kind: 'preflight', corsOrigin: cors };
  }

  // 4. Public routes: constant assets + liveness, no data, no credentials (design D3).
  if (PUBLIC_ROUTES.has(`${meta.method} ${meta.path}`)) return { kind: 'allow' };

  // 5. Origin: absent (non-browser) or same-origin pass; allowlisted passes with CORS headers.
  let corsOrigin: string | undefined;
  if (meta.origin !== undefined && meta.origin !== `http://${meta.host}`) {
    const cors = allowlistedOrigin(meta.origin, policy);
    if (cors === null) return reject(403, 'origin not allowed');
    corsOrigin = cors;
  }

  // 6. Bearer auth.
  if (policy.authToken !== undefined) {
    const presented = extractBearer(meta.authorization);
    if (presented === null || !tokensEqual(presented, policy.authToken)) {
      return reject(401, 'unauthorized', true);
    }
  }

  // 7. CSRF: POST bodies must be JSON (not a CORS-simple content type).
  if (meta.method === 'POST' && !isJsonContentType(meta.contentType)) {
    return reject(415, 'content-type must be application/json');
  }

  // 8. Allow.
  return corsOrigin === undefined ? { kind: 'allow' } : { kind: 'allow', corsOrigin };
}

/** Replace every occurrence of `secret` in `text` with `[redacted]` (no RegExp involved). */
export function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === '') return text;
  return text.split(secret).join('[redacted]');
}
