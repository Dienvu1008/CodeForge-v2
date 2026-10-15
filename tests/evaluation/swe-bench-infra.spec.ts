// SWE-bench infrastructure adapters — dataset loader (JSON/JSONL) + git workspace setup.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSweBenchDataset,
  parseSweBenchRecords,
  SweBenchDatasetError,
  SweBenchWorkspaceSetup,
} from '@codeforge/infrastructure';
import type { SweBenchSetup } from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

function record(id: string): Record<string, unknown> {
  return {
    instance_id: id, repo: 'a/b', base_commit: 'c0',
    problem_statement: 'fix it', test_patch: 'diff --git a/t b/t\n',
    FAIL_TO_PASS: ['t::f'], PASS_TO_PASS: [],
  };
}

describe('parseSweBenchRecords', () => {
  it('parses a JSON array', () => {
    const recs = parseSweBenchRecords(JSON.stringify([record('a__b-1'), record('a__b-2')]));
    expect(recs).toHaveLength(2);
  });

  it('parses JSONL (one object per line, blank lines ignored)', () => {
    const body = `${JSON.stringify(record('a__b-1'))}\n\n${JSON.stringify(record('a__b-2'))}\n`;
    const recs = parseSweBenchRecords(body);
    expect(recs).toHaveLength(2);
  });

  it('throws on a malformed JSONL line, naming the line number', () => {
    const body = `${JSON.stringify(record('a__b-1'))}\n{not json`;
    expect(() => parseSweBenchRecords(body)).toThrowError(/line 2/);
  });

  it('returns [] for an empty body', () => {
    expect(parseSweBenchRecords('   ')).toEqual([]);
  });
});

describe('loadSweBenchDataset', () => {
  it('loads + validates a JSONL dataset into task/setup bundles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-'));
    cleanup.push(dir);
    const path = join(dir, 'data.jsonl');
    writeFileSync(path, `${JSON.stringify(record('a__b-1'))}\n${JSON.stringify(record('a__b-2'))}\n`, 'utf8');

    const bundles = loadSweBenchDataset(path);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.task.id).toBe('a__b-1');
    expect(bundles[0]!.task.category).toBe('BUGFIX');
    expect(bundles[0]!.setup.repo).toBe('a/b');
  });

  it('throws SweBenchDatasetError with field detail when a record is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-'));
    cleanup.push(dir);
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify([{ repo: 'x/y' }]), 'utf8');
    expect(() => loadSweBenchDataset(path)).toThrowError(SweBenchDatasetError);
  });

  it('throws when the file cannot be read', () => {
    expect(() => loadSweBenchDataset(join(tmpdir(), 'does-not-exist-swe.jsonl'))).toThrowError(SweBenchDatasetError);
  });

  it('loads the committed sample fixture into exactly one bundle', () => {
    const path = join(__dirname, '..', '..', 'benchmarks', 'swe-bench', 'sample.jsonl');
    const bundles = loadSweBenchDataset(path);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.task.id).toBe('codeforge__sample-1');
    expect(bundles[0]!.setup.repo).toBe('octocat/hello-world');
    expect(bundles[0]!.task.verification[0]!.target).toContain('default_name');
    // The gold patch + test patch bodies are NOT visible in anything the agent reads (only the
    // problem statement is). seedFiles is empty; the description carries no diff/test source.
    const agentVisible = JSON.stringify({ d: bundles[0]!.task.description, s: bundles[0]!.task.seedFiles });
    expect(agentVisible).not.toContain('diff --git');       // no patch bodies
    expect(agentVisible).not.toContain('greet.test.js');    // no test file source
    expect(bundles[0]!.task.seedFiles).toEqual({});
    // The gold patch is retained in the setup for provenance only.
    expect(bundles[0]!.setup.goldPatch).toContain('diff --git');
  });
});

describe('SweBenchWorkspaceSetup', () => {
  const setup: SweBenchSetup = {
    instanceId: 'a__b-1', repo: 'a/b', baseCommit: 'deadbeef',
    testPatch: 'diff --git a/t b/t\n@@ -1 +1 @@\n-x\n+y\n',
    failToPass: ['t::f'], passToPass: [],
  };

  it('prepareBaseline clones then checks out base_commit (both via the supervisor)', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([
      { exitCode: 0, stdout: 'Cloning...', stderr: '' },  // clone
      { exitCode: 0, stdout: 'HEAD is now at deadbeef', stderr: '' }, // checkout
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);

    const wss = new SweBenchWorkspaceSetup({ supervisor: sup });
    const r = await wss.prepareBaseline(dir, setup);
    expect(r.ok).toBe(true);
    expect(sup.callCount).toBe(2);
    // First call is a clone of the resolved GitHub URL into '.'; second checks out base_commit.
    expect(sup.calls[0]!.options.args).toContain('clone');
    expect(sup.calls[0]!.options.args.some((a) => a.includes('github.com/a/b'))).toBe(true);
    expect(sup.calls[1]!.options.args).toEqual(expect.arrayContaining(['checkout', '--force', 'deadbeef']));
  });

  it('prepareBaseline reports a clone failure as ok=false (not a throw)', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 128, stdout: '', stderr: 'fatal: repository not found' }]);
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);

    const r = await wssSetup(sup).prepareBaseline(dir, setup);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('clone');
    expect(r.detail).toContain('repository not found');
    expect(sup.callCount).toBe(1); // short-circuits before checkout
  });

  it('a custom resolveRepoUrl points the clone at a local mirror (offline)', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 0, stdout: '', stderr: '' }, { exitCode: 0, stdout: '', stderr: '' }]);
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);

    const wss = new SweBenchWorkspaceSetup({ supervisor: sup, resolveRepoUrl: (repo) => `/mirror/${repo}` });
    await wss.prepareBaseline(dir, setup);
    expect(sup.calls[0]!.options.args).toContain('/mirror/a/b');
  });

  it('applyTestPatch writes the patch into the scratch area and runs git apply', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 0, stdout: '', stderr: '' }]); // git apply
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);

    const r = await wssSetup(sup).applyTestPatch(dir, setup);
    expect(r.ok).toBe(true);
    // Patch file was written into the scratch zone.
    const patchPath = join(dir, '.codeforge', 'swe-bench-test.patch');
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, 'utf8')).toContain('+y');
    // git apply was invoked against that patch path.
    expect(sup.calls[0]!.options.args).toContain('apply');
    expect(sup.calls[0]!.options.args.some((a) => a.endsWith('swe-bench-test.patch'))).toBe(true);
  });

  it('applyTestPatch reports a failed apply as ok=false', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 1, stdout: '', stderr: 'error: patch does not apply' }]);
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);

    const r = await wssSetup(sup).applyTestPatch(dir, setup);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('apply_test_patch');
    expect(r.detail).toContain('does not apply');
  });

  it('applyTestPatch is a no-op (ok=true) when the test patch is empty', async () => {
    const sup = new FakeProcessSupervisor();
    const dir = mkdtempSync(join(tmpdir(), 'cf-swe-ws-'));
    cleanup.push(dir);
    const r = await wssSetup(sup).applyTestPatch(dir, { ...setup, testPatch: '' });
    expect(r.ok).toBe(true);
    expect(sup.callCount).toBe(0); // nothing to apply → no git call
  });

  function wssSetup(sup: FakeProcessSupervisor): SweBenchWorkspaceSetup {
    return new SweBenchWorkspaceSetup({ supervisor: sup });
  }
});
