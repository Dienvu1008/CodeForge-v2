#!/usr/bin/env node
// runtime-cli.ts — CodeForge v2 runtime entrypoint. Wires the deterministic kernel with
// a real Ollama model and starts the ObservabilityServer so dashboard/Telegram/VS Code
// can connect. This is a BOOTSTRAP — it assembles the library pieces; all logic lives in
// agent-core (pure) + infrastructure (adapters).
//
// Usage:
//   node dist/cli/runtime-cli.js --workspace /path/to/project --model qwen2.5-coder --goal "Add auth"
//
// Options:
//   --workspace <path>   Project root (default: cwd)
//   --model <name>       Ollama model name (default: qwen2.5-coder)
//   --endpoint <url>     Ollama server URL (default: http://localhost:11434)
//   --goal <description> What the agent should do
//   --port <number>      HTTP server port for the dashboard (default: 9500)
//   --db <path>          SQLite database file (default: .codeforge/runtime.db)
//   --max-steps <n>      Max orchestrator iterations (default: 40)
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

// Infrastructure
import { SqliteDatabaseAdapter }          from '../sqlite/index.js';
import { runMigrations, createMigrationRegistry } from '../sqlite/index.js';
import { SqliteSessionRepository }        from '../repositories/index.js';
import { SqliteTaskRepository }           from '../repositories/index.js';
import { SqliteTaskRunRepository }        from '../repositories/index.js';
import { SqliteTaskExecutionRepository }  from '../repositories/index.js';
import { SqliteTaskGraphRepository }      from '../repositories/index.js';
import { SqliteGraphCommitter }           from '../repositories/index.js';
import { SqliteCheckpointRepository }     from '../repositories/index.js';
import { SqliteWorkspaceLockService }     from '../repositories/index.js';
import { SqliteEventLog }                 from '../event-log/index.js';
import { SqliteToolCallRepository }       from '../repositories/index.js';
import { SqliteApprovalRepository }       from '../repositories/index.js';
import { SqliteVerificationRepository }   from '../repositories/index.js';
import { SqliteFailureRepository }        from '../repositories/index.js';
import { SqliteRecoveryActionRepository } from '../repositories/index.js';
import { Blake3GraphHasher }              from '../graph-hash/index.js';
import { OllamaModelGateway }            from '../model/index.js';
import { NodeWorkspaceManager }           from '../workspace/index.js';
import { NodeProcessSupervisor }          from '../process/index.js';
import { NodeToolExecutor }               from '../tools/index.js';
import { ObservabilityService }           from '../observability-server/observability-service.js';
import { HttpTransport }                  from '../observability-server/http-transport.js';
import { SessionStateControlGate }        from '../observability-server/session-state-control-gate.js';
import { inspectProject }                 from '../verification-runtime/index.js';
import { WorkspaceProcessSupervisor }     from '../verification-runtime/index.js';
import { ContextCollector }               from '../context-runtime/index.js';

// Agent-core (pure domain)
import {
  SessionService,
  SessionOrchestrator,
  Planner,
  PlanCritic,
  GraphCommitService,
  GraphService,
  ExecutionCoordinator,
  TaskRunService,
  TaskExecutor,
  CheckpointService,
  NoopProcessReconciler,
  ToolGateway,
  ContextBuilder,
  ControlPlane,
  VerificationEngine,
  CompletionGate,
  PERMISSIVE_TEST_POLICY,
  buildVerificationPolicy,
  FailureAnalyzer,
  RecoveryEngine,
  type Session,
  type Goal,
} from '@codeforge/agent-core';
import { computeWorkspaceRevision } from '../workspace-revision/index.js';

// ── Argument parsing (minimal, no external deps) ────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]!;
    if (key.startsWith('--') && i + 1 < argv.length) {
      args[key.slice(2)] = argv[++i]!;
    }
  }
  return args;
}

// ── Deterministic id / time helpers ─────────────────────────────────────────

function makeRuntime() {
  let seq = 0;
  return {
    now: () => new Date().toISOString(),
    nextId: () => `${Date.now().toString(36)}-${(++seq).toString(36).padStart(4, '0')}`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const workspaceRoot = resolve(args['workspace'] ?? process.cwd());
  const modelName     = args['model']    ?? 'qwen2.5-coder';
  const endpoint      = args['endpoint'] ?? 'http://localhost:11434';
  const goalDesc      = args['goal']     ?? 'Describe what CodeForge should do with --goal "..."';
  const port          = parseInt(args['port'] ?? '9500', 10);
  const maxSteps      = parseInt(args['max-steps'] ?? '40', 10);
  const dbPath        = args['db'] ?? join(workspaceRoot, '.codeforge', 'runtime.db');

  console.log('╔═══════════════════════════════════════════╗');
  console.log('║         CodeForge v2 Runtime              ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  workspace:  ${workspaceRoot}`);
  console.log(`  model:      ${modelName}`);
  console.log(`  endpoint:   ${endpoint}`);
  console.log(`  goal:       ${goalDesc}`);
  console.log(`  port:       ${port}`);
  console.log(`  db:         ${dbPath}`);
  console.log(`  max-steps:  ${maxSteps}`);
  console.log('');

  // 1. Database
  mkdirSync(resolve(dbPath, '..'), { recursive: true });
  const db = new SqliteDatabaseAdapter(dbPath);
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => new Date().toISOString() });

  const rt = makeRuntime();
  const sessionId = randomUUID();
  const goalId    = randomUUID();

  // 2. Repositories
  const sessions   = new SqliteSessionRepository(db);
  const events     = new SqliteEventLog(db);
  const tasks      = new SqliteTaskRepository(db);
  const taskRuns   = new SqliteTaskRunRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const graphs     = new SqliteTaskGraphRepository(db);
  const committer  = new SqliteGraphCommitter(db);
  const checkpointRepo = new SqliteCheckpointRepository(db);
  const lock       = new SqliteWorkspaceLockService(db);
  const toolCalls  = new SqliteToolCallRepository(db);
  const approvals  = new SqliteApprovalRepository(db);
  const verReports = new SqliteVerificationRepository(db);
  const failures   = new SqliteFailureRepository(db);
  const recoveryActions = new SqliteRecoveryActionRepository(db);

  // 3. Model gateway (Ollama)
  const model = new OllamaModelGateway({
    endpoint,
    model: modelName,
    timeoutMs: 300_000,
    options: { temperature: 0.2 },
  });
  console.log(`  Ollama model gateway: ${modelName} @ ${endpoint}`);

  // 4. Domain services
  const hasher     = new Blake3GraphHasher();
  const graphSvc   = new GraphService({ hasher, now: rt.now, nextId: rt.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
  const commitSvc  = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: rt.now, nextId: rt.nextId });
  const sessionSvc = new SessionService({ sessions, events, lock, now: rt.now, nextId: rt.nextId });
  const coordinator = new ExecutionCoordinator({ executions, now: rt.now });
  const runSvc     = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: rt.now, nextId: rt.nextId });
  const checkpointSvc = new CheckpointService({ checkpoints: checkpointRepo, events, now: rt.now, nextId: rt.nextId });
  // P10.4: advisory PlanCritic drives one bounded refinement round so the Planner
  // decomposes complex goals into a better multi-task graph (MG-006 — advisory only).
  const planCritic = new PlanCritic({ gateway: model, now: rt.now, nextId: rt.nextId });
  const planner    = new Planner({ gateway: model, now: rt.now, nextId: rt.nextId, planCritic });
  const ctxBuilder = new ContextBuilder({ now: rt.now, nextId: rt.nextId });

  // 5. Workspace + tool execution
  const workspace = new NodeWorkspaceManager({ root: workspaceRoot, now: rt.now, nextId: rt.nextId });
  const supervisor = new NodeProcessSupervisor();
  const toolExec = new NodeToolExecutor({
    filesystem: { workspace },
    git:        { workspace, supervisor },
    shell:      { workspace, supervisor },
  });

  // 6. Verification + ToolGateway
  //    P10.1: real verification. Checks run in the workspace via a dedicated supervisor
  //    (forces cwd + env + resolves npm/npx on Windows), and the policy is DERIVED from
  //    the project (build/test/lint). Task PASSED only when checks are green (TI-005).
  // The runtime DB lives at .codeforge/ INSIDE the workspace; its writes must not count
  // as workspace mutations (else verification sees drift → INVALID). Exclude it as a
  // scratch zone from the revision hash (WS/VR-003 scratch spirit).
  const SCRATCH_PREFIXES = ['.codeforge/'];
  const revisionProvider = {
    capture: async (_label: string) => computeWorkspaceRevision({
      root: workspaceRoot,
      scratchPrefixes: SCRATCH_PREFIXES,
      createdBy: { sessionId, reason: 'pre_verify' },
    }),
  };
  const checkSupervisor = new WorkspaceProcessSupervisor({ workspaceRoot });
  const verEngine = new VerificationEngine({
    reports: verReports, events, supervisor: checkSupervisor, revisionProvider,
    now: rt.now, nextId: rt.nextId,
  });
  const completionGate = new CompletionGate({ reports: verReports });
  const verificationPolicy = buildVerificationPolicy(inspectProject(workspaceRoot));
  const checkNames = verificationPolicy.checks.map((c) => c.name);
  console.log(`  Verification: ${checkNames.length > 0 ? checkNames.join(', ') : '(no checks — tasks cannot be verified-PASSED)'}`);

  const tg = new ToolGateway({
    calls: toolCalls, approvals, events,
    policy: PERMISSIVE_TEST_POLICY, // TODO (P10.5): real risk policy + approval
    now: rt.now, nextId: rt.nextId,
  });

  // 6b. Context collector (P10.3): reads the workspace (files + symbols + import graph)
  //     and feeds the signals to the ContextBuilder so the agent sees the real codebase
  //     instead of guessing. Excludes the .codeforge/ scratch zone (its own skip list).
  const contextCollector = new ContextCollector({ workspaceRoot });

  // 7. TaskExecutor
  const taskExec = new TaskExecutor({
    taskRunService: runSvc, executionCoordinator: coordinator,
    contextBuilder: ctxBuilder, gateway: model,
    toolGateway: tg, executor: toolExec,
    verificationEngine: verEngine, completionGate,
    verificationPolicy,
    contextProvider: contextCollector,
    // P10.1: capture a FRESH revision right before verify so the agent's own file
    // edits (made during execute) are the baseline, not "drift" (VR-008). Reuses
    // revisionProvider — same shape, scratch-aware, excludes .codeforge/.
    verificationRevisionProvider: { capture: (reason: string) => revisionProvider.capture(reason) },
    maxToolCalls: maxSteps * 2,
    now: rt.now, nextId: rt.nextId,
  });

  // 8. Control gate (reads authoritative session state)
  const gate = new SessionStateControlGate({
    sessions, pollIntervalMs: 200, maxWaitMs: 3_600_000,
  });

  // 8b. Recovery stack (P10.2): when a task does not reach PASSED (run FAILED/TIMEOUT or
  // verification red), the orchestrator classifies the failure and retries with the red
  // output injected into the prompt — or escalates when stuck (no-progress / max attempts).
  const failureAnalyzer = new FailureAnalyzer({ failures, events, now: rt.now, nextId: rt.nextId });
  const recoveryEngine  = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: rt.now, nextId: rt.nextId });
  // Detailed red-check output comes from the verification supervisor (the frozen engine
  // discards it). This feeds both the classifier and the retry prompt.
  const verificationEvidenceProvider = { lastFailureOutput: () => checkSupervisor.lastFailureOutput() };

  // 9. Orchestrator
  const orchestrator = new SessionOrchestrator({
    sessionService: sessionSvc, planner, graphCommitService: commitSvc,
    graphRepository: graphs, taskRepository: tasks, executionRepository: executions,
    executionCoordinator: coordinator, taskExecutor: taskExec,
    checkpointService: checkpointSvc, maxIterations: maxSteps,
    controlGate: gate,
    taskRunRepository: taskRuns,
    failureAnalyzer, recoveryEngine, failureRepository: failures,
    verificationEvidenceProvider,
    now: rt.now, nextId: rt.nextId,
  });

  // 10. Observability server
  const obService = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events,
    controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    toolControl: { approve: (id, by) => tg.approve(id, by), deny: (id, by, reason) => tg.deny(id, by, reason) },
    now: rt.now, nextId: rt.nextId,
  });
  const http = new HttpTransport({ service: obService, streamPollMs: 300 });
  const actualPort = await http.listen(port, '0.0.0.0');
  console.log(`  Dashboard:  http://localhost:${actualPort}/`);
  console.log('');

  // 11. Create session + seed graph
  const session: Session = {
    sessionId, workspaceId: 'ws-' + workspaceRoot, workspaceRoot,
    goalId, graphVersion: 1, state: 'CREATED',
    createdAt: rt.now(), updatedAt: rt.now(),
    runtimeVersion: '0.9.0', schemaVersion: 1,
    budgetId: 'B-' + sessionId, lockId: 'L-' + sessionId,
    metadata: { hostname: hostname(), processId: process.pid,
      ollamaEndpoint: endpoint,
      ollamaModels: { planner: modelName, critic: modelName, executor: modelName, analyzer: modelName } },
  };
  const goal: Goal = {
    goalId, version: 1, description: goalDesc, constraints: [],
    acceptanceCriteria: [{ criterionId: 'AC1', description: goalDesc, mandatory: true }],
    createdAt: rt.now(), createdBy: 'user',
  };

  await sessionSvc.create({ session, hostname: session.metadata.hostname, processId: session.metadata.processId });
  await graphs.commit({
    graphId: 'GR-' + sessionId, sessionId, version: 1, nodes: [], edges: [],
    createdAt: rt.now(), createdBy: 'planner', canonicalHash: 'seed',
    schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: 'M0-' + sessionId, sessionId, baseVersion: 0, operations: [],
    proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: rt.nextId(), source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'init', at: rt.now() },
    createdAt: rt.now(), status: 'COMMITTED',
  });

  const revision = await computeWorkspaceRevision({
    root: workspaceRoot,
    scratchPrefixes: SCRATCH_PREFIXES,
    createdBy: { sessionId, reason: 'session_start' },
  });
  console.log(`  Session:    ${sessionId}`);
  console.log(`  Goal:       ${goalDesc}`);
  console.log(`  Workspace:  ${revision.fileCount} files, ${revision.hash.slice(0, 12)}...`);
  console.log('');
  console.log('  Running agent...');
  console.log('  Open the dashboard to observe:');
  console.log(`    http://localhost:${actualPort}/?session=${sessionId}`);
  console.log('');

  // 12. Run the agent
  try {
    const result = await orchestrator.run({
      sessionId, goal, revision, graphVersion: 1,
    });
    console.log('');
    console.log('╔═══════════════════════════════════════════╗');
    console.log(`║  Result: ${result.sessionState.padEnd(33)}║`);
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`  Tasks run:    ${result.taskRunCount}`);
    console.log(`  Passed:       ${result.passedTaskIds.length}`);
    console.log(`  Non-passed:   ${result.nonPassedTaskIds.length}`);
    console.log(`  Duration:     ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Metrics:      http://localhost:${actualPort}/metrics?session=${sessionId}`);
    console.log(`  Audit:        http://localhost:${actualPort}/audit?session=${sessionId}`);
  } catch (err) {
    console.error('  Agent error:', err instanceof Error ? err.message : err);
  }

  console.log('');
  console.log('  Server still running — press Ctrl+C to stop.');
  // Keep process alive for the HTTP server.
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
