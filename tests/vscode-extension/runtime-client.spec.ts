// RuntimeClient (P12.22) — pure HTTP client with an injected fake fetch (no network, no vscode).
import { describe, it, expect } from 'vitest';
import { RuntimeClient, joinUrl, type FetchLike } from '../../packages/vscode-extension/src/runtime-client.js';
import type { ControlRequest } from '@codeforge/agent-core';

/** A fake fetch that records calls and returns scripted responses keyed by URL substring. */
function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>): { fetch: FetchLike; calls: { url: string; init?: unknown }[] } {
  const calls: { url: string; init?: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { ok: false, status: 404, body: {} };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetch, calls };
}

describe('joinUrl', () => {
  it('trims a trailing slash on the base and normalises the path', () => {
    expect(joinUrl('http://x:9500/', '/state')).toBe('http://x:9500/state');
    expect(joinUrl('http://x:9500', 'state')).toBe('http://x:9500/state');
  });
});

describe('RuntimeClient', () => {
  it('getState returns the projection and null for an unreachable/unknown session', async () => {
    const { fetch } = fakeFetch({ '/state': { body: { sessionId: 'S', sessionState: 'RUNNING' } } });
    const c = new RuntimeClient({ baseUrl: 'http://x:9500', fetch });
    const st = await c.getState('S');
    expect(st?.sessionId).toBe('S');

    const { fetch: f404 } = fakeFetch({ '/other': { body: {} } }); // /state → 404
    const c2 = new RuntimeClient({ baseUrl: 'http://x:9500', fetch: f404 });
    expect(await c2.getState('S')).toBeNull();
  });

  it('getChanges unwraps { changes } and defaults to [] on error', async () => {
    const { fetch } = fakeFetch({ '/changes': { body: { changes: [{ toolCallId: 'TC1', toolName: 'write_file', kind: 'write', state: 'SUCCEEDED', at: 't', summary: 'write a' }] } } });
    const c = new RuntimeClient({ baseUrl: 'http://x:9500', fetch });
    const ch = await c.getChanges('S');
    expect(ch).toHaveLength(1);
    expect(ch[0]!.toolName).toBe('write_file');

    const { fetch: fe } = fakeFetch({ '/nope': { body: {} } });
    expect(await new RuntimeClient({ baseUrl: 'http://x:9500', fetch: fe }).getChanges('S')).toEqual([]);
  });

  it('listSessions unwraps { sessions }', async () => {
    const { fetch } = fakeFetch({ '/sessions': { body: { sessions: [{ sessionId: 'S', state: 'RUNNING', createdAt: 't' }] } } });
    const sessions = await new RuntimeClient({ baseUrl: 'http://x:9500', fetch }).listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['S']);
  });

  it('postControl posts the ControlRequest and returns the admission', async () => {
    const { fetch, calls } = fakeFetch({ '/control': { body: { admission: { admitted: true }, record: { result: 'ok' } } } });
    const c = new RuntimeClient({ baseUrl: 'http://x:9500', fetch });
    const req: ControlRequest = { intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'vscode-user', surface: 'vscode' } };
    const res = await c.postControl(req);
    expect(res.admission?.admitted).toBe(true);
    const ctrl = calls.find((x) => x.url.includes('/control'))!;
    expect((ctrl.init as { method: string }).method).toBe('POST');
    expect((ctrl.init as { body: string }).body).toContain('"intent":"pause"');
  });

  it('getEvents passes the from cursor and defaults to [] on error', async () => {
    const { fetch, calls } = fakeFetch({ '/events': { body: [{ eventId: 'E1', type: 'VERIFICATION_ENDED', at: 't', payload: {} }] } });
    const c = new RuntimeClient({ baseUrl: 'http://x:9500', fetch });
    const events = await c.getEvents('S', 5);
    expect(events).toHaveLength(1);
    expect(calls[0]!.url).toContain('from=5');
  });
});

describe('RuntimeClient.postClarification', () => {
  /** A fake fetch for /clarification returning a fixed status and a JSON (or broken) body. */
  function scripted(status: number, body: unknown, opts: { nonJson?: boolean; throws?: boolean } = {}) {
    const calls: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (opts.throws) throw new Error('ECONNREFUSED');
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { if (opts.nonJson) throw new SyntaxError('Unexpected token <'); return body; },
        text: async () => (opts.nonJson ? '<html>oops</html>' : JSON.stringify(body)),
      };
    };
    return { client: new RuntimeClient({ baseUrl: 'http://x:9500/', fetch }), calls };
  }

  it('POSTs {sessionId, answers} to /clarification and returns 200 with the body', async () => {
    const { client, calls } = scripted(200, { requestId: 'r1', answered: 1, skipped: 1 });
    const res = await client.postClarification('S', { q1: 'json' });
    expect(res).toEqual({ status: 200, body: { requestId: 'r1', answered: 1, skipped: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://x:9500/clarification');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({ sessionId: 'S', answers: { q1: 'json' } });
  });

  it('returns a 409 status with the error body as-is', async () => {
    const { client } = scripted(409, { error: 'no open clarification' });
    expect(await client.postClarification('S', { q1: 'x' })).toEqual({ status: 409, body: { error: 'no open clarification' } });
  });

  it('degrades a non-JSON body to HTTP <status>', async () => {
    const { client } = scripted(501, null, { nonJson: true });
    expect(await client.postClarification('S', { q1: 'x' })).toEqual({ status: 501, body: { error: 'HTTP 501' } });
  });

  it('returns status 0 / runtime unreachable when fetch throws', async () => {
    const { client } = scripted(0, null, { throws: true });
    expect(await client.postClarification('S', { q1: 'x' })).toEqual({ status: 0, body: { error: 'runtime unreachable' } });
  });
});
