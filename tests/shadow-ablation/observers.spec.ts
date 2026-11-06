// kernel-shadow-ablation task 3.6 — enforcement-point observers (design C6–C10).
//
// Property 6: for any generated proposal (tool name × risk class × autonomy level × path ×
// command) and either mode, the ledger decision at EP-TOOL-POLICY equals the Kernel's
// `determineAction`, at EP-SHELL the outcome of the Kernel's `checkCommand`, and at EP-PATH the
// outcome of a plain `NodeWorkspaceManager.checkPath` on the same sandbox. In the enforce arm the
// recorded decision also equals the observed ToolCall state.
//
// Examples: EP-APPROVAL shadow approve (`decidedBy: 'policy'`), EP-VERIFY copy-not-persisted,
// EP-COMPLETION shadow with the real reason, EP-ENV names only + spawn env = safeEnv,
// EP-SCHEMA inactive, previewArgs secret hiding.
//
// Real Kernel objects only: SQLite `:memory:`, real NodeWorkspaceManager / NodeToolExecutor on a
// temp sandbox, FakeProcessSupervisor (no real process is spawned).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompletionGate,
  OPEN_PATH_ACCESS_POLICY,
  DEFAULT_SHELL_POLICY,
  DEFAULT_VERIFICATION_POLICY,
  ShellPolicyError,
  VerificationEngine,
  buildToolPolicy,
  checkCommand,
  determineAction,
  safeEnv,
  WorkspaceError,
  type AutonomyLevel,
  type RiskClass,
  type ToolCall,
  type VerificationPolicy,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  NodeToolExecutor,
  NodeWorkspaceManager,
  SqliteApprovalRepository,
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteToolCallRepository,
  SqliteVerificationRepository,
  createMigrationRegistry,
  runMigrations,
} from '@codeforge/infrastructure';
import { FakeProcessSupervisor, FakeRevisionProvider } from '@codeforge/testing';
import {
  AblationCompletionGate,
  AblationToolExecutor,
  AblationToolGateway,
  AblationVerificationEngine,
  AblationWorkspaceManager,
  DecisionLedger,
  ShadowApprovalCoordinator,
  createSandbox,
  destroySandbox,
  innerShellPolicyFor,
  previewArgs,
  type ArmMode,
  type KernelDecision,
  type LedgerEntry,
  type Sandbox,
} from '@codeforge/testing/shadow-ablation';

// ── seeded PRNG (same mulberry32 generators as tests/mission/clarification-generators.ts; kept
// local because tests/tsconfig.json does not include tests/mission/**) ─────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}
/** Async property runner: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(seed: number, runs: number, body: (rng: Rng, iteration: number) => Promise<void>): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

// ── generators ────────────────────────────────────────────────────────────────

const RISK_CLASSES: readonly RiskClass[] = [
  'READ_ONLY', 'LOW_RISK', 'MODIFY_WORKSPACE', 'NETWORK', 'PACKAGE_INSTALL', 'SYSTEM', 'DESTRUCTIVE', 'PRIVILEGED',
];
const AUTONOMY: readonly AutonomyLevel[] = ['full', 'edits', 'readonly'];
const MODES: readonly ArmMode[] = ['enforce', 'shadow'];
const GATEWAY_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'grep', 'glob',
  'run_command', 'git_add', 'git_commit', 'unknown_tool', 'rm',
] as const;
const PATH_TOOLS = ['read_file', 'write_file', 'delete_file', 'list_dir'] as const;
const ALLOWLISTED_COMMANDS = ['node', 'echo', 'git', 'npm', 'ls', 'node.exe', 'NPM', '/usr/bin/node'] as const;
const FORBIDDEN_COMMANDS = [
  'bash', 'sh', 'powershell', 'cmd', 'C:\\Windows\\System32\\cmd.exe', '/bin/bash', 'format', 'shutdown', 'nc',
] as const;

function genPath(rng: Rng, n: number): string {
  const kind = int(rng, 0, 3);
  if (kind === 0) {
    return pick(rng, [`src/f${n}.ts`, `a${n}.txt`, `dir/sub/x${n}.md`, `./b${n}.txt`, `src/../ok${n}.txt`]);
  }
  if (kind === 1) {
    return pick(rng, [`../outside-${n}.txt`, `src/../../x${n}`, `..\\..\\y${n}.txt`, `a/b/../../../z${n}`]);
  }
  if (kind === 2) {
    return pick(rng, ['/etc/passwd', 'C:\\Windows\\win.ini', join(tmpdir(), `cf-obs-outside-${n}.txt`)]);
  }
  return pick(rng, ['.', `nested/deeper/file${n}.json`, `src\\win${n}.ts`]);
}

function genCommand(rng: Rng): string {
  return rng() < 0.5 ? pick(rng, ALLOWLISTED_COMMANDS) : pick(rng, FORBIDDEN_COMMANDS);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

function counters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(6, '0'),
  };
}

function makeCall(id: string, toolName: string, riskClass: RiskClass, args: unknown): ToolCall {
  return {
    toolCallId: id, sessionId: 'S', taskId: 'T1', toolName, toolVersion: '1.0', riskClass,
    arguments: args, argumentsHash: `HASH-${id}`,
    state: 'REQUESTED', proposedBy: 'model',
    provenance: { provenanceId: `PV-${id}`, source: { kind: 'model', id: 'executor' }, inputs: [], reason: 'execute', at: '2026-01-01T00:00:00.000Z' },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};

const ONE_CHECK_POLICY: VerificationPolicy = {
  ...DEFAULT_VERIFICATION_POLICY,
  checks: [{ name: 'check-0', kind: 'test', command: 'node', args: ['--version'], minScope: 'SMOKE', timeoutMs: 5_000 }],
};

/** The Kernel's decision vocabulary for a policy action (`deny` is a block). */
function kernelOfAction(action: ReturnType<typeof determineAction>): KernelDecision {
  return action === 'deny' ? 'block' : action;
}

function stateFor(decision: KernelDecision): ToolCall['state'] {
  if (decision === 'block') return 'DENIED';
  if (decision === 'require_approval') return 'APPROVAL_PENDING';
  return 'APPROVED';
}

/** Kernel EP-SHELL outcome via the Kernel's own `checkCommand`. */
function kernelShell(command: string): { decision: 'allow' | 'block'; reason?: string } {
  try {
    checkCommand(command, DEFAULT_SHELL_POLICY);
    return { decision: 'allow' };
  } catch (err) {
    if (err instanceof ShellPolicyError) return { decision: 'block', reason: err.code };
    throw err;
  }
}

/** Kernel EP-PATH outcome via a plain NodeWorkspaceManager on the same root. */
async function kernelPath(ws: NodeWorkspaceManager, relpath: string): Promise<{ decision: 'allow' | 'block'; reason?: string }> {
  try {
    await ws.checkPath(relpath);
    return { decision: 'allow' };
  } catch (err) {
    if (err instanceof WorkspaceError && (err.code === 'PATH_ESCAPE' || err.code === 'SYMLINK_ESCAPE')) {
      return { decision: 'block', reason: err.code };
    }
    throw err;
  }
}

function at(entries: readonly LedgerEntry[], point: LedgerEntry['point']): LedgerEntry[] {
  return entries.filter((e) => e.point === point);
}

let db: SqliteDatabaseAdapter;
let sandboxes: Sandbox[] = [];

function newSandbox(label: ArmMode): Sandbox {
  const sb = createSandbox({ 'README.md': '# seed\n', 'src/index.ts': 'export const x = 1;\n' }, label);
  sandboxes.push(sb);
  return sb;
}

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
});

afterEach(() => {
  db.close();
  for (const sb of sandboxes) destroySandbox(sb);
  sandboxes = [];
});

function makeGateway(mode: ArmMode, autonomy: AutonomyLevel, ledger: DecisionLedger, c = counters()): {
  gateway: AblationToolGateway; calls: SqliteToolCallRepository; approvals: SqliteApprovalRepository;
} {
  const calls = new SqliteToolCallRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const gateway = new AblationToolGateway(
    { calls, approvals, events: new SqliteEventLog(db), now: c.now, nextId: c.nextId },
    { mode, enforcedPolicy: buildToolPolicy(autonomy), approvalResolution: 'none', ledger },
  );
  return { gateway, calls, approvals };
}

function makeExecutor(mode: ArmMode, sandbox: Sandbox, ledger: DecisionLedger): {
  executor: AblationToolExecutor; supervisor: FakeProcessSupervisor;
} {
  const c = counters();
  const inner = new NodeWorkspaceManager({ root: sandbox.root, now: c.now, nextId: c.nextId });
  const workspace = new AblationWorkspaceManager(inner, sandbox, mode, ledger);
  const supervisor = new FakeProcessSupervisor();
  const node = new NodeToolExecutor({
    filesystem: { workspace },
    git: { workspace, supervisor },
    shell: { workspace, supervisor, shellPolicy: innerShellPolicyFor(mode) },
  });
  const executor = new AblationToolExecutor(node, {
    mode, shellPolicy: DEFAULT_SHELL_POLICY, envSource: process.env, ledger,
  });
  return { executor, supervisor };
}

// ── Property 6 ────────────────────────────────────────────────────────────────

describe('kernel-shadow-ablation observers — Property 6', () => {
  // Feature: kernel-shadow-ablation, Property 6: Ledger decisions equal the Kernel's decisions
  it('ledger decisions at EP-TOOL-POLICY / EP-SHELL / EP-PATH equal the Kernel functions in both modes', async () => {
    const boxes: Record<ArmMode, Sandbox> = { enforce: newSandbox('enforce'), shadow: newSandbox('shadow') };
    const plain: Record<ArmMode, NodeWorkspaceManager> = {
      enforce: new NodeWorkspaceManager({ root: boxes.enforce.root, ...counters() }),
      shadow: new NodeWorkspaceManager({ root: boxes.shadow.root, ...counters() }),
    };
    const gwCounters = counters();
    let seq = 0;

    await forAllAsync(0x5eed0006, 150, async (rng, i) => {
      const mode = pick(rng, MODES);
      const autonomy = pick(rng, AUTONOMY);
      const riskClass = pick(rng, RISK_CLASSES);
      const toolName = pick(rng, GATEWAY_TOOLS);
      const relpath = genPath(rng, i);
      const command = genCommand(rng);
      const pathTool = pick(rng, PATH_TOOLS);
      const ctx = `mode=${mode} autonomy=${autonomy} risk=${riskClass} tool=${toolName} path=${relpath} cmd=${command} pathTool=${pathTool}`;

      const ledger = new DecisionLedger();

      // ── EP-TOOL-POLICY ──
      ledger.setStep(0, 'organic');
      const { gateway } = makeGateway(mode, autonomy, ledger, gwCounters);
      const expectedPolicy = kernelOfAction(determineAction(toolName, riskClass, buildToolPolicy(autonomy)));
      const result = await gateway.request(makeCall(`TC-${++seq}`, toolName, riskClass, { path: relpath }));
      const policyEntries = at(ledger.snapshot().entries, 'EP-TOOL-POLICY');
      expect(policyEntries, ctx).toHaveLength(1);
      const pe = policyEntries[0]!;
      expect(pe.decision, ctx).toBe(expectedPolicy);
      if (mode === 'enforce') {
        expect(result.state, ctx).toBe(stateFor(expectedPolicy));
        expect(pe.wouldBlock, ctx).toBe(false);
        expect(pe.effective, ctx).toBe(expectedPolicy === 'allow' ? 'allow' : 'block');
      } else {
        // Shadow: only the TG-007/SE-009 override (PRIVILEGED → DENIED) still stops the call.
        const effective = result.state === 'DENIED' ? 'block' : 'allow';
        expect(result.state === 'DENIED', ctx).toBe(riskClass === 'PRIVILEGED');
        expect(pe.effective, ctx).toBe(effective);
        expect(pe.wouldBlock, ctx).toBe(expectedPolicy !== 'allow' && effective === 'allow');
        const approvalEntries = at(ledger.snapshot().entries, 'EP-APPROVAL');
        const expectApproval = expectedPolicy === 'require_approval' && result.state === 'APPROVED';
        expect(approvalEntries.length, ctx).toBe(expectApproval ? 1 : 0);
      }

      // ── EP-SHELL (+ containment delivery) ──
      ledger.setStep(1, 'organic');
      const { executor, supervisor } = makeExecutor(mode, boxes[mode], ledger);
      const shell = kernelShell(command);
      await executor.execute(makeCall(`TC-${++seq}`, 'run_command', 'SYSTEM', { command, args: ['-v'] }));
      const step1 = ledger.snapshot().entries.filter((e) => e.step === 1);
      const shellEntries = at(step1, 'EP-SHELL');
      expect(shellEntries, ctx).toHaveLength(1);
      expect(shellEntries[0]!.decision, ctx).toBe(shell.decision);
      if (shell.reason !== undefined) expect(shellEntries[0]!.reason, ctx).toBe(shell.reason);
      expect(shellEntries[0]!.wouldBlock, ctx).toBe(mode === 'shadow' && shell.decision === 'block');
      const reachesSpawn = mode === 'shadow' || shell.decision === 'allow';
      expect(supervisor.callCount, ctx).toBe(reachesSpawn ? 1 : 0);
      expect(at(step1, 'EP-ENV').length, ctx).toBe(reachesSpawn ? 1 : 0);
      if (reachesSpawn) expect(supervisor.lastOptions?.command, ctx).toBe(command);

      // ── EP-PATH ──
      ledger.setStep(2, 'organic');
      const expectedPath = await kernelPath(plain[mode], relpath);
      const args = pathTool === 'write_file' ? { path: relpath, content: `c${i}` } : { path: relpath };
      await executor.execute(makeCall(`TC-${++seq}`, pathTool, 'MODIFY_WORKSPACE', args));
      const pathEntries = at(ledger.snapshot().entries.filter((e) => e.step === 2), 'EP-PATH');
      expect(pathEntries.length, ctx).toBeGreaterThan(0);
      for (const e of pathEntries) {
        expect(e.decision, ctx).toBe(expectedPath.decision);
        if (expectedPath.reason !== undefined) expect(e.reason, ctx).toBe(expectedPath.reason);
        expect(e.wouldBlock, ctx).toBe(mode === 'shadow' && expectedPath.decision === 'block');
        expect(e.effective, ctx).toBe(mode === 'enforce' ? expectedPath.decision : 'allow');
      }
      // A shadow block goes to containment (simulated), never to the real filesystem.
      if (mode === 'shadow' && expectedPath.decision === 'block') {
        const sim = ledger.snapshot().containment.filter((c) => c.step === 2 && c.kind === 'escape-simulated');
        expect(sim.length, ctx).toBeGreaterThan(0);
      }
    });
  }, 60_000);
});

// ── Examples ──────────────────────────────────────────────────────────────────

describe('kernel-shadow-ablation observers — examples', () => {
  it('EP-APPROVAL: shadow DESTRUCTIVE call is approved by ShadowApprovalCoordinator with decidedBy policy', async () => {
    const ledger = new DecisionLedger();
    ledger.setStep(0, 'organic');
    const { gateway, calls, approvals } = makeGateway('shadow', 'full', ledger);
    const pending = await gateway.request(makeCall('TC-D1', 'delete_file', 'DESTRUCTIVE', { path: 'stale.txt' }));
    // TG-007: DESTRUCTIVE stays APPROVAL_PENDING even under the shadow pass policy.
    expect(pending.state).toBe('APPROVAL_PENDING');

    const coordinator = new ShadowApprovalCoordinator(() => gateway, ledger, 'none');
    await expect(coordinator.awaitDecision('S', 'TC-D1')).resolves.toBe('approved');

    const approval = await approvals.getByToolCall('TC-D1');
    expect(approval?.decision).toBe('APPROVED');
    expect(approval?.decidedBy).toBe('policy');
    expect((await calls.getById('TC-D1'))?.state).toBe('APPROVED');

    const entries = ledger.snapshot().entries;
    const policy = at(entries, 'EP-TOOL-POLICY');
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ decision: 'require_approval', effective: 'allow', wouldBlock: true, tool: 'delete_file' });
    const appr = at(entries, 'EP-APPROVAL');
    expect(appr).toHaveLength(1);
    expect(appr[0]).toMatchObject({ decision: 'block', reason: 'approval_required', effective: 'allow', wouldBlock: true });
  });

  it('EP-VERIFY: shadow returns a PASS copy while the VerificationRepository keeps FAIL', async () => {
    const reports = new SqliteVerificationRepository(db);
    const ledgers: Record<ArmMode, DecisionLedger> = { enforce: new DecisionLedger(), shadow: new DecisionLedger() };
    const returned: Record<ArmMode, string> = { enforce: '', shadow: '' };
    for (const mode of MODES) {
      const c = counters();
      const supervisor = new FakeProcessSupervisor().setOutcome(/node/, { exitCode: 1, stderr: 'check failed' });
      const engine = new AblationVerificationEngine(
        { reports, events: new SqliteEventLog(db), supervisor, revisionProvider: new FakeRevisionProvider(REVISION), now: c.now, nextId: () => `${mode}-${c.nextId()}` },
        { mode, ledger: ledgers[mode] },
      );
      const report = await engine.verify({
        sessionId: 'S', taskId: `T-${mode}`, taskRunId: `TR-${mode}`, targetRevision: REVISION,
        policy: ONE_CHECK_POLICY, reason: 'task_completion',
      });
      returned[mode] = report.status;
      const stored = await reports.getById(report.verificationId);
      expect(stored?.status).toBe('FAIL');
      const ev = at(ledgers[mode].snapshot().entries, 'EP-VERIFY');
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        decision: 'block', reason: 'FAIL',
        effective: mode === 'shadow' ? 'allow' : 'block', wouldBlock: mode === 'shadow',
      });
    }
    expect(returned).toEqual({ enforce: 'FAIL', shadow: 'PASS' });
  });

  it('EP-COMPLETION: shadow returns canComplete true and records the real gate reason', async () => {
    const reports = new SqliteVerificationRepository(db);
    const c = counters();
    // Persist a real FAIL report for T1 through the plain Kernel engine.
    const plainEngine = new VerificationEngine({
      reports, events: new SqliteEventLog(db),
      supervisor: new FakeProcessSupervisor().setOutcome(/node/, { exitCode: 1 }),
      revisionProvider: new FakeRevisionProvider(REVISION), now: c.now, nextId: c.nextId,
    });
    await plainEngine.verify({ sessionId: 'S', taskId: 'T1', taskRunId: 'TR1', targetRevision: REVISION, policy: ONE_CHECK_POLICY, reason: 'task_completion' });

    for (const taskId of ['T1', 'T-no-report']) {
      const real = await new CompletionGate({ reports }).canComplete(taskId, REVISION);
      expect(real.canComplete).toBe(false);
      expect(real.reason).toBeDefined();

      const enforceLedger = new DecisionLedger();
      const enforced = await new AblationCompletionGate({ reports }, { mode: 'enforce', ledger: enforceLedger }).canComplete(taskId, REVISION);
      expect(enforced).toEqual(real);
      expect(at(enforceLedger.snapshot().entries, 'EP-COMPLETION')[0]).toMatchObject({
        decision: 'block', reason: real.reason, effective: 'block', wouldBlock: false,
      });

      const shadowLedger = new DecisionLedger();
      const shadowed = await new AblationCompletionGate({ reports }, { mode: 'shadow', ledger: shadowLedger }).canComplete(taskId, REVISION);
      expect(shadowed).toEqual({ ...real, canComplete: true });
      const entries = at(shadowLedger.snapshot().entries, 'EP-COMPLETION');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ decision: 'block', reason: real.reason, effective: 'allow', wouldBlock: true });
    }
  });

  describe('EP-ENV', () => {
    const SECRET_VARS: Readonly<Record<string, string>> = {
      GITHUB_TOKEN_CF_OBS_TEST: 'ghp-value-0f1e2d3c4b5a69788796a5b4',
      CF_OBS_PASSWORD_TEST: 'pw-value-hunter2-9a8b7c6d5e',
    };
    beforeEach(() => {
      for (const [k, v] of Object.entries(SECRET_VARS)) process.env[k] = v;
    });
    afterEach(() => {
      for (const k of Object.keys(SECRET_VARS)) Reflect.deleteProperty(process.env, k);
    });

    it('records filtered variable names, never values, and the spawn env equals safeEnv', async () => {
      for (const mode of MODES) {
        const ledger = new DecisionLedger();
        ledger.setStep(0, 'organic');
        const { executor, supervisor } = makeExecutor(mode, newSandbox(mode), ledger);
        const res = await executor.execute(makeCall(`TC-ENV-${mode}`, 'run_command', 'SYSTEM', { command: 'node', args: ['-v'] }));
        expect(res.exitCode).toBe(0);

        const env = at(ledger.snapshot().entries, 'EP-ENV');
        expect(env).toHaveLength(1);
        expect(env[0]!.decision).toBe('filter');
        expect(env[0]!.effective).toBe('filter');
        expect(env[0]!.wouldBlock).toBe(false);
        for (const name of Object.keys(SECRET_VARS)) expect(env[0]!.reason).toContain(name);

        const serialized = JSON.stringify(ledger.snapshot());
        for (const value of Object.values(SECRET_VARS)) expect(serialized).not.toContain(value);

        expect(supervisor.callCount).toBe(1);
        const spawnEnv = supervisor.lastOptions?.env;
        expect(spawnEnv).toEqual(safeEnv(process.env));
        for (const name of Object.keys(SECRET_VARS)) expect(spawnEnv).not.toHaveProperty(name);
      }
    });
  });

  it('EP-SCHEMA: recorded once as inactive when no schemas are wired', async () => {
    const c = counters(); // one id source: both gateways share the :memory: event log
    for (const mode of MODES) {
      const ledger = new DecisionLedger();
      const { gateway } = makeGateway(mode, 'full', ledger, c);
      expect(gateway.schemaCheck).toBe('inactive');
      ledger.setStep(0, 'organic');
      await gateway.request(makeCall(`TC-S1-${mode}`, 'read_file', 'READ_ONLY', { path: 'a.txt' }));
      ledger.setStep(1, 'organic');
      await gateway.request(makeCall(`TC-S2-${mode}`, 'write_file', 'MODIFY_WORKSPACE', { path: 'b.txt', content: 'x' }));
      const schema = at(ledger.snapshot().entries, 'EP-SCHEMA');
      expect(schema).toHaveLength(1);
      expect(schema[0]!.decision).toBe('allow');
      expect(schema[0]!.reason).toMatch(/^inactive/);
      expect(schema[0]!.wouldBlock).toBe(false);
    }
  });

  it('previewArgs hides values under secret-like keys and pattern secrets', () => {
    const preview = previewArgs({
      path: 'src/config.ts',
      password: 'hunter2-plain',
      apiKey: 'plainkey123',
      nested: { api_key: 'nestedkey456', list: [{ token: 'tok789' }] },
      content: 'const conf = "password=patternsecret1"; Authorization: Bearer abc.def.ghi',
      aws: 'AKIAABCDEFGHIJKLMNOP',
    });
    for (const secret of ['hunter2-plain', 'plainkey123', 'nestedkey456', 'tok789', 'patternsecret1', 'abc.def.ghi', 'AKIAABCDEFGHIJKLMNOP']) {
      expect(preview).not.toContain(secret);
    }
    expect(preview).toContain('[REDACTED]');
    expect(preview).toContain('src/config.ts');

    // Truncated after redaction to 200 chars + ellipsis.
    const long = previewArgs({ content: 'x'.repeat(1000) });
    expect(long.length).toBe(201);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ── kernel-gap-closure: EP-PATH rows for the Path_Access_Policy (SE-012, WS-011) ─────────────

describe('kernel-gap-closure observers — EP-PATH SENSITIVE_PATH / PROTECTED_PATH', () => {
  const SEED = { '.env': 'SECRET=1\n', '.git/config': '[core]\n', 'src/a.ts': 'export {};\n' } as const;

  function pathSetup(mode: ArmMode): { ws: AblationWorkspaceManager; ledger: DecisionLedger; sandbox: Sandbox } {
    const sandbox = createSandbox(SEED, mode);
    sandboxes.push(sandbox);
    const c = counters();
    // Mirrors arm.ts: the shadow arm's inner manager is open, the observer holds the real policy.
    const inner = new NodeWorkspaceManager({
      root: sandbox.root, now: c.now, nextId: c.nextId,
      ...(mode === 'shadow' ? { pathAccess: OPEN_PATH_ACCESS_POLICY } : {}),
    });
    const ledger = new DecisionLedger();
    ledger.setStep(0, 'organic');
    return { ws: new AblationWorkspaceManager(inner, sandbox, mode, ledger), ledger, sandbox };
  }

  const blocks = (ledger: DecisionLedger): LedgerEntry[] =>
    at(ledger.snapshot().entries, 'EP-PATH').filter((e) => e.decision === 'block');

  it('enforce: sensitive read and protected write are blocked, recorded and rethrown', async () => {
    const { ws, ledger, sandbox } = pathSetup('enforce');

    await expect(ws.readFile('.env')).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
    await expect(ws.writeFile('.git/config', 'x', 'S')).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    await expect(ws.deleteFile('.git/config', 'S')).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    await expect(ws.checkAccess('read', 'server.pem')).rejects.toBeInstanceOf(WorkspaceError);

    const rows = blocks(ledger);
    expect(rows.map((e) => e.reason)).toEqual(['SENSITIVE_PATH', 'PROTECTED_PATH', 'PROTECTED_PATH', 'SENSITIVE_PATH']);
    for (const e of rows) expect(e).toMatchObject({ decision: 'block', effective: 'block', wouldBlock: false });
    expect(readFileSync(join(sandbox.root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(ledger.snapshot().containment).toEqual([]);

    // Not over-blocking: reading VCS metadata and ordinary files stays allowed.
    await expect(ws.readFile('.git/config')).resolves.toBe('[core]\n');
    await expect(ws.readFile('src/a.ts')).resolves.toBe('export {};\n');
    expect(blocks(ledger)).toHaveLength(4);
  });

  it('shadow: the same calls record wouldBlock and are performed inside the sandbox', async () => {
    const { ws, ledger, sandbox } = pathSetup('shadow');

    await expect(ws.readFile('.env')).resolves.toBe('SECRET=1\n');
    await ws.writeFile('.git/config', 'changed\n', 'S');
    await expect(ws.checkAccess('read', 'server.pem')).resolves.toBeUndefined();

    const rows = blocks(ledger);
    expect(rows.map((e) => e.reason)).toEqual(['SENSITIVE_PATH', 'PROTECTED_PATH', 'SENSITIVE_PATH']);
    for (const e of rows) expect(e).toMatchObject({ decision: 'block', effective: 'allow', wouldBlock: true });
    // The operation really happened, but only in the temp sandbox.
    expect(readFileSync(join(sandbox.root, '.git', 'config'), 'utf8')).toBe('changed\n');
    expect(ledger.snapshot().containment).toEqual([]);
  });

  it('enforce and shadow record identical EP-PATH block rows for the same calls', async () => {
    const rowsByMode: Record<ArmMode, Array<[string, string | undefined]>> = { enforce: [], shadow: [] };
    for (const mode of MODES) {
      const { ws, ledger } = pathSetup(mode);
      for (const p of ['.env', '.env.local', 'id_rsa']) await ws.readFile(p).catch(() => undefined);
      await ws.writeFile('.git/HEAD', 'x', 'S').catch(() => undefined);
      rowsByMode[mode] = blocks(ledger).map((e) => [e.tool, e.reason]);
    }
    expect(rowsByMode.shadow).toEqual(rowsByMode.enforce);
    expect(rowsByMode.enforce.length).toBeGreaterThanOrEqual(3);
  });
});
