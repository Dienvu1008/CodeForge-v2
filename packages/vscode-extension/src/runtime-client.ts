/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// RuntimeClient (P12.22) — PURE, OFFLINE-TESTABLE HTTP client for the CodeForge runtime's
// observability server. No `vscode` import: it takes an injectable `fetch` so it can be unit
// tested with a fake (and so the extension host can pass the global fetch). It only READS
// (/state, /changes, /events, /sessions, /config, /workspace/files) and submits control/goals
// through the SAME endpoints the dashboard uses (POST /control, POST /goal) — OB-006: the
// extension is a client, never a parallel authority.
import type { RuntimeProjection, DomainEvent, ControlRequest } from '@codeforge/agent-core';

/** Minimal fetch shape we depend on (so tests can inject a fake without DOM types). */
export type FetchLike = (url: string, init?: {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** One recent-session summary (GET /sessions). */
export interface SessionSummary {
  readonly sessionId: string;
  readonly state: string;
  readonly createdAt: string;
}

/** One reconstructed change (GET /changes) — mirrors ObservabilityService.ChangeView. */
export interface ChangeView {
  readonly toolCallId: string;
  readonly taskId?: string;
  readonly toolName: string;
  readonly path?: string;
  readonly state: string;
  readonly at: string;
  readonly kind: 'edit' | 'write' | 'delete' | 'move' | 'other';
  readonly diff?: string;
  readonly summary: string;
  /** Raw before/after content for a side-by-side diff (vscode.diff). Present for edit/write. */
  readonly before?: string;
  readonly after?: string;
}

/** Runtime config (GET /config). */
export interface RuntimeConfigView {
  readonly workspaceRoot: string;
  readonly model: string;
  readonly endpoint: string;
}

/** One installed model (GET /models). */
export interface ModelInfo {
  readonly name: string;
  readonly sizeBytes?: number;
  readonly parameterSize?: string;
  readonly quantization?: string;
}

/** Admission result shape returned by POST /control (we only read admitted + reason). */
export interface ControlResult {
  readonly admission?: { readonly admitted: boolean; readonly reason?: string };
  readonly record?: { readonly result?: string };
}

/** Result of POST /clarification: the HTTP status (0 = unreachable) plus the parsed body. */
export interface ClarificationPostResult {
  readonly status: number;
  readonly body: {
    readonly requestId?: string;
    readonly answered?: number;
    readonly skipped?: number;
    readonly error?: string;
  };
}

export interface RuntimeClientOptions {
  /** Base URL of the runtime HTTP server, e.g. "http://127.0.0.1:9500". */
  readonly baseUrl: string;
  /** Injectable fetch (global fetch in the extension host; a fake in tests). */
  readonly fetch: FetchLike;
}

/** Join base + path, trimming a trailing slash on the base so we never double-slash. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}

export class RuntimeClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: RuntimeClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch;
  }

  get baseUrl(): string { return this.base; }

  /** GET /state — the runtime projection, or null when unknown/unreachable. */
  async getState(sessionId: string): Promise<RuntimeProjection | null> {
    return this.getJson<RuntimeProjection>(`/state?session=${encodeURIComponent(sessionId)}`);
  }

  /** GET /changes — the agent's change transcript. Empty on any error. */
  async getChanges(sessionId: string): Promise<readonly ChangeView[]> {
    const body = await this.getJson<{ changes?: readonly ChangeView[] }>(`/changes?session=${encodeURIComponent(sessionId)}`);
    return body?.changes ?? [];
  }

  /** GET /events — ordered domain events (for the governance view). Empty on any error. */
  async getEvents(sessionId: string, fromSequence = 0): Promise<readonly DomainEvent[]> {
    const body = await this.getJson<readonly DomainEvent[]>(`/events?session=${encodeURIComponent(sessionId)}&from=${fromSequence}`);
    return body ?? [];
  }

  /** GET /sessions — recent sessions (newest first). Empty on any error. */
  async listSessions(limit = 20): Promise<readonly SessionSummary[]> {
    const body = await this.getJson<{ sessions?: readonly SessionSummary[] }>(`/sessions?limit=${limit}`);
    return body?.sessions ?? [];
  }

  /** GET /config — runtime config, or null. */
  async getConfig(): Promise<RuntimeConfigView | null> {
    return this.getJson<RuntimeConfigView>('/config');
  }

  /** GET /models — installed models (for the model picker). Empty on any error. */
  async getModels(): Promise<readonly ModelInfo[]> {
    const body = await this.getJson<{ models?: readonly ModelInfo[] }>('/models');
    return body?.models ?? [];
  }

  /** GET /health — true when the runtime HTTP server answers {ok:true}. */
  async health(): Promise<boolean> {
    const body = await this.getJson<{ ok?: boolean }>('/health');
    return body?.ok === true;
  }

  /** POST /control — submit a ControlRequest (pause/resume/cancel/checkpoint/approve/deny). */
  async postControl(request: ControlRequest): Promise<ControlResult> {
    const res = await this.fetchImpl(joinUrl(this.base, '/control'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    try { return (await res.json()) as ControlResult; }
    catch { return { admission: { admitted: false, reason: `HTTP ${res.status}` } }; }
  }

  /** POST /goal — enqueue a new goal at runtime. Returns the raw body or null on error. */
  async postGoal(description: string): Promise<{ goalId?: string; position?: number; error?: string } | null> {
    try {
      const res = await this.fetchImpl(joinUrl(this.base, '/goal'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      return (await res.json()) as { goalId?: string; position?: number; error?: string };
    } catch { return null; }
  }

  /**
   * POST /clarification — submit answers to an open goal-clarification request. Never throws:
   * the HTTP status is returned as-is (200/400/404/409/501), a non-JSON body degrades to
   * `{ error: 'HTTP <status>' }`, and a network failure yields `{ status: 0, error: 'runtime unreachable' }`.
   */
  async postClarification(sessionId: string, answers: Readonly<Record<string, string>>): Promise<ClarificationPostResult> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(joinUrl(this.base, '/clarification'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, answers }),
      });
    } catch {
      return { status: 0, body: { error: 'runtime unreachable' } };
    }
    try {
      const body = (await res.json()) as unknown;
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        return { status: res.status, body: body as ClarificationPostResult['body'] };
      }
    } catch { /* fall through */ }
    return { status: res.status, body: { error: `HTTP ${res.status}` } };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await this.fetchImpl(joinUrl(this.base, path));
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null; // unreachable runtime / parse error → null (caller degrades)
    }
  }
}
