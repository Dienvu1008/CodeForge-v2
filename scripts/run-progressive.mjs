// Tier-A capability curve runner. Runs the difficulty-graded progressive benchmark through the
// REAL CodeForge kernel driven by a REAL model (Ollama by default, or any configured gateway), in
// isolated throwaway workspaces, and prints a per-difficulty pass/fail curve + cost metrics.
//
// This is a MEASUREMENT TOOL, not a CI test: it calls a live model (slow, non-deterministic), so
// it is a script you run deliberately, never part of `npm test`.
//
// Usage:
//   node scripts/run-progressive.mjs                       # default: ollama qwen2.5-coder:latest
//   node scripts/run-progressive.mjs qwen2.5-coder:latest  # pick an Ollama model
//   node scripts/run-progressive.mjs --provider openai-compatible --endpoint https://api.openai.com/v1 --model gpt-4o-mini   (key via CODEFORGE_API_KEY)
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskRepository, SqliteTaskRunRepository,
  SqliteTaskExecutionRepository, SqliteTaskGraphRepository, SqliteGraphCommitter,
  SqliteCheckpointRepository, SqliteWorkspaceLockService, SqliteEventLog, SqliteToolCallRepository,
  SqliteApprovalRepository, SqliteVerificationRepository, Blake3GraphHasher,
  runMigrations, createMigrationRegistry,
  NodeWorkspaceManager, NodeProcessSupervisor, NodeToolExecutor, WorkspaceProcessSupervisor,
  BenchmarkRunner, loadBenchmarkFile, inspectProject, SwitchableModelGateway,
  SqliteFailureRepository, SqliteRecoveryActionRepository, ContextCollector,
  WorkspaceSnapshotRollback,
} from '../packages/infrastructure/dist/index.js';
import {
  SessionService, SessionOrchestrator, Planner, GraphCommitService, GraphService,
  ExecutionCoordinator, TaskRunService, TaskExecutor, CheckpointService, NoopProcessReconciler,
  ToolGateway, ContextBuilder, VerificationEngine, CompletionGate,
  FailureAnalyzer, RecoveryEngine,
  buildToolPolicy, buildVerificationPolicy,
} from '../packages/agent-core/dist/index.js';

// ── parse args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, def) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; }
const provider = flag('provider', 'ollama');
const endpoint = flag('endpoint', provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1');
const model = flag('model', argv[0] && !argv[0].startsWith('--') ? argv[0] : 'qwen2.5-coder:latest');
const apiKey = process.env.CODEFORGE_API_KEY;
// Optional per-case delay (ms) to stay under a provider's tokens-per-minute rate limit
// (e.g. Groq free tier caps gpt-oss-120b at 8000 TPM — without a pause the planner call of
// later cases gets HTTP 429, which the runtime reports as PLAN_FAILED → PLANNING_FAILURE,
// masking the model's real capability). Default 0 (no delay) for local Ollama.
const delayMs = Number(flag('delay-ms', '0')) || 0;
// Optional MINIMUM interval between any two model calls (ms). Unlike --delay-ms (which pauses
// between CASES), this spaces out the many calls WITHIN a case (plan + each execute step +
// recovery), which is what actually trips a requests-per-minute (RPM) cap on a hosted free tier
// (e.g. Gemini). A global monotonic gate so bursts can never exceed 60000/interval calls/min.
const minCallIntervalMs = Number(flag('min-call-interval-ms', '0')) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize model calls so each starts at least `minCallIntervalMs` after the previous one began.
let _rpmChain = Promise.resolve();
let _lastCallAt = 0;
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
      // Keep the chain alive regardless of this call's success (so one failure doesn't stall it).
      _rpmChain = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

let counter = 0;
function counters() { let t = 0; let n = 0; return { now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z', nextId: () => 'ID-' + String(n++).padStart(5, '0') }; }
function revision(root) { return { revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0, createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' } }; }

function makeGateway() {
  const gw = new SwitchableModelGateway({ endpoint, initialModel: model, timeoutMs: 300000, options: { temperature: 0.2 } });
  if (provider === 'openai-compatible') gw.setProvider({ provider: 'openai-compatible', model, endpoint, ...(apiKey ? { apiKey } : {}), timeoutMs: 300000 });
  // Gemini uses its own native endpoint by default; pass endpoint only if the caller set a custom one.
  else if (provider === 'gemini') gw.setProvider({ provider: 'gemini', model, ...(flag('endpoint', undefined) ? { endpoint } : {}), ...(apiKey ? { apiKey } : {}), timeoutMs: 300000 });
  return gw;
}

function makeRealAgentRunner() {
  return {
    async run({ workspaceRoot, task }) {
      if (delayMs > 0) await sleep(delayMs);
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
        // Codebase context (files + symbols + import-graph) so the agent SEES the real workspace
        // instead of guessing — the product CLI always wires this. Critical for cross-file tasks
        // (rename + update all call sites): importReverseEdges tells the model which files call the
        // symbol. Without it the benchmark under-measures the runtime (same gap as recovery was).
        const contextCollector = new ContextCollector({ workspaceRoot });
        const taskExec = new TaskExecutor({
          taskRunService: taskRunSvc, executionCoordinator: coordinator,
          contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
          gateway: gw, toolGateway: tg, executor: toolExec,
          verificationEngine: verEngine, completionGate: new CompletionGate({ reports: new SqliteVerificationRepository(db) }),
          verificationPolicy: buildVerificationPolicy(inspectProject(workspaceRoot)),
          contextProvider: contextCollector,
          // P10.1: capture a fresh revision right before verify so the agent's own edits are the
          // baseline, not "drift" (matches the product CLI wiring).
          verificationRevisionProvider: { capture: async () => revision(workspaceRoot) },
          events, maxToolCalls: 12, now: c.now, nextId: c.nextId,
        });
        // Recovery stack (P10.2): without this a task that fails verification is never retried —
        // the benchmark would measure a one-shot model, not the model + the runtime's recovery
        // loop (which re-prompts with the red check output). The product CLI always wires this;
        // the capability curve must too, or it under-sells the runtime.
        const failures = new SqliteFailureRepository(db);
        const recoveryActions = new SqliteRecoveryActionRepository(db);
        const failureAnalyzer = new FailureAnalyzer({ failures, events, now: c.now, nextId: c.nextId });
        const recoveryEngine = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId });
        const verificationEvidenceProvider = { lastFailureOutput: () => checkSupervisor.lastFailureOutput() };
        // P12.14: ROLLBACK port — snapshot the clean (seeded) workspace so an authorised ROLLBACK
        // (SYNTAX class) reverts the agent's broken edit before retrying on that baseline.
        const workspaceRollback = new WorkspaceSnapshotRollback({ root: workspaceRoot });
        const sid = 'S';
        await sessionSvc.create({ session: { sessionId: sid, workspaceId: 'W', workspaceRoot, goalId: 'G', graphVersion: 1, state: 'CREATED', createdAt: c.now(), updatedAt: c.now(), runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L', metadata: { hostname: 'h', processId: 1, ollamaEndpoint: endpoint, ollamaModels: { planner: model, critic: model, executor: model, analyzer: model } } }, hostname: 'h', processId: 1 });
        await graphs.commit({ graphId: 'GR', sessionId: sid, version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1' }, { mutationId: 'M0', sessionId: sid, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed', provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' }, createdAt: 't', status: 'COMMITTED' });
        const orchestrator = new SessionOrchestrator({ sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs, taskRepository: new SqliteTaskRepository(db), executionRepository: executions, executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, taskRunRepository: taskRuns, failureAnalyzer, recoveryEngine, failureRepository: failures, recoveryActionRepository: recoveryActions, verificationEvidenceProvider, workspaceRollback, now: c.now, nextId: c.nextId });
        const goal = { goalId: 'G', version: 1, description: task.description, constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }], createdAt: c.now(), createdBy: 'user' };
        try { await workspaceRollback.captureClean(sid); } catch { /* non-fatal */ }
        try { await orchestrator.run({ sessionId: sid, goal, revision: revision(workspaceRoot), graphVersion: 1 }); }
        catch (err) { if (process.env.CF_DEBUG) console.error(`  [orch error] ${task.description.slice(0, 40)} :: ${err?.code ?? ''} ${err?.message ?? String(err)}`); }
        return { events: await events.query({ sessionId: sid }), traceRef: sid };
      } finally { db.close(); }
    },
  };
}

const benchmark = loadBenchmarkFile(flag('benchmark', 'benchmarks/codeforge-progressive/benchmark.json'));
// Optional case filter: --only PG-12  (or comma-separated: --only PG-05,PG-12). Lets a focused
// re-measure of one or a few cases run without burning the whole curve's RPM budget.
const onlyArg = flag('only', undefined);
if (onlyArg) {
  const want = new Set(onlyArg.split(',').map((s) => s.trim().toUpperCase()));
  benchmark.tasks = benchmark.tasks.filter((t) => want.has(String(t.id).toUpperCase()));
  if (benchmark.tasks.length === 0) { console.error(`--only '${onlyArg}' matched no task id`); process.exit(1); }
}
console.log(`\nCapability curve: ${provider} '${model}' @ ${endpoint}  (${benchmark.tasks.length} tasks)\n`);
const runner = new BenchmarkRunner({
  agent: makeRealAgentRunner(),
  makeCheckSupervisor: (root) => new WorkspaceProcessSupervisor({ workspaceRoot: root }),
  provenance: { agentName: 'codeforge', agentVersion: '0.12.0', gitCommit: 'progressive', model, runtimeConfig: { provider }, environment: process.platform },
  now: () => new Date().toISOString(), newRunId: () => `run-${++counter}`,
});

const { run, result } = await runner.run(benchmark);
const byId = new Map(benchmark.tasks.map((t) => [t.id, t]));
console.log('  id      difficulty  verdict   detail');
console.log('  ' + '-'.repeat(66));
for (const r of run.results) {
  const t = byId.get(r.taskId);
  const mark = r.verdict === 'SUCCESS' ? 'PASS' : r.verdict === 'FAILURE' ? 'FAIL' : 'INVALID';
  const failed = r.checks.filter((c) => !c.passed).map((c) => c.description);
  console.log(`  ${r.taskId.padEnd(7)} ${String(t?.difficulty).padEnd(11)} ${mark.padEnd(9)} ${failed.length ? failed[0] : ''}`);
  // CF_DEBUG: dump every failing check's evidence detail (e.g. the `node test.js` AssertionError),
  // so a FAIL can be read as "which assertion / which file" rather than just a check name.
  if (process.env.CF_DEBUG) {
    for (const c of r.checks) {
      if (c.passed) continue;
      console.log(`    ↳ FAILED CHECK: ${c.description}`);
      if (c.detail) console.log('      ' + String(c.detail).replace(/\n/g, '\n      ').slice(0, 2000));
    }
  }
}
// Per-difficulty rollup.
const diffs = ['TRIVIAL', 'EASY', 'MEDIUM', 'HARD', 'EXPERT'];
console.log('\n  by difficulty:');
for (const d of diffs) {
  const ids = benchmark.tasks.filter((t) => t.difficulty === d).map((t) => t.id);
  if (ids.length === 0) continue;
  const pass = run.results.filter((r) => ids.includes(r.taskId) && r.verdict === 'SUCCESS').length;
  console.log(`    ${d.padEnd(8)} ${pass}/${ids.length}`);
}
console.log(`\n  TOTAL: ${result.success}/${result.total} success  (failure=${result.failure}, invalid=${result.invalid})`);
console.log(`  failure classes: ${JSON.stringify(result.failureBreakdown)}`);
console.log('\nPROGRESSIVE DONE');
