/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// P0 security hardening — HTTP runtime security gate (design C1/C2, Properties 1–5).
//
// Pure policy (`http-security.ts`) is property-tested against an INDEPENDENT reference
// implementation of the ordered checks Host → method → preflight → public route → Origin →
// auth → content type. The transport properties (3, 4) and the examples run against a REAL
// `HttpTransport` on `listen(0)` backed by a REAL `ObservabilityService` (in-memory SQLite, same
// ports as http-transport.spec.ts) wrapped in a recording spy, so "the service was never
// touched" is observed, not assumed.
//
// Raw requests go through `node:http` (not fetch) so the test controls Host / Origin exactly.
// Requests without a Host header are covered by the pure property only: Node's HTTP/1.1 server
// answers those with its own 400 before any handler runs (requireHostHeader).
//
// Requirements 1.4, 3.1–3.6, 4.1, 4.2, 4.5, 5.1–5.6, 6.1–6.4, 7.1–7.3, 8.1, 8.2, 8.4, 8.5,
// 11.1, 11.2, 12.1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest, Agent, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  ObservabilityService,
  HttpTransport,
  runMigrations,
  createMigrationRegistry,
  DASHBOARD_HTML,
  DASHBOARD_JS,
  evaluateRequest,
  tokensEqual,
  redactSecret,
  buildAllowedHosts,
  type GateDecision,
  type RequestMeta,
  type SecurityPolicy,
} from '@codeforge/infrastructure';
import { ControlPlane, SessionService, ExecutionCoordinator, type Session } from '@codeforge/agent-core';

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

const TOKEN = 'cf-test-token-0123456789abcdef';
const ALLOWED_ORIGIN = 'https://app.example.com';

// ── seeded helpers ────────────────────────────────────────────────────────────────────────────

/** Async twin of `forAll`: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(seed: number, runs: number, body: (rng: Rng, iteration: number) => Promise<void>): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

const HEADER_SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~+/';

function genChars(rng: Rng, alphabet: readonly string[], min: number, max: number): string {
  const len = int(rng, min, max);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, alphabet);
  return out;
}

/** A bearer-safe token (no whitespace), 16..48 chars. */
function genHeaderToken(rng: Rng): string {
  return genChars(rng, [...HEADER_SAFE], 16, 48);
}

// ── Property 1: reference gate ────────────────────────────────────────────────────────────────

/** Comparable view of a GateDecision (optional flags folded to explicit values). */
type NormDecision =
  | { readonly kind: 'allow'; readonly corsOrigin: string | null }
  | { readonly kind: 'preflight'; readonly corsOrigin: string }
  | { readonly kind: 'reject'; readonly status: number; readonly error: string; readonly wwwAuthenticate: boolean };

function normalizeDecision(d: GateDecision): NormDecision {
  if (d.kind === 'allow') return { kind: 'allow', corsOrigin: d.corsOrigin ?? null };
  if (d.kind === 'preflight') return { kind: 'preflight', corsOrigin: d.corsOrigin };
  return { kind: 'reject', status: d.status, error: d.error, wwwAuthenticate: d.wwwAuthenticate === true };
}

function rejectRef(status: number, error: string, wwwAuthenticate = false): NormDecision {
  return { kind: 'reject', status, error, wwwAuthenticate };
}

/**
 * Independent reference of the design C1 decision table. Origins in the generated policies are
 * already in normalized form (lowercase scheme://host[:port]), so membership is an exact lookup.
 */
function referenceDecision(meta: RequestMeta, policy: SecurityPolicy): NormDecision {
  // 1. Host
  const host = meta.host === undefined ? undefined : meta.host.toLowerCase();
  if (host === undefined || !policy.allowedHosts.has(host)) return rejectRef(403, 'host not allowed');
  // 2. Method
  if (meta.method !== 'GET' && meta.method !== 'POST' && meta.method !== 'OPTIONS') {
    return rejectRef(405, 'method not allowed');
  }
  // 3. Preflight
  if (meta.method === 'OPTIONS') {
    if (meta.origin !== undefined && policy.allowedOrigins.has(meta.origin)) {
      return { kind: 'preflight', corsOrigin: meta.origin };
    }
    return rejectRef(403, 'origin not allowed');
  }
  // 4. Public routes
  if (meta.method === 'GET' && (meta.path === '/' || meta.path === '/app.js' || meta.path === '/health')) {
    return { kind: 'allow', corsOrigin: null };
  }
  // 5. Origin
  let corsOrigin: string | null = null;
  if (meta.origin !== undefined && meta.origin !== `http://${meta.host}`) {
    if (!policy.allowedOrigins.has(meta.origin)) return rejectRef(403, 'origin not allowed');
    corsOrigin = meta.origin;
  }
  // 6. Auth
  if (policy.authToken !== undefined) {
    const m = meta.authorization === undefined ? null : /^bearer ([^\s]+)$/i.exec(meta.authorization);
    if (m === null || m[1] !== policy.authToken) return rejectRef(401, 'unauthorized', true);
  }
  // 7. Content type
  if (meta.method === 'POST') {
    const media = (meta.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (media !== 'application/json') return rejectRef(415, 'content-type must be application/json');
  }
  return { kind: 'allow', corsOrigin };
}

const P1_PORT = 9500;
const P1_PATHS = [
  '/', '/app.js', '/health', '/state', '/trace', '/audit', '/metrics', '/events', '/changes', '/sessions',
  '/workspace/files', '/config', '/config/model', '/stream', '/models', '/models/pull', '/control', '/goal',
  '/clarification', '/plan-choice', '/unknown', '/app.js/', '/health/x',
];
const P1_CONTENT_TYPES: readonly (string | undefined)[] = [
  undefined, '', 'application/json', 'application/json; charset=utf-8', 'Application/JSON',
  'APPLICATION/JSON;charset=UTF-8', ' application/json ', 'text/plain', 'text/plain;charset=UTF-8',
  'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp',
  'application/json-patch+json',
];

function genPolicy(rng: Rng): SecurityPolicy {
  const hosts = new Set([`127.0.0.1:${P1_PORT}`, `localhost:${P1_PORT}`, `[::1]:${P1_PORT}`]);
  if (bool(rng)) hosts.add(`lan.example:${P1_PORT}`);
  const origins = new Set<string>(bool(rng) ? [ALLOWED_ORIGIN, 'http://localhost:3000'] : []);
  return {
    allowedHosts: hosts,
    allowedOrigins: origins,
    ...(bool(rng) ? { authToken: genHeaderToken(rng) } : {}),
  };
}

function genMeta(rng: Rng, policy: SecurityPolicy): RequestMeta {
  const lowerHosts = [`127.0.0.1:${P1_PORT}`, `localhost:${P1_PORT}`, `[::1]:${P1_PORT}`, `lan.example:${P1_PORT}`];
  const caseHosts = [`LOCALHOST:${P1_PORT}`, `LocalHost:${P1_PORT}`, `LAN.Example:${P1_PORT}`];
  const badHosts = [
    `127.0.0.1:${P1_PORT + 1}`, `localhost:${P1_PORT + 1}`, 'localhost', '127.0.0.1', `evil.example:${P1_PORT}`,
    `attacker.localhost:${P1_PORT}`, `127.0.0.1.nip.io:${P1_PORT}`, `0.0.0.0:${P1_PORT}`, '',
  ];
  const hostKind = pick(rng, ['lower', 'lower', 'lower', 'case', 'bad', 'absent'] as const);
  const host =
    hostKind === 'lower' ? pick(rng, lowerHosts)
    : hostKind === 'case' ? pick(rng, caseHosts)
    : hostKind === 'bad' ? pick(rng, badHosts)
    : undefined;

  const method = pick(rng, ['GET', 'GET', 'POST', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH', 'HEAD']);

  // Same-origin is only generated for a lowercase Host (browsers serialize Origin lowercase).
  const originKinds = ['absent', 'absent', 'allowlisted', 'foreign', 'null', 'cross-loopback'] as const;
  const originKind = pick(rng, hostKind === 'lower' ? [...originKinds, 'same', 'same'] : [...originKinds]);
  const origin =
    originKind === 'absent' ? undefined
    : originKind === 'same' ? `http://${host ?? ''}`
    : originKind === 'allowlisted' ? pick(rng, [ALLOWED_ORIGIN, 'http://localhost:3000'])
    : originKind === 'foreign' ? pick(rng, ['http://evil.example', 'https://attacker.test:8443', `http://evil.example:${P1_PORT}`, 'file://'])
    : originKind === 'null' ? 'null'
    : pick(rng, [`http://127.0.0.1:${P1_PORT + 1}`, `http://localhost:${P1_PORT}`, `https://localhost:${P1_PORT}`]);

  const token = policy.authToken ?? genHeaderToken(rng);
  const authorization = pick<string | undefined>(rng, [
    undefined, '', 'Bearer', 'Bearer ', `Bearer ${token}`, `Bearer ${token}`, `bearer ${token}`, `BEARER ${token}`,
    `Bearer  ${token}`, `Bearer ${token} extra`, `Bearer ${token}x`, `Bearer ${token.slice(1)}`,
    `Bearer ${genHeaderToken(rng)}`, `Basic ${Buffer.from(`u:${token}`).toString('base64')}`, `Token ${token}`, token,
  ]);

  return {
    method,
    path: pick(rng, P1_PATHS),
    host,
    origin,
    authorization,
    contentType: pick(rng, P1_CONTENT_TYPES),
  };
}

describe('Property 1: gate decision matches the reference order', () => {
  // Feature: p0-security-hardening, Property 1: Gate decision matches the reference order
  it('evaluateRequest equals the independent reference on 2000 seeded requests', () => {
    const seen = new Set<string>();
    forAll(0x5ec0_0001, 2000, (rng) => {
      const policy = genPolicy(rng);
      const meta = genMeta(rng, policy);
      const expected = referenceDecision(meta, policy);
      const actual = normalizeDecision(evaluateRequest(meta, policy));
      expect(actual, JSON.stringify({ meta, policy: { ...policy, allowedHosts: [...policy.allowedHosts], allowedOrigins: [...policy.allowedOrigins] } }))
        .toEqual(expected);
      seen.add(expected.kind === 'reject' ? `reject:${expected.status}:${expected.error}` : `${expected.kind}:${expected.corsOrigin !== null}`);
    });
    // Generator sanity: every outcome of the decision table was exercised.
    expect([...seen].sort()).toEqual([
      'allow:false', 'allow:true', 'preflight:true',
      'reject:401:unauthorized', 'reject:403:host not allowed', 'reject:403:origin not allowed',
      'reject:405:method not allowed', 'reject:415:content-type must be application/json',
    ]);
  });

  it('buildAllowedHosts: loopback names always, specific bind address, extras; wildcard adds nothing implicit', () => {
    const loop = buildAllowedHosts('127.0.0.1', 9500, []);
    for (const h of ['127.0.0.1:9500', 'localhost:9500', '[::1]:9500']) expect(loop.has(h)).toBe(true);
    expect(loop.has('evil.example:9500')).toBe(false);
    expect(loop.has('127.0.0.1:9501')).toBe(false);

    const wild = buildAllowedHosts('0.0.0.0', 9500, ['lan.example']);
    expect(wild.has('lan.example:9500')).toBe(true);
    expect(wild.has('0.0.0.0:9500')).toBe(false);

    expect(buildAllowedHosts('192.168.1.5', 9500, []).has('192.168.1.5:9500')).toBe(true);
    expect(buildAllowedHosts('fd00::5', 9500, []).has('[fd00::5]:9500')).toBe(true);
  });
});

// ── Property 2: token comparison ──────────────────────────────────────────────────────────────

describe('Property 2: token comparison is exact', () => {
  // Feature: p0-security-hardening, Property 2: Token comparison is exact
  it('tokensEqual(presented, expected) is true exactly when the strings are equal, and never throws', () => {
    const alphabet = [...HEADER_SAFE, 'é', 'ß', '日', '本', '🔑', '\u0000', ' '];
    let equalSeen = 0;
    forAll(0x5ec0_0002, 1000, (rng) => {
      const expected = genChars(rng, alphabet, 16, 48);
      const i = int(rng, 0, expected.length - 1);
      const presented = pick(rng, [
        expected,
        expected,
        expected.slice(0, i),                                         // prefix
        expected + genChars(rng, alphabet, 1, 8),                     // extension
        expected.slice(0, i) + (expected[i] === 'x' ? 'y' : 'x') + expected.slice(i + 1), // one-char change
        expected.slice(0, i) + 'é' + expected.slice(i + 1),           // non-ASCII change (may equal)
        genChars(rng, alphabet, 0, 64),                               // different length / random
        '',
        expected.toUpperCase(),
      ]);
      let result: boolean | undefined;
      expect(() => { result = tokensEqual(presented, expected); }).not.toThrow();
      expect(result).toBe(presented === expected);
      if (presented === expected) equalSeen++;
    });
    expect(equalSeen).toBeGreaterThan(50);
  });
});

// ── Property 5: redaction ─────────────────────────────────────────────────────────────────────

describe('Property 5: error output never contains the token', () => {
  // Feature: p0-security-hardening, Property 5: Error output never contains the token
  it('redactSecret removes every occurrence and leaves token-free text unchanged', () => {
    // Regex metacharacters and non-ASCII on purpose (catches RegExp-based implementations).
    // No '[' / ']' so a replacement can never combine with neighbours into a new occurrence.
    const tokenAlphabet = [...HEADER_SAFE, '.', '*', '$', '(', ')', '?', '|', '^', '\\', 'é', '日'];
    const fillerAlphabet = [...'abcdefghijklmnopqrstuvwxyz :/{}"\'\n', 'é'];
    forAll(0x5ec0_0005, 500, (rng) => {
      const token = genChars(rng, tokenAlphabet, 16, 40);
      const k = int(rng, 0, 4);
      let text = genChars(rng, fillerAlphabet, 0, 30);
      for (let j = 0; j < k; j++) text += token + genChars(rng, fillerAlphabet, 0, 30);
      const out = redactSecret(text, token);
      expect(out.includes(token)).toBe(false);
      if (!text.includes(token)) expect(out).toBe(text);
      else expect(out).toContain('[redacted]');
      expect(redactSecret(text, undefined)).toBe(text);
    });
  });
});

// ── transport fixture (real HttpTransport + spy ObservabilityService) ──────────────────────────

type Overrides = Readonly<Record<string, (...args: unknown[]) => unknown>>;

interface FixtureOptions {
  readonly authToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
  readonly overrides?: Overrides;
}

interface Fixture {
  readonly port: number;
  readonly transport: HttpTransport;
  /** Names of every ObservabilityService method the transport called, in order. */
  readonly calls: string[];
  close(): Promise<void>;
}

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.12.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

/** Same in-memory ports as http-transport.spec.ts: session 'S' RUNNING with one task. */
async function buildService(): Promise<{ service: ObservabilityService; db: SqliteDatabaseAdapter }> {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  let t = 0; let n = 0;
  const now = (): string => `2026-01-01T00:00:${String(t++ % 60).padStart(2, '0')}.000Z`;
  const nextId = (): string => `ID-${String(n++).padStart(4, '0')}`;
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  const sessionSvc = new SessionService({ sessions, events, lock, now, nextId });
  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  await sessionSvc.transition('S', 'SESSION_INITIALIZED');
  await sessionSvc.transition('S', 'SESSION_READY');
  await tasks.create({ taskId: 'T1', description: 'a', acceptanceCriteria: [], constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: 't', createdBy: 'planner' });
  await graphs.commit({
    graphId: 'GR', sessionId: 'S', version: 1, nodes: [{ taskId: 'T1', addedInVersion: 1 }], edges: [],
    createdAt: 't', createdBy: 'planner', canonicalHash: 'h', schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
    createdAt: 't', status: 'COMMITTED',
  });
  await new ExecutionCoordinator({ executions, now }).init('T1');

  let model = 'qwen2.5-coder:7b';
  const service = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events, controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    goalIngress: { submitGoal: () => ({ goalId: 'G-NEW', position: 0 }) },
    runtimeConfig: {
      get: () => ({ workspaceRoot: '/r', model, endpoint: 'http://localhost:11434' }),
      setModel: (m: string) => { model = m; return m; },
    },
    now, nextId,
  });
  return { service, db };
}

/** Records every method call on the service; `overrides` replace a method's behaviour. */
function spyService(target: ObservabilityService, overrides: Overrides, calls: string[]): ObservabilityService {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      return (...args: unknown[]): unknown => {
        calls.push(name);
        const override = overrides[name];
        return override !== undefined ? override(...args) : (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function startFixture(o: FixtureOptions = {}, host?: string): Promise<Fixture> {
  const { service, db } = await buildService();
  const calls: string[] = [];
  const transport = new HttpTransport({
    service: spyService(service, o.overrides ?? {}, calls),
    streamPollMs: 20,
    ...(o.authToken !== undefined ? { authToken: o.authToken } : {}),
    ...(o.allowedOrigins !== undefined ? { allowedOrigins: o.allowedOrigins } : {}),
    ...(o.allowedHosts !== undefined ? { allowedHosts: o.allowedHosts } : {}),
  });
  const port = host === undefined ? await transport.listen(0) : await transport.listen(0, host);
  return {
    port, transport, calls,
    close: async () => { await transport.close(); db.close(); },
  };
}

interface RawRequest {
  readonly method: string;
  readonly path: string;
  /** Host header value. Default `127.0.0.1:<port>`. */
  readonly host?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Resolve as soon as the status + headers arrive, then drop the connection (SSE routes). */
  readonly headersOnly?: boolean;
  /** Reuse connections from this agent (defaults to a one-shot socket when undefined). */
  readonly agent?: Agent | false;
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A raw node:http request with full control over Host / Origin (fetch rewrites those). */
function send(port: number, r: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: r.host ?? `127.0.0.1:${port}`, ...(r.headers ?? {}) };
    if (r.body !== undefined) headers['content-length'] = String(Buffer.byteLength(r.body));
    let settled = false;
    const req = httpRequest(
      { host: '127.0.0.1', port, method: r.method, path: r.path, headers, setHost: false,
        agent: r.agent !== undefined ? r.agent : false },
      (res) => {
        res.on('error', () => undefined);
        if (r.headersOnly === true) {
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error(`timeout: ${r.method} ${r.path}`)));
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    req.end(r.body);
  });
}

function json(body: string): unknown {
  return JSON.parse(body) as unknown;
}

const JSON_CT = { 'content-type': 'application/json' } as const;
const BEARER = { authorization: `Bearer ${TOKEN}` } as const;
const PAUSE = JSON.stringify({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });

interface Route { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: string }

const PUBLIC_ROUTE_LIST: readonly Route[] = [
  { method: 'GET', path: '/' }, { method: 'GET', path: '/app.js' }, { method: 'GET', path: '/health' },
];
const PROTECTED_ROUTE_LIST: readonly Route[] = [
  { method: 'GET', path: '/state?session=S' },
  { method: 'GET', path: '/trace?session=S' },
  { method: 'GET', path: '/audit?session=S' },
  { method: 'GET', path: '/metrics?session=S' },
  { method: 'GET', path: '/events?session=S' },
  { method: 'GET', path: '/changes?session=S' },
  { method: 'GET', path: '/sessions' },
  { method: 'GET', path: '/workspace/files' },
  { method: 'GET', path: '/config' },
  { method: 'GET', path: '/stream?session=S' },
  { method: 'GET', path: '/models' },
  { method: 'POST', path: '/config/model', body: JSON.stringify({ model: 'm' }) },
  { method: 'POST', path: '/control', body: PAUSE },
  { method: 'POST', path: '/goal', body: JSON.stringify({ description: 'build a thing' }) },
  { method: 'POST', path: '/clarification', body: JSON.stringify({ sessionId: 'S', answers: { q1: 'x' } }) },
  { method: 'POST', path: '/plan-choice', body: JSON.stringify({ sessionId: 'S', optionId: 'o1' }) },
  { method: 'POST', path: '/models/pull', body: JSON.stringify({ name: 'qwen2.5-coder:7b' }) },
];
const ALL_ROUTES: readonly Route[] = [...PUBLIC_ROUTE_LIST, ...PROTECTED_ROUTE_LIST];

function otherPort(port: number): number {
  return port === 65535 ? 65534 : port + 1;
}

function withQuery(path: string, extra: string): string {
  return path.includes('?') ? `${path}&${extra}` : `${path}?${extra}`;
}

// ── Property 3: no wildcard CORS ──────────────────────────────────────────────────────────────

describe('Property 3: no wildcard CORS', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture({ authToken: TOKEN, allowedOrigins: [ALLOWED_ORIGIN] }); });
  afterAll(async () => { await fx.close(); });

  // Feature: p0-security-hardening, Property 3: No wildcard CORS
  it('every response has no ACAO, or an allowlisted ACAO with Vary: Origin — never *', async () => {
    let withAcao = 0;
    const agent = new Agent({ keepAlive: true, maxSockets: 4 });
    try {
    await forAllAsync(0x5ec0_0003, 150, async (rng) => {
      const port = fx.port;
      const route = pick(rng, ALL_ROUTES);
      const method = pick(rng, [route.method, route.method, route.method, 'OPTIONS', 'PUT', 'DELETE']);
      const host = pick(rng, [`127.0.0.1:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `evil.example:${port}`, `127.0.0.1:${otherPort(port)}`]);
      const origin = pick<string | undefined>(rng, [undefined, ALLOWED_ORIGIN, ALLOWED_ORIGIN, `http://${host}`, 'http://evil.example', 'null']);
      const auth = pick<string | undefined>(rng, [undefined, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${genHeaderToken(rng)}`]);
      const ct = pick<string | undefined>(rng, ['application/json', 'application/json', 'text/plain', undefined]);
      const headers: Record<string, string> = {};
      if (origin !== undefined) headers['origin'] = origin;
      if (auth !== undefined) headers['authorization'] = auth;
      if (method === 'POST' && ct !== undefined) headers['content-type'] = ct;
      if (method === 'OPTIONS' && bool(rng)) {
        headers['access-control-request-method'] = 'POST';
        headers['access-control-request-headers'] = 'authorization, content-type';
      }
      const res = await send(port, {
        method, path: route.path, host, headers, headersOnly: true, agent,
        ...(method === 'POST' ? { body: route.body ?? '{}' } : {}),
      });
      const acao = res.headers['access-control-allow-origin'];
      if (acao !== undefined) {
        withAcao++;
        expect(acao).not.toBe('*');
        expect([ALLOWED_ORIGIN]).toContain(acao);
        expect(String(res.headers['vary'] ?? '').toLowerCase()).toContain('origin');
      }
    });
    } finally { agent.destroy(); }
    // Generator sanity: allowlisted cross-origin requests were exercised and answered with ACAO.
    expect(withAcao).toBeGreaterThan(0);
  }, 60_000);
});

// ── Property 4: rejected requests never reach the service ─────────────────────────────────────

describe('Property 4: rejected requests never reach the service', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture({ authToken: TOKEN, allowedOrigins: [ALLOWED_ORIGIN] }); });
  afterAll(async () => { await fx.close(); });

  // Feature: p0-security-hardening, Property 4: Rejected requests never reach the service
  it('a gate rejection (401/403/405/415) records zero ObservabilityService calls', async () => {
    const faultsSeen = new Set<string>();
    const pathsSeen = new Set<string>();
    const agent = new Agent({ keepAlive: true, maxSockets: 4 });
    try {
    await forAllAsync(0x5ec0_0004, 200, async (rng) => {
      const port = fx.port;
      const fault = pick(rng, ['host', 'method', 'preflight', 'origin', 'auth', 'content-type'] as const);
      const route = fault === 'host' || fault === 'method' || fault === 'preflight'
        ? pick(rng, ALL_ROUTES)
        : fault === 'content-type'
          ? pick(rng, PROTECTED_ROUTE_LIST.filter((r) => r.method === 'POST'))
          : pick(rng, PROTECTED_ROUTE_LIST);

      // Baseline: a request that would pass every check; then inject exactly one fault.
      let method: string = route.method;
      let path = route.path;
      let host = pick(rng, [`127.0.0.1:${port}`, `localhost:${port}`]);
      let origin = pick<string | undefined>(rng, [undefined, undefined, ALLOWED_ORIGIN, `http://${host}`]);
      let auth: string | undefined = `Bearer ${TOKEN}`;
      let ct: string | undefined = route.method === 'POST' ? pick(rng, ['application/json', 'application/json; charset=utf-8']) : undefined;
      let expectedStatus: number;

      switch (fault) {
        case 'host':
          host = pick(rng, [`evil.example:${port}`, `127.0.0.1:${otherPort(port)}`, `localhost:${otherPort(port)}`,
            `127.0.0.1.nip.io:${port}`, `attacker.localhost:${port}`, 'localhost']);
          if (origin !== undefined && origin !== ALLOWED_ORIGIN) origin = `http://${host}`;
          expectedStatus = 403;
          break;
        case 'method':
          method = pick(rng, ['PUT', 'DELETE', 'PATCH']);
          expectedStatus = 405;
          break;
        case 'preflight':
          method = 'OPTIONS';
          origin = pick<string | undefined>(rng, [undefined, 'http://evil.example', 'null', `http://${host}`]);
          expectedStatus = 403;
          break;
        case 'origin':
          origin = pick(rng, ['http://evil.example', 'https://attacker.test:8443', 'null',
            `http://localhost:${otherPort(port)}`, `http://evil.example:${port}`, `https://${host}`]);
          expectedStatus = 403;
          break;
        case 'auth':
          auth = pick<string | undefined>(rng, [undefined, `Bearer ${genHeaderToken(rng)}`, `Bearer ${TOKEN}x`,
            `Bearer ${TOKEN.slice(1)}`, `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}`, 'Bearer', TOKEN]);
          if (bool(rng)) path = withQuery(path, `${pick(rng, ['token', 'access_token'])}=${encodeURIComponent(TOKEN)}`);
          expectedStatus = 401;
          break;
        case 'content-type':
          ct = pick<string | undefined>(rng, [undefined, 'text/plain', 'text/plain;charset=UTF-8',
            'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']);
          expectedStatus = 415;
          break;
      }

      const headers: Record<string, string> = {};
      if (origin !== undefined) headers['origin'] = origin;
      if (auth !== undefined) headers['authorization'] = auth;
      if (ct !== undefined) headers['content-type'] = ct;
      fx.calls.length = 0;
      const res = await send(port, {
        method, path, host, headers, headersOnly: true, agent,
        ...(route.method === 'POST' && method !== 'OPTIONS' ? { body: route.body ?? '{}' } : {}),
      });
      expect(res.status, `${fault}: ${method} ${path} host=${host} origin=${String(origin)}`).toBe(expectedStatus);
      expect([401, 403, 405, 415]).toContain(res.status);
      expect(fx.calls, `${fault}: ${method} ${path}`).toEqual([]);
      faultsSeen.add(fault);
      pathsSeen.add(route.path.split('?')[0]!);
    });
    } finally { agent.destroy(); }
    expect(faultsSeen.size).toBe(6);
    for (const p of ['/stream', '/models/pull', '/control', '/goal', '/clarification', '/plan-choice', '/config/model']) {
      expect(pathsSeen.has(p), p).toBe(true);
    }
  }, 60_000);
});

// ── examples ──────────────────────────────────────────────────────────────────────────────────

describe('binding (Requirement 1.4)', () => {
  it('listen(0) binds 127.0.0.1 by default', async () => {
    const fx = await startFixture();
    try {
      const server = (fx.transport as unknown as { server: Server }).server;
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally { await fx.close(); }
  });

  it("listen(0, '0.0.0.0') without a token rejects; with a token it resolves", async () => {
    const { service, db } = await buildService();
    const open = new HttpTransport({ service });
    try {
      await expect(open.listen(0, '0.0.0.0')).rejects.toThrow(/auth token/i);
    } finally { await open.close(); }
    const authed = new HttpTransport({ service, authToken: TOKEN });
    try {
      expect(await authed.listen(0, '0.0.0.0')).toBeGreaterThan(0);
    } finally { await authed.close(); db.close(); }
  });
});

describe('bearer authentication (Requirements 3.1, 3.2, 3.4, 3.5)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture({ authToken: TOKEN }); });
  afterAll(async () => { await fx.close(); });

  const cases: readonly Route[] = [
    { method: 'GET', path: '/state?session=S' },
    { method: 'POST', path: '/control', body: PAUSE },
    { method: 'POST', path: '/goal', body: JSON.stringify({ description: 'x' }) },
  ];

  it('401 + WWW-Authenticate: Bearer without a token, with a wrong token, and with ?token= in the URL', async () => {
    for (const c of cases) {
      const variants: { readonly path: string; readonly headers: Record<string, string> }[] = [
        { path: c.path, headers: {} },
        { path: c.path, headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}Z` } },
        { path: c.path, headers: { authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` } },
        { path: withQuery(c.path, `token=${TOKEN}`), headers: {} },
        { path: withQuery(c.path, `access_token=${TOKEN}`), headers: {} },
      ];
      for (const v of variants) {
        fx.calls.length = 0;
        const res = await send(fx.port, {
          method: c.method, path: v.path,
          headers: { ...v.headers, ...(c.method === 'POST' ? JSON_CT : {}) },
          ...(c.body !== undefined ? { body: c.body } : {}),
        });
        expect(res.status, `${c.method} ${v.path}`).toBe(401);
        expect(String(res.headers['www-authenticate'])).toMatch(/^Bearer/);
        expect(json(res.body)).toEqual({ error: 'unauthorized' });
        expect(fx.calls).toEqual([]);
      }
    }
  });

  it('the right token gets the normal responses (200 /state, 200 /control, 202 /goal)', async () => {
    const st = await send(fx.port, { method: 'GET', path: '/state?session=S', headers: BEARER });
    expect(st.status).toBe(200);
    expect((json(st.body) as { sessionState: string }).sessionState).toBe('RUNNING');
    const ctl = await send(fx.port, { method: 'POST', path: '/control', headers: { ...BEARER, ...JSON_CT }, body: PAUSE });
    expect(ctl.status).toBe(200);
    const goal = await send(fx.port, { method: 'POST', path: '/goal', headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ description: 'x' }) });
    expect(goal.status).toBe(202);
    expect(json(goal.body)).toEqual({ goalId: 'G-NEW', position: 0 });
  });

  it('/, /app.js and /health stay public under auth and carry no credentials', async () => {
    fx.calls.length = 0;
    const html = await send(fx.port, { method: 'GET', path: '/' });
    const js = await send(fx.port, { method: 'GET', path: '/app.js' });
    const health = await send(fx.port, { method: 'GET', path: '/health' });
    expect(html.status).toBe(200);
    expect(html.body).toBe(DASHBOARD_HTML);
    expect(js.status).toBe(200);
    expect(js.body).toBe(DASHBOARD_JS);
    expect(health.status).toBe(200);
    expect(json(health.body)).toEqual({ ok: true });
    expect(fx.calls).toEqual([]); // no runtime data behind the public routes
    for (const text of [html.body, js.body, health.body]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/);
      expect(text).not.toMatch(/(api[-_]?key|password)\s*[:=]\s*["'][^"'\s]{4,}["']/i);
    }
  });
});

describe('cross-origin policy (Requirements 5.1–5.6, 6.3)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture({ allowedOrigins: [ALLOWED_ORIGIN] }); });
  afterAll(async () => { await fx.close(); });

  it('a foreign Origin gets 403 on POST /control and GET /state; the service is untouched', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      fx.calls.length = 0;
      const post = await send(fx.port, { method: 'POST', path: '/control', headers: { origin, ...JSON_CT }, body: PAUSE });
      expect(post.status).toBe(403);
      expect(json(post.body)).toEqual({ error: 'origin not allowed' });
      const get = await send(fx.port, { method: 'GET', path: '/state?session=S', headers: { origin } });
      expect(get.status).toBe(403);
      expect(json(get.body)).toEqual({ error: 'origin not allowed' });
      expect(post.headers['access-control-allow-origin']).toBeUndefined();
      expect(get.headers['access-control-allow-origin']).toBeUndefined();
      expect(fx.calls).toEqual([]);
    }
  });

  it('an allowlisted Origin gets the exact ACAO value and Vary: Origin', async () => {
    const res = await send(fx.port, { method: 'GET', path: '/state?session=S', headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(String(res.headers['vary']).toLowerCase()).toContain('origin');
  });

  it('preflight: allowlisted Origin → 204 with allow headers; missing / foreign Origin → 403 without CORS headers', async () => {
    const ok = await send(fx.port, {
      method: 'OPTIONS', path: '/control',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(String(ok.headers['vary']).toLowerCase()).toContain('origin');
    const methods = String(ok.headers['access-control-allow-methods']).split(',').map((s) => s.trim().toUpperCase());
    expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'OPTIONS']));
    const allowHeaders = String(ok.headers['access-control-allow-headers']).split(',').map((s) => s.trim().toLowerCase());
    expect(allowHeaders).toEqual(expect.arrayContaining(['authorization', 'content-type']));

    for (const headers of [{}, { origin: 'http://evil.example' }, { origin: 'null' }]) {
      fx.calls.length = 0;
      const denied = await send(fx.port, { method: 'OPTIONS', path: '/control', headers });
      expect(denied.status).toBe(403);
      expect(json(denied.body)).toEqual({ error: 'origin not allowed' });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
      expect(denied.headers['access-control-allow-methods']).toBeUndefined();
      expect(denied.headers['access-control-allow-headers']).toBeUndefined();
      expect(fx.calls).toEqual([]);
    }
  });
});

describe('CSRF, Host and method checks (Requirements 4.1, 4.5, 6.1, 6.2, 6.4)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture(); });
  afterAll(async () => { await fx.close(); });

  it('POST /goal with text/plain → 415 and the service is untouched; JSON with parameters is accepted', async () => {
    fx.calls.length = 0;
    const res = await send(fx.port, { method: 'POST', path: '/goal', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ description: 'x' }) });
    expect(res.status).toBe(415);
    expect(json(res.body)).toEqual({ error: 'content-type must be application/json' });
    expect(fx.calls).toEqual([]);
    const ok = await send(fx.port, { method: 'POST', path: '/goal', headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify({ description: 'x' }) });
    expect(ok.status).toBe(202);
  });

  it('a bad Host → 403 on /, /health and /state', async () => {
    for (const host of [`evil.example:${fx.port}`, `127.0.0.1:${otherPort(fx.port)}`]) {
      for (const path of ['/', '/health', '/state?session=S']) {
        fx.calls.length = 0;
        const res = await send(fx.port, { method: 'GET', path, host });
        expect(res.status, `${host} ${path}`).toBe(403);
        expect(json(res.body)).toEqual({ error: 'host not allowed' });
        expect(fx.calls).toEqual([]);
      }
    }
  });

  it('PUT → 405 method not allowed', async () => {
    fx.calls.length = 0;
    const res = await send(fx.port, { method: 'PUT', path: '/state?session=S', headers: JSON_CT, body: '{}' });
    expect(res.status).toBe(405);
    expect(json(res.body)).toEqual({ error: 'method not allowed' });
    expect(fx.calls).toEqual([]);
  });
});

describe('no secret leakage (Requirements 8.1, 8.2, 8.4, 8.5)', () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture({
      authToken: TOKEN,
      overrides: {
        getTrace: async () => { throw new Error(`boom ${TOKEN}`); },
        submitGoal: () => { throw new Error(`goal ingress offline: ${TOKEN}`); },
        pullModel: async () => { throw new Error(`pull failed for ${TOKEN}`); },
      },
    });
  });
  afterAll(async () => { await fx.close(); });

  it("an unexpected Error('boom ' + token) → 500 { error: 'internal error' }", async () => {
    const res = await send(fx.port, { method: 'GET', path: '/trace?session=S', headers: BEARER });
    expect(res.status).toBe(500);
    expect(json(res.body)).toEqual({ error: 'internal error' });
    expect(res.body).not.toContain(TOKEN);
  });

  it('a 501 message that contains the token is redacted', async () => {
    const res = await send(fx.port, { method: 'POST', path: '/goal', headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ description: 'x' }) });
    expect(res.status).toBe(501);
    expect(json(res.body)).toEqual({ error: 'goal ingress offline: [redacted]' });
  });

  it('the /models/pull SSE error frame is redacted', async () => {
    const res = await send(fx.port, { method: 'POST', path: '/models/pull', headers: { ...BEARER, ...JSON_CT }, body: JSON.stringify({ name: 'm' }) });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"status":"error"');
    expect(res.body).toContain('[redacted]');
    expect(res.body).not.toContain(TOKEN);
  });

  it('static responses carry nosniff and a CSP with script-src self and object-src none', async () => {
    for (const path of ['/', '/app.js']) {
      const res = await send(fx.port, { method: 'GET', path });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain('frame-ancestors'); // the VS Code webview iframe must keep working
    }
  });
});

describe('compatibility on a loopback, tokenless transport (Requirements 3.6, 11.1, 11.2)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await startFixture(); });
  afterAll(async () => { await fx.close(); });

  it('RuntimeClient-shaped requests (Node fetch, JSON, no Origin, Host 127.0.0.1:<port>) get the normal responses', async () => {
    const base = `http://127.0.0.1:${fx.port}`;
    const get = async (p: string): Promise<number> => (await fetch(`${base}${p}`)).status;
    const post = async (p: string, body: unknown): Promise<number> =>
      (await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;

    expect(await get('/health')).toBe(200);
    expect(await get('/state?session=S')).toBe(200);
    expect(await get('/trace?session=S')).toBe(200);
    expect(await get('/events?session=S')).toBe(200);
    expect(await get('/changes?session=S')).toBe(200);
    expect(await get('/sessions?limit=5')).toBe(200);
    expect(await get('/workspace/files')).toBe(200);
    expect(await get('/config')).toBe(200);
    expect(await get('/models')).toBe(501); // model admin not wired: unchanged route response
    expect(await post('/goal', { description: 'x' })).toBe(202);
    expect(await post('/clarification', { sessionId: 'S', answers: { q1: 'x' } })).toBe(501);
    expect(await post('/plan-choice', { sessionId: 'S', optionId: 'o1' })).toBe(501);
    expect(await post('/control', JSON.parse(PAUSE) as unknown)).toBe(200);
  });

  it('dashboard iframe requests (same-origin Origin http://127.0.0.1:<port>) get the normal responses', async () => {
    const origin = `http://127.0.0.1:${fx.port}`;
    const page = await send(fx.port, { method: 'GET', path: '/?session=S' }); // navigation: no Origin
    expect(page.status).toBe(200);
    expect(page.body).toContain('CodeForge');
    expect((await send(fx.port, { method: 'GET', path: '/app.js' })).status).toBe(200);
    expect((await send(fx.port, { method: 'GET', path: '/state?session=S', headers: { origin } })).status).toBe(200);
    expect((await send(fx.port, { method: 'GET', path: '/sessions?limit=50', headers: { origin } })).status).toBe(200);
    const model = await send(fx.port, { method: 'POST', path: '/config/model', headers: { origin, ...JSON_CT }, body: JSON.stringify({ model: 'llama3' }) });
    expect(model.status).toBe(200);
    expect(json(model.body)).toEqual({ model: 'llama3' });
    const stream = await send(fx.port, { method: 'GET', path: '/stream?session=S', headers: { origin }, headersOnly: true });
    expect(stream.status).toBe(200);
    expect(String(stream.headers['content-type'])).toContain('text/event-stream');
    // A browser on localhost:<port> is same-origin with its own Host.
    const lh = await send(fx.port, { method: 'GET', path: '/sessions', host: `localhost:${fx.port}`, headers: { origin: `http://localhost:${fx.port}` } });
    expect(lh.status).toBe(200);
  });
});
