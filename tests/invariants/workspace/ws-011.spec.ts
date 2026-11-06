// @invariant WS-011
// Version-control metadata (.git, .hg, .svn) is write-protected and read-open: write_file under .git
// fails with PROTECTED_PATH, reading .git/HEAD is allowed, and .gitignore (not metadata) stays writable.
// Enforcement: NodeWorkspaceManager (Path_Access_Policy) via FilesystemExecutor. Phase 12. Severity CRITICAL.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until tasks 3.1 and 4.1 land.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspaceManager, FilesystemExecutor } from '@codeforge/infrastructure';
import type { ToolCall } from '@codeforge/agent-core';

let root: string;
let exec: FilesystemExecutor;

beforeEach(async () => {
  root = (await fsRealpath(await mkdtemp(join(tmpdir(), 'cf2-ws011-')))).replace(/\\/g, '/');
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(root, '.git', 'config'), '[core]\n');
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
    toolCallId: 'TC-WS011',
    sessionId: 'S-1',
    toolName,
    toolVersion: '1.0',
    riskClass: 'MODIFY_WORKSPACE',
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

describe('WS-011: protected VCS metadata', () => {
  it('write_file .git/config fails with PROTECTED_PATH and leaves the file unchanged', async () => {
    const r = await exec.execute(call('write_file', { path: '.git/config', content: '[evil]\n' }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('PROTECTED_PATH');
    expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it('read_file .git/HEAD is allowed (read-open)', async () => {
    const r = await exec.execute(call('read_file', { path: '.git/HEAD' }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('refs/heads/main');
  });

  it('write_file .gitignore is allowed (not VCS metadata)', async () => {
    const r = await exec.execute(call('write_file', { path: '.gitignore', content: 'dist\n' }));
    expect(r.exitCode).toBe(0);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('dist\n');
  });
});
