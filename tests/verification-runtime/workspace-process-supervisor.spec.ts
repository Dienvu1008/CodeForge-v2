// P10.1 — WorkspaceProcessSupervisor: real cross-platform check execution.
//
// The VerificationEngine (frozen, Phase 1.5) spawns checks with shell:false, cwd:'/'
// and env:{}. This adapter must (a) force the workspace as cwd, (b) inject a minimal
// PATH-bearing env, and (c) on Windows launch npm-family .cmd shims via cmd.exe — since
// Node 18.20/20.12/22+ refuses to spawn a .cmd with shell:false (CVE-2024-27980, EINVAL).
//
// These are INTEGRATION tests: they spawn a real `npm run <script>` against a temp
// package.json. They run identically on Windows + Linux/WSL2. The scripts use `node -e`
// so there is no shell dependency and exit codes are controlled precisely:
//   npm run ok  -> node -e "process.exit(0)"  -> exitCode 0  (PASS path)
//   npm run bad -> node -e "process.exit(1)"  -> exitCode 1  (FAIL path)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkspaceProcessSupervisor } from '@codeforge/infrastructure';

describe('WorkspaceProcessSupervisor — real npm check execution (cross-platform)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cf-wps-'));
    const pkg = {
      name: 'wps-fixture',
      version: '1.0.0',
      scripts: {
        ok: 'node -e "process.exit(0)"',
        bad: 'node -e "process.exit(1)"',
      },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('runs a passing npm script -> exitCode 0, not timed out', async () => {
    const sup = new WorkspaceProcessSupervisor({ workspaceRoot: root });
    // Mirror what the engine passes: logical command, hardcoded cwd:'/' + env:{} that
    // the adapter must override. The adapter resolves npm -> cmd.exe /c npm.cmd on Win.
    const r = await sup.spawn({
      command: 'npm',
      args: ['run', 'ok', '--silent'],
      cwd: '/',
      env: {},
      timeoutMs: 60_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('runs a failing npm script -> nonzero exitCode (drives verification FAIL)', async () => {
    const sup = new WorkspaceProcessSupervisor({ workspaceRoot: root });
    const r = await sup.spawn({
      command: 'npm',
      args: ['run', 'bad', '--silent'],
      cwd: '/',
      env: {},
      timeoutMs: 60_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('forces the workspace root as cwd even when caller passes cwd:/', async () => {
    // The `ok` script resolves relative to cwd; if cwd were '/', npm would not find
    // this package.json. A clean exit 0 proves cwd was overridden to the workspace.
    const sup = new WorkspaceProcessSupervisor({ workspaceRoot: root });
    const r = await sup.spawn({
      command: 'npm',
      args: ['run', 'ok', '--silent'],
      cwd: '/',
      env: {},
      timeoutMs: 60_000,
    });
    expect(r.exitCode).toBe(0);
  });
});
