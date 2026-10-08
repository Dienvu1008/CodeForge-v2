// CapabilityDiscovery — Phase 12 (P12.3). Orchestrates probing + inventory to produce VERIFIED
// capabilities and a PreflightReport. Advisory: it reports facts verified by the prober; it
// decides nothing about execution. Lives in agent-core; the prober (I/O) is injected (DC-002).
import type { Capability } from '../domain/mission.js';
import type { PreflightReport } from '../domain/mission.js';
import {
  type CapabilityProbe,
  type CapabilityProber,
  DEFAULT_MACHINE_PROBES,
  verdictFromOutcome,
  EnvironmentInventory,
} from './capability.js';

export interface CapabilityDiscoveryDeps {
  readonly prober: CapabilityProber;
  readonly now:    () => string;   // ISO timestamp
  readonly nowMs:  () => number;   // epoch ms (for inventory freshness)
  readonly inventory?: EnvironmentInventory;
}

export class CapabilityDiscovery {
  private readonly inventory: EnvironmentInventory;

  constructor(private readonly deps: CapabilityDiscoveryDeps) {
    this.inventory = deps.inventory ?? new EnvironmentInventory();
  }

  /**
   * Verify a set of probes (defaults to DEFAULT_MACHINE_PROBES), recording each result in the
   * inventory. Returns the verified capabilities sorted by name. Each capability's status is
   * trustworthy (MI-003): VERIFIED only with real command evidence.
   */
  async discover(probes: readonly CapabilityProbe[] = DEFAULT_MACHINE_PROBES): Promise<readonly Capability[]> {
    const results: Capability[] = [];
    for (const probe of probes) {
      const outcome = await this.deps.prober.probe(probe);
      const cap = verdictFromOutcome(outcome, this.deps.now());
      this.inventory.record(cap, this.deps.nowMs());
      results.push(cap);
    }
    return results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The underlying inventory (for freshness-aware lookups / reuse across missions). */
  getInventory(): EnvironmentInventory {
    return this.inventory;
  }

  /**
   * Build a deterministic PreflightReport (§11): readiness = verified/required (or verified/total
   * when no explicit requirements), blockers = required capabilities not VERIFIED. Pure over the
   * supplied capabilities + required names.
   */
  buildPreflight(
    missionId: string,
    machine: readonly Capability[],
    workspace: readonly Capability[],
    aiModels: readonly string[],
    required: readonly string[],
  ): PreflightReport {
    const all = [...machine, ...workspace];
    const verifiedNames = new Set(all.filter((c) => c.status === 'VERIFIED').map((c) => c.name));

    const blockers: string[] = [];
    for (const r of required) if (!verifiedNames.has(r)) blockers.push(r);

    const denom = required.length > 0 ? required.length : Math.max(1, all.length);
    const numer = required.length > 0
      ? required.filter((r) => verifiedNames.has(r)).length
      : all.filter((c) => c.status === 'VERIFIED').length;
    const readiness = Math.round((numer / denom) * 100);

    const warnings: string[] = [];
    for (const c of all) {
      if (c.status === 'STALE') warnings.push(`${c.name}: capability is stale (re-verify)`);
    }

    return {
      missionId,
      machine: [...machine].sort(byName),
      workspace: [...workspace].sort(byName),
      aiModels: [...aiModels].sort(),
      readiness,
      blockers: blockers.sort(),
      warnings: warnings.sort(),
      createdAt: this.deps.now(),
    };
  }
}

function byName(a: Capability, b: Capability): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
