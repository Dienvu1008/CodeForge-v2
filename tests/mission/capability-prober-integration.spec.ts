// P12.3 integration — NodeCapabilityProber against REAL tools via the real ProcessSupervisor.
// Proves MI-003 end-to-end: `node` is actually probed (VERIFIED), a bogus tool is COMMAND_NOT_FOUND
// (UNAVAILABLE). `node` is guaranteed present (the test runner IS node), so this is deterministic
// and cross-platform (the prober resolves .cmd wrappers on Windows; `node` is a bare exe).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeProcessSupervisor, NodeCapabilityProber } from '@codeforge/infrastructure';
import {
  CapabilityDiscovery,
  verdictFromOutcome,
  type CapabilityProbe,
} from '@codeforge/agent-core';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cf2-cap-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const nodeProbe: CapabilityProbe = {
  name: 'node', scope: 'machine', command: 'node', args: ['--version'],
  enables: ['run_js'], versionPattern: 'v?(\\d+\\.\\d+\\.\\d+)',
};
const bogusProbe: CapabilityProbe = {
  name: 'definitely-not-a-real-tool-xyz', scope: 'machine',
  command: 'definitely-not-a-real-tool-xyz', args: ['--version'], enables: ['nothing'],
};

function prober() {
  return new NodeCapabilityProber({ supervisor: new NodeProcessSupervisor(), cwd: dir, timeoutMs: 10_000 });
}

describe('P12.3 NodeCapabilityProber — real verification (MI-003)', () => {
  it('verifies node (present) with a real version + evidence', async () => {
    const outcome = await prober().probe(nodeProbe);
    expect(outcome.notFound).toBe(false);
    expect(outcome.exitCode).toBe(0);
    const cap = verdictFromOutcome(outcome, '2026-01-01T00:00:00.000Z');
    expect(cap.status).toBe('VERIFIED');
    expect(cap.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cap.evidence).toContain('node --version');
  });

  it('reports a bogus tool as UNAVAILABLE (command not found)', async () => {
    const outcome = await prober().probe(bogusProbe);
    expect(outcome.notFound).toBe(true);
    const cap = verdictFromOutcome(outcome, '2026-01-01T00:00:00.000Z');
    expect(cap.status).toBe('UNAVAILABLE');
    expect(cap.enables).toEqual([]);
  });

  it('discovery over [node, bogus] records one VERIFIED + one UNAVAILABLE', async () => {
    const disc = new CapabilityDiscovery({
      prober: prober(),
      now: () => new Date().toISOString(),
      nowMs: () => Date.now(),
    });
    const caps = await disc.discover([nodeProbe, bogusProbe]);
    const byName = Object.fromEntries(caps.map((c) => [c.name, c.status]));
    expect(byName['node']).toBe('VERIFIED');
    expect(byName['definitely-not-a-real-tool-xyz']).toBe('UNAVAILABLE');
  });
});
