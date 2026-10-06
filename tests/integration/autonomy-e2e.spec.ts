// P8-I1 — Autonomy E2E (PHASE_8_ROADMAP §4.5).
//
// Wires the three Phase-8 components to the REAL kernel and proves no bypass:
//   1. computeSchedule (real Scheduler) → planParallelBatch picks a parallel batch.
//   2. Every admitted task's tool call executes THROUGH the real ToolGateway + policy +
//      FakeProcessSupervisor — never around it (AU-001, closing the au-001 E2E todo).
//   3. MultiAgentCoordinator merges sub-agent output as proposals; a forged-authority
//      result is rejected; a graph suggestion stays PROPOSED (AU-002/007).
//   4. BranchIsolation gives each branch a disjoint scratch zone and refuses an
//      orphan-leaving cancel; a sibling is untouched (AU-005/006).
//   5. Scheduling + batch planning are deterministic across runs (AU-003); the batch's
//      cumulative cost stays within the parent budget (AU-004).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ToolGateway,
  ToolGatewayError,
  PERMISSIVE_TEST_POLICY,
  computeSchedule,
  planParallelBatch,
  MultiAgentCoordinator,
  allocateScratchZones,
  classifyWrite,
  cancelOneBranch,
  BranchIsolationError,
  type GraphNode,
  type GraphEdge,
  type TaskState,
  type ToolCall,
  type ToolExecutor,
  type ExecutorResult,
  type TaskCost,
  type SubAgentResult,
  type GraphMutation,
  type Provenance,
  type BranchRunOutcome,
} from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function node(taskId: string): GraphNode { return { taskId, addedInVersion: 1 }; }

function toolCall(id: string): ToolCall {
  return {
    toolCallId: id, sessionId: 'S', toolName: 'read_file', toolVersion: '1.0',
    riskClass: 'READ_ONLY', arguments: { path: `src/${id}.ts` }, argumentsHash: `HASH-${id}`,
    state: 'REQUESTED', proposedBy: 'model',
    provenance: { provenanceId: 'P', source: { kind: 'model', id: 'executor' }, inputs: [], reason: 'execute', at: '2026-01-01T00:00:00.000Z' },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

const cost = (toolCalls: number): TaskCost => ({ wallClockMs: 0, modelTokens: 0, toolCalls, recoveryAttempts: 0 });

function prov(kind: Provenance['source']['kind'], id: string): Provenance {
  return { provenanceId: `pv-${id}`, source: { kind, id }, inputs: [], reason: 'r', at: 't' };
}
function mutation(status: GraphMutation['status']): GraphMutation {
  return {
    mutationId: 'm', sessionId: 'S', baseVersion: 0, operations: [],
    proposedBy: 'planner', reason: 'r', provenance: prov('model', 'm'), createdAt: 't', status,
  };
}

let db: SqliteDatabaseAdapter;
let callsRepo: SqliteToolCallRepository;
let events: SqliteEventLog;
let supervisor: FakeProcessSupervisor;
let gateway: ToolGateway;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
  callsRepo  = new SqliteToolCallRepository(db);
  events     = new SqliteEventLog(db);
  supervisor = new FakeProcessSupervisor();
  const c = makeCounters();
  gateway = new ToolGateway({
    calls: callsRepo, approvals: new SqliteApprovalRepository(db), events,
    policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId,
  });
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 + AU-001 E2E: parallel batch executes THROUGH the ToolGateway
// ─────────────────────────────────────────────────────────────────────────────

describe('P8-I1 — parallel batch runs through the kernel (AU-001)', () => {
  it('every admitted task executes via ToolGateway (no bypass) and the events prove it', async () => {
    // Three independent READY tasks (no edges → independent by construction, SC-003).
    const nodes = [node('a'), node('b'), node('c')];
    const edges: GraphEdge[] = [];
    const states = new Map<string, TaskState>([['a', 'READY'], ['b', 'READY'], ['c', 'READY']]);

    const sched = computeSchedule({ nodes, edges, states });
    expect(sched.schedulable).toEqual(['a', 'b', 'c']);

    // Plan a parallel batch (cap 2) over the real schedulable set.
    const batch = planParallelBatch({ schedulable: sched.schedulable, maxConcurrency: 2 });
    expect(batch.admitted).toEqual(['a', 'b']);

    // Execute each admitted task's tool call THROUGH the gateway.
    for (const taskId of batch.admitted) {
      supervisor.setSequence([{ exitCode: 0, stdout: 'ok', stderr: '' }]);
      const requested = await gateway.request(toolCall(taskId));
      expect(requested.state).toBe('APPROVED'); // READ_ONLY auto-approve
      const executor: ToolExecutor = {
        async execute(): Promise<ExecutorResult> {
          return supervisor.spawn({ command: 'cat', args: [], cwd: '/r', env: {}, timeoutMs: 5000 });
        },
      };
      const done = await gateway.execute(taskId, executor);
      expect(done.state).toBe('SUCCEEDED');
    }

    // No way to execute 'a'/'b' except through the gateway — the event log is the proof.
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types.filter((t) => t === 'TOOL_CALL_STARTED')).toHaveLength(2);
    expect(types.filter((t) => t === 'TOOL_CALL_ENDED')).toHaveLength(2);

    // The deferred task 'c' never produced a tool call (it was not admitted).
    expect(await callsRepo.getById('c')).toBeNull();
  });

  it('an un-requested tool call cannot execute (TG-001 bypass attempt fails)', async () => {
    const err = await gateway.execute('ghost', {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe('NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: multi-agent fan-out → proposals, no authority (AU-002/007)
// ─────────────────────────────────────────────────────────────────────────────

describe('P8-I1 — multi-agent proposals never become authority (AU-002/007)', () => {
  it('merges proposals and rejects a forged-authority sub-agent', () => {
    const coord = new MultiAgentCoordinator();
    const results: SubAgentResult[] = [
      { agentId: 'planner', provenance: prov('model', 'planner'),
        suggestions: [{ kind: 'graph', mutation: mutation('PROPOSED') }] },
      { agentId: 'executor', provenance: prov('model', 'executor'),
        suggestions: [{ kind: 'completion', taskId: 'a', rationale: 'built' }] },
      { agentId: 'rogue', provenance: prov('runtime', 'rogue'),
        suggestions: [{ kind: 'completion', taskId: 'a', rationale: 'forced' }] },
    ];
    const out = coord.coordinate(results);
    // Two legitimate proposals, the rogue rejected.
    expect(out.proposals).toHaveLength(2);
    expect(out.rejected).toEqual([{ agentId: 'rogue', reason: 'authority-source' }]);
    // The graph proposal stays PROPOSED — only the graph committer (GI-009) can commit it.
    const graphProposal = out.proposals.find((p) => p.kind === 'graph');
    expect(graphProposal?.kind).toBe('graph');
    if (graphProposal?.kind === 'graph') expect(graphProposal.mutation.status).toBe('PROPOSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: branch isolation + no-orphan cancel (AU-005/006)
// ─────────────────────────────────────────────────────────────────────────────

describe('P8-I1 — branch isolation + no-orphan cancel (AU-005/006)', () => {
  it('branches have disjoint zones; a foreign write is rejected; cancel leaves no orphan', () => {
    const zones = allocateScratchZones(['a', 'b']);
    // Each branch writes its own zone fine; cannot write the sibling's.
    expect(classifyWrite('a', '.scratch/a/x', zones).allowed).toBe(true);
    expect(classifyWrite('a', '.scratch/b/x', zones).allowed).toBe(false);

    // Cancel branch 'a' cleanly; sibling 'b' is preserved verbatim.
    const before: BranchRunOutcome[] = [
      { branchId: 'a', runState: 'RUNNING', orphanPids: [] },
      { branchId: 'b', runState: 'RUNNING', orphanPids: [] },
    ];
    const after = cancelOneBranch(before, { branchId: 'a', runState: 'CANCELLED', orphanPids: [] });
    expect(after.find((o) => o.branchId === 'b')).toBe(before[1]);
    // An orphan-leaving cancel is refused.
    expect(() =>
      cancelOneBranch(before, { branchId: 'a', runState: 'CANCELLED', orphanPids: [1] }),
    ).toThrowError(BranchIsolationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 + 5: budget ceiling (AU-004) + determinism (AU-003)
// ─────────────────────────────────────────────────────────────────────────────

describe('P8-I1 — budget ceiling + determinism (AU-004/003)', () => {
  it('the batch cumulative cost never exceeds the parent remaining (AU-004)', () => {
    const batch = planParallelBatch({
      schedulable: ['a', 'b', 'c'],
      maxConcurrency: 10,
      cost: new Map([['a', cost(2)], ['b', cost(2)], ['c', cost(2)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 5, recoveryAttempts: 0 },
    });
    expect(batch.admitted).toEqual(['a', 'b']); // 2+2=4<=5; c would be 6>5
    const total = batch.admitted.length * 2;
    expect(total).toBeLessThanOrEqual(5);
  });

  it('scheduling + batch planning are deterministic across runs (AU-003)', () => {
    const nodes = [node('c'), node('a'), node('b')];
    const states = new Map<string, TaskState>([['a', 'READY'], ['b', 'READY'], ['c', 'READY']]);
    const run = (): readonly string[] =>
      planParallelBatch({ schedulable: computeSchedule({ nodes, edges: [], states }).schedulable, maxConcurrency: 2 }).admitted;
    expect(run()).toEqual(run());
    expect(run()).toEqual(['a', 'b']); // sorted, cap 2
  });
});
