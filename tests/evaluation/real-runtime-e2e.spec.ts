// Real-runtime E2E (§33) — run the native benchmark through the ACTUAL CodeForge kernel: a real
// SessionOrchestrator → Planner → TaskExecutor → ToolGateway → NodeToolExecutor (filesystem) →
// VerificationEngine, over a real SQLite kernel, against the isolated benchmark workspace. The
// model is a FakeModel (CI-deterministic; FM-8 no network) scripted to emit a plan then a
// write_file tool call then done. This is the honest "real runtime integration tested" claim:
// files are written through the governed tool path, not by the test.
//
// It then records the first BASELINE for the native benchmark from this run.
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskRepository, SqliteTaskRunRepository,
  SqliteTaskExecutionRepository, SqliteTaskGraphRepository, SqliteGraphCommitter,
  SqliteCheckpointRepository, SqliteWorkspaceLockService, SqliteEventLog, SqliteToolCallRepository,
  SqliteApprovalRepository, SqliteVerificationRepository, Blake3GraphHasher,
  runMigrations, createMigrationRegistry,
  NodeWorkspaceManager, NodeProcessSupervisor, NodeToolExecutor, WorkspaceProcessSupervisor,
  BenchmarkRunner, BaselineStore, loadBenchmarkFile, inspectProject,
  type AgentRunner,
} from '@codeforge/infrastructure';
import {
  SessionService, SessionOrchestrator, Planner, GraphCommitService, GraphService,
  ExecutionCoordinator, TaskRunService, TaskExecutor, CheckpointService, NoopProcessReconciler,
  ToolGateway, ContextBuilder, VerificationEngine, CompletionGate,
  buildToolPolicy, buildVerificationPolicy,
  type BenchmarkTask, type RunProvenance, type Session, type Goal, type WorkspaceRevision,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

const BENCHMARK_PATH = join(__dirname, '..', '..', 'benchmarks', 'codeforge-native', 'benchmark.json');

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

// A per-case counter source (deterministic within a case).
function counters() {
  let t = 0; let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

/**
 * Script the FakeModel for a given task: Planner gets a 1-task plan; the executor gets a
 * write_file tool call (the "solution") then done. We only know how to solve a couple of tasks;
 * the rest get a plausible-but-wrong attempt → the checks will fail them (realistic mixed run).
 */
function scriptModel(task: BenchmarkTask): FakeModel {
  const model = new FakeModel();
  const plan = JSON.stringify({ tasks: [{ id: 'T1', description: task.description, strategy: 'generate' }], edges: [], reason: 'single task' });

  // Known solutions for a subset of the native tasks (written through the real tool path).
  const solutions: Record<string, { path: string; content: string }> = {
    'CF-002': { path: 'src/util.js', content: "function isPositive(n) { return n > 0; }\nfunction isEven(n) { return n % 2 === 0; }\nmodule.exports = { isPositive, isEven };\n" },
    'CF-004': { path: 'test.js', content: "const assert = require('node:assert');\nconst { reverse } = require('./src/str.js');\nassert.strictEqual(reverse('abc'), 'cba');\nconsole.log('ok');\n" },
    'CF-007': { path: 'ENTRY.md', content: '# Entry point\n\nThe entry point is `src/server.js`, which listens on port `8080`.\n' },
  };

  const sol = solutions[task.id];
  // Planner call matches on the planning system prompt; executor calls match anything else.
  model.setResponse(/plan|decompose|task graph/i, plan);
  if (sol !== undefined) {
    model.setSequence([
      plan,
      JSON.stringify({ type: 'tool_call', toolName: 'write_file', arguments: { path: sol.path, content: sol.content } }),
      JSON.stringify({ type: 'done', summary: `wrote ${sol.path}` }),
    ]);
  } else {
    // Unknown task: plan then immediately claim done without a real fix → checks fail (FAILURE).
    model.setSequence([plan, JSON.stringify({ type: 'done', summary: 'no change' })]);
  }
  return model;
}

/** Build a real-runtime AgentRunner that drives the actual kernel against the isolated workspace. */
function makeRealAgentRunner(): AgentRunner {
  return {
    async run({ workspaceRoot, task }) {
      const db = new SqliteDatabaseAdapter(':memory:');
      db.open();
      try {
        runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
        const c = counters();
        const model = scriptModel(task);

        const sessions = new SqliteSessionRepository(db);
        const events = new SqliteEventLog(db);
        const tasks = new SqliteTaskRepository(db);
        const taskRuns = new SqliteTaskRunRepository(db);
        const executions = new SqliteTaskExecutionRepository(db);
        const graphs = new SqliteTaskGraphRepository(db);
        const committer = new SqliteGraphCommitter(db);
        const checkpoints = new SqliteCheckpointRepository(db);
        const lock = new SqliteWorkspaceLockService(db);
        const toolCalls = new SqliteToolCallRepository(db);
        const approvals = new SqliteApprovalRepository(db);
        const verReports = new SqliteVerificationRepository(db);

        const hasher = new Blake3GraphHasher();
        const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
        const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
        const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
        const coordinator = new ExecutionCoordinator({ executions, now: c.now });
        const taskRunSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
        const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });
        const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });

        // Real tool path: NodeToolExecutor writing into the isolated workspace via the ToolGateway.
        const workspace = new NodeWorkspaceManager({ root: workspaceRoot, now: c.now, nextId: c.nextId });
        const supervisor = new NodeProcessSupervisor();
        const toolExec = new NodeToolExecutor({
          filesystem: { workspace },
          git: { workspace, supervisor },
          shell: { workspace, supervisor },
        });
        const checkSupervisor = new WorkspaceProcessSupervisor({ workspaceRoot });
        const revisionProvider = { capture: async (_r: string) => revision(workspaceRoot) };
        const verEngine = new VerificationEngine({
          reports: verReports, events, supervisor: checkSupervisor, revisionProvider,
          now: c.now, nextId: c.nextId,
        });
        const completionGate = new CompletionGate({ reports: verReports });
        const verificationPolicy = buildVerificationPolicy(inspectProject(workspaceRoot));
        const tg = new ToolGateway({ calls: toolCalls, approvals, events, policy: buildToolPolicy('full'), now: c.now, nextId: c.nextId });
        const taskExec = new TaskExecutor({
          taskRunService: taskRunSvc, executionCoordinator: coordinator,
          contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
          gateway: model, toolGateway: tg, executor: toolExec,
          verificationEngine: verEngine, completionGate, verificationPolicy,
          events, maxToolCalls: 8, now: c.now, nextId: c.nextId,
        });

        const sid = 'S';
        const session: Session = {
          sessionId: sid, workspaceId: 'W', workspaceRoot, goalId: 'G', graphVersion: 1, state: 'CREATED',
          createdAt: c.now(), updatedAt: c.now(), runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
          metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'fake', ollamaModels: { planner: 'f', critic: 'f', executor: 'f', analyzer: 'f' } },
        };
        await sessionSvc.create({ session, hostname: 'h', processId: 1 });
        await graphs.commit({
          graphId: 'GR', sessionId: sid, version: 1, nodes: [], edges: [],
          createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
        }, {
          mutationId: 'M0', sessionId: sid, baseVersion: 0, operations: [],
          proposedBy: 'planner', reason: 'seed',
          provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
          createdAt: 't', status: 'COMMITTED',
        });

        const orchestrator = new SessionOrchestrator({
          sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc,
          graphRepository: graphs, taskRepository: tasks, executionRepository: executions,
          executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc,
          maxIterations: 6, now: c.now, nextId: c.nextId,
        });

        const goal: Goal = {
          goalId: 'G', version: 1, description: task.description,
          constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
          createdAt: c.now(), createdBy: 'user',
        };
        try {
          await orchestrator.run({ sessionId: sid, goal, revision: revision(workspaceRoot), graphVersion: 1 });
        } catch { /* a plan/commit error → the checks will mark it FAILURE/INVALID; don't crash the benchmark */ }

        const traceEvents = await events.query({ sessionId: sid });
        return { events: traceEvents, traceRef: sid };
      } finally {
        db.close();
      }
    },
  };
}

function revision(root: string): WorkspaceRevision {
  return {
    revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

describe('Real-runtime benchmark E2E + first baseline', () => {
  it('runs the native benchmark through the real kernel and records a baseline', async () => {
    const benchmark = loadBenchmarkFile(BENCHMARK_PATH);
    const provenance: RunProvenance = {
      agentName: 'codeforge', agentVersion: '0.12.0', gitCommit: 'eval-e2e', model: 'fake-model',
      runtimeConfig: { mission: false, learning: false }, environment: process.platform,
    };
    let n = 0;
    const runner = new BenchmarkRunner({
      agent: makeRealAgentRunner(),
      makeCheckSupervisor: (root) => new WorkspaceProcessSupervisor({ workspaceRoot: root }),
      provenance, now: () => new Date().toISOString(), newRunId: () => `run-${++n}`,
    });

    const { run, result } = await runner.run(benchmark);

    // Every case produced a verdict and a trace from the REAL runtime.
    expect(result.total).toBe(10);
    expect(run.results.every((r) => r.traceRef === 'S')).toBe(true);
    // At least the scripted-solvable tasks succeeded through the governed tool path.
    expect(result.success).toBeGreaterThanOrEqual(1);
    // The run is coherent: success + failure + invalid == total.
    expect(result.success + result.failure + result.invalid).toBe(10);

    // Record the first baseline to a temp dir (not the dev repo).
    const dir = join(tmpdir(), `cf-baseline-e2e-${Date.now()}`);
    cleanup.push(dir);
    const store = new BaselineStore({ dir, now: () => new Date().toISOString(), newId: () => `b-${++n}` });
    store.saveRun(run);
    const baseline = store.recordBaseline('codeforge-0.12-fakemodel', result);
    const reloaded = store.loadBaseline('codeforge-0.12-fakemodel');
    expect(reloaded?.result.total).toBe(10);
    expect(baseline.label).toBe('codeforge-0.12-fakemodel');

    console.log(`BASELINE codeforge-0.12-fakemodel: ${result.success}/${result.total} success, ` +
      `failures=${JSON.stringify(result.failureBreakdown)}`);
  }, 120_000);
});
