// HttpTransport (P9.3) — a THIN node:http adapter over ObservabilityService. Zero new
// dependencies. It only: parses the request, calls the protocol-agnostic service, and
// serializes JSON or SSE. No business logic lives here — swapping to another server
// (Fastify, Hono, WebSocket) is a new transport over the SAME service.
//
// Routes:
//   GET  /state?session=<id>        -> RuntimeProjection (OB-005)
//   GET  /trace?session=<id>        -> ActivityTrace (OB-007)
//   GET  /events?session=<id>&from= -> DomainEvent[] (replay, OB-004)
//   GET  /stream?session=<id>&from= -> text/event-stream live tail (OB-009)
//   POST /control  {ControlRequest} -> { admission, record } (OB-006)
//   GET  /                          -> dashboard HTML (static client)
//   GET  /app.js                    -> dashboard script (static client)
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ControlRequest } from '@codeforge/agent-core';
import type { ObservabilityService } from './observability-service.js';
import { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard-assets.js';

export interface HttpTransportOptions {
  readonly service: ObservabilityService;
  /** Poll interval (ms) for the SSE tail. Default 500. */
  readonly streamPollMs?: number;
}

export class HttpTransport {
  private readonly server: Server;
  private readonly streamPollMs: number;
  /** Open sockets, tracked so close() can force-drain lingering SSE connections. */
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: HttpTransportOptions) {
    this.streamPollMs = opts.streamPollMs ?? 500;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Start listening. Returns the bound port (useful with port 0 for tests). */
  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      // Force-drain any lingering connections (e.g. an open SSE stream) so close()
      // resolves promptly instead of waiting on keep-alive sockets.
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
    });
  }

  // ── request handling ──────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const session = url.searchParams.get('session') ?? '';
      const from = Number(url.searchParams.get('from') ?? '0') || 0;

      // Permissive CORS for a local dashboard; tighten in a hardened deploy.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (method === 'GET' && path === '/') return this.sendHtml(res, DASHBOARD_HTML);
      if (method === 'GET' && path === '/app.js') return this.sendJs(res, DASHBOARD_JS);
      if (method === 'GET' && path === '/health') return this.sendJson(res, 200, { ok: true });

      if (method === 'GET' && path === '/state') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        const state = await this.opts.service.getState(session);
        return state === null
          ? this.sendJson(res, 404, { error: 'session not found' })
          : this.sendJson(res, 200, state);
      }
      if (method === 'GET' && path === '/trace') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, await this.opts.service.getTrace(session));
      }
      if (method === 'GET' && path === '/audit') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, await this.opts.service.getAuditTimeline(session));
      }
      if (method === 'GET' && path === '/events') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, await this.opts.service.getEvents(session, from));
      }
      if (method === 'GET' && path === '/stream') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.streamSse(req, res, session, from);
      }
      if (method === 'POST' && path === '/control') {
        const body = await readBody(req);
        let request: ControlRequest;
        try { request = JSON.parse(body) as ControlRequest; }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        const result = await this.opts.service.submitControl(request);
        return this.sendJson(res, result.admission.admitted ? 200 : 409, result);
      }

      this.sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      this.sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  }

  // ── SSE live tail (read-only, polls EventLog by sequenceNumber) ─────────────────

  private async streamSse(req: IncomingMessage, res: ServerResponse, session: string, from: number): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let cursor = from;
    let closed = false;
    const stop = (): void => { closed = true; };
    req.on('close', stop);
    res.on('close', stop);
    res.on('error', stop); // socket destroyed on server close — stop quietly, no throw

    // Prime with any events already past the cursor, then poll for new ones.
    while (!closed && res.writable) {
      const events = await this.opts.service.getEvents(session, cursor);
      for (const e of events) {
        if (e.sequenceNumber <= cursor) continue;
        if (closed || !res.writable) break;
        // Writes can race with a socket teardown; swallow the teardown error.
        try {
          res.write(`id: ${e.sequenceNumber}\n`);
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch { closed = true; break; }
        cursor = e.sequenceNumber;
      }
      if (closed) break;
      await sleep(this.streamPollMs);
    }
    try { res.end(); } catch { /* already torn down */ }
  }

  // ── serializers ────────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(json);
  }
  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  private sendJs(res: ServerResponse, js: string): void {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(js);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
