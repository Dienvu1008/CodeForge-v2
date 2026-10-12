// P12.9 — mission-driven model routing (orchestrator seam). A MissionStage that returns a
// selectedModelId causes the orchestrator to call the optional RuntimeModelSelector with that id,
// exactly once, before task execution. Fail-safe: no selector, or no selectedModelId, or a
// throwing selector ⇒ the run proceeds unchanged.
import { describe, it, expect } from 'vitest';
import {
  SessionOrchestrator,
  type MissionStage,
  type RuntimeModelSelector,
  type Goal,
  type WorkspaceRevision,
  type TaskGraph,
  type GraphMutation,
  type Task,
  type TaskExecutorRequest,
  type SessionOrchestratorDeps,
} from '@codeforge/agent-core';

const GOAL: Goal = {
  goalId: 'G', version: 1, description: 'build a thing',
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
    nodes: [{ taskId: 'T1', addedInVersion: 1 }], edges: [],
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

function makeDeps(): { deps: Omit<SessionOrchestratorDeps, 'now' | 'nextId'>; now: () => string; nextId: () => string } {
  let n = 0;
  const states = new Map<string, string>([['T1', 'PENDING']]);
  const sessionService = { async transition() { return {} as never; }, async complete() { return {} as never; } };
  const planner = { async plan(): Promise<GraphMutation> { return mutationWithTask(); } };
  const graphCommitService = { async commit() { return { status: 'COMMITTED' as const, version: 1, validation: { status: 'VALIDATED' as const, errors: [] } }; } };
  const graphRepository = { async getCurrent(): Promise<TaskGraph> { return oneNodeGraph(); } };
  const taskRepository = { async create() {}, async getById() { return TASK; } };
  const executionRepository = { async getByTask(id: string) { const s = states.get(id); return s === undefined ? null : { currentState: s, attempts: 0 }; } };
  const executionCoordinator = { async init(id: string) { if (!states.has(id)) states.set(id, 'PENDING'); }, async setState(id: string, s: string) { states.set(id, s); } };
  const taskExecutor = { async execute(req: TaskExecutorRequest) { states.set(req.task.taskId, 'PASSED'); return { taskPassed: true, finalState: 'SUCCEEDED', toolCallCount: 0 } as never; } };
  const checkpointService = { async capture() {} };
  const deps = {
    sessionService, planner, graphCommitService, graphRepository,
    taskRepository, executionRepository, executionCoordinator, taskExecutor, checkpointService,
  } as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId'>;
  return { deps, now: () => '2026-01-01T00:00:00.000Z', nextId: () => `id-${++n}` };
}

function recordingSelector(): RuntimeModelSelector & { calls: string[] } {
  const calls: string[] = [];
  return { calls, selectModel(id: string) { calls.push(id); } };
}

describe('P12.9 — mission-driven model routing (orchestrator applies selectedModelId)', () => {
  it('calls the selector once with the mission-chosen id', async () => {
    const { deps, now, nextId } = makeDeps();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [], selectedModelId: 'gpt-strong' }; } };
    const sel = recordingSelector();
    const orch = new SessionOrchestrator({ ...deps, missionStage: stage, modelSelector: sel, now, nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
    expect(sel.calls).toEqual(['gpt-strong']);
  });

  it('does not call the selector when the stage returns no selectedModelId', async () => {
    const { deps, now, nextId } = makeDeps();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [] }; } };
    const sel = recordingSelector();
    const orch = new SessionOrchestrator({ ...deps, missionStage: stage, modelSelector: sel, now, nextId });

    await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(sel.calls).toEqual([]);
  });

  it('runs fine when a selectedModelId is present but no selector is wired (fail-safe)', async () => {
    const { deps, now, nextId } = makeDeps();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [], selectedModelId: 'gpt-strong' }; } };
    const orch = new SessionOrchestrator({ ...deps, missionStage: stage, now, nextId }); // no modelSelector

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
  });

  it('a throwing selector is non-fatal — the run still completes', async () => {
    const { deps, now, nextId } = makeDeps();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [], selectedModelId: 'bad' }; } };
    const sel: RuntimeModelSelector = { selectModel() { throw new Error('switch failed'); } };
    const orch = new SessionOrchestrator({ ...deps, missionStage: stage, modelSelector: sel, now, nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
  });
});
