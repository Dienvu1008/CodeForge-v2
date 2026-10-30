/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SWE-bench adapter (agent-core, PURE) — EVALUATION_MODEL §external benchmarks.
//
// Maps an official SWE-bench task record into CodeForge's own BenchmarkTask so a SWE-bench
// instance can be driven through the SAME evaluation pipeline (BenchmarkRunner → isolated
// workspace → real runtime → deterministic checks → evaluator) as the native suite.
//
// What SWE-bench is (relevant fields of each record):
//   instance_id      e.g. "django__django-11099" — stable id.
//   repo             "owner/name" GitHub repo the task lives in.
//   base_commit      the commit the agent starts from (the buggy state).
//   problem_statement the GitHub issue text — this is the GOAL handed to the agent.
//   patch            the GOLD solution patch (reference only — NEVER given to the agent; we
//                    evaluate on behaviour, never on matching this patch, per the master prompt).
//   test_patch       a patch that adds/updates the tests used to judge the fix. Applied by the
//                    HARNESS after the agent runs — not given to the agent.
//   FAIL_TO_PASS     tests that FAIL on base_commit and must PASS after a correct fix.
//   PASS_TO_PASS     tests that already PASS and must STAY passing (no regression).
//   environment_setup_commit / version  pin the dependency environment.
//
// Why a BenchmarkTask cannot hold all of this: the frozen domain's `seedFiles` is an inline
// path→content map, but a SWE-bench repo is far too large to inline, and the test_patch +
// test selection must be applied by the harness AFTER the agent edits. So this adapter returns
// a BUNDLE: the BenchmarkTask (goal + a single command check that runs the harness) PLUS a
// `SweBenchSetup` side-channel carrying the repo/commit/patch/test data the infrastructure
// runner needs to (1) materialise the repo at base_commit before the run and (2) apply the
// test_patch and run the selected tests as the check. agent-core stays I/O-free (DC-002); the
// infra runner consumes the setup.
//
// Deterministic + total: same record → same task/setup, or a structured rejection. Never coerces
// bad input (mirrors the benchmark-loader philosophy).
import type { BenchmarkTask, BenchmarkCheck } from '../domain/evaluation.js';
import type { BenchmarkLoadError, BenchmarkLoadResult } from './benchmark-loader.js';

// ── SWE-bench record ────────────────────────────────────────────────────────────

/** The subset of an official SWE-bench instance record this adapter consumes. */
export interface SweBenchInstance {
  readonly instance_id: string;
  readonly repo: string;              // "owner/name"
  readonly base_commit: string;
  readonly problem_statement: string;
  /** GOLD patch — reference only; the adapter records it but never hands it to the agent. */
  readonly patch?: string;
  /** Test patch applied by the harness after the run (adds/updates the judging tests). */
  readonly test_patch: string;
  /** Tests that must flip from fail→pass. Non-empty for a usable instance. */
  readonly fail_to_pass: readonly string[];
  /** Tests that must stay passing (regression guard). May be empty. */
  readonly pass_to_pass: readonly string[];
  readonly environment_setup_commit?: string;
  readonly version?: string;
}

/**
 * Everything the infrastructure runner needs to set up + judge a SWE-bench case, that does not
 * fit in a BenchmarkTask. Travels alongside the task (keyed by task id).
 */
export interface SweBenchSetup {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly testPatch: string;
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
  readonly environmentSetupCommit?: string;
  readonly version?: string;
  /** GOLD patch — kept for provenance/debugging ONLY; must never be exposed to the agent. */
  readonly goldPatch?: string;
}

/** A BenchmarkTask paired with its SWE-bench setup side-channel. */
export interface SweBenchTaskWithSetup {
  readonly task: BenchmarkTask;
  readonly setup: SweBenchSetup;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface SweBenchAdapterOptions {
  /**
   * How the harness runs the selected tests inside the prepared repo. SWE-bench's own harness
   * uses per-repo commands (pytest/tox/…); we keep this injectable so a caller can plug the
   * right runner. The resolved command is stored verbatim as the task's `command` check target.
   * `{tests}` in the template is replaced by the space-joined FAIL_TO_PASS+PASS_TO_PASS selection.
   * Default: "python -m pytest -q {tests}".
   */
  readonly testCommandTemplate?: string;
  /** Hard wall-clock limit per case (ms). Default 1_800_000 (30 min — SWE-bench tasks are heavy). */
  readonly timeoutMs?: number;
  /** Max agent iterations recorded as a resource limit (advisory). Default 40. */
  readonly maxIterations?: number;
}

const DEFAULT_TEST_COMMAND = 'python -m pytest -q {tests}';
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_ITERATIONS = 40;

// ── validation ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}
/** SWE-bench stores FAIL_TO_PASS/PASS_TO_PASS as either a JSON array or a JSON-encoded string. */
function coerceStringList(v: unknown): readonly string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return [];
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
    } catch { /* not JSON — fall through */ }
  }
  return undefined;
}

/**
 * Validate one SWE-bench record (an untrusted plain object). Accepts both snake_case canonical
 * fields and the common `FAIL_TO_PASS` / `PASS_TO_PASS` upper-case keys. Total + deterministic.
 */
export function validateSweBenchInstance(raw: unknown, path = 'instance'): BenchmarkLoadResult<SweBenchInstance> {
  const errors: BenchmarkLoadError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ path, message: 'instance must be an object' }] };

  if (!nonEmptyString(raw.instance_id)) errors.push({ path: `${path}.instance_id`, message: 'instance_id required' });
  if (!nonEmptyString(raw.repo)) errors.push({ path: `${path}.repo`, message: 'repo required' });
  if (!nonEmptyString(raw.base_commit)) errors.push({ path: `${path}.base_commit`, message: 'base_commit required' });
  if (!nonEmptyString(raw.problem_statement)) errors.push({ path: `${path}.problem_statement`, message: 'problem_statement required' });
  if (typeof raw.test_patch !== 'string' || raw.test_patch === '') errors.push({ path: `${path}.test_patch`, message: 'test_patch required' });

  const f2p = coerceStringList(raw.FAIL_TO_PASS ?? raw.fail_to_pass);
  const p2p = coerceStringList(raw.PASS_TO_PASS ?? raw.pass_to_pass);
  if (f2p === undefined || f2p.length === 0) {
    errors.push({ path: `${path}.FAIL_TO_PASS`, message: 'FAIL_TO_PASS must be a non-empty string array (or JSON-encoded array)' });
  }
  if (p2p === undefined) {
    errors.push({ path: `${path}.PASS_TO_PASS`, message: 'PASS_TO_PASS must be a string array (or JSON-encoded array)' });
  }

  if (errors.length > 0) return { ok: false, errors };

  const instance: SweBenchInstance = {
    instance_id: raw.instance_id as string,
    repo: raw.repo as string,
    base_commit: raw.base_commit as string,
    problem_statement: raw.problem_statement as string,
    test_patch: raw.test_patch as string,
    fail_to_pass: f2p as readonly string[],
    pass_to_pass: (p2p ?? []) as readonly string[],
    ...(nonEmptyString(raw.patch) ? { patch: raw.patch } : {}),
    ...(nonEmptyString(raw.environment_setup_commit) ? { environment_setup_commit: raw.environment_setup_commit } : {}),
    ...(nonEmptyString(raw.version) ? { version: raw.version } : {}),
  };
  return { ok: true, value: instance };
}

// ── mapping ───────────────────────────────────────────────────────────────────

/** The space-joined test selection (FAIL_TO_PASS first, then PASS_TO_PASS), de-duplicated. */
export function sweBenchTestSelection(instance: SweBenchInstance): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...instance.fail_to_pass, ...instance.pass_to_pass]) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/**
 * Build the harness test command for an instance from the template (substituting `{tests}`).
 * Exposed so the infra runner records the exact command it will run as the check target.
 */
export function sweBenchTestCommand(instance: SweBenchInstance, template = DEFAULT_TEST_COMMAND): string {
  const tests = sweBenchTestSelection(instance).join(' ');
  return template.includes('{tests}') ? template.replace('{tests}', tests) : `${template} ${tests}`.trim();
}

/**
 * Convert one validated SWE-bench instance into a BenchmarkTask + its setup side-channel.
 *
 * The task's single `command` check runs the harness test command; the infra runner is
 * responsible for having applied the test_patch and checked out base_commit first (via the
 * SweBenchSetup). The GOLD patch is carried in the setup for provenance only and is NEVER placed
 * in the task description or seedFiles — the agent must solve the problem from the issue text.
 */
export function sweBenchInstanceToTask(
  instance: SweBenchInstance,
  options: SweBenchAdapterOptions = {},
): SweBenchTaskWithSetup {
  const template = options.testCommandTemplate ?? DEFAULT_TEST_COMMAND;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const command = sweBenchTestCommand(instance, template);

  const check: BenchmarkCheck = {
    kind: 'command',
    target: command,
    description: `SWE-bench ${instance.instance_id}: FAIL_TO_PASS + PASS_TO_PASS tests pass after the fix`,
    timeoutMs,
  };

  const task: BenchmarkTask = {
    id: instance.instance_id,
    version: 1,
    category: 'BUGFIX', // SWE-bench is issue-resolution; it maps to CodeForge's BUGFIX category.
    title: `SWE-bench: ${instance.repo} — ${instance.instance_id}`,
    description: instance.problem_statement,
    seedFiles: {}, // the repo is materialised by the runner's SweBenchWorkspaceSetup, not inline.
    verification: [check],
    expected: { missionType: 'BUGFIX' },
    difficulty: 'HARD', // real-repo issue resolution; the curve's hard end.
    risk: 'MEDIUM',
    timeoutMs,
    resourceLimits: { maxIterations },
  };

  const setup: SweBenchSetup = {
    instanceId: instance.instance_id,
    repo: instance.repo,
    baseCommit: instance.base_commit,
    testPatch: instance.test_patch,
    failToPass: instance.fail_to_pass,
    passToPass: instance.pass_to_pass,
    ...(instance.environment_setup_commit !== undefined ? { environmentSetupCommit: instance.environment_setup_commit } : {}),
    ...(instance.version !== undefined ? { version: instance.version } : {}),
    ...(instance.patch !== undefined ? { goldPatch: instance.patch } : {}),
  };

  return { task, setup };
}

/**
 * Convert a list of raw SWE-bench records into a validated set of task+setup bundles, rejecting
 * the whole batch with structured errors if ANY record is invalid or any instance_id repeats.
 */
export function sweBenchInstancesToTasks(
  rawInstances: readonly unknown[],
  options: SweBenchAdapterOptions = {},
): BenchmarkLoadResult<readonly SweBenchTaskWithSetup[]> {
  const errors: BenchmarkLoadError[] = [];
  const bundles: SweBenchTaskWithSetup[] = [];
  const seen = new Set<string>();
  rawInstances.forEach((raw, i) => {
    const result = validateSweBenchInstance(raw, `instances[${i}]`);
    if (!result.ok) { errors.push(...result.errors); return; }
    if (seen.has(result.value.instance_id)) {
      errors.push({ path: `instances[${i}].instance_id`, message: `duplicate instance_id: ${result.value.instance_id}` });
      return;
    }
    seen.add(result.value.instance_id);
    bundles.push(sweBenchInstanceToTask(result.value, options));
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: bundles };
}
