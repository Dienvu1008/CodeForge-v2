// Model management — OllamaModelAdmin (list + pull parsing) and the /models + /models/pull HTTP
// routes. The admin client is deliberately NOT the ModelGateway: it has no authority over the
// runtime, it only lists/downloads local Ollama models. Uses a stubbed global fetch (no network).
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskGraphRepository,
  SqliteTaskExecutionRepository, SqliteTaskRunRepository, SqliteEventLog, SqliteWorkspaceLockService,
  ObservabilityService, HttpTransport, OllamaModelAdmin, OllamaModelAdminError,
  runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';
import { ControlPlane, SessionService, type Session } from '@codeforge/agent-core';
import type { ModelAdminPort, ModelPullProgress } from '@codeforge/infrastructure';

// ── OllamaModelAdmin unit tests (stubbed fetch) ─────────────────────────────────

describe('OllamaModelAdmin', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('listModels parses /api/tags into normalized model info', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      models: [
        { name: 'qwen2.5-coder:7b', size: 4700000000, modified_at: '2026-01-01T00:00:00Z', details: { parameter_size: '7B', quantization_level: 'Q4_K_M' } },
        { name: 'deepseek-r1:14b', size: 9000000000, details: {} },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const admin = new OllamaModelAdmin({ endpoint: 'http://localhost:11434' });
    const models = await admin.listModels();
    expect(models.map((m) => m.name)).toEqual(['deepseek-r1:14b', 'qwen2.5-coder:7b']); // sorted
    const qwen = models.find((m) => m.name === 'qwen2.5-coder:7b')!;
    expect(qwen.parameterSize).toBe('7B');
    expect(qwen.quantization).toBe('Q4_K_M');
    expect(qwen.sizeBytes).toBe(4700000000);
  });

  it('listModels throws OllamaModelAdminError when Ollama is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const admin = new OllamaModelAdmin({ endpoint: 'http://localhost:11434' });
    await expect(admin.listModels()).rejects.toBeInstanceOf(OllamaModelAdminError);
  });

  it('pullModel streams NDJSON progress and reports percent + done', async () => {
    const ndjson = [
      '{"status":"pulling manifest"}',
      '{"status":"downloading","total":100,"completed":50}',
      '{"status":"downloading","total":100,"completed":100}',
      '{"status":"success"}',
    ].join('\n');
    globalThis.fetch = vi.fn(async () => new Response(ndjson, { status: 200 })) as unknown as typeof fetch;

    const admin = new OllamaModelAdmin({ endpoint: 'http://localhost:11434' });
    const seen: ModelPullProgress[] = [];
    await admin.pullModel('qwen2.5-coder:7b', (p) => seen.push(p));

    expect(seen.some((p) => p.status === 'pulling manifest')).toBe(true);
    expect(seen.some((p) => p.percent === 50)).toBe(true);
    expect(seen[seen.length - 1]!.done).toBe(true);
  });

  it('pullModel rejects an empty name', async () => {
    const admin = new OllamaModelAdmin({ endpoint: 'http://localhost:11434' });
    await expect(admin.pullModel('   ', () => {})).rejects.toBeInstanceOf(OllamaModelAdminError);
  });
});

// ── HTTP route tests (fake ModelAdminPort; no network) ──────────────────────────

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.12.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'x', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

const FAKE_ADMIN: ModelAdminPort = {
  async listModels() { return [{ name: 'qwen2.5-coder:7b', parameterSize: '7B' }]; },
  async pullModel(_name, onProgress) {
    onProgress({ status: 'downloading', total: 10, completed: 5, percent: 50, done: false });
    onProgress({ status: 'success', done: true });
  },
};

async function buildTransport(withAdmin: boolean) {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => 't' });
  let t = 0; let n = 0;
  const now = () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`;
  const nextId = () => `ID-${n++}`;
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const lock = new SqliteWorkspaceLockService(db);
  const sessionSvc = new SessionService({ sessions, events, lock, now, nextId });
  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  const service = new ObservabilityService({
    sessions, graphs: new SqliteTaskGraphRepository(db), executions: new SqliteTaskExecutionRepository(db),
    taskRuns: new SqliteTaskRunRepository(db), events, controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    ...(withAdmin ? { modelAdmin: FAKE_ADMIN } : {}),
    now, nextId,
  });
  const transport = new HttpTransport({ service, streamPollMs: 50 });
  const port = await transport.listen(0);
  return { db, transport, base: `http://127.0.0.1:${port}` };
}

describe('model management HTTP routes', () => {
  let ctx: Awaited<ReturnType<typeof buildTransport>>;
  afterEach(async () => { if (ctx) { await ctx.transport.close(); ctx.db.close(); } });

  it('GET /models returns installed models when admin is wired', async () => {
    ctx = await buildTransport(true);
    const r = await fetch(`${ctx.base}/models`);
    expect(r.status).toBe(200);
    const body = await r.json() as { models: { name: string }[] };
    expect(body.models[0]!.name).toBe('qwen2.5-coder:7b');
  });

  it('GET /models returns 501 when admin is NOT wired (optional dep)', async () => {
    ctx = await buildTransport(false);
    expect((await fetch(`${ctx.base}/models`)).status).toBe(501);
  });

  it('POST /models/pull streams SSE progress to a terminal done frame', async () => {
    ctx = await buildTransport(true);
    const r = await fetch(`${ctx.base}/models/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'qwen2.5-coder:7b' }),
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('downloading');
    expect(text).toContain('"done":true');
  });

  it('POST /models/pull rejects an empty name with 400', async () => {
    ctx = await buildTransport(true);
    const r = await fetch(`${ctx.base}/models/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }),
    });
    expect(r.status).toBe(400);
  });

  it('GET /sessions lists recent sessions (for dashboard auto-connect after Submit Goal)', async () => {
    ctx = await buildTransport(true);
    const r = await fetch(`${ctx.base}/sessions?limit=5`);
    expect(r.status).toBe(200);
    const body = await r.json() as { sessions: { sessionId: string; state: string }[] };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.some((s) => s.sessionId === 'S')).toBe(true);
  });
});
