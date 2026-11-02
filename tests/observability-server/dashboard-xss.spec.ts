/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Dashboard XSS / HTML-injection regression test (P0 security hardening).
//
// Runs the REAL DASHBOARD_JS inside a tiny stub DOM (the repo has no jsdom). Every network response
// is attacker-controlled: model output (MISSION_* payloads, task ids), workspace file names and
// content (diffs), tool arguments/results (/changes), session metadata (/state, /sessions,
// /config), model names and error messages. The test then asserts that attacker markup never
// escapes into the DOM:
//
// (a) No HTML sink (innerHTML / insertAdjacentHTML) receives a payload tag, on* event-handler
//     attribute, or javascript: URL.
// (b) Data-derived className values are in the TASK_STATE_CLASS / CHANGE_KIND_CLASS / GOV_LEVEL_CLASS
//     allowlists (no attribute injection through class='k <payload>').
// (c) Payload strings appear verbatim as textContent (the renderers actually ran and the strings
//     were treated as text, not markup). This replaces the stale `sinks.length > 5` guard.
// (d) No href or src attribute holds a non-http(s) scheme (no javascript: URLs in links).
//
// Text written through textContent / DOM properties is inert by construction; the test records
// it only to verify the renderers ran (assertion c).
import { describe, it, expect, beforeEach } from 'vitest';
import { DASHBOARD_JS } from '@codeforge/infrastructure';

// ── Payload corpus ────────────────────────────────────────────────────────────
const P   = `"'><img src=x onerror=alert(1)>`;          // HTML/attribute injection + dangerous tag
const P2  = `' onmouseover='alert(2)' x='`;             // attribute breakout + on* handler
const PJ  = 'javascript:alert(3)';                      // javascript: URL
const PS  = '<script>alert(4)</script>';                 // raw <script>
const PI  = '<iframe srcdoc="alert(5)">';                // <iframe srcdoc>
const PSV = '<svg onload=alert(6)>';                     // <svg> onload
const ALL_PAYLOADS = [P, P2, PJ, PS, PI, PSV] as const;

// ── DOM recording ─────────────────────────────────────────────────────────────
// Sinks: every innerHTML / insertAdjacentHTML write (these are the only paths that parse markup).
interface Sink { readonly where: string; readonly html: string }
// TextRecords: textContent / value writes — proves payload was rendered as plain text.
interface TextRecord { readonly where: string; readonly text: string }
// ClassRecords: className assignments from data-derived values.
interface ClassRecord { readonly where: string; readonly cls: string }
// AttrRecords: every setAttribute call — checked for dangerous href/src schemes.
interface AttrRecord { readonly where: string; readonly attr: string; readonly val: string }

const sinks: Sink[] = [];
const textRecords: TextRecord[] = [];
const classRecords: ClassRecord[] = [];
const attrRecords: AttrRecord[] = [];

// ── Stub DOM ──────────────────────────────────────────────────────────────────
class StubEl {
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((ev: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  hidden = false;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  onclick: unknown = null;

  private _text = '';
  private _className = '';

  constructor(readonly tag: string, readonly id = '') {}

  // ── innerHTML: records the sink and resets children ──
  set innerHTML(v: string) {
    sinks.push({ where: `#${this.id || this.tag}.innerHTML`, html: String(v) });
    this.children = [];
  }
  get innerHTML(): string { return ''; }

  // ── insertAdjacentHTML: records the sink ──
  insertAdjacentHTML(_pos: string, v: string): void {
    sinks.push({ where: `#${this.id || this.tag}.insertAdjacentHTML`, html: String(v) });
  }

  // ── textContent: records verbatim text ──
  set textContent(v: string) {
    const s = String(v);
    this._text = s;
    this.children = [];
    if (s) textRecords.push({ where: `#${this.id || this.tag}.textContent`, text: s });
  }
  get textContent(): string { return this._text; }

  // ── value: records as text (model names go through .value on <option>) ──
  get value(): string { return this.attrs['value'] ?? this._text; }
  set value(v: string) {
    const s = String(v);
    this.attrs['value'] = s;
    if (s) textRecords.push({ where: `#${this.id || this.tag}.value`, text: s });
  }

  // ── className: records data-derived class assignments ──
  get className(): string { return this._className; }
  set className(v: string) {
    this._className = String(v);
    if (this._className) classRecords.push({ where: `#${this.id || this.tag}.className`, cls: this._className });
  }

  get title(): string { return this.attrs['title'] ?? ''; }
  set title(v: string) { this.attrs['title'] = String(v); }

  // ── DOM manipulation ──
  get firstChild(): StubEl | null { return this.children[0] ?? null; }
  appendChild(c: StubEl): StubEl { this.children.push(c); return c; }
  removeChild(c: StubEl): StubEl { this.children = this.children.filter((x) => x !== c); return c; }

  setAttribute(k: string, v: string): void {
    const ks = String(k);
    const vs = String(v);
    this.attrs[ks] = vs;
    attrRecords.push({ where: `#${this.id || this.tag}`, attr: ks, val: vs });
  }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  querySelectorAll(): StubEl[] { return []; }
  querySelector(): StubEl | null { return null; }

  get classList() {
    return {
      add: (c: string) => {
        this._className = (this._className ? this._className + ' ' : '') + c;
        classRecords.push({ where: `#${this.id || this.tag}.classList.add`, cls: c });
      },
      remove: () => undefined,
      contains: () => false,
    };
  }

  // Helper used by fire() in runDashboard to simulate events.
  fire(type: string): void {
    for (const fn of this.listeners[type] ?? []) {
      fn({ preventDefault: () => undefined, key: '', shiftKey: false });
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
    createElement: (tag: string) => {
      const el = new StubEl(tag);
      return el;
    },
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

// ── Malicious runtime responses ───────────────────────────────────────────────
function sseBody(frames: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < frames.length
          ? { done: false, value: enc.encode(frames[i++]!) }
          : { done: true, value: undefined },
    }),
  };
}

// Inject payloads through LLM/model output (MISSION_* event payloads, task ids, plan text).
const evil = {
  type: 'MISSION_RECEIVED',
  at: `2026-01-01T00:00:00${P}`,
  sequenceNumber: 1,
  payload: { description: P },
};

const EVENTS = [
  evil,
  { type: 'MISSION_CLASSIFIED',            at: 't', payload: { missionType: PS,  matchedKeyword: P2 } },
  { type: 'MISSION_UNCERTAINTY_ASSESSED',  at: 't', payload: { level: PI,  openQuestions: [PSV] } },
  { type: 'MISSION_ASSUMPTIONS_MADE',      at: 't', payload: { clarifiedGoal: PJ, assumptions: [{ assumption: P, acceptance: P2 }] } },
  { type: 'VERIFICATION_ENDED',            at: 't', payload: { status: P,  scope: P2 } },
  { type: 'RECOVERY_ACTION_TAKEN',         at: 't', payload: { action: PS, outcome: PI, reason: PSV } },
  // Tool-call approval: inject payloads through toolCallId (session metadata + approval banner).
  { type: 'TOOL_CALL_REQUESTED',           at: 't', payload: { state: 'APPROVAL_PENDING', toolCallId: P } },
  // Unknown event type: the type itself is attacker-controlled.
  { type: P, at: 't', payload: {} },
];

// Inject through: model names (/models), error messages (/goal, /models, /config/model),
// workspace file names (/workspace/files), diffs (/changes), session metadata (/state, /sessions, /config).
const RESPONSES: Record<string, unknown> = {
  '/config': { workspaceRoot: P, model: PS, endpoint: PI },
  '/models': {
    models: [
      { name: P,   parameterSize: P2,  quantization: PSV, sizeBytes: 1 },
      { name: P2,  parameterSize: PS,  quantization: PJ,  sizeBytes: 2 },
      { name: PJ,  parameterSize: PI,  quantization: P,   sizeBytes: 3 },
    ],
  },
  '/sessions': { sessions: [{ sessionId: P2, state: PS, createdAt: 't' }] },
  '/state': {
    sessionId: P,   sessionState: PS,  graphVersion: PJ,
    model: PI,      provider: PSV,
    counts: { total: P, passed: 0, active: 0, blocked: 0, failed: 0 },
    tasks: [
      { taskId: P,   state: P,          dependsOn: [] },
      { taskId: P2,  state: 'RUNNING',  dependsOn: [P] },
      { taskId: PS,  state: PI,         dependsOn: [P2] },
      { taskId: PSV, state: 'FAILED',   dependsOn: [PS] },
    ],
  },
  '/events': EVENTS,
  '/trace':  { entries: EVENTS },
  // Tool args/results through /changes: inject payload through kind (class injection vector),
  // path, summary, and diff lines.
  '/changes': {
    changes: [
      {
        toolCallId: P,  toolName: P2, kind: PSV,  path: P,
        state: PS,      at: PJ,       summary: PI,
        diff: `+${P}\n-${P2}\n ${PS}`,
      },
      {
        toolCallId: PS, toolName: PI, kind: 'edit', path: PJ,
        state: P2,      at: P,        summary: PSV,
        diff: `+${PI}\n-${PSV}`,
      },
    ],
  },
  '/workspace/files': {
    files: [
      { path: P,   sizeBytes: P2 },
      { path: PS,  sizeBytes: 1  },
      { path: PJ + '.js', sizeBytes: 1 },
      { path: PSV, sizeBytes: 2  },
    ],
  },
  // Goal error message through /goal.
  '/goal': { error: P },
};

async function runDashboard(): Promise<void> {
  // Reset all recording arrays.
  sinks.length = 0;
  textRecords.length = 0;
  classRecords.length = 0;
  attrRecords.length = 0;

  const { document } = makeDom();
  const fakeFetch = async (url: string) => {
    const path = String(url).split('?')[0]!;
    if (path === '/stream') {
      return {
        ok: true, status: 200,
        body: sseBody([`id: 1\ndata: ${JSON.stringify(evil)}\n\n`]),
        json: async () => ({}),
      };
    }
    const body = RESPONSES[path] ?? {};
    const ok = path !== '/goal';
    return { ok, status: ok ? 200 : 400, json: async () => body, body: null };
  };

  let lastEventSource: { onmessage?: (ev: { data: string }) => void; onopen?: () => void; close: () => void } | undefined;
  class FakeEventSource {
    onmessage?: (ev: { data: string }) => void;
    constructor() { lastEventSource = this as never; }
    close() {}
  }

  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };

  const run = new Function(
    'window', 'document', 'fetch', 'EventSource', 'sessionStorage',
    'setInterval', 'setTimeout', 'AbortController', 'TextDecoder',
    DASHBOARD_JS,
  );
  run(
    { fetch: fakeFetch }, document, fakeFetch, FakeEventSource,
    sessionStorage, () => 0, () => 0, AbortController, TextDecoder,
  );

  const flush = () => new Promise((r) => setTimeout(r, 15));
  await flush();

  // Connect to a session — drives /state, /events, /changes, /workspace/files, /trace, /stream.
  document.getElementById('session').value = 'S';
  document.getElementById('connect').fire('click');
  await flush();
  await flush();

  // Deliver an SSE event through the fake EventSource (exercises onmessage path).
  lastEventSource?.onmessage?.({ data: JSON.stringify(evil) });

  // Submit a goal that gets a malicious error response.
  document.getElementById('goalInput').value = P;
  document.getElementById('chatForm').fire('submit');
  await flush();
  await flush();
}

// ── Sink scanner ──────────────────────────────────────────────────────────────
const TAG  = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const DANGEROUS_TAGS = new Set(['img', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg']);

function findInjections(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(TAG)) {
    const tag = m[1]!.toLowerCase();
    if (DANGEROUS_TAGS.has(tag)) out.push(`<${tag}> tag`);
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      const name  = a[1]!.toLowerCase();
      const value = (a[2] ?? '').replace(/^["']|["']$/g, '').toLowerCase();
      if (name.startsWith('on')) out.push(`${name}= on <${tag}>`);
      if (value.includes('javascript:')) out.push(`javascript: URL in ${name} on <${tag}>`);
    }
  }
  return out;
}

// ── Allowlist definitions (mirroring DASHBOARD_JS) ───────────────────────────
// These mirror the constants in DASHBOARD_JS; the test verifies class tokens stay within them.
const TASK_STATE_ALLOWED  = new Set(['pending','ready','active','blocked','passed','failed','verifying','superseded']);
const CHANGE_KIND_ALLOWED = new Set(['edit','write','delete','move']);
const GOV_LEVEL_ALLOWED   = new Set(['pass','fail','recover','gate','approve','deny']);
const CHIP_STATUS_ALLOWED = new Set(['queued','running','completed','aborted','failed','awaiting_human']);
// Union of all allowlisted data-derived tokens.
const ALL_DATA_CLASSES = new Set([
  ...TASK_STATE_ALLOWED, ...CHANGE_KIND_ALLOWED, ...GOV_LEVEL_ALLOWED, ...CHIP_STATUS_ALLOWED,
]);
// Structural / static CSS classes that the dashboard always applies (never derived from data).
const STATIC_CLASSES = new Set([
  'kv', 'controls', 'bar', 'cat', 'chip', 'msg', 'meta', 'goalText', 'view',
  'gov', 'gi', 'gt', 'gm', 'sub', 'chd', 'k', 'p', 't', 'change',
  'reasoning', 'reasoning-sub',
  'ab-top', 'ab-badge', 'ab-title', 'ab-detail', 'ab-risk', 'ab-actions',
  'node', 'edge',
  // diff line classes (renderDiff)
  'add', 'del',
  // approval banner show/hide toggle
  'show',
  // empty string (classList.add called with empty string by some branches)
  '',
]);

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('dashboard: attacker-controlled data never becomes markup', () => {
  beforeEach(async () => {
    await runDashboard();
  });

  // Self-test: the scanner must catch the payloads if they were inserted raw.
  it('scanner self-test: detects dangerous content when inserted raw', () => {
    expect(findInjections(`<span>${P}</span>`)).toContain('<img> tag');
    expect(findInjections(`<a data-x='${P2}'>x</a>`)).toContain('onmouseover= on <a>');
    expect(findInjections(`<a href="${PJ}">x</a>`)).toContain('javascript: URL in href on <a>');
    expect(findInjections(PS)).toContain('<script> tag');
    expect(findInjections(PI)).toContain('<iframe> tag');
    expect(findInjections(PSV)).toContain('<svg> tag');
  });

  // (a) No HTML sink may receive an injected tag, on* attribute, or javascript: URL.
  it('(a) no HTML sink receives an injected tag, event handler, or javascript: URL', () => {
    // The only remaining innerHTML sink is the static "#approval" literal; there should be ≥ 1.
    // After 5.1 the count is exactly 2 (both are the static approval sink fired twice per connect).
    expect(sinks.length).toBeGreaterThanOrEqual(1);

    const problems = sinks.flatMap((s) =>
      findInjections(s.html).map((p) => `${s.where}: ${p}`),
    );
    expect(problems).toEqual([]);
  });

  // (b) Data-derived className values must be in the allowlists.
  it('(b) every data-derived className is in the allowlists (no attribute injection via class)', () => {
    // All payloads that could be injected into class attributes.
    const payloadSet = new Set(ALL_PAYLOADS.map((p) => p.toLowerCase()));

    const violations = classRecords.filter((r) => {
      const tokens = r.cls.trim().split(/\s+/).filter(Boolean);
      return tokens.some((tok) => {
        const lower = tok.toLowerCase();
        // Reject if it looks like markup.
        if (lower.includes('<') || lower.includes('>')) return true;
        if (/^on\w+/.test(lower)) return true;
        if (lower.includes('javascript:')) return true;
        // Reject if any payload string appears verbatim in the token.
        for (const p of payloadSet) { if (lower.includes(p)) return true; }
        // A token is only valid when it is in the static-class set OR in the data-class allowlists.
        if (STATIC_CLASSES.has(tok)) return false;  // structural class — always OK
        if (ALL_DATA_CLASSES.has(lower)) return false; // allowlisted data-derived value — OK
        // Tokens from SVG numeric attributes (x, y, width etc.) and similar pass through;
        // the dashboard never interpolates data into class="" on SVG nodes, so any unexpected
        // token from a non-static, non-allowlisted class is a violation.
        // Allow purely numeric tokens (geometry values written as className accidentally).
        if (/^\d+(\.\d+)?$/.test(tok)) return false;
        // Everything else that is not in either set is a violation.
        return !STATIC_CLASSES.has(tok) && !ALL_DATA_CLASSES.has(lower);
      });
    });

    expect(violations.map((v) => `${v.where}: "${v.cls}"`)).toEqual([]);
  });

  // (c) Payload strings appear verbatim as textContent (the renderers actually ran).
  // This asserts that the dashboarded received attacker-controlled data AND stored it safely.
  it('(c) payload strings appear verbatim as textContent (renderers ran; payloads treated as text)', () => {
    // Collect all recorded text.
    const allText = textRecords.map((r) => r.text).join('\n');

    // Every payload must appear at least once as plain text somewhere in the recorded output.
    // This proves the rendering path executed; if it never ran we'd catch bugs in the scenario.
    for (const payload of ALL_PAYLOADS) {
      expect(allText).toContain(payload);
    }
  });

  // (d) No href or src attribute may hold a non-http(s) scheme (no javascript: URLs in links/images).
  it('(d) no href or src attribute contains a non-http(s) scheme', () => {
    const schemePattern = /^[a-z][a-z0-9+.-]*:/i;
    const safeScheme    = /^https?:/i;

    const violations = attrRecords.filter((r) => {
      const attr = r.attr.toLowerCase();
      if (attr !== 'href' && attr !== 'src') return false;
      const val = r.val.trim();
      if (!val) return false;
      // Must either have a safe scheme or be a relative URL.
      return schemePattern.test(val) && !safeScheme.test(val);
    });

    expect(violations.map((v) => `${v.where} ${v.attr}="${v.val}"`)).toEqual([]);
  });
});
