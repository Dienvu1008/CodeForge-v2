// Shared lightweight orchestrator fakes for the MI-001/002/004 invariant tests.
//
// These stand in for the real services at the SessionOrchestrator seam. They record the calls
// the invariants care about (planner invocations, session transitions, graph commits) without a
// database. The empty-graph plan makes the orchestrator's main loop terminate immediately
// (allTerminal over zero nodes is true), so a run reduces to: transitions → [mission stage] →
// plan → commit → complete. That is exactly the control flow the MI invariants constrain.
import type {
  Goal,
  WorkspaceRevision,
  GraphMutation,
  TaskGraph,
  SessionOrchestratorDeps,
} from '@codeforge/agent-core';

export const GOAL: Goal = {
  goalId: 'G', version: 1, description: 'build a new app from scratch with multiple subsystems',
  constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
};

export const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};

function emptyGraph(): TaskGraph {
  return {
    graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'planner', canonicalHash: 'h',
    schemaVersion: 1, canonicalFormVersion: 'v1',
  };
}

function emptyMutation(): GraphMutation {
  return {
    mutationId: 'M', sessionId: 'S', baseVersion: 1, operations: [],
    proposedBy: 'planner', reason: 'empty plan',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z', status: 'PROPOSED',
  };
}

export interface OrchestratorFakes {
  deps: Omit<SessionOrchestratorDeps, 'now' | 'nextId'>;
  now: () => string;
  nextId: () => string;
  events: string[];       // event types emitted via sessionService (transition audit stand-in)
  plannerCalls: number;
  transitions: string[];  // session transition events applied
  commits: number;
}

export function makeOrchestratorFakes(): OrchestratorFakes {
  let n = 0;
  const state = {
    events: [] as string[],
    plannerCalls: 0,
    transitions: [] as string[],
    commits: 0,
  };

  const sessionService = {
    async transition(_id: string, event: string) { state.transitions.push(event); return {} as never; },
    async complete(_id: string, _allTerminal: boolean) { state.transitions.push('COMPLETE'); return {} as never; },
  };

  const planner = {
    async plan(_sid: string, _goal: Goal, _graph: TaskGraph, _rev: WorkspaceRevision): Promise<GraphMutation> {
      state.plannerCalls += 1;
      return emptyMutation();
    },
  };

  const graphCommitService = {
    async commit(_m: GraphMutation) { state.commits += 1; return { status: 'COMMITTED' as const, version: 1, validation: { status: 'VALIDATED' as const, errors: [] } }; },
  };

  const graphRepository = {
    async getCurrent(_sid: string): Promise<TaskGraph> { return emptyGraph(); },
  };

  const taskRepository = { async create() {}, async getById() { return null; } };
  const executionRepository = { async getByTask() { return null; } };
  const executionCoordinator = { async init() {}, async setState() {} };
  const taskExecutor = { async execute() { return { taskPassed: false } as never; } };
  const checkpointService = { async capture() {} };

  const deps = {
    sessionService, planner, graphCommitService, graphRepository,
    taskRepository, executionRepository, executionCoordinator, taskExecutor,
    checkpointService,
  } as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId'>;

  return {
    deps,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `id-${++n}`,
    get events() { return state.events; },
    get plannerCalls() { return state.plannerCalls; },
    get transitions() { return state.transitions; },
    get commits() { return state.commits; },
  };
}
