// Capability discovery contract + probe catalog + inventory — Phase 12 (P12.3).
//
// MI-003: a capability is only a usable execution prerequisite when VERIFIED, i.e. the runtime
// actually ran a probe command (e.g. `flutter --version`) via the ProcessSupervisor and got
// evidence. An LLM claim that a tool exists is NEVER sufficient. The pure core here owns:
//   - the probe CATALOG (tool → command/args + what it enables + capability scope),
//   - the deterministic VERDICT logic (SpawnResult-like outcome → CapabilityStatus + version),
//   - the EnvironmentInventory (cache + TTL/freshness; machine vs workspace).
// The actual spawning (I/O) lives in infrastructure and implements CapabilityProber.
import type { Capability, CapabilityScope, CapabilityStatus } from '../domain/mission.js';

// ── Probe catalog ────────────────────────────────────────────────────────────────

export interface CapabilityProbe {
  /** Stable capability name, e.g. 'flutter'. */
  readonly name: string;
  readonly scope: CapabilityScope;
  /** Executable to run (resolved on PATH by the adapter; may need .cmd on Windows). */
  readonly command: string;
  /** Args that print a version and exit quickly, e.g. ['--version']. */
  readonly args: readonly string[];
  /** What a VERIFIED instance of this capability enables (§8). */
  readonly enables: readonly string[];
  /** Regex (as string) to extract a version from stdout/stderr; first capture group. */
  readonly versionPattern?: string;
}

/**
 * Default machine-capability probes. Deliberately small + practical (§36). Extend by adding a
 * probe. Each probe runs `<command> <args>`; exit 0 → VERIFIED. The adapter resolves the real
 * executable per platform (e.g. appends .cmd on Windows for npm/flutter wrappers).
 */
export const DEFAULT_MACHINE_PROBES: readonly CapabilityProbe[] = [
  { name: 'node',    scope: 'machine', command: 'node',    args: ['--version'], enables: ['run_js', 'npm'],              versionPattern: 'v?(\\d+\\.\\d+\\.\\d+)' },
  { name: 'npm',     scope: 'machine', command: 'npm',     args: ['--version'], enables: ['install_deps', 'run_scripts'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'git',     scope: 'machine', command: 'git',     args: ['--version'], enables: ['version_control'],            versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'python',  scope: 'machine', command: 'python',  args: ['--version'], enables: ['run_python'],                 versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'flutter', scope: 'machine', command: 'flutter', args: ['--version'], enables: ['build_windows', 'build_android', 'test', 'analyze'], versionPattern: 'Flutter (\\d+\\.\\d+\\.\\d+)' },
  { name: 'dart',    scope: 'machine', command: 'dart',    args: ['--version'], enables: ['run_dart', 'test'],           versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'docker',  scope: 'machine', command: 'docker',  args: ['--version'], enables: ['containers'],                 versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'cargo',   scope: 'machine', command: 'cargo',   args: ['--version'], enables: ['build_rust', 'test'],         versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'dotnet',  scope: 'machine', command: 'dotnet',  args: ['--version'], enables: ['build_dotnet', 'test'],       versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  { name: 'java',    scope: 'machine', command: 'java',    args: ['-version'],  enables: ['run_java'],                   versionPattern: 'version "?(\\d+[\\d._]*)' },
];

// ── Prober contract (implemented in infrastructure) ──────────────────────────────

/** The minimal outcome a prober returns for one probe (SpawnResult-shaped, I/O done upstream). */
export interface ProbeOutcome {
  /** The probe that was run (echoed back for correlation). */
  readonly probe: CapabilityProbe;
  /** Process exit code (null if it never launched / was killed). */
  readonly exitCode: number | null;
  /** Combined stdout+stderr (version banners often go to stderr, e.g. java). */
  readonly output: string;
  /** True when the executable could not be found (ENOENT) → UNAVAILABLE. */
  readonly notFound: boolean;
  /** True when the probe timed out. */
  readonly timedOut: boolean;
}

/** The I/O boundary: runs probes via ProcessSupervisor. Implemented in infrastructure. */
export interface CapabilityProber {
  /** Run one probe and return its raw outcome. Never throws for non-zero exit. */
  probe(probe: CapabilityProbe): Promise<ProbeOutcome>;
}

// ── Deterministic verdict (pure) ─────────────────────────────────────────────────

/**
 * Turn a raw probe outcome into a Capability with a trustworthy status (MI-003). VERIFIED only
 * when the probe launched and exited 0; otherwise UNAVAILABLE (not found / non-zero / timeout).
 * `now` injects the verification timestamp (deterministic in tests). Pure.
 */
export function verdictFromOutcome(outcome: ProbeOutcome, now: string): Capability {
  const { probe } = outcome;
  if (!outcome.notFound && !outcome.timedOut && outcome.exitCode === 0) {
    const version = extractVersion(outcome.output, probe.versionPattern);
    return {
      name: probe.name,
      scope: probe.scope,
      status: 'VERIFIED' satisfies CapabilityStatus,
      ...(version !== undefined ? { version } : {}),
      evidence: `${probe.command} ${probe.args.join(' ')} → ${firstLine(outcome.output)}`,
      enables: probe.enables,
      lastVerified: now,
    };
  }
  // Not found / timed out / non-zero exit → not usable as a prerequisite.
  return {
    name: probe.name,
    scope: probe.scope,
    status: 'UNAVAILABLE' satisfies CapabilityStatus,
    evidence: outcome.notFound
      ? `${probe.command}: command not found`
      : outcome.timedOut
        ? `${probe.command}: probe timed out`
        : `${probe.command} exited ${outcome.exitCode}`,
    enables: [],
    lastVerified: now,
  };
}

function extractVersion(output: string, pattern?: string): string | undefined {
  if (pattern === undefined) return undefined;
  try {
    const m = new RegExp(pattern).exec(output);
    return m?.[1];
  } catch {
    return undefined;
  }
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// ── EnvironmentInventory (pure: cache + TTL/freshness) ────────────────────────────

export interface InventoryEntry {
  readonly capability: Capability;
  /** Epoch ms when verified; used for TTL freshness. */
  readonly verifiedAtMs: number;
}

/**
 * A deterministic cache of verified capabilities with TTL-based freshness (§10). It holds no
 * authority — it just remembers what was verified and when, and marks entries STALE past the
 * TTL so the caller can re-probe. No I/O (the prober does that); injected clock keeps it pure.
 */
export class EnvironmentInventory {
  private readonly entries = new Map<string, InventoryEntry>();

  /** TTL in ms after which a VERIFIED capability is considered STALE (default 10 min). */
  constructor(private readonly ttlMs: number = 10 * 60 * 1000) {}

  /** Record (or overwrite) a freshly verified capability. */
  record(capability: Capability, verifiedAtMs: number): void {
    this.entries.set(this.key(capability.scope, capability.name), { capability, verifiedAtMs });
  }

  /**
   * Look up a capability, applying freshness: a VERIFIED entry older than TTL is returned with
   * status STALE (so the caller re-probes before trusting it). Returns undefined if unknown.
   */
  get(scope: Capability['scope'], name: string, nowMs: number): Capability | undefined {
    const entry = this.entries.get(this.key(scope, name));
    if (entry === undefined) return undefined;
    if (entry.capability.status === 'VERIFIED' && nowMs - entry.verifiedAtMs > this.ttlMs) {
      return { ...entry.capability, status: 'STALE' };
    }
    return entry.capability;
  }

  /** All known capabilities for a scope, freshness-applied, sorted by name (deterministic). */
  list(scope: Capability['scope'], nowMs: number): readonly Capability[] {
    const out: Capability[] = [];
    for (const [k, entry] of this.entries) {
      if (!k.startsWith(`${scope}\u0001`)) continue;
      const fresh = this.get(entry.capability.scope, entry.capability.name, nowMs)!;
      out.push(fresh);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private key(scope: string, name: string): string {
    return `${scope}\u0001${name}`;
  }
}
