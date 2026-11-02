/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Dashboard authentication test (P0 security hardening).
//
// Runs the REAL DASHBOARD_JS inside a minimal stub environment using the same
// new Function(…) pattern as dashboard-xss.spec.ts. No jsdom, no new deps.
//
// Validates: Requirements 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 12.4
//
// Scenarios:
//   1. 401 on first fetch → form shown (R9.1)
//   2. Token submission → all subsequent fetches carry Bearer; token not in URL (R9.2, R9.3, R9.4)
//   3. localStorage never touched (R9.4)
//   4. With a token, /stream uses fetch (not EventSource); EventSource never constructed (R9.5)
//   5. Fetch-stream reconnects with from=<lastSeq> after done:true + 2s timer fires (R9.5)
//   6. Later 401 clears sessionStorage and re-shows the form (R9.7)
//   7. Without a token, /stream uses EventSource (R9.6)
//   8. Asset scan: no hardcoded credentials in DASHBOARD_JS / DASHBOARD_HTML (R8.4)

import { describe, it, expect } from 'vitest';
import { DASHBOARD_JS, DASHBOARD_HTML } from '@codeforge/infrastructure';

// ── Minimal stub DOM ──────────────────────────────────────────────────────────
class StubEl {
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  private _listeners: Record<string, ((ev: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  className = '';
  value = '';
  title = '';
  _hidden = false;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  onclick: unknown = null;
  private _text = '';

  constructor(readonly tag: string, readonly id = '') {}

  get hidden(): boolean { return this._hidden; }
  set hidden(v: boolean) { this._hidden = v; }

  set innerHTML(v: string) { this.children = []; void v; }
  get innerHTML(): string { return ''; }
  insertAdjacentHTML(_pos: string, _v: string): void {}

  set textContent(v: string) { this._text = String(v); this.children = []; }
  get textContent(): string { return this._text; }

  get firstChild(): StubEl | null { return this.children[0] ?? null; }
  appendChild(c: StubEl): StubEl { this.children.push(c); return c; }
  removeChild(c: StubEl): StubEl { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this._listeners[type] ??= []).push(fn);
  }
  querySelectorAll(): StubEl[] { return []; }
  querySelector(): StubEl | null { return null; }
  get classList() {
    return {
      add: (c: string) => { this.className += ' ' + c; },
      remove: () => undefined,
      contains: () => false,
    };
  }
  focus(): void { /* stub */ }
  /** Fire a synthetic event on this element. */
  fire(type: string, extra?: Record<string, unknown>): void {
    for (const fn of this._listeners[type] ?? []) {
      fn({ preventDefault: () => undefined, key: '', shiftKey: false, ...extra });
    }
  }
}

function makeDom() {
  const byId = new Map<string, StubEl>();
  const document = {
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, new StubEl('div', id));
      return byId.get(id)!;
    },
    createElement: (tag: string) => new StubEl(tag),
    createElementNS: (_ns: string, tag: string) => new StubEl(tag),
    createTextNode: (text: string) => {
      const n = new StubEl('#text');
      n.textContent = text;
      return n;
    },
    querySelectorAll: () => [] as StubEl[],
  };
  return { document, byId };
}

// ── Fake SSE body helpers ─────────────────────────────────────────────────────

/** Build a body that yields one SSE frame then signals done:true. */
function makeSseBody(id: number, eventJson: string) {
  const enc = new TextEncoder();
  const frame = `id: ${id}\ndata: ${eventJson}\n\n`;
  let sent = false;
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
        if (!sent) { sent = true; return { done: false, value: enc.encode(frame) }; }
        return { done: true, value: undefined };
      },
      cancel: async () => undefined,
    }),
  };
}

// ── Timer capture helper ──────────────────────────────────────────────────────
/**
 * Returns a fake setTimeout/clearTimeout pair.
 * Call flushTimers() to fire all currently-pending callbacks.
 */
function makeTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;

  const fakeSetTimeout = (fn: () => void, _ms?: number): number => {
    const id = nextId++;
    pending.set(id, fn);
    return id;
  };
  const fakeClearTimeout = (id: number): void => { pending.delete(id); };

  const flushTimers = (): void => {
    const cbs = [...pending.values()];
    pending.clear();
    for (const fn of cbs) fn();
  };

  return { fakeSetTimeout, fakeClearTimeout, flushTimers };
}

// ── Standard fake responses ───────────────────────────────────────────────────
const STANDARD_RESPONSES: Record<string, unknown> = {
  '/config':           { workspaceRoot: '/ws', model: 'test-model', endpoint: 'http://x' },
  '/models':           { models: [{ name: 'test-model', parameterSize: '7B', quantization: 'Q4', sizeBytes: 1 }] },
  '/sessions':         { sessions: [] },
  '/state':            { sessionId: 'S1', sessionState: 'RUNNING', graphVersion: 1, model: 'm', provider: 'p', counts: { total: 0, passed: 0, active: 0, blocked: 0, failed: 0 }, tasks: [] },
  '/events':           [],
  '/trace':            { entries: [] },
  '/changes':          { changes: [] },
  '/workspace/files':  { files: [] },
};

// ── Harness types ─────────────────────────────────────────────────────────────
interface Harness {
  allFetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  eventSourceCount: number;
  eventSourceConstructed: boolean;
  sessionStore: Map<string, string>;
  localStorageTouched: boolean;
  force401: boolean;
  document: ReturnType<typeof makeDom>['document'];
  byId: ReturnType<typeof makeDom>['byId'];
  /** Flush any pending setTimeout callbacks captured during the run. */
  flushTimers: () => void;
}

// ── Harness factory ───────────────────────────────────────────────────────────
/**
 * Boot DASHBOARD_JS in a controlled environment.
 *
 * @param initialToken  Pre-seed sessionStorage (simulates token already set from a prior run).
 * @param start401      Make every response return 401 until force401 is set to false.
 * @param streamBody    Optional custom stream body factory; defaults to a single-frame done body.
 */
async function bootDashboard(opts: {
  initialToken?: string;
  start401?: boolean;
  streamBody?: () => ReturnType<typeof makeSseBody>;
} = {}): Promise<Harness> {
  const { document, byId } = makeDom();
  const { fakeSetTimeout, fakeClearTimeout, flushTimers } = makeTimers();

  const allFetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let eventSourceCount = 0;
  const sessionStore = new Map<string, string>();
  let localStorageTouched = false;
  let force401 = opts.start401 ?? false;

  if (opts.initialToken) sessionStore.set('codeforge.authToken', opts.initialToken);

  const streamBodyFactory = opts.streamBody ?? (() => {
    const goodEvent = { type: 'MISSION_RECEIVED', at: '2026-01-01T00:00:00', sequenceNumber: 42, payload: { description: 'test' } };
    return makeSseBody(42, JSON.stringify(goodEvent));
  });

  // Collect all fetch calls, honour force401, serve canned responses.
  const fakeFetch = async (url: string, init?: RequestInit) => {
    allFetchCalls.push({ url: String(url), init });
    const path = String(url).split('?')[0]!;

    if (force401) {
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }), body: null };
    }
    if (path === '/stream') {
      return { ok: true, status: 200, body: streamBodyFactory(), json: async () => ({}) };
    }
    const body = STANDARD_RESPONSES[path] ?? {};
    return { ok: true, status: 200, json: async () => body, body: null };
  };

  // FakeEventSource — counts constructions; does nothing else.
  class FakeEventSource {
    onmessage?: (ev: { data: string; lastEventId?: string }) => void;
    onopen?: () => void;
    onerror?: () => void;
    constructor() { eventSourceCount++; }
    close() {}
  }

  // Fake sessionStorage (per-tab scope).
  const stubSessionStorage = {
    getItem:    (k: string)           => sessionStore.get(k) ?? null,
    setItem:    (k: string, v: string) => { sessionStore.set(k, v); },
    removeItem: (k: string)            => { sessionStore.delete(k); },
  };

  // Fake localStorage — any access records the touch.
  const makeLocalStorageMethod = (name: string) =>
    (..._args: unknown[]) => {
      void name;
      localStorageTouched = true;
      return null;
    };
  const stubLocalStorage = {
    getItem:    makeLocalStorageMethod('getItem'),
    setItem:    makeLocalStorageMethod('setItem'),
    removeItem: makeLocalStorageMethod('removeItem'),
    clear:      makeLocalStorageMethod('clear'),
    key:        makeLocalStorageMethod('key'),
    get length() { localStorageTouched = true; return 0; },
  };

  const run = new Function(
    'window', 'document', 'fetch', 'EventSource', 'sessionStorage', 'localStorage',
    'setInterval', 'setTimeout', 'clearTimeout', 'AbortController', 'TextDecoder',
    DASHBOARD_JS,
  );
  run(
    { fetch: fakeFetch },
    document,
    fakeFetch,
    FakeEventSource,
    stubSessionStorage,
    stubLocalStorage,
    () => 0,             // setInterval — no polling during test
    fakeSetTimeout,      // setTimeout — captured for manual firing
    fakeClearTimeout,    // clearTimeout
    AbortController,     // real AbortController for fetch streams
    TextDecoder,         // real TextDecoder
  );

  // Flush micro-tasks: initial loadConfig / captureBaseline / refreshModels.
  const flush = () => new Promise<void>((r) => setImmediate(r));
  await flush(); await flush(); await flush();

  return {
    allFetchCalls,
    get eventSourceCount() { return eventSourceCount; },
    get eventSourceConstructed() { return eventSourceCount > 0; },
    sessionStore,
    get localStorageTouched() { return localStorageTouched; },
    get force401() { return force401; },
    set force401(v: boolean) { force401 = v; },
    document,
    byId,
    flushTimers,
  };
}

// ── Test helpers ──────────────────────────────────────────────────────────────
const flush = () => new Promise<void>((r) => setImmediate(r));

async function submitToken(h: Harness, token: string): Promise<void> {
  const input = h.byId.get('authToken') ?? h.document.getElementById('authToken');
  input.value = token;
  const form = h.byId.get('authForm') ?? h.document.getElementById('authForm');
  form.fire('submit');
  await flush(); await flush(); await flush();
}

async function connectSession(h: Harness, sid = 'test-session'): Promise<void> {
  const sessionInput = h.byId.get('session') ?? h.document.getElementById('session');
  sessionInput.value = sid;
  const btn = h.byId.get('connect') ?? h.document.getElementById('connect');
  btn.fire('click');
  await flush(); await flush(); await flush();
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('dashboard authentication (R8.4, R9.1–9.7, R12.4)', () => {

  // ── Scenario 1: 401 on first fetch → form shown ──────────────────────────
  it('1. 401 on first fetch → authForm is shown (hidden === false)', async () => {
    // Validates: Requirement 9.1
    const h = await bootDashboard({ start401: true });
    const form = h.byId.get('authForm') ?? h.document.getElementById('authForm');
    expect(form.hidden).toBe(false);
  });

  // ── Scenario 2: Token submission → all fetches carry Bearer; token not in URL ─
  it('2. after token submit every fetch carries Authorization: Bearer <token>', async () => {
    // Validates: Requirements 9.2, 9.3
    const TOKEN = 'scenario2-token-abcdefgh';
    const h = await bootDashboard({ start401: true });
    h.force401 = false;

    // Clear calls recorded during boot (pre-submit 401 calls are expected to lack the header).
    h.allFetchCalls.length = 0;

    await submitToken(h, TOKEN);

    // At least loadConfig / refreshModels / captureBaseline fire.
    expect(h.allFetchCalls.length).toBeGreaterThan(0);

    for (const call of h.allFetchCalls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      // Find the authorization header case-insensitively.
      const authHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
      expect(authHeader).toBeDefined();
      expect(authHeader![1]).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('2. token never appears in any fetch URL', async () => {
    // Validates: Requirement 9.4
    const TOKEN = 'no-url-leak-token-12345';
    const h = await bootDashboard({ start401: true });
    h.force401 = false;
    await submitToken(h, TOKEN);
    await connectSession(h);   // drives /stream, /state, /trace, etc.

    for (const call of h.allFetchCalls) {
      // Neither the token value nor token-in-query patterns.
      expect(call.url).not.toContain(TOKEN);
      expect(call.url).not.toMatch(/[?&](token|access_token)=/i);
    }
  });

  // ── Scenario 3: localStorage never touched ───────────────────────────────
  it('3. localStorage is never accessed at any point', async () => {
    // Validates: Requirement 9.4
    const h = await bootDashboard({ start401: true });
    h.force401 = false;
    await submitToken(h, 'any-token-for-ls-test-1');
    await connectSession(h);
    expect(h.localStorageTouched).toBe(false);
  });

  // ── Scenario 4: with a token, /stream uses fetch (not EventSource) ───────
  it('4. with a token set at startup, /stream uses fetch and EventSource is never constructed', async () => {
    // Validates: Requirement 9.5
    const TOKEN = 'stream-via-fetch-token-xyz';
    const h = await bootDashboard({ initialToken: TOKEN });
    h.allFetchCalls.length = 0;

    await connectSession(h, 'sid-for-fetch-stream');

    // fetch must have been called for /stream.
    const streamCalls = h.allFetchCalls.filter((c) => c.url.includes('/stream'));
    expect(streamCalls.length).toBeGreaterThan(0);

    // Every /stream call must carry the Bearer header.
    for (const call of streamCalls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
      expect(auth).toBeDefined();
      expect(auth![1]).toBe(`Bearer ${TOKEN}`);
    }

    // EventSource must NOT have been constructed.
    expect(h.eventSourceConstructed).toBe(false);
  });

  // ── Scenario 5: fetch-stream reconnects with from=<lastSeq> ──────────────
  it('5. after stream done:true, firing the 2s timer issues a second fetch with from=<lastSeq>', async () => {
    // Validates: Requirement 9.5
    // The stream body delivers id:42 then done:true; openFetchStream sets reconnectTimer via
    // setTimeout. Calling flushTimers() fires that callback and triggers a second fetch.
    const TOKEN = 'reconnect-test-token-9999';
    const SEQ = 42;

    const h = await bootDashboard({
      initialToken: TOKEN,
      streamBody: () => {
        const frame = `id: ${SEQ}\ndata: ${JSON.stringify({ type: 'PING', at: 't', payload: {} })}\n\n`;
        const enc = new TextEncoder();
        let sent = false;
        return {
          getReader: () => ({
            read: async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
              if (!sent) { sent = true; return { done: false, value: enc.encode(frame) }; }
              return { done: true, value: undefined };
            },
            cancel: async () => undefined,
          }),
        };
      },
    });

    // Connect to trigger openFetchStream.
    await connectSession(h, 'sess-reconnect');

    const before = h.allFetchCalls.filter((c) => c.url.includes('/stream')).length;
    expect(before).toBeGreaterThan(0); // first fetch happened

    // Fire the reconnect timer that openFetchStream registered via setTimeout.
    h.flushTimers();
    await flush(); await flush(); await flush();

    const after = h.allFetchCalls.filter((c) => c.url.includes('/stream'));
    // At least one more /stream call should have been made.
    expect(after.length).toBeGreaterThan(before);

    // The reconnect call must carry from=<lastSeq>.
    const reconnectCall = after[after.length - 1]!;
    expect(reconnectCall.url).toContain(`from=${SEQ}`);
  });

  // ── Scenario 6: later 401 clears sessionStorage and re-shows the form ────
  it('6. a 401 received while authenticated clears sessionStorage and re-shows authForm', async () => {
    // Validates: Requirement 9.7
    const TOKEN = 'valid-token-to-revoke-xyz1';
    const h = await bootDashboard({ initialToken: TOKEN, start401: false });

    // Token should be in sessionStorage from the seeded boot.
    expect(h.sessionStore.get('codeforge.authToken')).toBe(TOKEN);

    // Connect once successfully (so a stream / state request exists).
    await connectSession(h, 'sid-revoke');

    // Now make all requests return 401 and trigger a new fetch.
    h.force401 = true;
    // Reset the session input so connect() sends requests.
    h.allFetchCalls.length = 0;
    const sessionInput = h.byId.get('session') ?? h.document.getElementById('session');
    sessionInput.value = 'sid-revoke-2';
    (h.byId.get('connect') ?? h.document.getElementById('connect')).fire('click');
    await flush(); await flush(); await flush();

    // sessionStorage token key must have been removed.
    expect(h.sessionStore.get('codeforge.authToken')).toBeUndefined();

    // authForm must be visible again.
    const form = h.byId.get('authForm') ?? h.document.getElementById('authForm');
    expect(form.hidden).toBe(false);
  });

  // ── Scenario 7: without a token, /stream uses EventSource ────────────────
  it('7. without a token, /stream is opened via EventSource (not fetch)', async () => {
    // Validates: Requirement 9.6
    // No token, no 401 — EventSource path.
    const h = await bootDashboard({ start401: false });
    h.allFetchCalls.length = 0;

    await connectSession(h, 'sess-eventsource');

    // EventSource must have been constructed.
    expect(h.eventSourceConstructed).toBe(true);

    // fetch must NOT have been used for /stream.
    const streamFetchCalls = h.allFetchCalls.filter((c) => c.url.includes('/stream'));
    expect(streamFetchCalls.length).toBe(0);
  });

  // ── Scenario 8: asset scan — no hardcoded credentials ────────────────────
  it('8a. DASHBOARD_JS contains no hardcoded token, API key or password', () => {
    // Validates: Requirement 8.4
    //
    // Allow list of intentional "Bearer " occurrences that only construct the header dynamically:
    //   - `"Bearer " + authToken`  — the authHeaders() function
    // Any literal `Bearer ` followed by a non-variable, non-placeholder credential (16+ alphanum chars
    // with no surrounding quotes/plus) is a violation.
    //
    // The pattern /Bearer [a-zA-Z0-9_-]{16,}/ must NOT match anywhere in the source.
    expect(DASHBOARD_JS).not.toMatch(/Bearer [a-zA-Z0-9_/+=-]{16,}/);

    // The literal string CODEFORGE_AUTH_TOKEN must not appear as a credential value in the JS
    // (it's the env-var name used server-side; the dashboard must not reference it at all).
    expect(DASHBOARD_JS).not.toContain('CODEFORGE_AUTH_TOKEN');

    // No hardcoded API-key or password assignment patterns.
    expect(DASHBOARD_JS).not.toMatch(/apiKey\s*[:=]\s*["'][^"']{8,}/i);
    expect(DASHBOARD_JS).not.toMatch(/password\s*=\s*["'][^"']{8,}/i);
    expect(DASHBOARD_JS).not.toMatch(/secret\s*=\s*["'][^"']{8,}/i);
  });

  it('8b. DASHBOARD_HTML contains no hardcoded token, API key or password', () => {
    // Validates: Requirement 8.4
    expect(DASHBOARD_HTML).not.toMatch(/Bearer [a-zA-Z0-9_/+=-]{16,}/);
    expect(DASHBOARD_HTML).not.toContain('CODEFORGE_AUTH_TOKEN');
    expect(DASHBOARD_HTML).not.toMatch(/apiKey\s*[:=]\s*["'][^"']{8,}/i);
    expect(DASHBOARD_HTML).not.toMatch(/password\s*=\s*["'][^"']{8,}/i);
    expect(DASHBOARD_HTML).not.toMatch(/secret\s*=\s*["'][^"']{8,}/i);
  });

  // ── Extra: token stored in sessionStorage (not localStorage) ─────────────
  it('R9.2: submitted token is stored in sessionStorage under TOKEN_KEY', async () => {
    // Validates: Requirement 9.2
    const TOKEN = 'sessionstorage-only-check';
    const h = await bootDashboard({ start401: true });
    h.force401 = false;
    await submitToken(h, TOKEN);
    expect(h.sessionStore.get('codeforge.authToken')).toBe(TOKEN);
    // localStorage must still be untouched.
    expect(h.localStorageTouched).toBe(false);
  });
});
