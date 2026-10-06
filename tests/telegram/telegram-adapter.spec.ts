// P9.8 — Telegram adapter: command router (offline) + transport (fake API client).
// Proves OB-006 one-control-path: a Telegram /pause admits identically to a dashboard
// Pause, through the SAME ObservabilityService.
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
  TelegramCommandRouter,
  TelegramTransport,
  runMigrations,
  createMigrationRegistry,
  type TelegramApiClient,
  type TelegramUpdate,
} from '@codeforge/infrastructure';
import {
  ControlPlane,
  SessionService,
  ExecutionCoordinator,
  type Session,
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
      ollamaModels: { planner: 'p', critic: 'c', executor: 'qwen2.5-coder', analyzer: 'a' } },
  };
}

let db: SqliteDatabaseAdapter;
let service: ObservabilityService;
let router: TelegramCommandRouter;
let sessionSvc: SessionService;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  const c = makeCounters();
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
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

  service = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events, controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    now: c.now, nextId: c.nextId,
  });
  router = new TelegramCommandRouter({ service });
});
afterEach(() => db.close());

describe('P9.8 TelegramCommandRouter — binding + reads', () => {
  it('requires binding a session before most commands', async () => {
    const r = await router.handle({ text: '/status', chatId: 'c1' });
    expect(r.text).toContain('No session bound');
  });

  it('/use binds a session, then /status reports state', async () => {
    expect((await router.handle({ text: '/use S', chatId: 'c1' })).text).toContain('Bound to session S');
    const r = await router.handle({ text: '/status', chatId: 'c1' });
    expect(r.chatId).toBe('c1');
    expect(r.text).toContain('S — RUNNING');
    expect(r.text).toContain('model qwen2.5-coder');
  });

  it('/task lists the task tree', async () => {
    router.bind('c1', 'S');
    const r = await router.handle({ text: '/task', chatId: 'c1' });
    expect(r.text).toContain('T1');
  });

  it('/log shows recent activity', async () => {
    router.bind('c1', 'S');
    const r = await router.handle({ text: '/log', chatId: 'c1' });
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('/help and empty text return usage', async () => {
    expect((await router.handle({ text: '/help', chatId: 'c1' })).text).toContain('CodeForge control bot');
    expect((await router.handle({ text: '', chatId: 'c1' })).text).toContain('CodeForge control bot');
  });

  it('unknown command returns help', async () => {
    router.bind('c1', 'S');
    expect((await router.handle({ text: '/frobnicate', chatId: 'c1' })).text).toContain('Unknown command');
  });
});

describe('P9.8 TelegramCommandRouter — control (OB-006 one path)', () => {
  it('/pause admits and transitions the session to PAUSED', async () => {
    router.bind('c1', 'S');
    const r = await router.handle({ text: '/pause', chatId: 'c1' });
    expect(r.text).toContain('pause: admitted');
    expect((await service.getState('S'))!.sessionState).toBe('PAUSED');
  });

  it('/resume returns the session to RUNNING', async () => {
    router.bind('c1', 'S');
    await router.handle({ text: '/pause', chatId: 'c1' });
    const r = await router.handle({ text: '/resume', chatId: 'c1' });
    expect(r.text).toContain('resume: admitted');
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING');
  });

  it('a non-admissible control is reported as rejected and changes nothing', async () => {
    router.bind('c1', 'S');
    const r = await router.handle({ text: '/resume', chatId: 'c1' }); // not PAUSED
    expect(r.text).toContain('resume: rejected');
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING');
  });

  it('a Telegram /pause produces the SAME admitted action as a dashboard pause', async () => {
    router.bind('c1', 'S');
    // Dashboard-shaped request directly to the service.
    const dash = await service.submitControl({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    // Reset to RUNNING, then the Telegram path.
    await service.submitControl({ intent: 'resume', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    const before = (await service.getState('S'))!.sessionState;
    await router.handle({ text: '/pause', chatId: 'c1' });
    const after = (await service.getState('S'))!.sessionState;
    expect(dash.admission.admitted).toBe(true);
    expect(before).toBe('RUNNING');
    expect(after).toBe('PAUSED'); // telegram path reached the same kernel effect
  });

  it('/approve without a tool call id is rejected (missing target)', async () => {
    router.bind('c1', 'S');
    const r = await router.handle({ text: '/approve', chatId: 'c1' });
    expect(r.text).toContain('approve: rejected');
  });
});

describe('P9.8 TelegramTransport — poll loop over a fake API client', () => {
  class FakeClient implements TelegramApiClient {
    public readonly sent: Array<{ chatId: string; text: string }> = [];
    constructor(private readonly queue: TelegramUpdate[]) {}
    async getUpdates(offset: number): Promise<readonly TelegramUpdate[]> {
      const batch = this.queue.filter((u) => u.updateId >= offset);
      this.queue.length = 0; // deliver once
      return batch;
    }
    async sendMessage(chatId: string, text: string): Promise<void> { this.sent.push({ chatId, text }); }
  }

  it('routes an update through the router and sends the reply; advances offset', async () => {
    router.bind('c1', 'S');
    const client = new FakeClient([
      { updateId: 10, message: { chatId: 'c1', text: '/status' } },
      { updateId: 11, message: { chatId: 'c1', text: '/pause' } },
    ]);
    const transport = new TelegramTransport({ router, client });

    const handled = await transport.pollOnce();
    expect(handled).toBe(2);
    expect(transport.currentOffset).toBe(12); // past updateId 11
    expect(client.sent[0]!.text).toContain('RUNNING');
    expect(client.sent[1]!.text).toContain('pause: admitted');
    expect((await service.getState('S'))!.sessionState).toBe('PAUSED');
  });

  it('ignores updates without a message', async () => {
    const client = new FakeClient([{ updateId: 5 }]);
    const transport = new TelegramTransport({ router, client });
    expect(await transport.pollOnce()).toBe(0);
    expect(transport.currentOffset).toBe(6);
    expect(client.sent).toEqual([]);
  });
});
