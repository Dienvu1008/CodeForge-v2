// MI-003 — A capability is only a usable execution prerequisite when VERIFIED by a real probe
// with evidence. An LLM claim that a tool exists is never sufficient.
//
// Enforced by verdictFromOutcome + CapabilityDiscovery: a probe that launched and exited 0
// yields VERIFIED (+ version + evidence); anything else (not found / timeout / non-zero) yields
// UNAVAILABLE. The EnvironmentInventory marks VERIFIED entries STALE past TTL so they are
// re-probed before being trusted.
import { describe, it, expect } from 'vitest';
import {
  verdictFromOutcome,
  CapabilityDiscovery,
  EnvironmentInventory,
  DEFAULT_MACHINE_PROBES,
  type CapabilityProbe,
  type CapabilityProber,
  type ProbeOutcome,
} from '@codeforge/agent-core';

const NOW = '2026-01-01T00:00:00.000Z';
const probe = (name: string): CapabilityProbe =>
  DEFAULT_MACHINE_PROBES.find((p) => p.name === name)
  ?? { name, scope: 'machine', command: name, args: ['--version'], enables: ['x'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' };

/** Fake prober with scripted outcomes keyed by probe name (deterministic, no I/O). */
class FakeProber implements CapabilityProber {
  constructor(private readonly outcomes: Record<string, Omit<ProbeOutcome, 'probe'>>) {}
  async probe(p: CapabilityProbe): Promise<ProbeOutcome> {
    const o = this.outcomes[p.name] ?? { exitCode: null, output: '', notFound: true, timedOut: false };
    return { probe: p, ...o };
  }
}

describe('MI-003 — only VERIFIED (with evidence) counts', () => {
  it('tool exists (exit 0) → VERIFIED with version + evidence', () => {
    const cap = verdictFromOutcome(
      { probe: probe('flutter'), exitCode: 0, output: 'Flutter 3.22.0 • channel stable', notFound: false, timedOut: false },
      NOW,
    );
    expect(cap.status).toBe('VERIFIED');
    expect(cap.version).toBe('3.22.0');
    expect(cap.evidence).toContain('flutter --version');
    expect(cap.enables).toContain('build_android');
    expect(cap.lastVerified).toBe(NOW);
  });

  it('tool missing (command not found) → UNAVAILABLE, no enables, no version', () => {
    const cap = verdictFromOutcome(
      { probe: probe('android-sdk' as never), exitCode: null, output: '', notFound: true, timedOut: false },
      NOW,
    );
    expect(cap.status).toBe('UNAVAILABLE');
    expect(cap.version).toBeUndefined();
    expect(cap.enables).toEqual([]);
    expect(cap.evidence).toContain('command not found');
  });

  it('non-zero exit (e.g. version mismatch harness) → UNAVAILABLE (not trusted)', () => {
    const cap = verdictFromOutcome(
      { probe: probe('node'), exitCode: 1, output: 'some error', notFound: false, timedOut: false },
      NOW,
    );
    expect(cap.status).toBe('UNAVAILABLE');
    expect(cap.evidence).toContain('exited 1');
  });

  it('timeout → UNAVAILABLE', () => {
    const cap = verdictFromOutcome(
      { probe: probe('docker'), exitCode: null, output: '', notFound: false, timedOut: true },
      NOW,
    );
    expect(cap.status).toBe('UNAVAILABLE');
    expect(cap.evidence).toContain('timed out');
  });

  it('discovery records VERIFIED/UNAVAILABLE per real probe outcome (never from a claim)', async () => {
    const prober = new FakeProber({
      node: { exitCode: 0, output: 'v20.18.1', notFound: false, timedOut: false },
      git:  { exitCode: 0, output: 'git version 2.44.0', notFound: false, timedOut: false },
      flutter: { exitCode: null, output: '', notFound: true, timedOut: false }, // claimed-but-absent
    });
    const disc = new CapabilityDiscovery({ prober, now: () => NOW, nowMs: () => 0 });
    const caps = await disc.discover([probe('node'), probe('git'), probe('flutter')]);
    const byName = Object.fromEntries(caps.map((c) => [c.name, c.status]));
    expect(byName['node']).toBe('VERIFIED');
    expect(byName['git']).toBe('VERIFIED');
    expect(byName['flutter']).toBe('UNAVAILABLE'); // absent despite any LLM claim
  });

  it('inventory marks a VERIFIED entry STALE past TTL (re-verify before trusting)', () => {
    const inv = new EnvironmentInventory(1000); // 1s TTL
    const cap = verdictFromOutcome({ probe: probe('node'), exitCode: 0, output: 'v20.18.1', notFound: false, timedOut: false }, NOW);
    inv.record(cap, 0);
    expect(inv.get('machine', 'node', 500)?.status).toBe('VERIFIED'); // within TTL
    expect(inv.get('machine', 'node', 2000)?.status).toBe('STALE');   // past TTL
  });

  it('preflight: required-but-unverified capability becomes a blocker', async () => {
    const prober = new FakeProber({
      flutter: { exitCode: 0, output: 'Flutter 3.22.0', notFound: false, timedOut: false },
    });
    const disc = new CapabilityDiscovery({ prober, now: () => NOW, nowMs: () => 0 });
    const machine = await disc.discover([probe('flutter')]);
    const report = disc.buildPreflight('m-1', machine, [], ['qwen'], ['flutter', 'android-sdk']);
    expect(report.blockers).toContain('android-sdk'); // required, not verified
    expect(report.blockers).not.toContain('flutter');  // required + verified
    expect(report.readiness).toBe(50); // 1 of 2 required verified
  });
});
