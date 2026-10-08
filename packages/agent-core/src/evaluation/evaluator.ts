// Deterministic evaluator — pure (agent-core). It decides a case's verdict from DETERMINISTIC
// evidence only (the check outcomes), never from anything the agent said about itself (§11). It
// also attributes a failure class from the trace so the roadmap can be re-ranked by evidence
// (§18), and aggregates case results into an EvaluationResult (§29).
import type {
  BenchmarkCaseResult,
  BenchmarkFailureClass,
  BenchmarkTask,
  CaseVerdict,
  EvaluationResult,
  Metric,
  RunProvenance,
} from '../domain/evaluation.js';
import type { DomainEvent } from '../domain/event.js';
import { computeMetrics, metricValue, type CaseEvidence } from './metrics.js';

/** A single executed check with its deterministic outcome + optional evidence detail. */
export interface CheckOutcome {
  readonly description: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface EvaluateCaseInput {
  readonly task: BenchmarkTask;
  readonly checks: readonly CheckOutcome[];
  readonly events: readonly DomainEvent[];
  readonly filesChanged: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** Set by the runner when the run could not complete (crash/setup error) → INVALID, not FAILURE. */
  readonly invalidReason?: string;
  /** Set by the runner when the whole case exceeded its wall-clock limit. */
  readonly timedOut?: boolean;
  readonly counters?: CaseEvidence['counters'];
  /** The runtime trace id (session) this case produced. */
  readonly traceRef?: string;
}

/**
 * Evaluate one case. Verdict rule (deterministic, agent is NOT the authority):
 *   - INVALID  when the run could not be judged (setup/crash) — not the agent's fault to "fail".
 *   - SUCCESS  when there is at least one check and ALL checks passed.
 *   - FAILURE  otherwise.
 * A failure class is attributed from the trace + checks for FAILURE/INVALID (best-effort, §18).
 */
export function evaluateCase(input: EvaluateCaseInput): BenchmarkCaseResult {
  const evidence: CaseEvidence = {
    task: input.task,
    checks: input.checks.map((c) => ({ passed: c.passed })),
    events: input.events,
    filesChanged: input.filesChanged,
    durationMs: input.durationMs,
    ...(input.counters !== undefined ? { counters: input.counters } : {}),
  };
  const metrics = computeMetrics(evidence);

  let verdict: CaseVerdict;
  let failureClass: BenchmarkFailureClass | undefined;

  if (input.invalidReason !== undefined) {
    verdict = 'INVALID';
    failureClass = classifyInvalid(input.invalidReason);
  } else if (input.timedOut === true) {
    verdict = 'FAILURE';
    failureClass = 'TIMEOUT';
  } else {
    const allPassed = input.checks.length > 0 && input.checks.every((c) => c.passed);
    verdict = allPassed ? 'SUCCESS' : 'FAILURE';
    if (!allPassed) failureClass = attributeFailure(input, metrics);
  }

  return {
    taskId: input.task.id,
    taskVersion: input.task.version,
    verdict,
    ...(failureClass !== undefined ? { failureClass } : {}),
    checks: input.checks.map((c) => ({
      description: c.description,
      passed: c.passed,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
    })),
    metrics,
    ...(input.traceRef !== undefined ? { traceRef: input.traceRef } : {}),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
  };
}

function classifyInvalid(reason: string): BenchmarkFailureClass {
  const r = reason.toLowerCase();
  if (r.includes('timeout') || r.includes('timed out')) return 'TIMEOUT';
  if (r.includes('resource') || r.includes('budget') || r.includes('exhaust')) return 'RESOURCE_EXHAUSTION';
  if (r.includes('setup') || r.includes('workspace') || r.includes('environment') || r.includes('spawn')) {
    return 'ENVIRONMENT_FAILURE';
  }
  return 'ENVIRONMENT_FAILURE';
}

/**
 * Attribute a dominant failure class from the trace. Ordered by severity/specificity: a
 * governance violation outranks everything; otherwise walk the pipeline from understanding →
 * verification. This is EVIDENCE for prioritization, not the pass/fail authority.
 */
function attributeFailure(input: EvaluateCaseInput, metrics: readonly Metric[]): BenchmarkFailureClass {
  const has = (t: string): boolean => input.events.some((e) => e.type === t);

  // Governance: any denied tool call during a failed case is the most important signal.
  if (metricValue(metrics, 'policy_denied_tool_calls') > 0) return 'GOVERNANCE_VIOLATION';

  // The architecture gate halted the run for a human (expected stop, but the case did not finish).
  if (has('MISSION_ARCHITECTURE_GATE_BLOCKED')) return 'MISSION_UNDERSTANDING_FAILURE';

  // No plan was ever committed → planning failure.
  if (!has('GRAPH_MUTATION_COMMITTED')) return 'PLANNING_FAILURE';

  // A tool call ended in error (vs. a clean implementation that just didn't satisfy checks).
  if (has('TOOL_CALL_DENIED')) return 'TOOL_FAILURE';

  // Recovery ran but the case still failed → recovery failure.
  if (has('RECOVERY_ACTION_CHOSEN')) return 'RECOVERY_FAILURE';

  // A run executed and verification caught the problem → verification/implementation.
  if (has('VERIFICATION_ENDED')) return 'VERIFICATION_FAILURE';

  // Default: the agent produced changes but they did not satisfy the checks.
  return 'IMPLEMENTATION_FAILURE';
}

/** Aggregate case results + run provenance into an EvaluationResult (§29). Deterministic. */
export function aggregate(
  runId: string,
  benchmarkId: string,
  benchmarkVersion: string,
  provenance: RunProvenance,
  results: readonly BenchmarkCaseResult[],
  now: string,
): EvaluationResult {
  const total = results.length;
  const success = results.filter((r) => r.verdict === 'SUCCESS').length;
  const failure = results.filter((r) => r.verdict === 'FAILURE').length;
  const invalid = results.filter((r) => r.verdict === 'INVALID').length;
  // Success rate is over JUDGED cases (INVALID excluded from the denominator — a case we
  // couldn't judge is not the agent failing the task).
  const judged = success + failure;
  const successRate = judged > 0 ? success / judged : 0;

  // Metric averages across all cases (by metric name), stably.
  const sums = new Map<string, { total: number; count: number }>();
  for (const r of results) {
    for (const m of r.metrics) {
      const acc = sums.get(m.name) ?? { total: 0, count: 0 };
      acc.total += m.value; acc.count += 1;
      sums.set(m.name, acc);
    }
  }
  const metricAverages: Record<string, number> = {};
  for (const name of [...sums.keys()].sort()) {
    const acc = sums.get(name)!;
    metricAverages[name] = acc.count > 0 ? acc.total / acc.count : 0;
  }

  const failureBreakdown: Record<string, number> = {};
  for (const r of results) {
    if (r.failureClass !== undefined) {
      failureBreakdown[r.failureClass] = (failureBreakdown[r.failureClass] ?? 0) + 1;
    }
  }

  const governanceViolations = results.reduce(
    (n, r) => n + (r.metrics.find((m) => m.name === 'policy_denied_tool_calls')?.value ?? 0),
    0,
  );

  return {
    runId, benchmarkId, benchmarkVersion, provenance,
    total, success, failure, invalid, successRate,
    metricAverages, failureBreakdown, governanceViolations,
    createdAt: now,
  };
}
