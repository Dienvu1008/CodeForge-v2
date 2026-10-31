// P9.3 — HttpTransport integration: real node:http on an ephemeral port over a real
// ObservabilityService. Proves the thin transport maps routes to the service and that
// control flows through the kernel (OB-005/006/009).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  ClarificationCoordinator,
  runMigrations,
  createMigrationRegistry,
  type ObservabilityServiceDeps,
} from '@codeforge/infrastructure';
import {
  ControlPlane,
  SessionService,
  ExecutionCoordinator,
  buildClarificationRequest,
  type Session,
  type ClarificationOutcome,
} from '@codeforge/agent-core';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}
function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.9.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

let db: SqliteDatabaseAdapter;
let transport: HttpTransport;
let base: string;
let events: SqliteEventLog;
/** The deps the default service was built with — reused to build variant services. */
let serviceDeps: ObservabilityServiceDeps;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  const c = makeCounters();
  const sessions = new SqliteSessionRepository(db);
  events = new SqliteEventLog(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
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
  const coord = new ExecutionCoordinator({ executions, now: c.now });
  await coord.init('T1');

  serviceDeps = {
    sessions, graphs, executions, taskRuns, events, controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    now: c.now, nextId: c.nextId,
  };
  const service = new ObservabilityService(serviceDeps);
  transport = new HttpTransport({ service, streamPollMs: 50 });
  const port = await transport.listen(0);
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => { await transport.close(); db.close(); });

describe('P9.3 HttpTransport — reads', () => {
  it('GET /health returns ok', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('GET /state returns the runtime projection', async () => {
    const r = await fetch(`${base}/state?session=S`);
    expect(r.status).toBe(200);
    const st = await r.json() as { sessionState: string; tasks: unknown[] };
    expect(st.sessionState).toBe('RUNNING');
    expect(st.tasks).toHaveLength(1);
  });

  it('GET /state for unknown session is 404', async () => {
    expect((await fetch(`${base}/state?session=NOPE`)).status).toBe(404);
  });

  it('GET /state without session is 400', async () => {
    expect((await fetch(`${base}/state`)).status).toBe(400);
  });

  it('GET /trace returns a structured trace', async () => {
    const t = await (await fetch(`${base}/trace?session=S`)).json() as { entries: unknown[] };
    expect(Array.isArray(t.entries)).toBe(true);
    expect(t.entries.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /audit returns a replay timeline with phase + authority path', async () => {
    const a = await (await fetch(`${base}/audit?session=S`)).json() as {
      entries: Array<{ phase: string; authorityPath: string }>; phaseCounts: Record<string, number>;
    };
    expect(a.entries.length).toBeGreaterThanOrEqual(1);
    expect(a.entries.every((e) => typeof e.phase === 'string' && typeof e.authorityPath === 'string')).toBe(true);
    // The session lifecycle transitions were produced by the SessionStateMachine.
    expect(a.entries.some((e) => e.authorityPath === 'SessionStateMachine')).toBe(true);
    expect(typeof a.phaseCounts.lifecycle).toBe('number');
  });

  it('GET /metrics returns per-session behavior metrics', async () => {
    const m = await (await fetch(`${base}/metrics?session=S`)).json() as {
      sessionId: string; eventCount: number; tools: { requested: number }; eventTypeCounts: unknown[];
    };
    expect(m.sessionId).toBe('S');
    expect(m.eventCount).toBeGreaterThanOrEqual(1);
    expect(typeof m.tools.requested).toBe('number');
    expect(Array.isArray(m.eventTypeCounts)).toBe(true);
  });

  it('GET /changes returns a changes array (empty when toolCalls lister not wired)', async () => {
    const r = await fetch(`${base}/changes?session=S`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { changes: unknown[] };
    expect(Array.isArray(body.changes)).toBe(true);
  });

  it('GET /changes requires a session', async () => {
    const r = await fetch(`${base}/changes`);
    expect(r.status).toBe(400);
  });

  it('GET / serves the dashboard HTML and /app.js the script', async () => {
    const html = await fetch(`${base}/`);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('CodeForge');
    const js = await fetch(`${base}/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
  });
});

describe('P9.3 HttpTransport — control (OB-006)', () => {
  it('POST /control pause transitions the session to PAUSED', async () => {
    const r = await fetch(`${base}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } }),
    });
    expect(r.status).toBe(200);
    const res = await r.json() as { admission: { admitted: boolean }; record: { result: string } };
    expect(res.admission.admitted).toBe(true);
    expect(res.record.result).toBe('applied');
    const st = await (await fetch(`${base}/state?session=S`)).json() as { sessionState: string };
    expect(st.sessionState).toBe('PAUSED');
  });

  it('POST /control with a non-admissible intent returns 409 and changes nothing', async () => {
    const r = await fetch(`${base}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'resume', sessionId: 'S', requestedBy: { kind: 'user', id: 'u' } }),
    });
    expect(r.status).toBe(409);
    const st = await (await fetch(`${base}/state?session=S`)).json() as { sessionState: string };
    expect(st.sessionState).toBe('RUNNING');
  });

  it('POST /control with invalid JSON returns 400', async () => {
    const r = await fetch(`${base}/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(r.status).toBe(400);
  });
});

describe('P9.3 HttpTransport — SSE live tail (OB-009)', () => {
  it('streams a session event to a connected client', async () => {
    // Append the event BEFORE opening the stream so delivery does not depend on precise
    // append/poll timing — the server's first (prime) poll must deliver everything past
    // the cursor. This keeps the test deterministic under parallel load.
    events.appendSync({
      eventId: 'E-live', sessionId: 'S', type: 'TASK_STATE_CHANGED',
      aggregate: { kind: 'task', id: 'T1' }, payload: { to: 'READY' },
      at: '2026-01-01T00:00:30.000Z', sequenceNumber: 0,
    });

    const controller = new AbortController();
    const resp = await fetch(`${base}/stream?session=S`, {
      headers: { accept: 'text/event-stream' }, signal: controller.signal,
    });
    expect(resp.headers.get('content-type')).toContain('text/event-stream');

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 8000;
    try {
      while (Date.now() < deadline && !buf.includes('TASK_STATE_CHANGED')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } finally {
      // Cancel the reader first and AWAIT it so the body stream settles, then abort the
      // fetch. Aborting while a read is still pending can surface an unhandled rejection
      // from undici's response stream (the source of the flaky "unhandled errors" warning).
      await reader.cancel().catch(() => undefined);
      controller.abort();
    }
    expect(buf).toContain('TASK_STATE_CHANGED');
  });
});

// Goal clarification gate — POST /clarification contract (design C4).
// A REAL ClarificationCoordinator is wired as the `clarification` port. Its session ports are
// fakes (transition is a no-op; the reader reports a controllable state) so awaitAnswers() parks
// without driving the real SQLite session. The ObservabilityService still resolves the session
// against the real SQLite repo, where session 'S' exists (unknown ids → 404).
// Requirements 1.5, 5.1–5.9, 6.3.
describe('POST /clarification — contract', () => {
  let clarifyTransport: HttpTransport;
  let clarifyBase: string;
  let coordinator: ClarificationCoordinator;
  let fakeState: string;
  let waiter: Promise<ClarificationOutcome> | undefined;

  const request = buildClarificationRequest('REQ-1', 'M-1', 'G', ['What is the input?', 'What is the output?']);

  /** Park a pending request for session 'S' (not awaited; terminated in afterEach). */
  function startWaiter(): void {
    waiter = coordinator.awaitAnswers('S', request);
  }

  function post(body: string, url = clarifyBase): Promise<Response> {
    return fetch(`${url}/clarification`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
  }
  function postJson(payload: unknown, url = clarifyBase): Promise<Response> {
    return post(JSON.stringify(payload), url);
  }

  beforeEach(async () => {
    fakeState = 'AWAITING_HUMAN';
    waiter = undefined;
    coordinator = new ClarificationCoordinator({
      sessionService: { transition: async () => undefined },
      sessions: { getById: async () => ({ state: fakeState }) },
      pollIntervalMs: 5,
    });
    const service = new ObservabilityService({ ...serviceDeps, clarification: coordinator });
    clarifyTransport = new HttpTransport({ service, streamPollMs: 50 });
    clarifyBase = `http://127.0.0.1:${await clarifyTransport.listen(0)}`;
  });

  afterEach(async () => {
    // Make sure the waiter terminates: flipping the state ends the poll loop ('cancelled')
    // if it was not already answered.
    fakeState = 'CANCELLING';
    if (waiter !== undefined) await waiter;
    await clarifyTransport.close();
  });

  it('200 with {requestId, answered, skipped} and resolves the waiter', async () => {
    startWaiter();
    const r = await postJson({ sessionId: 'S', answers: { q1: 'a CSV file', q2: '   ' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ requestId: 'REQ-1', answered: 1, skipped: 1 });
    expect(await waiter).toEqual({ kind: 'answered', answers: { q1: 'a CSV file', q2: '' } });
  });

  it('400 invalid JSON body', async () => {
    startWaiter();
    const r = await post('{not json');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('400 sessionId required (missing, empty string, number)', async () => {
    startWaiter();
    for (const payload of [
      { answers: { q1: 'x' } },
      { sessionId: '', answers: { q1: 'x' } },
      { sessionId: 42, answers: { q1: 'x' } },
    ]) {
      const r = await postJson(payload);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'sessionId required' });
    }
  });

  it('400 answers required ({}, null, array, missing)', async () => {
    startWaiter();
    for (const payload of [
      { sessionId: 'S', answers: {} },
      { sessionId: 'S', answers: null },
      { sessionId: 'S', answers: ['x'] },
      { sessionId: 'S' },
    ]) {
      const r = await postJson(payload);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'answers required' });
    }
  });

  it('400 answers must be strings', async () => {
    startWaiter();
    const r = await postJson({ sessionId: 'S', answers: { q1: 7 } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'answers must be strings' });
  });

  it('400 unknown question id', async () => {
    startWaiter();
    const r = await postJson({ sessionId: 'S', answers: { qX: 'x' } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'unknown question id: qX' });
  });

  it('400 answer too long (501 chars)', async () => {
    startWaiter();
    const r = await postJson({ sessionId: 'S', answers: { q1: 'a'.repeat(501) } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'answer too long' });
  });

  it('a rejected 400 does not consume the pending request (follow-up valid POST → 200)', async () => {
    startWaiter();
    expect((await postJson({ sessionId: 'S', answers: { qX: 'x' } })).status).toBe(400);
    expect((await postJson({ sessionId: 'S', answers: { q1: 7 } })).status).toBe(400);
    expect((await postJson({ sessionId: 'S', answers: { q1: 'a'.repeat(501) } })).status).toBe(400);
    const r = await postJson({ sessionId: 'S', answers: { q1: 'in', q2: 'out' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ requestId: 'REQ-1', answered: 2, skipped: 0 });
  });

  it('404 session not found', async () => {
    startWaiter();
    const r = await postJson({ sessionId: 'NOPE', answers: { q1: 'x' } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'session not found' });
  });

  it('409 on a second submit after an accepted one', async () => {
    startWaiter();
    expect((await postJson({ sessionId: 'S', answers: { q1: 'x' } })).status).toBe(200);
    const r = await postJson({ sessionId: 'S', answers: { q2: 'y' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'session not awaiting clarification' });
  });

  it('409 when the session has no pending request', async () => {
    const r = await postJson({ sessionId: 'S', answers: { q1: 'x' } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'session not awaiting clarification' });
  });

  it('501 clarification not enabled when the port is not wired', async () => {
    // `base` is the default transport, built WITHOUT the clarification port.
    const r = await postJson({ sessionId: 'S', answers: { q1: 'x' } }, base);
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: 'clarification not enabled' });
  });
});
