// @invariant TG-013
// Mutating a test file that existed when the goal started (the oracle that defines "correct") is
// classified DESTRUCTIVE and needs approval; creating a new test file stays MODIFY_WORKSPACE.
// Enforcement: resolveToolRiskClass + WorkspaceTestBaseline. Phase 12. Severity HIGH.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until tasks 3.3 and 4.4 land.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToolRiskClass } from '@codeforge/agent-core';
import { WorkspaceTestBaseline } from '@codeforge/infrastructure';

let root: string;
let baseline: WorkspaceTestBaseline;

beforeEach(async () => {
  root = (await fsRealpath(await mkdtemp(join(tmpdir(), 'cf2-tg013-')))).replace(/\\/g, '/');
  await writeFile(join(root, 'test.js'), "console.log('given test');\n");
  baseline = new WorkspaceTestBaseline({ root });
  await baseline.capture();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TG-013: existing-test approval', () => {
  it('edit_file on a baseline test is DESTRUCTIVE', () => {
    const risk = resolveToolRiskClass(
      'edit_file',
      { path: 'test.js', oldString: 'given', newString: 'edited' },
      { testBaseline: baseline },
    );
    expect(risk).toBe('DESTRUCTIVE');
  });

  it('write_file of a new test file is MODIFY_WORKSPACE', () => {
    const risk = resolveToolRiskClass(
      'write_file',
      { path: 'new.test.js', content: '// new' },
      { testBaseline: baseline },
    );
    expect(risk).toBe('MODIFY_WORKSPACE');
  });
});
