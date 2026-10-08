// Evaluation / Benchmark domain model — the "Task Correctness" axis (EVALUATION_MODEL §2.2).
//
// This is a SEPARATE domain from the runtime Task model. A BenchmarkTask describes a goal + an
// environment + how to VERIFY the result — it never prescribes an expected patch (CodeForge is
// evaluated on behavior/results, not on one implementation). Evaluation is EXTERNAL to the agent:
// the agent never judges its own success (the master prompt §11). The verdict comes from
// deterministic checks (tests/build/invariants/expected-behavior); an LLM judge may be added
// later as a SECONDARY signal but never replaces deterministic verification where it is possible.
//
// Pure types only — readonly, no logic, no I/O (DT-20). Runner/evaluator/metrics live under
// ../evaluation/ (agent-core, pure orchestration) and ../../infrastructure (I/O adapters).
import type { Provenance } from './provenance.js';

// ── Categories (§9) ──────────────────────────────────────────────────────────────
// Deliberately broader than SWE-bench: CodeForge's objective is not only bug fixing.

export type BenchmarkCategory =
  | 'BUGFIX'
  | 'FEATURE'
  | 'REFACTOR'
  | 'MIGRATION'
  | 'TESTING'
  | 'DEBUGGING'
  | 'REPOSITORY_UNDERSTANDING'
  | 'ARCHITECTURE'
  | 'PROJECT_GENERATION'
  | 'RESEARCH_AND_IMPLEMENT'
  | 'MULTI_FILE'
  | 'MULTI_REPOSITORY';

export type BenchmarkDifficulty = 'TRIVIAL' | 'EASY' | 'MEDIUM' | 'HARD' | 'EXPERT';
export type BenchmarkRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ── Verification method (§8) ───────────────────────────────────────────────────
// How the evaluator decides SUCCESS. All deterministic. A task may compose several checks.

export type VerificationKind =
  | 'command'        // run a command in the isolated workspace; exit 0 = pass (e.g. the test suite)
  | 'file_exists'    // a path must exist after the run
  | 'file_absent'    // a path must NOT exist after the run
  | 'file_contains'  // a path must contain a substring/regex
  | 'build'          // the project build must succeed
  | 'no_regression'; // a baseline command that passed before must still pass

export interface BenchmarkCheck {
  readonly kind: VerificationKind;
  /** For command/build/no_regression: the command line. For file_*: the target path. */
  readonly target: string;
  /** Optional args for command/build. */
  readonly args?: readonly string[];
  /** For file_contains: substring (or regex when `isRegex`). */
  readonly expect?: string;
  readonly isRegex?: boolean;
  /** Human-readable description of what this check proves. */
  readonly description: string;
  /** Per-check timeout (ms). Falls back to the task timeout. */
  readonly timeoutMs?: number;
}

// ── BenchmarkTask (§8) ───────────────────────────────────────────────────────────

/**
 * A single reproducible evaluation case. It carries enough to set up an isolated workspace, run
 * the agent against a goal, and verify the result deterministically — WITHOUT an expected patch.
 */
export interface BenchmarkTask {
  readonly id: string;              // e.g. 'CF-001'
  readonly version: number;         // bump when the task's meaning changes
  readonly category: BenchmarkCategory;
  readonly title: string;
  readonly description: string;     // the goal handed to the agent

  /**
   * Initial workspace state: a set of seed files (relative path → content) materialized into the
   * isolated workspace before the run. Empty for a from-scratch PROJECT_GENERATION task.
   */
  readonly seedFiles: Readonly<Record<string, string>>;

  /** Deterministic checks that decide SUCCESS/FAILURE (§11). Non-empty for a usable task. */
  readonly verification: readonly BenchmarkCheck[];

  /**
   * Expected behavioral signals (advisory, for failure-class attribution — NOT the pass/fail
   * authority). E.g. the mission type a correct run should classify as, or files it should touch.
   */
  readonly expected?: {
    readonly missionType?: string;
    readonly touchesPaths?: readonly string[];
    readonly maxFilesChanged?: number;
  };

  readonly difficulty: BenchmarkDifficulty;
  readonly risk: BenchmarkRisk;
  /** Hard wall-clock limit for the whole case (ms). */
  readonly timeoutMs: number;
  /** Optional resource ceilings (advisory to the runner / recorded for provenance). */
  readonly resourceLimits?: {
    readonly maxToolCalls?: number;
    readonly maxModelTokens?: number;
    readonly maxIterations?: number;
  };
}

// ── Benchmark + version (§8) ─────────────────────────────────────────────────────

export interface Benchmark {
  readonly id: string;              // e.g. 'codeforge-native'
  readonly version: string;         // semver-ish, e.g. '0.1.0'
  readonly description: string;
  readonly tasks: readonly BenchmarkTask[];
}

// ── Metrics (§15) ─────────────────────────────────────────────────────────────────
// A metric is a named numeric/boolean reading. The set is OPEN: new metrics can be added
// without changing the runner. A few canonical names are suggested per group.

export type MetricGroup =
  | 'correctness'
  | 'efficiency'
  | 'scope'
  | 'planning'
  | 'context'
  | 'recovery'
  | 'governance'
  | 'routing';

export interface Metric {
  readonly name: string;            // e.g. 'tests_passed', 'tool_calls', 'files_changed'
  readonly group: MetricGroup;
  readonly value: number;           // booleans encoded as 0/1
  readonly unit?: string;           // 'ms', 'tokens', 'count', '' …
}

// ── Failure classification (§18) ───────────────────────────────────────────────────
// A failed case should say WHERE it failed, so the roadmap can be re-ranked by evidence.

export type BenchmarkFailureClass =
  | 'MISSION_UNDERSTANDING_FAILURE'
  | 'MODEL_SELECTION_FAILURE'
  | 'CONTEXT_FAILURE'
  | 'PLANNING_FAILURE'
  | 'TOOL_FAILURE'
  | 'IMPLEMENTATION_FAILURE'
  | 'VERIFICATION_FAILURE'
  | 'RECOVERY_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'TIMEOUT'
  | 'RESOURCE_EXHAUSTION'
  | 'GOVERNANCE_VIOLATION';

// ── Result of a single case (§13) ──────────────────────────────────────────────────

export type CaseVerdict = 'SUCCESS' | 'FAILURE' | 'INVALID';

export interface BenchmarkCaseResult {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly verdict: CaseVerdict;
  /** When FAILURE/INVALID: the dominant failure class (best-effort attribution). */
  readonly failureClass?: BenchmarkFailureClass;
  /** Per-check outcomes (deterministic evidence behind the verdict). */
  readonly checks: readonly { readonly description: string; readonly passed: boolean; readonly detail?: string }[];
  readonly metrics: readonly Metric[];
  /** Id of the runtime trace (EventLog session) this case produced, when available. */
  readonly traceRef?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

// ── Reproducibility provenance (§13) ───────────────────────────────────────────────

export interface RunProvenance {
  readonly agentName: string;       // 'codeforge'
  readonly agentVersion: string;    // runtimeVersion
  readonly gitCommit: string;
  readonly model: string;           // model id used (or 'fake-model')
  readonly modelVersion?: string;
  readonly configVersion?: string;  // prompt/config version
  readonly runtimeConfig: Readonly<Record<string, string | number | boolean>>;
  readonly environment: string;     // 'win32' | 'linux' | …
}

// ── BenchmarkRun (§13) — one benchmark × one agent/model/config ─────────────────────

export interface BenchmarkRun {
  readonly runId: string;
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly provenance: RunProvenance;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly results: readonly BenchmarkCaseResult[];
}

// ── EvaluationResult (§29) — aggregate of a run ─────────────────────────────────────

export interface EvaluationResult {
  readonly runId: string;
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly provenance: RunProvenance;
  readonly total: number;
  readonly success: number;
  readonly failure: number;
  readonly invalid: number;
  readonly successRate: number;     // 0.0–1.0
  /** Aggregated metric averages, keyed by metric name. */
  readonly metricAverages: Readonly<Record<string, number>>;
  /** Count of failures per class (§18). */
  readonly failureBreakdown: Readonly<Record<string, number>>;
  readonly governanceViolations: number;
  readonly createdAt: string;
}

// ── Baseline + regression (§16, §30) ────────────────────────────────────────────────

export interface Baseline {
  readonly baselineId: string;
  readonly label: string;           // e.g. 'codeforge-0.12-fakemodel'
  readonly result: EvaluationResult;
  readonly provenance: Provenance;
  readonly recordedAt: string;
}

export type RegressionVerdict = 'IMPROVEMENT' | 'REGRESSION' | 'NEUTRAL' | 'MIXED';

export interface RegressionReport {
  readonly verdict: RegressionVerdict;
  readonly baselineLabel: string;
  readonly currentLabel: string;
  readonly successRateDelta: number;          // current − baseline (−1.0…+1.0)
  /** Metric deltas keyed by name (current − baseline). Positive = larger value. */
  readonly metricDeltas: Readonly<Record<string, number>>;
  /** Human-readable notes, e.g. "success flat but tool_calls +120%". */
  readonly notes: readonly string[];
}

/** Current evaluation-domain schema version (bump when any shape changes). */
export const EVALUATION_VERSION = 1;
