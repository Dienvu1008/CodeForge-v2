// run-swe-bench.mjs — drive a SWE-bench dataset through the real CodeForge runtime end-to-end.
//
// Pipeline per instance (SweBenchAgentRunner threads the harness phases around the runtime):
//   clone repo @ base_commit  ->  run the orchestrator with the issue as the goal
//     ->  apply the judging test_patch  ->  BenchmarkRunner runs FAIL_TO_PASS/PASS_TO_PASS
//
// Usage:
//   node scripts/run-swe-bench.mjs --dataset benchmarks/swe-bench/sample.jsonl \
//        --provider openai-compatible --endpoint https://api.groq.com/openai/v1 \
//        --model openai/gpt-oss-20b                        (key via CODEFORGE_API_KEY)
//   node scripts/run-swe-bench.mjs --dataset <file> --only <instance_id[,id]> \
//        --test-command "python -m pytest -q {tests}" --repo-mirror /path/to/mirror \
//        --min-call-interval-ms 3000
//
// Requirements for a LIVE run: git on PATH, network (or a --repo-mirror), and the per-repo test
// environment (python/pytest/tox) installed. Without those, the clone/test steps fail and cases
// are reported INVALID — the adapter itself still runs. CF_DEBUG=1 prints per-step errors.
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskRepository, SqliteTaskRunRepository,
  SqliteTaskExecutionRepository, SqliteTaskGraphRepository, SqliteGraphCommitter,
  SqliteCheckpointRepository, SqliteWorkspaceLockService, SqliteEventLog, SqliteToolCallRepository,
  SqliteApprovalRepository, SqliteVerificationRepository, Blake3GraphHasher,
  runMigrations, createMigrationRegistry,
  NodeWorkspaceManager, NodeProcessSupervisor, NodeToolExecutor, WorkspaceProcessSupervisor,
  BenchmarkRunner, inspectProject, SwitchableModelGateway,
  SqliteFailureRepository, SqliteRecoveryActionRepository, ContextCollector,
  WorkspaceSnapshotRollback,
  loadSweBenchDataset, SweBenchWorkspaceSetup, SweBenchAgentRunner,
} from '../packages/infrastructure/dist/index.js';
import {
  SessionService, SessionOrchestrator, Planner, GraphCommitService, GraphService,
  ExecutionCoordinator, TaskRunService, TaskExecutor, CheckpointService, NoopProcessReconciler,
  ToolGateway, ContextBuilder, VerificationEngine, CompletionGate,
  FailureAnalyzer, RecoveryEngine,
  buildToolPolicy, buildVerificationPolicy,
} from '../packages/agent-core/dist/index.js';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, def) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; }
const datasetPath = flag('dataset', 'benchmarks/swe-bench/sample.jsonl');
const provider = flag('provider', 'ollama');
const endpoint = flag('endpoint', provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1');
const model = flag('model', 'qwen2.5-coder:latest');
const apiKey = process.env.CODEFORGE_API_KEY;
const onlyArg = flag('only', undefined);
const testCommandTemplate = flag('test-command', 'python -m pytest -q {tests}');
const repoMirror = flag('repo-mirror', undefined);
const minCallIntervalMs = Number(flag('min-call-interval-ms', '0')) || 0;
const maxSteps = parseInt(flag('max-steps', '40'), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── gateway + RPM throttle (same shape as run-progressive.mjs) ───────────────
function makeGateway() {
  const gw = new SwitchableModelGateway({ endpoint, initialModel: model, timeoutMs: 300000, options: { temperature: 0.2 } });
  if (provider === 'openai-compatible') gw.setProvider({ provider: 'openai-compatible', model, endpoint, ...(apiKey ? { apiKey } : {}), timeoutMs: 300000 });
  else if (provider === 'gemini') gw.setProvider({ provider: 'gemini', model, ...(flag('endpoint', undefined) ? { endpoint } : {}), ...(apiKey ? { apiKey } : {}), timeoutMs: 300000 });
  return gw;
}
let _lastCallAt = 0; let _rpmChain = Promise.resolve();
function rpmThrottle(gw) {
  if (minCallIntervalMs <= 0) return gw;
  return {
    get identity() { return gw.identity; },
    generate(request) {
      const run = _rpmChain.then(async () => {
        const wait = _lastCallAt + minCallIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        _lastCallAt = Date.now();
        return gw.generate(request);
      });
      _rpmChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
function counters() { let t = 0; let n = 0; return { now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z', nextId: () => 'ID-' + String(n++).padStart(5, '0') }; }
function revision(root) { return { revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0, createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' } }; }

// ── runOrchestrator: drive the REAL runtime for one prepared workspace ───────
async function runOrchestrator({ workspaceRoot, task }) {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  try {
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    const c = counters();
    const gw = rpmThrottle(makeGateway());
    const events = new SqliteEventLog(db);
    const graphs = new SqliteTaskGraphRepository(db);
    const hasher = new Blake3GraphHasher();
    const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
    const graphCommitSvc = new GraphCommitService({ graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc, now: c.now, nextId: c.nextId });
    const sessionSvc = new SessionService({ sessions: new SqliteSessionRepository(db), events, lock: new SqliteWorkspaceLockService(db), now: c.now, nextId: c.nextId });
    const executions = new SqliteTaskExecutionRepository(db);
    const coordinator = new ExecutionCoordinator({ executions, now: c.now });
    const taskRunSvc = new TaskRunService({ runs: new SqliteTaskRunRepository(db), events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
    const checkpointSvc = new CheckpointService({ checkpoints: new SqliteCheckpointRepository(db), events, now: c.now, nextId: c.nextId });
    const planner = new Planner({ gateway: gw, now: c.now, nextId: c.nextId });
    const workspace = new NodeWorkspaceManager({ root: workspaceRoot, now: c.now, nextId: c.nextId });
    const supervisor = new NodeProcessSupervisor();
    const toolExec = new NodeToolExecutor({ filesystem: { workspace }, git: { workspace, supervisor }, shell: { workspace, supervisor } });
    const checkSupervisor = new WorkspaceProcessSupervisor({ workspaceRoot });
    const verEngine = new VerificationEngine({ reports: new SqliteVerificationRepository(db), events, supervisor: checkSupervisor, revisionProvider: { capture: async () => revision(workspaceRoot) }, now: c.now, nextId: c.nextId });
    const tg = new ToolGateway({ calls: new SqliteToolCallRepository(db), approvals: new SqliteApprovalRepository(db), events, policy: buildToolPolicy('full'), now: c.now, nextId: c.nextId });
    const taskRuns = new SqliteTaskRunRepository(db);
    const contextCollector = new ContextCollector({ workspaceRoot });
    const taskExec = new TaskExecutor({
      taskRunService: taskRunSvc, executionCoordinator: coordinator,
      contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
      gateway: gw, toolGateway: tg, executor: toolExec,
      verificationEngine: verEngine, completionGate: new CompletionGate({ reports: new SqliteVerificationRepository(db) }),
      verificationPolicy: buildVerificationPolicy(inspectProject(workspaceRoot)),
      contextProvider: contextCollector,
      verificationRevisionProvider: { capture: async () => revision(workspaceRoot) },
      events, maxToolCalls: maxSteps, now: c.now, nextId: c.nextId,
    });
    const failures = new SqliteFailureRepository(db);
    const recoveryActions = new SqliteRecoveryActionRepository(db);
    const failureAnalyzer = new FailureAnalyzer({ failures, events, now: c.now, nextId: c.nextId });
    const recoveryEngine = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId });
    const verificationEvidenceProvider = { lastFailureOutput: () => checkSupervisor.lastFailureOutput() };
    const workspaceRollback = new WorkspaceSnapshotRollback({ root: workspaceRoot });
    const sid = 'S';
    await sessionSvc.create({ session: { sessionId: sid, workspaceId: 'W', workspaceRoot, goalId: 'G', graphVersion: 1, state: 'CREATED', createdAt: c.now(), updatedAt: c.now(), runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L', metadata: { hostname: 'h', processId: 1, ollamaEndpoint: endpoint, ollamaModels: { planner: model, critic: model, executor: model, analyzer: model } } }, hostname: 'h', processId: 1 });
    await graphs.commit({ graphId: 'GR', sessionId: sid, version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1' }, { mutationId: 'M0', sessionId: sid, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed', provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' }, createdAt: 't', status: 'COMMITTED' });
    const orchestrator = new SessionOrchestrator({ sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs, taskRepository: new SqliteTaskRepository(db), executionRepository: executions, executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, taskRunRepository: taskRuns, failureAnalyzer, recoveryEngine, failureRepository: failures, recoveryActionRepository: recoveryActions, verificationEvidenceProvider, workspaceRollback, now: c.now, nextId: c.nextId });
    const goal = { goalId: 'G', version: 1, description: task.description, constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }], createdAt: c.now(), createdBy: 'user' };
    try { await workspaceRollback.captureClean(sid); } catch { /* non-fatal */ }
    try { await orchestrator.run({ sessionId: sid, goal, revision: revision(workspaceRoot), graphVersion: 1 }); }
    catch (err) { if (process.env.CF_DEBUG) console.error(`  [orch error] ${task.id} :: ${err?.code ?? ''} ${err?.message ?? String(err)}`); }
    return { events: await events.query({ sessionId: sid }), traceRef: sid };
  } finally { db.close(); }
}

// ── load dataset -> bundles -> benchmark + SweBenchAgentRunner ───────────────
let bundles = loadSweBenchDataset(datasetPath, { testCommandTemplate, maxIterations: maxSteps });
if (onlyArg) {
  const want = new Set(onlyArg.split(',').map((s) => s.trim()));
  bundles = bundles.filter((b) => want.has(b.task.id));
  if (bundles.length === 0) { console.error(`--only '${onlyArg}' matched no instance_id`); process.exit(1); }
}

const workspaceSetup = new SweBenchWorkspaceSetup({
  supervisor: new NodeProcessSupervisor(),
  ...(repoMirror ? { resolveRepoUrl: (repo) => `${repoMirror.replace(/\/+$/, '')}/${repo}` } : {}),
});
const agent = new SweBenchAgentRunner({ bundles, workspaceSetup, runOrchestrator });

const benchmark = {
  id: 'swe-bench', version: '0.1.0',
  description: `SWE-bench dataset: ${datasetPath}`,
  tasks: bundles.map((b) => b.task),
};

console.log(`\nSWE-bench: ${provider} '${model}' @ ${endpoint}  (${benchmark.tasks.length} instances)\n`);

let counter = 0;
const runner = new BenchmarkRunner({
  agent,
  makeCheckSupervisor: (root) => new WorkspaceProcessSupervisor({ workspaceRoot: root }),
  provenance: { agentName: 'codeforge', agentVersion: '0.12.0', gitCommit: 'swe-bench', model, runtimeConfig: { provider }, environment: process.platform },
  now: () => new Date().toISOString(), newRunId: () => `swe-run-${++counter}`,
});

const { run, result } = await runner.run(benchmark);

console.log('  instance_id                              verdict   detail');
console.log('  ' + '-'.repeat(72));
for (const r of run.results) {
  const mark = r.verdict === 'SUCCESS' ? 'PASS' : r.verdict === 'FAILURE' ? 'FAIL' : 'INVALID';
  const failed = r.checks.filter((c) => !c.passed).map((c) => c.description);
  console.log(`  ${r.taskId.padEnd(40)} ${mark.padEnd(9)} ${failed.length ? failed[0] : ''}`);
  if (process.env.CF_DEBUG) {
    for (const c of r.checks) {
      if (c.passed) continue;
      if (c.detail) console.log('      ' + String(c.detail).replace(/\n/g, '\n      ').slice(0, 2000));
    }
  }
}
console.log(`\n  TOTAL: ${result.success}/${result.total} resolved  (failure=${result.failure}, invalid=${result.invalid})`);
console.log(`  failure classes: ${JSON.stringify(result.failureBreakdown)}`);
console.log('\nSWE-BENCH DONE');
