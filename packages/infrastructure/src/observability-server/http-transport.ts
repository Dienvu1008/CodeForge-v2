/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// HttpTransport (P9.3) — a THIN node:http adapter over ObservabilityService. Zero new
// dependencies. It only: parses the request, calls the protocol-agnostic service, and
// serializes JSON or SSE. No business logic lives here — swapping to another server
// (Fastify, Hono, WebSocket) is a new transport over the SAME service.
//
// Routes:
//   GET  /state?session=<id>        -> RuntimeProjection (OB-005)
//   GET  /trace?session=<id>        -> ActivityTrace (OB-007)
//   GET  /events?session=<id>&from= -> DomainEvent[] (replay, OB-004)
//   GET  /changes?session=<id>      -> { changes: ChangeView[] } (agent change transcript + diffs)
//   GET  /sessions?limit=           -> { sessions: [{sessionId,state,createdAt}] } (recent, read-only)
//   GET  /workspace/files           -> { files: [{path,sizeBytes}] } (the agent's result, read-only)
//   GET  /config                    -> { workspaceRoot, model, endpoint } (runtime config)
//   POST /config/model {model}      -> { model } (switch the active model at runtime)
//   GET  /stream?session=<id>&from= -> text/event-stream live tail (OB-009)
//   POST /control  {ControlRequest} -> { admission, record } (OB-006)
//   POST /goal     {description, acceptanceCriteria?} -> { goalId, position } (P10.9)
//   POST /clarification {sessionId, answers} -> { requestId, answered, skipped } (goal clarification;
//                                   400 invalid input, 404 unknown session, 409 not awaiting, 501 off)
//   POST /plan-choice {sessionId, optionId | useRecommended:true} -> { requestId, optionId, source }
//                                   (plan options; 400 invalid, 404 unknown session, 409 not awaiting, 501 off)
//   GET  /models                    -> { models: OllamaModelInfo[] } (model management)
//   POST /models/pull {name}        -> text/event-stream pull progress (model download)
//   GET  /                          -> dashboard HTML (static client)
//   GET  /app.js                    -> dashboard script (static client)
//   GET  /health                    -> { ok: true } (liveness)
//
// Security (P0 hardening; pure policy in ./http-security.ts):
//   - Every request passes `evaluateRequest` BEFORE any body read or route branch. A rejection is
//     answered from the gate decision alone, so ObservabilityService is never touched:
//       Host ∉ allowlist → 403 · method ∉ {GET,POST,OPTIONS} → 405 · OPTIONS from a non-allowlisted
//       Origin → 403 · foreign Origin on a protected route → 403 · missing/wrong bearer token (when
//       `authToken` is set) → 401 + WWW-Authenticate · POST without application/json → 415.
//   - Public routes (GET /, /app.js, /health) skip the Origin/auth checks but not the Host check.
//   - CORS: no wildcard. Only allowlisted origins get an exact Access-Control-Allow-Origin +
//     `Vary: Origin`; preflight answers 204 only for them.
//   - `listen` fails closed: a non-loopback bind (or `requireAuth`) without a token is rejected, as
//     is an invalid or `*` allowed origin. The policy is built with the real port after bind.
//   - Error bodies (status ≥ 400, and the /models/pull SSE error frame) are redacted of the token;
//     unexpected errors answer 500 { error: 'internal error' } with no message echo.
//   - Static assets carry `X-Content-Type-Options: nosniff` and a CSP (no frame-ancestors, so the
//     VS Code webview can keep embedding the dashboard in an iframe).
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { ControlRequest } from '@codeforge/agent-core';
import { ObservabilityServiceError, type ObservabilityService } from './observability-service.js';
import { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard-assets.js';
import {
  buildAllowedHosts,
  evaluateRequest,
  isLoopbackAddress,
  normalizeOrigin,
  redactSecret,
  type SecurityPolicy,
} from './http-security.js';

export interface HttpTransportOptions {
  readonly service: ObservabilityService;
  /** Poll interval (ms) for the SSE tail. Default 500. */
  readonly streamPollMs?: number;
  /** Shared bearer token. When set, Protected_Route requests require it. */
  readonly authToken?: string;
  /** Force auth even on loopback. Default: true when authToken is set. Requires authToken. */
  readonly requireAuth?: boolean;
  /** Extra Host header hostnames (no port) accepted besides the loopback names. */
  readonly allowedHosts?: readonly string[];
  /** Exact cross-origin origins allowed (CORS + Origin check). Default: none. */
  readonly allowedOrigins?: readonly string[];
}

/** CSP for the static dashboard assets (design C2). No frame-ancestors: the VS Code webview iframes it. */
const STATIC_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

export class HttpTransport {
  private readonly server: Server;
  private readonly streamPollMs: number;
  /** Open sockets, tracked so close() can force-drain lingering SSE connections. */
  private readonly sockets = new Set<Socket>();
  /** In-flight handle() promises, tracked so close() can await full teardown. */
  private readonly handlers = new Set<Promise<void>>();
  /** Set to true when close() begins; SSE loops check this to stop promptly. */
  private closing = false;
  /** Gate policy; built in listen() once the real port is known. */
  private policy: SecurityPolicy | undefined;

  constructor(private readonly opts: HttpTransportOptions) {
    this.streamPollMs = opts.streamPollMs ?? 500;
    this.server = createServer((req, res) => {
      const p = this.handle(req, res);
      this.handlers.add(p);
      p.finally(() => this.handlers.delete(p));
    });
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /**
   * Start listening. Returns the bound port (useful with port 0 for tests). Fails closed: a
   * non-loopback host or `requireAuth` without a token, or an invalid / `*` allowed origin, rejects
   * without binding.
   */
  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    const token = this.opts.authToken;
    if (!isLoopbackAddress(host) && token === undefined) {
      return Promise.reject(new Error(`auth token required to bind non-loopback host ${host}`));
    }
    if (this.opts.requireAuth === true && token === undefined) {
      return Promise.reject(new Error('requireAuth is set but no auth token was provided'));
    }
    if (!isLoopbackAddress(host) && this.opts.requireAuth === false) {
      return Promise.reject(new Error(`auth cannot be disabled when binding non-loopback host ${host}`));
    }
    const origins = new Set<string>();
    for (const entry of this.opts.allowedOrigins ?? []) {
      const normalized = entry.trim() === '*' ? null : normalizeOrigin(entry);
      if (normalized === null) return Promise.reject(new Error(`invalid allowed origin: ${entry}`));
      origins.add(normalized);
    }
    const enforcedToken = this.opts.requireAuth === false ? undefined : token;

    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => { reject(err); };
      this.server.once('error', onError);
      this.server.listen(port, host, () => {
        this.server.off('error', onError);
        const bound = (this.server.address() as AddressInfo).port;
        this.policy = {
          allowedHosts: buildAllowedHosts(host, bound, this.opts.allowedHosts ?? []),
          allowedOrigins: origins,
          ...(enforcedToken !== undefined ? { authToken: enforcedToken } : {}),
        };
        resolve(bound);
      });
    });
  }

  close(): Promise<void> {
    this.closing = true;
    // Force-drain any lingering connections (e.g. an open SSE stream) so close()
    // resolves promptly instead of waiting on keep-alive sockets.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    // Wait for the server to stop accepting new connections, then for every in-flight
    // handle() to finish. This prevents the DB from being closed while an SSE poll
    // loop is still mid-read (a dangling better-sqlite3 call causes a native crash on
    // Windows when the DB is torn down under the loop — Requirement 11.3/11.4).
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        // All connections are gone; wait for any still-running async handlers to drain.
        void Promise.allSettled([...this.handlers]).then(() => resolve());
      });
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

      // Security gate: metadata only (no body read), before any route branch (Requirement 7).
      const policy = this.policy;
      if (policy === undefined) return this.sendJson(res, 503, { error: 'server not ready' });
      const decision = evaluateRequest({
        method,
        path,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
      }, policy);
      if (decision.kind === 'reject') {
        if (decision.wwwAuthenticate === true) res.setHeader('WWW-Authenticate', 'Bearer');
        return this.sendJson(res, decision.status, { error: decision.error });
      }
      if (decision.kind === 'preflight') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': decision.corsOrigin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (decision.corsOrigin !== undefined) {
        // Exact allowlisted origin only — never `*` (Requirement 5.1, 5.2).
        res.setHeader('Access-Control-Allow-Origin', decision.corsOrigin);
        res.setHeader('Vary', 'Origin');
      }

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
      if (method === 'GET' && path === '/changes') {
        if (session === '') return this.sendJson(res, 400, { error: 'session required' });
        return this.sendJson(res, 200, { changes: await this.opts.service.getChanges(session) });
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

      if (method === 'POST' && path === '/clarification') {
        // Goal clarification answers. Transport only — the service/coordinator validates and
        // accepts at most once; this route never writes events (OB-009).
        const body = await readBody(req);
        let payload: unknown;
        try { payload = JSON.parse(body); }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        const fields = isPlainObject(payload) ? payload : {};
        const sessionId = fields['sessionId'];
        if (typeof sessionId !== 'string' || sessionId === '') {
          return this.sendJson(res, 400, { error: 'sessionId required' });
        }
        const answers = fields['answers'];
        if (!isPlainObject(answers) || Object.keys(answers).length === 0) {
          return this.sendJson(res, 400, { error: 'answers required' });
        }
        let result;
        try {
          result = await this.opts.service.submitClarification(sessionId, answers);
        } catch (err) {
          if (err instanceof ObservabilityServiceError && err.code === 'CLARIFICATION_UNSUPPORTED') {
            return this.sendJson(res, 501, { error: 'clarification not enabled' });
          }
          if (err instanceof ObservabilityServiceError && err.code === 'SESSION_NOT_FOUND') {
            return this.sendJson(res, 404, { error: 'session not found' });
          }
          throw err; // falls through to the generic 500 handler
        }
        if (result.ok) {
          return this.sendJson(res, 200, { requestId: result.requestId, answered: result.answered, skipped: result.skipped });
        }
        switch (result.code) {
          case 'NOT_AWAITING': return this.sendJson(res, 409, { error: 'session not awaiting clarification' });
          case 'NON_STRING_ANSWER': return this.sendJson(res, 400, { error: 'answers must be strings' });
          case 'UNKNOWN_QUESTION': return this.sendJson(res, 400, { error: result.message });
          case 'ANSWER_TOO_LONG': return this.sendJson(res, 400, { error: 'answer too long' });
          case 'EMPTY_ANSWERS': return this.sendJson(res, 400, { error: 'answers required' });
          default: return this.sendJson(res, 400, { error: 'invalid answers' });
        }
      }

      if (method === 'POST' && path === '/plan-choice') {
        // Plan options choice. Transport only — the service/coordinator validates and accepts at
        // most once; this route never writes events (OB-009).
        const body = await readBody(req);
        let payload: unknown;
        try { payload = JSON.parse(body); }
        catch { return this.sendJson(res, 400, { error: 'invalid JSON body' }); }
        const fields = isPlainObject(payload) ? payload : {};
        const sessionId = fields['sessionId'];
        if (typeof sessionId !== 'string' || sessionId === '') {
          return this.sendJson(res, 400, { error: 'sessionId required' });
        }
        let result;
        try {
          result = await this.opts.service.submitPlanChoice(sessionId, fields);
        } catch (err) {
          if (err instanceof ObservabilityServiceError && err.code === 'PLAN_OPTIONS_UNSUPPORTED') {
            return this.sendJson(res, 501, { error: 'plan options not enabled' });
          }
          if (err instanceof ObservabilityServiceError && err.code === 'SESSION_NOT_FOUND') {
            return this.sendJson(res, 404, { error: 'session not found' });
          }
          throw err;
        }
        if (result.ok) {
          return this.sendJson(res, 200, { requestId: result.requestId, optionId: result.optionId, source: result.source });
        }
        if (result.code === 'NOT_AWAITING') return this.sendJson(res, 409, { error: 'session not awaiting plan choice' });
        return this.sendJson(res, 400, { error: result.message });
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
    } catch {
      // Never echo err.message: it can carry paths, payloads or the token (Requirement 8.2).
      if (res.headersSent) { try { res.end(); } catch { /* already torn down */ } return; }
      this.sendJson(res, 500, { error: 'internal error' });
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
    while (!closed && !this.closing && res.writable) {
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
        if (closed || this.closing || !res.writable) break;
        // Writes can race with a socket teardown; swallow the teardown error.
        try {
          res.write(`id: ${e.sequenceNumber}\n`);
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch { closed = true; break; }
        cursor = e.sequenceNumber;
      }
      if (closed || this.closing) break;
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
      const message = err instanceof Error ? err.message : 'pull failed';
      write({ status: 'error', done: true, error: redactSecret(message, this.opts.authToken) });
    }
    try { res.end(); } catch { /* already torn down */ }
  }

  // ── serializers ────────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    // Error bodies never carry the token (Requirement 8.1).
    const safe = status >= 400 ? redactStrings(body, this.opts.authToken) : body;
    const json = JSON.stringify(safe);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(json);
  }
  private sendHtml(res: ServerResponse, html: string): void {
    // no-store: the dashboard asset changes with the build; never let a browser serve a stale
    // copy (that made a fixed Submit-Goal handler look "broken" because the old JS was cached).
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': STATIC_CSP,
    });
    res.end(html);
  }
  private sendJs(res: ServerResponse, js: string): void {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': STATIC_CSP,
    });
    res.end(js);
  }
}

/** Deep-copy `value` with every string passed through `redactSecret` (error bodies only). */
function redactStrings(value: unknown, secret: string | undefined): unknown {
  if (secret === undefined || secret === '') return value;
  if (typeof value === 'string') return redactSecret(value, secret);
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, secret));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v, secret);
    return out;
  }
  return value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A non-null, non-array object (JSON object literal). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
