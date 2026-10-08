// Benchmark loader + validator — pure (agent-core). Turns untrusted plain objects (parsed from
// JSON dataset files by an infrastructure adapter) into validated BenchmarkTask / Benchmark
// values, or a list of structured errors. No I/O here: the caller reads files; this validates.
//
// Validation is deterministic and total — same input → same result. A task that fails validation
// is never silently coerced; it is rejected with a reason (mirrors the structured-output
// validator philosophy: never "fix" bad input).
import type {
  Benchmark,
  BenchmarkTask,
  BenchmarkCheck,
  BenchmarkCategory,
  BenchmarkDifficulty,
  BenchmarkRisk,
  VerificationKind,
} from '../domain/evaluation.js';

export interface BenchmarkLoadError {
  /** Dotted path to the offending field, e.g. 'tasks[2].verification[0].kind'. */
  readonly path: string;
  readonly message: string;
}

export type BenchmarkLoadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly BenchmarkLoadError[] };

const CATEGORIES: ReadonlySet<string> = new Set<BenchmarkCategory>([
  'BUGFIX', 'FEATURE', 'REFACTOR', 'MIGRATION', 'TESTING', 'DEBUGGING',
  'REPOSITORY_UNDERSTANDING', 'ARCHITECTURE', 'PROJECT_GENERATION',
  'RESEARCH_AND_IMPLEMENT', 'MULTI_FILE', 'MULTI_REPOSITORY',
]);
const DIFFICULTIES: ReadonlySet<string> = new Set<BenchmarkDifficulty>(['TRIVIAL', 'EASY', 'MEDIUM', 'HARD', 'EXPERT']);
const RISKS: ReadonlySet<string> = new Set<BenchmarkRisk>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const CHECK_KINDS: ReadonlySet<string> = new Set<VerificationKind>([
  'command', 'file_exists', 'file_absent', 'file_contains', 'build', 'no_regression',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStringRecord(v: unknown): v is Record<string, string> {
  return isObject(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Validate a single benchmark check. */
function validateCheck(raw: unknown, path: string, errors: BenchmarkLoadError[]): BenchmarkCheck | undefined {
  if (!isObject(raw)) { errors.push({ path, message: 'check must be an object' }); return undefined; }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !CHECK_KINDS.has(kind)) {
    errors.push({ path: `${path}.kind`, message: `invalid check kind: ${String(kind)}` });
    return undefined;
  }
  if (typeof raw.target !== 'string' || raw.target.trim() === '') {
    errors.push({ path: `${path}.target`, message: 'target must be a non-empty string' });
    return undefined;
  }
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    errors.push({ path: `${path}.description`, message: 'description must be a non-empty string' });
    return undefined;
  }
  if ((kind === 'file_contains') && typeof raw.expect !== 'string') {
    errors.push({ path: `${path}.expect`, message: 'file_contains requires a string "expect"' });
    return undefined;
  }
  const check: BenchmarkCheck = {
    kind: kind as VerificationKind,
    target: raw.target,
    description: raw.description,
    ...(Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string') ? { args: raw.args as string[] } : {}),
    ...(typeof raw.expect === 'string' ? { expect: raw.expect } : {}),
    ...(typeof raw.isRegex === 'boolean' ? { isRegex: raw.isRegex } : {}),
    ...(typeof raw.timeoutMs === 'number' ? { timeoutMs: raw.timeoutMs } : {}),
  };
  return check;
}

/** Validate a single benchmark task. */
export function validateBenchmarkTask(raw: unknown, path = 'task'): BenchmarkLoadResult<BenchmarkTask> {
  const errors: BenchmarkLoadError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ path, message: 'task must be an object' }] };

  if (typeof raw.id !== 'string' || raw.id.trim() === '') errors.push({ path: `${path}.id`, message: 'id required' });
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    errors.push({ path: `${path}.version`, message: 'version must be a positive integer' });
  }
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) {
    errors.push({ path: `${path}.category`, message: `invalid category: ${String(raw.category)}` });
  }
  if (typeof raw.title !== 'string' || raw.title.trim() === '') errors.push({ path: `${path}.title`, message: 'title required' });
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    errors.push({ path: `${path}.description`, message: 'description required' });
  }
  if (raw.seedFiles !== undefined && !isStringRecord(raw.seedFiles)) {
    errors.push({ path: `${path}.seedFiles`, message: 'seedFiles must be a record of path → string content' });
  }
  if (typeof raw.difficulty !== 'string' || !DIFFICULTIES.has(raw.difficulty)) {
    errors.push({ path: `${path}.difficulty`, message: `invalid difficulty: ${String(raw.difficulty)}` });
  }
  if (typeof raw.risk !== 'string' || !RISKS.has(raw.risk)) {
    errors.push({ path: `${path}.risk`, message: `invalid risk: ${String(raw.risk)}` });
  }
  if (typeof raw.timeoutMs !== 'number' || raw.timeoutMs <= 0) {
    errors.push({ path: `${path}.timeoutMs`, message: 'timeoutMs must be a positive number' });
  }

  const checks: BenchmarkCheck[] = [];
  if (!Array.isArray(raw.verification) || raw.verification.length === 0) {
    errors.push({ path: `${path}.verification`, message: 'verification must be a non-empty array' });
  } else {
    raw.verification.forEach((c, i) => {
      const check = validateCheck(c, `${path}.verification[${i}]`, errors);
      if (check !== undefined) checks.push(check);
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const task: BenchmarkTask = {
    id: raw.id as string,
    version: raw.version as number,
    category: raw.category as BenchmarkCategory,
    title: raw.title as string,
    description: raw.description as string,
    seedFiles: (raw.seedFiles as Record<string, string> | undefined) ?? {},
    verification: checks,
    difficulty: raw.difficulty as BenchmarkDifficulty,
    risk: raw.risk as BenchmarkRisk,
    timeoutMs: raw.timeoutMs as number,
    ...(isObject(raw.expected) ? { expected: raw.expected as NonNullable<BenchmarkTask['expected']> } : {}),
    ...(isObject(raw.resourceLimits) ? { resourceLimits: raw.resourceLimits as NonNullable<BenchmarkTask['resourceLimits']> } : {}),
  };
  return { ok: true, value: task };
}

/** Validate a full benchmark (metadata + task list). Rejects duplicate task ids. */
export function validateBenchmark(raw: unknown): BenchmarkLoadResult<Benchmark> {
  const errors: BenchmarkLoadError[] = [];
  if (!isObject(raw)) return { ok: false, errors: [{ path: 'benchmark', message: 'benchmark must be an object' }] };
  if (typeof raw.id !== 'string' || raw.id.trim() === '') errors.push({ path: 'id', message: 'id required' });
  if (typeof raw.version !== 'string' || raw.version.trim() === '') errors.push({ path: 'version', message: 'version required' });
  if (typeof raw.description !== 'string') errors.push({ path: 'description', message: 'description required' });

  const tasks: BenchmarkTask[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    errors.push({ path: 'tasks', message: 'tasks must be a non-empty array' });
  } else {
    raw.tasks.forEach((t, i) => {
      const result = validateBenchmarkTask(t, `tasks[${i}]`);
      if (!result.ok) { errors.push(...result.errors); return; }
      if (seenIds.has(result.value.id)) {
        errors.push({ path: `tasks[${i}].id`, message: `duplicate task id: ${result.value.id}` });
        return;
      }
      seenIds.add(result.value.id);
      tasks.push(result.value);
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const benchmark: Benchmark = {
    id: raw.id as string,
    version: raw.version as string,
    description: raw.description as string,
    tasks,
  };
  return { ok: true, value: benchmark };
}
