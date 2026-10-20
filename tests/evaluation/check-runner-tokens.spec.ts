// check-runner token expansion (P12.27) — command checks can reference repo scripts portably via
// ${CODEFORGE_REPO} and the case workspace via ${WORKSPACE}, so benchmark.json never hardcodes a
// machine path (used by the MQL5 compile-wrapper check). A fake supervisor records the spawn.
import { describe, it, expect, afterEach } from 'vitest';
import { BenchmarkCheckRunner } from '@codeforge/infrastructure';
import type { SpawnOptions, SpawnResult, ProcessSupervisor } from '@codeforge/agent-core';

class RecordingSupervisor implements ProcessSupervisor {
  public last: SpawnOptions | null = null;
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    this.last = options;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false } as SpawnResult;
  }
}

const savedRepo = process.env['CODEFORGE_REPO'];
afterEach(() => {
  if (savedRepo === undefined) delete process.env['CODEFORGE_REPO'];
  else process.env['CODEFORGE_REPO'] = savedRepo;
});

describe('BenchmarkCheckRunner — ${...} token expansion', () => {
  it('expands ${CODEFORGE_REPO} and ${WORKSPACE} in command args', async () => {
    process.env['CODEFORGE_REPO'] = '/repo';
    const sup = new RecordingSupervisor();
    const runner = new BenchmarkCheckRunner({ supervisor: sup, workspaceRoot: '/ws' });
    await runner.runAll([
      { kind: 'command', target: 'node', args: ['${CODEFORGE_REPO}/scripts/mql5-compile.mjs', '${WORKSPACE}/Sum.mq5'], description: 'compile' },
    ]);
    expect(sup.last?.command).toBe('node');
    expect(sup.last?.args).toEqual(['/repo/scripts/mql5-compile.mjs', '/ws/Sum.mq5']);
  });

  it('leaves an unset ${CODEFORGE_REPO} token literal (surfaces as a spawn failure, not a wrong path)', async () => {
    delete process.env['CODEFORGE_REPO'];
    const sup = new RecordingSupervisor();
    const runner = new BenchmarkCheckRunner({ supervisor: sup, workspaceRoot: '/ws' });
    await runner.runAll([{ kind: 'command', target: 'node', args: ['${CODEFORGE_REPO}/x.mjs'], description: 'x' }]);
    expect(sup.last?.args).toEqual(['${CODEFORGE_REPO}/x.mjs']);
  });

  it('expands tokens in a whitespace-split bare target too', async () => {
    process.env['CODEFORGE_REPO'] = '/repo';
    const sup = new RecordingSupervisor();
    const runner = new BenchmarkCheckRunner({ supervisor: sup, workspaceRoot: '/ws' });
    await runner.runAll([{ kind: 'command', target: 'cat ${WORKSPACE}/log.txt', description: 'cat' }]);
    expect(sup.last?.command).toBe('cat');
    expect(sup.last?.args).toEqual(['/ws/log.txt']);
  });
});
