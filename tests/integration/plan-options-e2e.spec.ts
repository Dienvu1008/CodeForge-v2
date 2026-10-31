/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Plan options (Goal Clarification Phase 2) — end to end: SessionOrchestrator + real
// MissionIntelligence (FakeModel ApproachAdvisor) + real PlanChoiceCoordinator + real SessionService
// on SQLite + ObservabilityService/HttpTransport. The user picks over POST /plan-choice; the Planner
// receives the chosen approach and the executor receives the [chosen-approach] assumption.
// Validates: Requirements 4.1, 4.3, 5.1, 6.1, 6.2, 6.4, 9.4
import { describe, it, expect, afterEach } from 'vitest';
import {
  SessionOrchestrator,
  SessionService,
  MissionIntelligence,
  ApproachAdvisor,
  ControlPlane,
  type Goal,
  type Session,
  type WorkspaceRevision,
  type TaskGraph,
  type GraphMutation,
  type Task,
  type TaskExecutorRequest,
  type SessionOrchestratorDeps,
  type PlanOption,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteEventLog,
  SqliteWorkspaceLockService,
  SqliteTaskGraphRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskRunRepository,
  PlanChoiceCoordinator,
  ObservabilityService,
  HttpTransport,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { FakeModel } from '@codeforge/testing';

const T0 = '2026-01-01T00:00:00.000Z';
const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r', includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH', fileCount: 0, totalBytes: 0, createdAt: T0, createdBy: { sessionId: 'S', reason: 'session_start' },
};
const TASK: Task = {
  taskId: 'T1', description: 'do it', acceptanceCriteria: [{ criterionId: 'c', description: 'done', mandatory: true }],
  constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: T0, createdBy: 'planner',
};
const GOAL: Goal = {
  goalId: 'G', version: 1,
  description: 'build a command-line tool that multiplies two matrices read from CSV files and writes the result to a file, with unit tests',
  constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'tests pass', mandatory: true }], createdAt: T0, createdBy: 'user',
};
const ADVISOR_JSON = JSON.stringify({ options: [
  { title: 'Single script', summary: 'One matmul.py with a CLI.', pros: ['Fast'], cons: ['No tests'], recommended: false },
  { title: 'Module + tests', summary: 'matmul.py exposing multiply(a, b) plus pytest tests.', pros: ['Verifiable'], cons: ['More files'], recommended: true },
] });

let db: SqliteDatabaseAdapter | undefined;
let transport: HttpTransport | undefined;
afterEach(async () => { await transport?.close(); transport = undefined; db?.close(); db = undefined; });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('plan options — orchestrator end to end over HTTP', () => {
  it('proposes, waits (no planning), takes the pick over POST /plan-choice, then steers Planner + executor', async () => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => T0 });
    let n = 0;
    const nextId = () => `id-${++n}`;
    const now = () => T0;
    const sessions = new SqliteSessionRepository(db);
    const events = new SqliteEventLog(db);
    const sessionSvc = new SessionService({ sessions, events, lock: new SqliteWorkspaceLockService(db), now, nextId });
    const session: Session = {
      sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1, state: 'CREATED', createdAt: T0, updatedAt: T0,
      runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
      metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'e', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
    };
    await sessionSvc.create({ session, hostname: 'h', processId: 1 });

    const coordinator = new PlanChoiceCoordinator({ sessionService: sessionSvc, sessions, pollIntervalMs: 10 });
    transport = new HttpTransport({
      service: new ObservabilityService({
        sessions, graphs: new SqliteTaskGraphRepository(db), executions: new SqliteTaskExecutionRepository(db),
        taskRuns: new SqliteTaskRunRepository(db), events, controlPlane: new ControlPlane(),
        sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
        planChoice: coordinator, now, nextId,
      }),
      streamPollMs: 50,
    });
    const base = `http://127.0.0.1:${await transport.listen(0)}`;

    const gw = new FakeModel();
    gw.setResponse(/.*/, ADVISOR_JSON);
    const planned: (PlanOption | undefined)[] = [];
    const captured: TaskExecutorRequest[] = [];
    const states = new Map<string, string>([['T1', 'PENDING']]);
    const orch = new SessionOrchestrator({
      sessionService: sessionSvc,
      missionStage: new MissionIntelligence({ events, now, newId: nextId, approachAdvisor: new ApproachAdvisor({ gateway: gw }), planChoiceGate: coordinator }),
      planner: {
        async plan(_s: string, _g: Goal, _gr: TaskGraph, _r: WorkspaceRevision, _pp: unknown, _lh: unknown, chosen?: PlanOption): Promise<GraphMutation> {
          planned.push(chosen);
          return {
            mutationId: 'M', sessionId: 'S', baseVersion: 1, operations: [{ kind: 'ADD_TASK', task: TASK } as never], proposedBy: 'planner', reason: 'plan',
            provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: T0 }, createdAt: T0, status: 'PROPOSED',
          } as unknown as GraphMutation;
        },
      },
      graphCommitService: { async commit() { return { status: 'COMMITTED' as const, version: 2, validation: { status: 'VALIDATED' as const, errors: [] } }; } },
      graphRepository: { async getCurrent(): Promise<TaskGraph> {
        return { graphId: 'GR', sessionId: 'S', version: 2, nodes: [{ taskId: 'T1', addedInVersion: 2 }], edges: [], createdAt: T0, createdBy: 'planner',
          canonicalHash: 'h', schemaVersion: 1, canonicalFormVersion: 'v1' } as unknown as TaskGraph;
      } },
      taskRepository: { async create() {}, async getById() { return TASK; } },
      executionRepository: { async getByTask(id: string) { const s = states.get(id); return s === undefined ? null : { currentState: s, attempts: 0 }; } },
      executionCoordinator: { async init() {}, async setState(id: string, s: string) { states.set(id, s); } },
      taskExecutor: { async execute(req: TaskExecutorRequest) { captured.push(req); states.set(req.task.taskId, 'PASSED'); return { taskPassed: true, finalState: 'SUCCEEDED', toolCallCount: 0 } as never; } },
      checkpointService: { async capture() {} },
      now, nextId,
    } as unknown as SessionOrchestratorDeps);

    const run = orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    // While waiting: AWAITING_HUMAN, PROPOSED logged, no planning.
    for (let i = 0; i < 200 && (await sessions.getById('S'))?.state !== 'AWAITING_HUMAN'; i++) await sleep(10);
    expect((await sessions.getById('S'))?.state).toBe('AWAITING_HUMAN');
    expect(planned).toHaveLength(0);
    const proposed = (await events.query({ sessionId: 'S' })).find((e) => e.type === 'PLAN_OPTIONS_PROPOSED');
    expect(proposed).toBeDefined();
    expect((proposed!.payload as { recommendedOptionId: string }).recommendedOptionId).toBe('o2');

    // The Goals panel picks the NON-recommended option.
    const res = await fetch(`${base}/plan-choice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'S', optionId: 'o1' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ optionId: 'o1', source: 'user' });

    const result = await run;
    expect(result.sessionState).toBe('COMPLETED');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ id: 'o1', title: 'Single script' });
    expect(captured[0]!.goalAssumptions).toEqual(['[chosen-approach] Single script — One matmul.py with a CLI.']);
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types.filter((t) => t === 'PLAN_OPTION_CHOSEN')).toHaveLength(1);
    expect(types.indexOf('PLAN_OPTIONS_PROPOSED')).toBeLessThan(types.indexOf('PLAN_OPTION_CHOSEN'));
  });
});