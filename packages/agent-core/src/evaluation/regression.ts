// Baseline comparison + regression detection + report rendering — pure (agent-core).
//
// Compares a current EvaluationResult against a baseline and classifies the delta (§30): a drop
// in success rate is a REGRESSION; a rise is an IMPROVEMENT; equal success but materially worse
// cost (runtime/tokens/tool-calls) is ALSO a regression (a system can get no better yet much more
// expensive). Rendering produces the human-readable report (§29).
import type { EvaluationResult, RegressionReport, RegressionVerdict } from '../domain/evaluation.js';

/** Metrics where a LARGER average is WORSE (cost/efficiency). Used for cost-regression detection. */
const COST_METRICS = ['runtime_ms', 'tool_calls', 'task_runs', 'model_tokens'] as const;
/** Relative threshold (fraction) beyond which a cost increase counts as a regression. */
const COST_REGRESSION_THRESHOLD = 0.25; // +25%
/** Absolute success-rate delta below which the change is "neutral". */
const SUCCESS_EPSILON = 0.001;

export function compareToBaseline(
  current: EvaluationResult,
  baseline: EvaluationResult,
  baselineLabel: string,
  currentLabel: string,
): RegressionReport {
  const successRateDelta = current.successRate - baseline.successRate;

  const metricDeltas: Record<string, number> = {};
  const names = new Set<string>([...Object.keys(current.metricAverages), ...Object.keys(baseline.metricAverages)]);
  for (const name of [...names].sort()) {
    metricDeltas[name] = (current.metricAverages[name] ?? 0) - (baseline.metricAverages[name] ?? 0);
  }

  const notes: string[] = [];
  let successImproved = false;
  let successRegressed = false;
  if (successRateDelta > SUCCESS_EPSILON) {
    successImproved = true;
    notes.push(`success rate ${pct(baseline.successRate)} → ${pct(current.successRate)} (+${pct(successRateDelta)})`);
  } else if (successRateDelta < -SUCCESS_EPSILON) {
    successRegressed = true;
    notes.push(`success rate ${pct(baseline.successRate)} → ${pct(current.successRate)} (${pct(successRateDelta)})`);
  } else {
    notes.push(`success rate unchanged at ${pct(current.successRate)}`);
  }

  // Cost regression: success flat/up but a cost metric grew materially.
  let costRegressed = false;
  for (const name of COST_METRICS) {
    const base = baseline.metricAverages[name];
    const cur = current.metricAverages[name];
    if (base === undefined || cur === undefined || base <= 0) continue;
    const rel = (cur - base) / base;
    if (rel > COST_REGRESSION_THRESHOLD) {
      costRegressed = true;
      notes.push(`${name} +${Math.round(rel * 100)}% (${round(base)} → ${round(cur)})`);
    }
  }

  let verdict: RegressionVerdict;
  if (successRegressed) {
    verdict = 'REGRESSION';
  } else if (costRegressed && successImproved) {
    verdict = 'MIXED';
    notes.push('accuracy improved but cost rose materially — review the trade-off');
  } else if (costRegressed) {
    verdict = 'REGRESSION';
    notes.push('no accuracy gain but cost rose materially');
  } else if (successImproved) {
    verdict = 'IMPROVEMENT';
  } else {
    verdict = 'NEUTRAL';
  }

  return { verdict, baselineLabel, currentLabel, successRateDelta, metricDeltas, notes };
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function round(x: number): number { return Math.round(x * 100) / 100; }

/**
 * Render a human-readable evaluation report (§29). Deterministic; stable key order. Optionally
 * includes a baseline comparison block.
 */
export function renderReport(result: EvaluationResult, regression?: RegressionReport): string {
  const lines: string[] = [];
  lines.push('CodeForge Evaluation Report');
  lines.push('───────────────────────────');
  lines.push('');
  lines.push(`Benchmark:    ${result.benchmarkId} @ ${result.benchmarkVersion}`);
  lines.push(`Run:          ${result.runId}`);
  lines.push(`Agent:        ${result.provenance.agentName} ${result.provenance.agentVersion} (${result.provenance.gitCommit})`);
  lines.push(`Model:        ${result.provenance.model}${result.provenance.modelVersion ? ' ' + result.provenance.modelVersion : ''}`);
  lines.push(`Environment:  ${result.provenance.environment}`);
  lines.push('');
  lines.push(`Tasks:        ${result.total}`);
  lines.push(`Success:      ${result.success}`);
  lines.push(`Failure:      ${result.failure}`);
  lines.push(`Invalid:      ${result.invalid}`);
  lines.push(`Success Rate: ${pct(result.successRate)} (over judged cases)`);
  lines.push('');
  lines.push('Metric averages:');
  for (const name of Object.keys(result.metricAverages).sort()) {
    lines.push(`  ${name.padEnd(28)} ${round(result.metricAverages[name]!)}`);
  }
  lines.push('');
  lines.push('Failure breakdown:');
  const fb = result.failureBreakdown;
  const fbKeys = Object.keys(fb).sort();
  if (fbKeys.length === 0) lines.push('  (none)');
  else for (const k of fbKeys) lines.push(`  ${k.padEnd(32)} ${fb[k]}`);
  lines.push('');
  lines.push(`Governance violations: ${result.governanceViolations}`);

  if (regression !== undefined) {
    lines.push('');
    lines.push(`Compared with baseline: ${regression.baselineLabel}`);
    lines.push(`Verdict: ${regression.verdict}`);
    for (const n of regression.notes) lines.push(`  - ${n}`);
  }

  return lines.join('\n');
}
