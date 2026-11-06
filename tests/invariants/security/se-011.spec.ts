// @invariant SE-011
// Shell argument boundary: every path-like argument of an allowlisted command must stay inside the
// workspace root, otherwise ShellExecutor returns exit 1 (PATH_ESCAPE) and never spawns.
// Enforcement: ShellExecutor + WorkspaceManager.checkPath. Phase 12. Severity CRITICAL.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until task 4.2 lands the argument checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspaceManager, ShellExecutor } from '@codeforge/infrastructure';
import type { ToolCall } from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';

let root: string;
let supervisor: FakeProcessSupervisor;
let executor: ShellExecutor;

beforeEach(async () => {
  root = (await fsRealpath(await mkdtemp(join(tmpdir(), 'cf2-se011-')))).replace(/\\/g, '/');
  let n = 0;
  const workspace = new NodeWorkspaceManager({
    root,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  });
  supervisor = new FakeProcessSupervisor();
  executor = new ShellExecutor({ workspace, supervisor });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function call(args: Record<string, unknown>): ToolCall {
  return {
    toolCallId: 'TC-SE011',
    sessionId: 'S-1',
    toolName: 'run_command',
    toolVersion: '1.0',
    riskClass: 'SYSTEM',
    arguments: args,
    argumentsHash: 'h',
    state: 'RUNNING',
    proposedBy: 'model',
    provenance: {
      provenanceId: 'PV-1',
      source: { kind: 'runtime', id: 'S-1' },
      inputs: [],
      reason: 'test',
      at: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SE-011: shell argument boundary', () => {
  it('rm -rf .. is rejected with PATH_ESCAPE and nothing is spawned', async () => {
    const r = await executor.execute(call({ command: 'rm', args: ['-rf', '..'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PATH_ESCAPE');
    expect(supervisor.callCount).toBe(0);
  });

  it('cat ../x is rejected with PATH_ESCAPE and nothing is spawned', async () => {
    const r = await executor.execute(call({ command: 'cat', args: ['../x'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PATH_ESCAPE');
    expect(supervisor.callCount).toBe(0);
  });

  it('node test.js (in-workspace argument) is spawned', async () => {
    supervisor.setOutcome(/node/, { exitCode: 0, stdout: 'ok', stderr: '' });
    const r = await executor.execute(call({ command: 'node', args: ['test.js'] }));
    expect(r.exitCode).toBe(0);
    expect(supervisor.callCount).toBe(1);
  });
});
