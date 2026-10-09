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
//   --goal <description> The FIRST goal. The runtime stays alive after it; POST /goal
//                        {"description":"..."} enqueues more goals (P10.9).
//   --port <number>      HTTP server port for the dashboard (default: 9500)
//   --db <path>          SQLite database file (default: .codeforge/runtime.db)
//   --max-steps <n>      Max orchestrator iterations (default: 40)
//   --autonomy <level>   full | edits | readonly (default: edits). Controls which tool
//                        risk classes auto-approve vs require a human decision.
//   --learning <on|off>  P11.6 learning plane for recovery ordering (default: off). When on,
//                        recovery reorders its try-order from history (advisory; LE-002).
//   --mission <on|off>   P12.7 Mission Intelligence stage before planning (default: off). When
//                        on, an advisory stage verifies capabilities, routes the model, and
//                        (for complex goals) proposes an architecture + runs a gate. Off =
//                        byte-identical to Phase 11 (MI-002 fail-safe parity).
import { resolve, join, relative, sep } from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
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
import { SqliteLearningStore }            from '../learning/index.js';
import { Blake3GraphHasher }              from '../graph-hash/index.js';
import { SwitchableModelGateway, OllamaModelAdmin } from '../model/index.js';
import { NodeWorkspaceManager }           from '../workspace/index.js';
import { NodeProcessSupervisor }          from '../process/index.js';
import { NodeToolExecutor }               from '../tools/index.js';
import { ObservabilityService }           from '../observability-server/observability-service.js';
import { HttpTransport }                  from '../observability-server/http-transport.js';
import { SessionStateControlGate }        from '../observability-server/session-state-control-gate.js';
import { inspectProject }                 from '../verification-runtime/index.js';
import { WorkspaceProcessSupervisor }     from '../verification-runtime/index.js';
import { ContextCollector }               from '../context-runtime/index.js';
import { NodeApprovalCoordinator }         from '../approval-runtime/index.js';

// Agent-core (pure domain)
import {
  SessionService,
  SessionOrchestrator,
  Planner,
  PlanCritic,
  GoalIngressService,
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
  buildToolPolicy,
  type AutonomyLevel,
  buildVerificationPolicy,
  FailureAnalyzer,
  RecoveryEngine,
  SelfModelBuilder,
  RecoveryAdvisor,
  AdviceGate,
  LessonWriter,
  // Phase 12 (P12.7): optional Mission Intelligence stage (advisory; MI-001/002/004).
  MissionIntelligence,
  MissionArchitect,
  CapabilityDiscovery,
  ModelRegistry,
  type Session,
  type Goal,
} from '@codeforge/agent-core';
import { NodeCapabilityProber } from '../mission/index.js';
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

// ── Workspace file listing (read-only; the dashboard "Result" view) ──────────
// Lists files under the workspace root, excluding the .codeforge scratch zone and heavy dirs.
// Pure read: no mutation, no authority. Bounded to a sane number of entries.
const WS_IGNORE = new Set(['.codeforge', 'node_modules', '.git', 'dist', '__pycache__']);
function listWorkspaceFiles(root: string): { path: string; sizeBytes: number }[] {
  const out: { path: string; sizeBytes: number }[] = [];
  const walk = (dir: string): void => {
    if (out.length >= 500) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (WS_IGNORE.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      out.push({ path: relative(root, abs).split(sep).join('/'), sizeBytes: st.size });
      if (out.length >= 500) return;
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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
  // P10.5: autonomy level controls which tool risk classes auto-approve vs ask a human.
  const autonomyArg   = (args['autonomy'] ?? 'edits').toLowerCase();
  const autonomy: AutonomyLevel =
    autonomyArg === 'full' || autonomyArg === 'readonly' ? autonomyArg : 'edits';
  // P11.6: optional learning plane for recovery ordering. OFF by default — when off, the
  // orchestrator is byte-identical to Phase 10 (LE-002). `--learning on` wires the advisors.
  const learningOn = (args['learning'] ?? 'off').toLowerCase() === 'on';
  // P12.7: optional Mission Intelligence stage before planning. OFF by default — when off, the
  // orchestrator is byte-identical to Phase 11 (MI-002 fail-safe parity). `--mission on` wires an
  // advisory analysis + verified preflight + architecture gate that runs ONCE before planning.
  const missionOn = (args['mission'] ?? 'off').toLowerCase() === 'on';

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
  // P10.9: one runtime now serves a QUEUE of goals. Each goal gets its own session; the
  // active session id is tracked here so shared helpers (revision provider) can tag it.
  let activeSessionId = randomUUID();

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

  // 3. Model gateway (Ollama) — SWITCHABLE so the user can pick a different model at runtime
  // from the dashboard without restarting (MG-001: still one gateway reference everywhere).
  const model = new SwitchableModelGateway({
    endpoint,
    initialModel: modelName,
    timeoutMs: 300_000,
    options: { temperature: 0.2 },
  });
  console.log(`  Ollama model gateway: ${modelName} @ ${endpoint} (switchable at runtime)`);

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
      createdBy: { sessionId: activeSessionId, reason: 'pre_verify' },
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

  // P10.5: real risk policy by autonomy level. DESTRUCTIVE always asks; PRIVILEGED denied.
  const toolPolicy = buildToolPolicy(autonomy);
  const askClasses = toolPolicy.rules
    .filter((r) => r.action === 'require_approval')
    .map((r) => r.riskClass);
  console.log(`  Autonomy:   ${autonomy} (auto-approve reads${autonomy !== 'readonly' ? ' + edits' : ''}; ask: ${askClasses.join(', ') || 'none'})`);
  console.log(`  Learning:   ${learningOn ? 'ON (recovery-order advice; advisory only)' : 'off (Phase 10 behavior)'}`);
  const tg = new ToolGateway({
    calls: toolCalls, approvals, events,
    policy: toolPolicy,
    now: rt.now, nextId: rt.nextId,
  });

  // P10.5: human-in-the-loop coordinator — pauses the session to AWAITING_HUMAN and waits
  // for a dashboard/Telegram/API approve/deny when a tool call needs it. The decision is
  // applied by ObservabilityService.toolControl → ToolGateway.approve/deny (already wired).
  const approvalCoordinator = new NodeApprovalCoordinator({
    toolCalls, sessionService: { transition: (id, ev, ctx) => sessionSvc.transition(id, ev as never, ctx as never) },
  });

  // 6b. Context collector (P10.3): reads the workspace (files + symbols + import graph)
  //     and feeds the signals to the ContextBuilder so the agent sees the real codebase
  //     instead of guessing. Excludes the .codeforge/ scratch zone (its own skip list).
  const contextCollector = new ContextCollector({ workspaceRoot });

  // 6c. Control gate (reads authoritative session state). Shared by the orchestrator
  //     (between tasks) and the TaskExecutor (P10.6: between ReAct steps).
  const gate = new SessionStateControlGate({
    sessions, pollIntervalMs: 200, maxWaitMs: 3_600_000,
  });

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
    approvalCoordinator,
    // P10.6: display-only progress events + responsive control at ReAct step boundaries.
    events,
    loopControl: gate,
    maxToolCalls: maxSteps * 2,
    now: rt.now, nextId: rt.nextId,
  });

  // 8b. Recovery stack (P10.2): when a task does not reach PASSED (run FAILED/TIMEOUT or
  // verification red), the orchestrator classifies the failure and retries with the red
  // output injected into the prompt — or escalates when stuck (no-progress / max attempts).
  const failureAnalyzer = new FailureAnalyzer({ failures, events, now: rt.now, nextId: rt.nextId });
  const recoveryEngine  = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: rt.now, nextId: rt.nextId });
  // Detailed red-check output comes from the verification supervisor (the frozen engine
  // discards it). This feeds both the classifier and the retry prompt.
  const verificationEvidenceProvider = { lastFailureOutput: () => checkSupervisor.lastFailureOutput() };

  // 8c. P11.6 learning plane (optional). When `--learning on`, wire the SelfModel builder,
  // RecoveryAdvisor, and AdviceGate so the orchestrator can reorder the recovery try-order
  // from this task's history. When off, these are undefined → Phase 10 behavior (LE-002).
  const learningStore = learningOn ? new SqliteLearningStore(db) : undefined;
  const learningBuilder = new SelfModelBuilder();
  const lessonWriter = learningOn
    ? new LessonWriter({ store: learningStore!, now: rt.now, nextId: rt.nextId })
    : undefined;
  const learningDeps = learningOn
    ? {
        selfModelBuilder:         learningBuilder,
        recoveryAdvisor:          new RecoveryAdvisor(),
        adviceGate:               new AdviceGate(),
        learningStore:            learningStore!,
      }
    : {};

  // 8d. P12.7 Mission Intelligence stage (optional). When `--mission on`, build an advisory
  // stage that runs ONCE before planning: verify machine capabilities via the ProcessSupervisor
  // (MI-003), route the model within a REAL registry seeded from the configured Ollama model
  // (MI-006), and (for complex missions) propose an architecture + run the deterministic gate
  // (MI-007). When off, missionStage is undefined → Phase 11 behavior (MI-002 parity).
  const missionStage = missionOn
    ? new MissionIntelligence({
        events,
        now: rt.now,
        newId: rt.nextId,
        capabilityDiscovery: new CapabilityDiscovery({
          prober: new NodeCapabilityProber({ supervisor, cwd: workspaceRoot }),
          now: rt.now,
          nowMs: () => Date.now(),
        }),
        // The configured Ollama model is the one model we KNOW is available (injected list,
        // not /api/tags — P12.4 decision). Tagged with mid-tier capabilities as a safe default.
        modelRegistry: new ModelRegistry([
          {
            id: modelName, tier: 'MEDIUM',
            capabilities: {
              reasoning: 'MEDIUM', coding: 'MEDIUM', architecture: 'MEDIUM',
              context: 'MEDIUM', toolUse: 'MEDIUM', speed: 'MEDIUM',
            },
          },
        ]),
        preferredModelId: modelName,
        architect: new MissionArchitect({ gateway: model, now: rt.now, newProvenanceId: rt.nextId }),
      })
    : undefined;
  console.log(`  Mission:    ${missionOn ? 'ON (advisory pre-planning: preflight + model routing + architecture gate)' : 'off (Phase 11 behavior)'}`);

  // 9. Orchestrator
  const orchestrator = new SessionOrchestrator({
    sessionService: sessionSvc, planner, graphCommitService: commitSvc,
    graphRepository: graphs, taskRepository: tasks, executionRepository: executions,
    executionCoordinator: coordinator, taskExecutor: taskExec,
    checkpointService: checkpointSvc, maxIterations: maxSteps,
    controlGate: gate,
    taskRunRepository: taskRuns,
    failureAnalyzer, recoveryEngine, failureRepository: failures,
    // P11.6+: always wire the recovery-action repo so RETRY/FIX outcomes are finalized
    // truthfully (SUCCEEDED/FAILED) after the next run — independent of the learning flag.
    recoveryActionRepository: recoveryActions,
    verificationEvidenceProvider,
    ...learningDeps,
    ...(missionStage !== undefined ? { missionStage } : {}),
    now: rt.now, nextId: rt.nextId,
  });

  // 10. Goal ingress (P10.9) — a FIFO queue of goals submitted at runtime via POST /goal.
  const goalIngress = new GoalIngressService({ now: rt.now, nextId: rt.nextId });

  // 11. Observability server
  const obService = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events,
    controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    toolControl: { approve: (id, by) => tg.approve(id, by), deny: (id, by, reason) => tg.deny(id, by, reason) },
    // P10.5: lets the ControlPlane admit approve/deny only for a call that is actually
    // APPROVAL_PENDING (gate against stray decisions).
    toolStateReader: { getState: async (id) => (await toolCalls.getById(id))?.state ?? null },
    // P10.9: POST /goal enqueues work while the runtime is already running.
    goalIngress,
    // Model management (GET /models, POST /models/pull): list + download Ollama models.
    modelAdmin: new OllamaModelAdmin({ endpoint }),
    // Workspace files (GET /workspace/files): read-only listing so the dashboard shows the RESULT
    // (what the agent produced). Excludes the .codeforge scratch zone. No authority.
    workspaceFiles: { list: async () => listWorkspaceFiles(workspaceRoot) },
    // Runtime config (GET /config, POST /config/model): report workspace + active model and let
    // the dashboard switch the model at runtime (the switchable gateway swaps the target model).
    runtimeConfig: {
      get: () => ({ workspaceRoot, model: model.model, endpoint }),
      setModel: (m: string) => model.setModel(m),
    },
    now: rt.now, nextId: rt.nextId,
  });
  const http = new HttpTransport({ service: obService, streamPollMs: 300 });
  const actualPort = await http.listen(port, '0.0.0.0');
  console.log(`  Dashboard:  http://localhost:${actualPort}/`);
  console.log('');

  // 12. Per-goal runner: a goal → a fresh session → seed graph → orchestrator.run().
  //     Each goal still goes through Planner → GraphCommit → orchestrator (GI-009) — the
  //     queue is only a Decision Gate for "what to do next", never a bypass.
  async function runGoal(goal: Goal): Promise<void> {
    const sid = randomUUID();
    activeSessionId = sid;
    const session: Session = {
      sessionId: sid, workspaceId: 'ws-' + workspaceRoot, workspaceRoot,
      goalId: goal.goalId, graphVersion: 1, state: 'CREATED',
      createdAt: rt.now(), updatedAt: rt.now(),
      runtimeVersion: '0.10.0', schemaVersion: 1,
      budgetId: 'B-' + sid, lockId: 'L-' + sid,
      metadata: { hostname: hostname(), processId: process.pid,
        ollamaEndpoint: endpoint,
        ollamaModels: { planner: modelName, critic: modelName, executor: modelName, analyzer: modelName } },
    };
    await sessionSvc.create({ session, hostname: session.metadata.hostname, processId: session.metadata.processId });
    await graphs.commit({
      graphId: 'GR-' + sid, sessionId: sid, version: 1, nodes: [], edges: [],
      createdAt: rt.now(), createdBy: 'planner', canonicalHash: 'seed',
      schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M0-' + sid, sessionId: sid, baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: rt.nextId(), source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'init', at: rt.now() },
      createdAt: rt.now(), status: 'COMMITTED',
    });

    const revision = await computeWorkspaceRevision({
      root: workspaceRoot,
      scratchPrefixes: SCRATCH_PREFIXES,
      createdBy: { sessionId: sid, reason: 'session_start' },
    });

    console.log('');
    console.log(`  > Goal:     ${goal.description}`);
    console.log(`    Session:  ${sid}`);
    console.log(`    Workspace: ${revision.fileCount} files, ${revision.hash.slice(0, 12)}...`);
    console.log(`    Observe:  http://localhost:${actualPort}/?session=${sid}`);

    try {
      const result = await orchestrator.run({ sessionId: sid, goal, revision, graphVersion: 1 });
      console.log(`  < Result:   ${result.sessionState} | tasks ${result.taskRunCount}, passed ${result.passedTaskIds.length}, non-passed ${result.nonPassedTaskIds.length} (${(result.durationMs / 1000).toFixed(1)}s)`);

      // P11.6: when learning is on, distill this session's recovery history into persisted
      // lessons so FUTURE sessions can be advised (cross-session value). Read-only w.r.t. the
      // run; purely additive; bounded + provenance via LessonWriter (LE-005/006).
      if (lessonWriter !== undefined) {
        try {
          const sFailures = await failures.getBySession(sid);
          const recActions = [];
          for (const f of sFailures) recActions.push(...await recoveryActions.getByFailure(f.failureId));
          const model = learningBuilder.build({ events: [], failures: sFailures, recoveryActions: recActions });
          const lessons = await lessonWriter.writeFromModel(model, 'project');
          if (lessons.length > 0) console.log(`    Learning:   persisted ${lessons.length} lesson(s) from this session`);
        } catch { /* learning write is non-fatal */ }
      }
      // P10.7: a goal that ended AWAITING_HUMAN (unresolved escalation) is NON-TERMINAL,
      // so it still holds the workspace lock. In the goal-queue model each goal is its own
      // session and the queue moves on, so abort the unresolved session to release the lock
      // for the next goal (one agent per workspace — SS-001). COMPLETED/ABORTED already
      // released it.
      if (result.sessionState === 'AWAITING_HUMAN') {
        try { await sessionSvc.transition(sid, 'ABORT'); } catch { /* best-effort */ }
      }
    } catch (err) {
      console.error('    Agent error:', err instanceof Error ? err.message : err);
      // Best-effort: release the workspace lock so a mid-run failure doesn't wedge the queue.
      try { await sessionSvc.transition(sid, 'ABORT'); } catch { /* best-effort */ }
    }
  }

  // 13. Seed the first goal from --goal, then run the queue worker (stays alive).
  goalIngress.submitGoal({ description: goalDesc });
  console.log('  Goal queue worker running. POST /goal {"description":"..."} to enqueue more.');
  console.log('  Press Ctrl+C to stop.');

  const idleSleepMs = 500;
  for (;;) {
    const next = goalIngress.dequeue();
    if (next === undefined) {
      await new Promise((r) => setTimeout(r, idleSleepMs));
      continue;
    }
    // A single goal must never crash the worker — log and keep draining the queue.
    try {
      await runGoal(next);
    } catch (err) {
      console.error('    Goal failed:', err instanceof Error ? err.message : err);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
