// BaselineStore — filesystem persistence for evaluation baselines + machine-readable run results
// (§13, §16). JSON files under a baselines directory. Deterministic layout; append-only in spirit
// (a baseline is identified by label; re-recording the same label overwrites intentionally).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Baseline, EvaluationResult, BenchmarkRun } from '@codeforge/agent-core';

export interface BaselineStoreDeps {
  /** Directory where baselines + runs are written (created if missing). */
  readonly dir: string;
  readonly now: () => string;
  readonly newId: () => string;
}

export class BaselineStore {
  constructor(private readonly deps: BaselineStoreDeps) {
    mkdirSync(this.deps.dir, { recursive: true });
  }

  /** Persist a full run (machine-readable result) under runs/<runId>.json. */
  saveRun(run: BenchmarkRun): string {
    const dir = join(this.deps.dir, 'runs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${run.runId}.json`);
    writeFileSync(path, JSON.stringify(run, null, 2), 'utf8');
    return path;
  }

  /** Record a baseline from an evaluation result under a label. Overwrites same label. */
  recordBaseline(label: string, result: EvaluationResult): Baseline {
    const baseline: Baseline = {
      baselineId: this.deps.newId(),
      label,
      result,
      provenance: {
        provenanceId: this.deps.newId(),
        source: { kind: 'runtime', id: 'benchmark-runner' },
        inputs: [result.runId],
        reason: 'evaluation baseline recorded',
        at: this.deps.now(),
      },
      recordedAt: this.deps.now(),
    };
    writeFileSync(this.baselinePath(label), JSON.stringify(baseline, null, 2), 'utf8');
    return baseline;
  }

  /** Load a baseline by label, or undefined when none recorded. */
  loadBaseline(label: string): Baseline | undefined {
    const path = this.baselinePath(label);
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, 'utf8')) as Baseline; }
    catch { return undefined; }
  }

  /** List recorded baseline labels. */
  listBaselines(): readonly string[] {
    const dir = join(this.deps.dir, 'baselines');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  }

  private baselinePath(label: string): string {
    const dir = join(this.deps.dir, 'baselines');
    mkdirSync(dir, { recursive: true });
    // Sanitize the label for a filename (deterministic).
    const safe = label.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(dir, `${safe}.json`);
  }
}
