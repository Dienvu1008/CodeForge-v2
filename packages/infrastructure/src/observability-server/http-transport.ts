// HttpTransport (P9.3) — a THIN node:http adapter over ObservabilityService. Zero new
// dependencies. It only: parses the request, calls the protocol-agnostic service, and
// serializes JSON or SSE. No business logic lives here — swapping to another server
// (Fastify, Hono, WebSocket) is a new transport over the SAME service.
//
// Routes:
//   GET  /state?session=<id>        -> RuntimeProjection (OB-005)
//   GET  /trace?session=<id>        -> ActivityTrace (OB-007)
//   GET  /events?session=<id>&from= -> DomainEvent[] (replay, OB-004)
//   GET  /sessions?limit=           -> { sessions: [{sessionId,state,createdAt}] } (recent, read-only)
//   GET  /workspace/files           -> { files: [{path,sizeBytes}] } (the agent's result, read-only)
//   GET  /config                    -> { workspaceRoot, model, endpoint } (runtime config)
//   POST /config/model {model}      -> { model } (switch the active model at runtime)
//   GET  /stream?session=<id>&from= -> text/event-stream live tail (OB-009)
//   POST /control  {ControlRequest} -> { admission, record } (OB-006)
//   POST /goal     {description, acceptanceCriteria?} -> { goalId, position } (P10.9)
//   GET  /models                    -> { models: OllamaModelInfo[] } (model management)
//   POST /models/pull {name}        -> text/event-stream pull progress (model download)
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
      if (method === 'GET' && path === '/metrics') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, await this.opts.service.getMetrics(session));
      }
      if (method === 'GET' && path === '/events') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, await this.opts.service.getEvents(session, from));
      }
      if (method === 'GET' && path === '/sessions') {
        const limit = Number(url.searchParams.get('limit') ?? '20') || 20;
        return this.sendJson(res, 200, { sessions: await this.opts.service.listRecentSessions(limit) });
      }
      if (method === 'GET' && path === '/workspace/files') {
        return this.sendJson(res, 200, { files: await this.opts.service.listWorkspaceFiles() });
      }
      if (method === 'GET' && path === '/config') {
        const cfg = this.opts.service.getRuntimeConfig();
        return cfg === null
          ? this.sendJson(res, 501, { error: 'runtime config not wired' })
          : this.sendJson(res, 200, cfg);
      }
      if (method === 'POST' && path === '/config/model') {
        const body = await readBody(req);
        let payload: { model?: unknown };
        try { payload = JSON.parse(body) as typeof payload; }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        if (typeof payload.model !== 'string' || payload.model.trim() === '') {
          return this.sendJson(res, 400, { error: 'model required' });
        }
        try {
          const model = this.opts.service.setActiveModel(payload.model);
          return this.sendJson(res, 200, { model });
        } catch (err) {
          return this.sendJson(res, 501, { error: err instanceof Error ? err.message : 'config unavailable' });
        }
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
      if (method === 'POST' && path === '/goal') {
        // P10.9: enqueue a NEW goal at runtime. Transport only — the service/ingress
        // builds the Goal and queues it; the runtime worker routes it through the kernel.
        const body = await readBody(req);
        let payload: { description?: unknown; acceptanceCriteria?: unknown };
        try { payload = JSON.parse(body) as typeof payload; }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        if (typeof payload.description !== 'string' || payload.description.trim() === '') {
          return this.sendJson(res, 400, { error: 'description required' });
        }
        const acceptanceCriteria = Array.isArray(payload.acceptanceCriteria)
          ? payload.acceptanceCriteria.filter((c): c is string => typeof c === 'string')
          : undefined;
        try {
          const result = this.opts.service.submitGoal({
            description: payload.description,
            ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
          });
          return this.sendJson(res, 202, result);
        } catch (err) {
          // Goal ingress not wired, or an empty-description guard tripped.
          return this.sendJson(res, 501, { error: err instanceof Error ? err.message : 'goal ingress unavailable' });
        }
      }

      // Model management: list installed models + stream a pull (download) with progress.
      if (method === 'GET' && path === '/models') {
        try {
          return this.sendJson(res, 200, { models: await this.opts.service.listModels() });
        } catch (err) {
          return this.sendJson(res, 501, { error: err instanceof Error ? err.message : 'model admin unavailable' });
        }
      }
      if (method === 'POST' && path === '/models/pull') {
        const body = await readBody(req);
        let payload: { name?: unknown };
        try { payload = JSON.parse(body) as typeof payload; }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        if (typeof payload.name !== 'string' || payload.name.trim() === '') {
          return this.sendJson(res, 400, { error: 'model name required' });
        }
        return this.streamModelPull(req, res, payload.name);
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
      // The read can race with a teardown that closes the underlying DB (e.g. the server
      // and DB are torn down together between poll iterations). A read failure here is a
      // teardown signal, not an error to propagate — stop quietly, mirroring the write
      // guard below (otherwise it surfaces as an unhandled rejection, e.g. DB_NOT_OPEN).
      let events;
      try {
        events = await this.opts.service.getEvents(session, cursor);
      } catch { break; }
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

  // ── model pull (SSE progress; download is a long-running operation) ─────────────

  private async streamModelPull(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let closed = false;
    const stop = (): void => { closed = true; };
    req.on('close', stop);
    res.on('error', stop);

    const write = (payload: unknown): void => {
      if (closed || !res.writable) return;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { closed = true; }
    };

    try {
      await this.opts.service.pullModel(name, (p) => write(p));
      write({ status: 'done', done: true });
    } catch (err) {
      write({ status: 'error', done: true, error: err instanceof Error ? err.message : 'pull failed' });
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
    // no-store: the dashboard asset changes with the build; never let a browser serve a stale
    // copy (that made a fixed Submit-Goal handler look "broken" because the old JS was cached).
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }
  private sendJs(res: ServerResponse, js: string): void {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
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
