// SWE-bench adapter (pure, agent-core) — validation + mapping to BenchmarkTask + setup.
import { describe, it, expect } from 'vitest';
import {
  validateSweBenchInstance,
  sweBenchInstanceToTask,
  sweBenchInstancesToTasks,
  sweBenchTestSelection,
  sweBenchTestCommand,
  type SweBenchInstance,
} from '@codeforge/agent-core';

// A minimal valid record in the canonical SWE-bench shape (arrays for the test selections).
function rawInstance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: 'django__django-11099',
    repo: 'django/django',
    base_commit: 'abc123def456',
    problem_statement: 'UsernameValidator allows trailing newline in usernames',
    patch: 'diff --git a/django/x.py b/django/x.py\n@@ -1 +1 @@\n-old\n+new\n',
    test_patch: 'diff --git a/tests/t.py b/tests/t.py\n@@ -1 +1 @@\n-x\n+y\n',
    FAIL_TO_PASS: ['tests/t.py::test_newline'],
    PASS_TO_PASS: ['tests/t.py::test_basic', 'tests/t.py::test_other'],
    environment_setup_commit: 'env999',
    version: '3.0',
    ...overrides,
  };
}

describe('validateSweBenchInstance', () => {
  it('accepts a well-formed record (array test selections)', () => {
    const r = validateSweBenchInstance(rawInstance());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.instance_id).toBe('django__django-11099');
    expect(r.value.fail_to_pass).toEqual(['tests/t.py::test_newline']);
    expect(r.value.pass_to_pass).toHaveLength(2);
    expect(r.value.patch).toContain('diff --git');
  });

  it('accepts JSON-encoded-string test selections (the HF dataset form)', () => {
    const r = validateSweBenchInstance(rawInstance({
      FAIL_TO_PASS: '["tests/t.py::test_a"]',
      PASS_TO_PASS: '[]',
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fail_to_pass).toEqual(['tests/t.py::test_a']);
    expect(r.value.pass_to_pass).toEqual([]);
  });

  it('rejects a record missing required fields with structured errors', () => {
    const r = validateSweBenchInstance({ repo: 'x/y' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.errors.map((e) => e.path);
    expect(paths).toContain('instance.instance_id');
    expect(paths).toContain('instance.base_commit');
    expect(paths).toContain('instance.problem_statement');
    expect(paths).toContain('instance.test_patch');
  });

  it('rejects an empty FAIL_TO_PASS (nothing to prove)', () => {
    const r = validateSweBenchInstance(rawInstance({ FAIL_TO_PASS: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.path.endsWith('FAIL_TO_PASS'))).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateSweBenchInstance('nope').ok).toBe(false);
    expect(validateSweBenchInstance(null).ok).toBe(false);
  });
});

describe('test selection + command', () => {
  const inst: SweBenchInstance = {
    instance_id: 'a__b-1', repo: 'a/b', base_commit: 'c0', problem_statement: 'p',
    test_patch: 'x', fail_to_pass: ['t::f1', 't::f2'], pass_to_pass: ['t::p1', 't::f1'],
  };

  it('selection is FAIL_TO_PASS then PASS_TO_PASS, de-duplicated, order preserved', () => {
    expect(sweBenchTestSelection(inst)).toEqual(['t::f1', 't::f2', 't::p1']);
  });

  it('default command substitutes the test selection into {tests}', () => {
    expect(sweBenchTestCommand(inst)).toBe('python -m pytest -q t::f1 t::f2 t::p1');
  });

  it('a template without {tests} appends the selection', () => {
    expect(sweBenchTestCommand(inst, 'tox -e py39 --')).toBe('tox -e py39 -- t::f1 t::f2 t::p1');
  });
});

describe('sweBenchInstanceToTask', () => {
  it('maps problem_statement → description and keeps seedFiles empty (repo is cloned by the runner)', () => {
    const r = validateSweBenchInstance(rawInstance());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { task, setup } = sweBenchInstanceToTask(r.value);

    expect(task.id).toBe('django__django-11099');
    expect(task.category).toBe('BUGFIX');
    expect(task.description).toBe('UsernameValidator allows trailing newline in usernames');
    expect(task.seedFiles).toEqual({});                 // the repo is materialised by setup, not inline
    expect(task.verification).toHaveLength(1);
    expect(task.verification[0]!.kind).toBe('command');
    expect(task.verification[0]!.target).toContain('pytest');
    expect(task.difficulty).toBe('HARD');

    // The setup side-channel carries the repo/commit/patch data the task cannot hold.
    expect(setup.repo).toBe('django/django');
    expect(setup.baseCommit).toBe('abc123def456');
    expect(setup.testPatch).toContain('tests/t.py');
    expect(setup.failToPass).toEqual(['tests/t.py::test_newline']);
    expect(setup.environmentSetupCommit).toBe('env999');
  });

  it('NEVER leaks the gold patch or test_patch into anything the agent reads', () => {
    const r = validateSweBenchInstance(rawInstance());
    if (!r.ok) throw new Error('expected ok');
    const { task, setup } = sweBenchInstanceToTask(r.value);
    const agentVisible = JSON.stringify({ description: task.description, seedFiles: task.seedFiles });
    expect(agentVisible).not.toContain('+new');        // gold patch body
    expect(agentVisible).not.toContain('tests/t.py');  // test patch body
    // The gold patch is preserved for provenance in the setup only.
    expect(setup.goldPatch).toContain('+new');
  });

  it('honours a custom test command template and timeout', () => {
    const r = validateSweBenchInstance(rawInstance());
    if (!r.ok) throw new Error('expected ok');
    const { task } = sweBenchInstanceToTask(r.value, { testCommandTemplate: 'tox -- {tests}', timeoutMs: 60_000 });
    expect(task.verification[0]!.target.startsWith('tox -- ')).toBe(true);
    expect(task.timeoutMs).toBe(60_000);
    expect(task.verification[0]!.timeoutMs).toBe(60_000);
  });
});

describe('sweBenchInstancesToTasks', () => {
  it('maps a batch and rejects the whole batch on a duplicate instance_id', () => {
    const dup = sweBenchInstancesToTasks([rawInstance(), rawInstance()]);
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.errors.some((e) => e.message.includes('duplicate instance_id'))).toBe(true);
  });

  it('maps a clean batch of distinct instances', () => {
    const r = sweBenchInstancesToTasks([
      rawInstance({ instance_id: 'a__b-1' }),
      rawInstance({ instance_id: 'a__b-2' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((b) => b.task.id)).toEqual(['a__b-1', 'a__b-2']);
  });

  it('rejects the batch when any record is invalid', () => {
    const r = sweBenchInstancesToTasks([rawInstance(), { repo: 'broken' }]);
    expect(r.ok).toBe(false);
  });
});
