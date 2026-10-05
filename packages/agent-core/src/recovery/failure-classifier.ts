// FailureClassifier — P5-FA1. Deterministic mapping from VerificationReport/TaskRun signals
// to a FailureClass. Pure + deterministic — same input → same output (RC-003 spirit).
//
// Classification priority (checked in order):
//   1. TaskRun state = TIMEOUT → TIMEOUT
//   2. VerificationReport checks for specific patterns → BUILD_ERROR | TEST_FAIL | LINT_ERROR
//   3. VerificationReport.status == INVALID → ENVIRONMENT
//   4. VerificationReport.status == FAIL → VERIFICATION_FAIL
//   5. TaskRun state = FAILED, no report → UNKNOWN
//
// This is NOT an LLM call. The LLM-based FailureAnalyzer is a separate module
// (Phase 5 extension) — the deterministic classifier runs first (RC-001).
import type { FailureClass } from '../domain/failure.js';
import type { VerificationReport } from '../domain/verification.js';
import type { TaskRunState } from '../state-machine/states.js';

// ── ClassifierInput ───────────────────────────────────────────────────────────

export interface ClassifierInput {
  /** Final state of the TaskRun. */
  readonly taskRunState: TaskRunState;
  /** Most recent VerificationReport for this run. Undefined if verification did not run. */
  readonly verificationReport?: VerificationReport | undefined;
  /**
   * Raw stderr string from the last tool call, if available.
   * Used for keyword-based classification (e.g. "error TS" → BUILD_ERROR).
   */
  readonly lastStderr?: string | undefined;
}

// ── Signal patterns ───────────────────────────────────────────────────────────

const BUILD_PATTERNS: readonly RegExp[] = [
  /error TS\d+/i,        // TypeScript compile errors
  /build failed/i,
  /compilation error/i,
  /Cannot find module/i,
];

const TEST_PATTERNS: readonly RegExp[] = [
  /FAIL\s/,              // Jest / Vitest FAIL prefix
  /\d+ failed/i,         // "3 tests failed"
  /AssertionError/i,
  /test suite failed/i,
];

const LINT_PATTERNS: readonly RegExp[] = [
  /\d+ problem/i,        // eslint "3 problems (3 errors, 0 warnings)"
  /eslint/i,
  /lint error/i,
];

// ── classifyFailure ───────────────────────────────────────────────────────────

/**
 * Deterministically classify a failure from observable signals.
 * RC-001: returns a class from the defined FailureClass union.
 * RC-003: deterministic on available signals; missing signals → UNKNOWN.
 */
export function classifyFailure(input: ClassifierInput): FailureClass {
  const { taskRunState, verificationReport, lastStderr = '' } = input;

  // 1. Timeout → explicit class.
  if (taskRunState === 'TIMEOUT') return 'TIMEOUT';

  // 2. Check VerificationReport check statuses for specific patterns.
  if (verificationReport !== undefined) {
    for (const check of verificationReport.checks) {
      if (check.status !== 'FAIL' && check.status !== 'ERROR') continue;
      const kind = check.kind;
      if (kind === 'build' || kind === 'typecheck') return 'SYNTAX';
      if (kind === 'test') return 'LOGIC';
      if (kind === 'lint' || kind === 'format') return 'TOOL';
    }

    // 3. status == INVALID → workspace drifted during verification → ENVIRONMENT.
    if (verificationReport.status === 'INVALID') return 'ENVIRONMENT';

    // 4. status == FAIL/ERROR but no specific check kind matched.
    if (verificationReport.status === 'FAIL' || verificationReport.status === 'ERROR') {
      // Try stderr patterns.
      if (matchesAny(lastStderr, BUILD_PATTERNS)) return 'SYNTAX';
      if (matchesAny(lastStderr, TEST_PATTERNS))  return 'LOGIC';
      if (matchesAny(lastStderr, LINT_PATTERNS))  return 'TOOL';
      return 'UNKNOWN';
    }
  }

  // 5. No report + FAILED run → try stderr heuristics.
  if (taskRunState === 'FAILED') {
    if (matchesAny(lastStderr, BUILD_PATTERNS)) return 'SYNTAX';
    if (matchesAny(lastStderr, TEST_PATTERNS))  return 'LOGIC';
    if (matchesAny(lastStderr, LINT_PATTERNS))  return 'TOOL';
    return 'UNKNOWN';
  }

  // 6. Anything else (should not happen for a failed run) → UNKNOWN.
  return 'UNKNOWN';
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}