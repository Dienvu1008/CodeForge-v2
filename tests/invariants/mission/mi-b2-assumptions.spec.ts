// Tier B2 — the Mission Intelligence stage's stated assumptions must be THREADED through the
// orchestrator into every TaskExecutorRequest (so they actually steer the agent — option (ii)
// "assume and state"). This is the orchestrator seam only: a stage returning `assumptions`
// results in each TaskExecutorRequest carrying `goalAssumptions`. Fail-safe parity: a stage
// with no assumptions leaves goalAssumptions undefined.
//
// The harness uses a single-node graph so the main loop actually schedules + executes one task
// (the shared MI-00x fakes use an empty graph and never reach the executor). The fake executor
// records the request it received and drives its task to PASSED so the loop terminates.
import { describe, it, expect } from 'vitest';
import {
  SessionOrchestrator,
  type MissionStage,
  type Goal,
  type WorkspaceRevision,
  type TaskGraph,
  type GraphMutation,
  type Task,
  type TaskExecutorRequest,
  type SessionOrchestratorDeps,
} from '@codeforge/agent-core';

const GOAL: Goal = {
  goalId: 'G', version: 1, description: 'help me build something',
  constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
};

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};

const TASK: Task = {
  taskId: 'T1', description: 'do the thing',
  acceptanceCriteria: [{ criterionId: 'c', description: 'done', mandatory: true }],
  constraints: [], priority: 1, strategy: { kind: 'generate' },
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'planner',
};

function oneNodeGraph(): TaskGraph {
  return {
    graphId: 'GR', sessionId: 'S', version: 1,
    nodes: [{ taskId: 'T1', addedInVersion: 1 }],
    edges: [],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'planner', canonicalHash: 'h',
    schemaVersion: 1, canonicalFormVersion: 'v1',
  } as unknown as TaskGraph;
}

function mutationWithTask(): GraphMutation {
  return {
    mutationId: 'M', sessionId: 'S', baseVersion: 1,
    operations: [{ kind: 'ADD_TASK', task: TASK } as never],
    proposedBy: 'planner', reason: 'plan',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z', status: 'PROPOSED',
  } as unknown as GraphMutation;
}

interface Harness {
  deps: Omit<SessionOrchestratorDeps, 'now' | 'nextId'>;
  now: () => string;
  nextId: () => string;
  captured: TaskExecutorRequest[];
}

function makeHarness(): Harness {
  let n = 0;
  const captured: TaskExecutorRequest[] = [];
  const states = new Map<string, string>([['T1', 'PENDING']]);

  const sessionService = {
    async transition() { return {} as never; },
    async complete() { return {} as never; },
  };
  const planner = { async plan(): Promise<GraphMutation> { return mutationWithTask(); } };
  const graphCommitService = {
    async commit() { return { status: 'COMMITTED' as const, version: 1, validation: { status: 'VALIDATED' as const, errors: [] } }; },
  };
  const graphRepository = { async getCurrent(): Promise<TaskGraph> { return oneNodeGraph(); } };
  const taskRepository = { async create() {}, async getById() { return TASK; } };
  // The orchestrator reads task states ONLY from executionRepository.getByTask(...).currentState,
  // so this fake projection must reflect the SAME `states` map the coordinator writes.
  const executionRepository = {
    async getByTask(id: string) {
      const s = states.get(id);
      return s === undefined ? null : { currentState: s, attempts: 0 };
    },
  };
  const executionCoordinator = {
    async init(id: string) { if (!states.has(id)) states.set(id, 'PENDING'); },
    async setState(id: string, s: string) { states.set(id, s); },
  };
  // The executor records the request it was handed and marks the task PASSED so the loop ends.
  const taskExecutor = {
    async execute(req: TaskExecutorRequest) {
      captured.push(req);
      states.set(req.task.taskId, 'PASSED');
      return { taskPassed: true, finalState: 'SUCCEEDED', toolCallCount: 0 } as never;
    },
  };
  const checkpointService = { async capture() {} };

  const deps = {
    sessionService, planner, graphCommitService, graphRepository,
    taskRepository, executionRepository, executionCoordinator, taskExecutor,
    checkpointService,
  } as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId'>;

  return { deps, now: () => '2026-01-01T00:00:00.000Z', nextId: () => `id-${++n}`, captured };
}

describe('Tier B2 — orchestrator threads stage assumptions into TaskExecutorRequest', () => {
  it('a stage returning assumptions sets goalAssumptions on the request', async () => {
    const h = makeHarness();
    const stage: MissionStage = {
      async analyze() {
        return { proceed: true, blockers: [], assumptions: ['Use TypeScript', 'CLI reads stdin'] };
      },
    };
    const orch = new SessionOrchestrator({ ...h.deps, missionStage: stage, now: h.now, nextId: h.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.goalAssumptions).toEqual(['Use TypeScript', 'CLI reads stdin']);
  });

  it('a stage with no assumptions leaves goalAssumptions undefined (fail-safe parity)', async () => {
    const h = makeHarness();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [] }; } };
    const orch = new SessionOrchestrator({ ...h.deps, missionStage: stage, now: h.now, nextId: h.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.goalAssumptions).toBeUndefined();
  });

  it('no stage at all leaves goalAssumptions undefined', async () => {
    const h = makeHarness();
    const orch = new SessionOrchestrator({ ...h.deps, now: h.now, nextId: h.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.goalAssumptions).toBeUndefined();
  });
});
