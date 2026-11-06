// @invariant SE-012
// Sensitive paths (.env, *.pem, id_rsa, .ssh/*, ...) cannot be read or changed by the agent: the
// filesystem tool returns a FAILED result (exit 1, SENSITIVE_PATH), not an exception. Template files
// such as .env.example stay readable.
// Enforcement: NodeWorkspaceManager (Path_Access_Policy) via FilesystemExecutor. Phase 12. Severity CRITICAL.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until tasks 3.1 and 4.1 land.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspaceManager, FilesystemExecutor } from '@codeforge/infrastructure';
import type { ToolCall } from '@codeforge/agent-core';

let root: string;
let exec: FilesystemExecutor;

beforeEach(async () => {
  root = (await fsRealpath(await mkdtemp(join(tmpdir(), 'cf2-se012-')))).replace(/\\/g, '/');
  await writeFile(join(root, '.env'), 'API_KEY=super-secret-marker\n');
  await writeFile(join(root, '.env.example'), 'API_KEY=changeme\n');
  let n = 0;
  const workspace = new NodeWorkspaceManager({
    root,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  });
  exec = new FilesystemExecutor({ workspace });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function call(toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    toolCallId: 'TC-SE012',
    sessionId: 'S-1',
    toolName,
    toolVersion: '1.0',
    riskClass: 'READ_ONLY',
    arguments: args,
    argumentsHash: 'h',
    state: 'APPROVED',
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

describe('SE-012: sensitive paths', () => {
  it('read_file .env is a failed tool result with SENSITIVE_PATH and no content', async () => {
    const r = await exec.execute(call('read_file', { path: '.env' }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('SENSITIVE_PATH');
    expect(r.stdout).not.toContain('super-secret-marker');
  });

  it('read_file .env.example (template) is allowed', async () => {
    const r = await exec.execute(call('read_file', { path: '.env.example' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('changeme');
  });
});
