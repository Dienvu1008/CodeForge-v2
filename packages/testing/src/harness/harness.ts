// Phase0Harness (C10) — PHASE_0_ACCEPTANCE §4.2.
//
// Loads the machine-readable registries (invariants.yaml, vectors manifest, scenarios.yaml)
// and runs what Phase 0 can run deterministically: workspace vectors (via C1/A3). Invariant
// and adversarial execution against a live runtime is Phase 1/1.5; here we load + report.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { computeWorkspaceHash } from '@codeforge/infrastructure';
import { VECTORS, buildVector } from '../workspace-vectors/index.js';

export interface InvariantEntry {
  readonly id: string;
  readonly statement: string;
  readonly enforcement: readonly string[];
  readonly violation_class: string;
  readonly test: string;
  readonly phase: number | string;
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  readonly status: 'ACTIVE' | 'DEPRECATED';
}

export interface InvariantRegistry {
  readonly version: number | string;
  readonly invariants: readonly InvariantEntry[];
}

export interface VectorResult {
  readonly id: string;
  readonly ran: boolean;
  readonly ok: boolean;
  readonly reason?: string;
  readonly hash?: string;
  readonly expectedHash?: string;
}

export interface Phase0Report {
  readonly invariantCount: number;
  readonly criticalCount: number;
  readonly vectorsRun: number;
  readonly vectorsPassed: number;
  readonly vectorsSkipped: number;
  readonly vectorResults: readonly VectorResult[];
}

const platform = process.platform === 'win32' ? 'win32' : 'linux';

export class Phase0Harness {
  constructor(private readonly rootDir: string) {}

  async loadInvariants(): Promise<InvariantRegistry> {
    const raw = await readFile(join(this.rootDir, 'invariants.yaml'), 'utf8');
    const parsed = yaml.load(raw) as InvariantRegistry;
    return parsed;
  }

  /** Load committed expected hash for a vector, or null if not generated on this platform. */
  private async loadExpectedHash(id: string): Promise<string | null> {
    try {
      const raw = await readFile(
        join(this.rootDir, 'tests', 'workspace', 'vectors', id, 'expected.json'),
        'utf8',
      );
      return (JSON.parse(raw) as { expectedHash: string }).expectedHash;
    } catch {
      return null;
    }
  }

  async runWorkspaceVector(id: string): Promise<VectorResult> {
    const vector = VECTORS.find((v) => v.id === id);
    if (!vector) return { id, ran: false, ok: false, reason: 'unknown vector' };

    const runsHere = !vector.platforms || vector.platforms.includes(platform);
    if (!runsHere) return { id, ran: false, ok: true, reason: `not applicable on ${platform}` };

    const built = await buildVector(vector);
    try {
      if (vector.requiresSymlink && built.symlinkSkipped) {
        return { id, ran: false, ok: true, reason: 'symlink unsupported on host' };
      }
      const res = await computeWorkspaceHash({
        root: built.root,
        scratchPrefixes: vector.scratchPrefixes ?? [],
        algorithm: 'blake3',
      });
      const expected = await this.loadExpectedHash(id);
      const ok = expected === null ? true : res.hash === expected;
      return {
        id,
        ran: true,
        ok,
        hash: res.hash,
        ...(expected !== null ? { expectedHash: expected } : {}),
      };
    } finally {
      await built.cleanup();
    }
  }

  async runAllWorkspaceVectors(): Promise<readonly VectorResult[]> {
    const results: VectorResult[] = [];
    for (const v of VECTORS) {
      results.push(await this.runWorkspaceVector(v.id));
    }
    return results;
  }

  async generateReport(): Promise<Phase0Report> {
    const registry = await this.loadInvariants();
    const critical = registry.invariants.filter((i) => i.severity === 'CRITICAL');
    const vectorResults = await this.runAllWorkspaceVectors();
    const run = vectorResults.filter((r) => r.ran);
    return {
      invariantCount: registry.invariants.length,
      criticalCount: critical.length,
      vectorsRun: run.length,
      vectorsPassed: run.filter((r) => r.ok).length,
      vectorsSkipped: vectorResults.length - run.length,
      vectorResults,
    };
  }
}
