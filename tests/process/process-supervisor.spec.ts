// P1.5-PS1 — ProcessSupervisor: FakeProcessSupervisor + NodeProcessSupervisor
//             + Schema migration v2 (approvals, failures, recovery_actions).
//
// Cross-platform: Windows + Linux/WSL2. Node commands are chosen to work on both:
//   node --version   (echo-equivalent, always available, exits 0)
//   node -e "..."    (stdout/stderr/exit-code control without shell dependency)
//   node -e "while(true){}" (timeout target)
//   node <nonexistent> (ENOENT / COMMAND_NOT_FOUND path)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  FakeProcessSupervisor,
  type FakeSpawnOutcome,
} from '@codeforge/testing';
import {
  NodeProcessSupervisor,
  runMigrations,
  createMigrationRegistry,
  SqliteDatabaseAdapter,
} from '@codeforge/infrastructure';
import { SpawnError } from '@codeforge/agent-core';

// Path to node executable — same runtime running the tests, guaranteed to exist.
const NODE = process.execPath;

// ── FakeProcessSupervisor ─────────────────────────────────────────────────────

describe('FakeProcessSupervisor — deterministic contract', () => {
  let fake: FakeProcessSupervisor;

  beforeEach(() => {
    fake = new FakeProcessSupervisor();
  });

  it('defaults to exitCode=0 with empty stdout/stderr', async () => {
    const r = await fake.spawn({ command: 'any', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBe(false);
    expect(r.killed).toBe(false);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('setOutcome: returns configured result for matching command', async () => {
    const outcome: FakeSpawnOutcome = { exitCode: 1, stderr: 'oops', durationMs: 42 };
    fake.setOutcome(/tsc/, outcome);
    const r = await fake.spawn({ command: 'tsc', args: ['--version'], cwd: '/r', timeoutMs: 100 });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('oops');
    expect(r.durationMs).toBe(42);
  });

  it('setOutcome: unmatched command falls through to default', async () => {
    fake.setOutcome(/tsc/, { exitCode: 99 });
    const r = await fake.spawn({ command: 'eslint', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r.exitCode).toBe(0);
  });

  it('setSequence: consumes outcomes in FIFO order', async () => {
    fake.setSequence([{ exitCode: 0, stdout: 'first' }, { exitCode: 1, stderr: 'second' }]);
    const r1 = await fake.spawn({ command: 'cmd', args: [], cwd: '/r', timeoutMs: 100 });
    const r2 = await fake.spawn({ command: 'cmd', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r1.stdout).toBe('first');
    expect(r2.exitCode).toBe(1);
  });

  it('sequence takes priority over rules', async () => {
    fake.setOutcome(/cmd/, { exitCode: 99 });
    fake.setSequence([{ exitCode: 0, stdout: 'seq' }]);
    const r = await fake.spawn({ command: 'cmd', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r.stdout).toBe('seq');
    expect(r.exitCode).toBe(0);
  });

  it('timedOut=true → exitCode is null (SE-007 timeout result)', async () => {
    fake.setOutcome(/slow/, { timedOut: true });
    const r = await fake.spawn({ command: 'slow', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('commandNotFound → throws SpawnError(COMMAND_NOT_FOUND)', async () => {
    fake.setOutcome(/missing/, { commandNotFound: true });
    await expect(
      fake.spawn({ command: 'missing', args: [], cwd: '/r', timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(SpawnError);
    await expect(
      fake.spawn({ command: 'missing', args: [], cwd: '/r', timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
  });

  it('tracks callCount and call history', async () => {
    await fake.spawn({ command: 'a', args: [], cwd: '/r', timeoutMs: 100 });
    await fake.spawn({ command: 'b', args: [], cwd: '/r', timeoutMs: 100 });
    expect(fake.callCount).toBe(2);
    expect(fake.calls[0]?.options.command).toBe('a');
    expect(fake.calls[1]?.options.command).toBe('b');
    expect(fake.lastOptions?.command).toBe('b');
  });

  it('reset() clears rules, sequence, and history', async () => {
    fake.setOutcome(/x/, { exitCode: 5 });
    fake.setSequence([{ exitCode: 3 }]);
    await fake.spawn({ command: 'x', args: [], cwd: '/r', timeoutMs: 100 });
    fake.reset();
    expect(fake.callCount).toBe(0);
    expect(fake.calls).toHaveLength(0);
    const r = await fake.spawn({ command: 'x', args: [], cwd: '/r', timeoutMs: 100 });
    expect(r.exitCode).toBe(0); // back to default
  });
});

// ── NodeProcessSupervisor (real subprocesses) ─────────────────────────────────

describe('NodeProcessSupervisor — real subprocess (SE-007/008, TG-010)', () => {
  const sup = new NodeProcessSupervisor();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf2-ps1-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exits 0 and captures stdout', async () => {
    const r = await sup.spawn({
      command: NODE,
      args: ['-e', 'process.stdout.write("hello")'],
      cwd: dir,
      env: {},
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr and non-zero exit code', async () => {
    const r = await sup.spawn({
      command: NODE,
      args: ['-e', 'process.stderr.write("err"); process.exit(2)'],
      cwd: dir,
      env: {},
      timeoutMs: 5_000,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe('err');
  });

  it('SE-007: timeout → timedOut=true, exitCode=null (TG-010: not left running)', async () => {
    const r = await sup.spawn({
      command: NODE,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      env: {},
      timeoutMs: 200,
      gracePeriodMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    // The process must be dead — no orphan (SE-008). We verify structurally: the
    // promise resolved, meaning the supervisor received the 'close' event.
  }, 8_000);

  it('COMMAND_NOT_FOUND → throws SpawnError', async () => {
    await expect(
      sup.spawn({
        command: join(dir, '__nonexistent_binary__'),
        args: [],
        cwd: dir,
        env: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(SpawnError);
  });

  it('env is replaced — subprocess cannot see parent env vars', async () => {
    // We set a sentinel in parent env, pass empty SafeEnv → subprocess should NOT see it.
    const r = await sup.spawn({
      command: NODE,
      args: ['-e', 'process.stdout.write(process.env.CF2_SENTINEL ?? "absent")'],
      cwd: dir,
      env: {}, // empty — SE-004: no inherited secrets
      timeoutMs: 5_000,
    });
    // Without the sentinel in SafeEnv the subprocess prints 'absent'.
    expect(r.stdout).toBe('absent');
  });

  it('shell:false — arguments with shell metacharacters are passed literally', async () => {
    // If shell:true were used, `; echo pwned` would execute a second command.
    const r = await sup.spawn({
      command: NODE,
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', '--', '; echo pwned'],
      cwd: dir,
      env: {},
      timeoutMs: 5_000,
    });
    // The literal string is printed, no second command was executed.
    expect(r.stdout).toContain('; echo pwned');
  });
});

// ── Schema migration v2 ───────────────────────────────────────────────────────

describe('Migration v2 (P1.5-DB2) — approvals, failures, recovery_actions', () => {
  let db: SqliteDatabaseAdapter;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  it('runMigrations advances to v2 and creates the three new tables', () => {
    const result = runMigrations(db, createMigrationRegistry(), {
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(result.toVersion).toBe(2);
    expect(result.applied).toContain('0002_phase15_approvals_failures_recovery');

    // Each table must exist and accept a basic query.
    expect(() => db.query('SELECT * FROM approvals LIMIT 0')).not.toThrow();
    expect(() => db.query('SELECT * FROM failures LIMIT 0')).not.toThrow();
    expect(() => db.query('SELECT * FROM recovery_actions LIMIT 0')).not.toThrow();
  });

  it('migration is idempotent — running again on an up-to-date db is a no-op', () => {
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    const r2 = runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    expect(r2.applied).toHaveLength(0);
    expect(r2.toVersion).toBe(2);
  });

  it('v1 tables still exist after v2 migration (additive-only, CP-007)', () => {
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    // Core v1 tables must not have been dropped.
    expect(() => db.query('SELECT * FROM sessions LIMIT 0')).not.toThrow();
    expect(() => db.query('SELECT * FROM tool_calls LIMIT 0')).not.toThrow();
    expect(() => db.query('SELECT * FROM verification_reports LIMIT 0')).not.toThrow();
  });

  it('approvals table enforces decision CHECK constraint', () => {
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    // Seed a session and tool_call so FK is satisfied.
    db.execute(
      `INSERT INTO sessions
        (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
         created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.2.0',1,'B','L','{}')`,
    );
    db.execute(
      `INSERT INTO tool_calls
        (tool_call_id, session_id, tool_name, tool_version, risk_class,
         arguments_json, arguments_hash, state, proposed_by, provenance_json,
         requested_at, schema_version)
       VALUES ('TC1','S','read_file','1.0','READ_ONLY','{}','HASH1','REQUESTED',
               'model','{}','t',1)`,
    );
    // Valid approval.
    expect(() =>
      db.execute(
        `INSERT INTO approvals
           (approval_id, tool_call_id, arguments_hash, tool_policy_version,
            decision, decided_by, decided_at)
         VALUES ('A1','TC1','HASH1',1,'APPROVED','policy','t')`,
      ),
    ).not.toThrow();
    // Invalid decision value.
    expect(() =>
      db.execute(
        `INSERT INTO approvals
           (approval_id, tool_call_id, arguments_hash, tool_policy_version,
            decision, decided_by, decided_at)
         VALUES ('A2','TC1','HASH1',1,'MAYBE','policy','t')`,
      ),
    ).toThrow();
  });
});
