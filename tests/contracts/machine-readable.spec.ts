// A4/A5 — machine-readable artifacts parse and satisfy Phase 0 metrics.
// PHASE_0_ACCEPTANCE §6.2 (scenarios) + §10 (checklist).
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadYaml<T>(rel: string): Promise<T> {
  return yaml.load(await readFile(join(rootDir, rel), 'utf8')) as T;
}

interface Scenario {
  id: string;
  stage: string;
  variants: string[];
  expected: string;
  enforcement: string[];
  success_criteria: string[];
}
interface ScenariosFile {
  version: number | string;
  scenarios: Scenario[];
}

describe('scenarios.yaml (A4)', () => {
  it('parses and declares >= 5 scenarios (PHASE_0_ACCEPTANCE §6.2)', async () => {
    const doc = await loadYaml<ScenariosFile>('scenarios.yaml');
    expect(doc.scenarios.length).toBeGreaterThanOrEqual(5);
  });

  it('covers the required stages (plan/execute/verify/recover/mixed)', async () => {
    const doc = await loadYaml<ScenariosFile>('scenarios.yaml');
    const stages = new Set(doc.scenarios.map((s) => s.stage));
    for (const stage of ['plan', 'execute', 'verify', 'recover', 'mixed']) {
      expect(stages.has(stage)).toBe(true);
    }
  });

  it('every scenario is well-formed and expects BLOCKED', async () => {
    const doc = await loadYaml<ScenariosFile>('scenarios.yaml');
    for (const s of doc.scenarios) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.variants.length).toBeGreaterThan(0);
      expect(s.enforcement.length).toBeGreaterThan(0);
      expect(s.success_criteria.length).toBeGreaterThan(0);
      expect(s.expected).toBe('BLOCKED');
    }
  });

  it('references only known adversarial variants', async () => {
    const doc = await loadYaml<ScenariosFile>('scenarios.yaml');
    const known = new Set([
      'MaliciousPlanner',
      'MaliciousReplanner',
      'MaliciousVerifier',
      'MaliciousToolProposal',
      'MaliciousFailureAnalyzer',
      'PromptInjectionContent',
      'CombinedAttack',
    ]);
    for (const s of doc.scenarios) {
      for (const v of s.variants) expect(known.has(v)).toBe(true);
    }
  });
});

interface ChecklistFile {
  version: number | string;
  metrics: {
    invariants_total: number;
    invariants_critical: number;
    invariants_critical_min: number;
    workspace_vectors: number;
    adversarial_variants: number;
    adversarial_scenarios: number;
    cross_platform_runners: number;
  };
}

describe('phase_0_checklist.yaml (A5)', () => {
  it('parses and metrics satisfy Phase 0 thresholds', async () => {
    const doc = await loadYaml<ChecklistFile>('phase_0_checklist.yaml');
    const m = doc.metrics;
    expect(m.invariants_total).toBe(144);
    expect(m.invariants_critical).toBeGreaterThanOrEqual(m.invariants_critical_min); // MA-6
    expect(m.workspace_vectors).toBe(20);
    expect(m.adversarial_variants).toBeGreaterThanOrEqual(7);
    expect(m.adversarial_scenarios).toBeGreaterThanOrEqual(5);
    expect(m.cross_platform_runners).toBeGreaterThanOrEqual(2);
  });
});
