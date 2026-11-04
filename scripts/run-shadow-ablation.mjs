// Shadow_Runner (kernel-shadow-ablation, design C15; Requirements 10.4, 13.1–13.3).
//
// Replays model traces through the REAL CodeForge kernel twice per (trace, injection plan): once
// in the ENFORCE arm (the kernel as shipped) and once in the SHADOW arm (every enforcement point
// observed, nothing stopped, effects outside the sandbox simulated), compares the pairs and writes
// the ablation report. It is a MEASUREMENT TOOL, not a CI test.
//
// It never contacts a model endpoint: the only model gateway it builds is the ReplayModelGateway
// inside runArm (recorded responses served in order). It reads no --endpoint / --model flag.
//
// Usage:
//   node scripts/run-shadow-ablation.mjs --traces .agents/traces/<run> --benchmark benchmarks/codeforge-progressive/benchmark.json [--only PG-05,PG-12] [--approval none|deny]
//   node scripts/run-shadow-ablation.mjs --synthetic [--only SYN-04]
//   Both forms accept --out-dir <dir> (default .agents).
//
// Output: <out-dir>/kernel-shadow-ablation.{md,json} (recorded traces) or
//         <out-dir>/kernel-shadow-ablation.synthetic.{md,json} (--synthetic).
// Exit codes: 0 report written; 1 usage / IO error; 2 report written but an ENFORCEMENT FAILURE
// (a reached out-of-policy injection the enforce arm did not stop) or a kernelMiss occurred.
//
// Recorded traces (Phase 2): command checks and verification run for REAL inside the sandbox,
// but only exact command lines from the case's declared checks plus the verification policy of
// the seeded sandbox (ContainedProcessSupervisor); every other spawn is simulated. This executes
// model-authored code with your OS privileges (same exposure as run-progressive.mjs) — run Phase 2
// in WSL or a disposable VM.
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve as _resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NodeProcessSupervisor, WorkspaceProcessSupervisor, inspectProject, loadBenchmarkFile,
} from '../packages/infrastructure/dist/index.js';
import { buildVerificationPolicy } from '../packages/agent-core/dist/index.js';
import {
  ContainedProcessSupervisor, INJECTION_CORPUS, UNINJECTED_PLAN_ID, TraceFormatError,
  buildInjectionPlans, buildReport, commandLine, compareArms, parseTrace, renderMarkdown,
  replayRefusal, runArm, synthesizeTraces, syntheticSupervisorFactory, uninjectedView,
} from '../packages/testing/dist/shadow-ablation/index.js';

// Benchmark command checks may reference repo scripts via ${CODEFORGE_REPO} (as in run-progressive).
process.env.CODEFORGE_REPO = _resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'usage:',
  '  node scripts/run-shadow-ablation.mjs --traces <dir> [--benchmark <file>] [--only <caseId,...>] [--approval none|deny] [--out-dir <dir>]',
  '  node scripts/run-shadow-ablation.mjs --synthetic [--only <SYN-xx,...>] [--out-dir <dir>]',
].join('\n');

class UsageError extends Error {}

// ── parse args (strict: unknown flags and missing values are usage errors) ─────────────────
const VALUE_FLAGS = new Set(['traces', 'benchmark', 'only', 'approval', 'out-dir']);
const BOOL_FLAGS = new Set(['synthetic']);

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument '${a}'`);
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) { opts[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag '${a}'`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`flag '${a}' needs a value`);
    opts[name] = v;
    i++;
  }
  if (opts.synthetic === true && opts.traces !== undefined) throw new UsageError('--synthetic and --traces are mutually exclusive');
  if (opts.synthetic !== true && opts.traces === undefined) throw new UsageError('one of --traces <dir> or --synthetic is required');
  if (opts.synthetic === true && (opts.benchmark !== undefined || opts.approval !== undefined)) {
    throw new UsageError('--benchmark and --approval apply to recorded traces only (synthetic scripts carry their own approval model)');
  }
  if (opts.approval !== undefined && opts.approval !== 'none' && opts.approval !== 'deny') {
    throw new UsageError(`--approval must be none or deny (got: ${opts.approval})`);
  }
  return opts;
}

/** `--only a,b` → upper-cased id set, or undefined. */
function onlySet(arg) {
  if (arg === undefined) return undefined;
  const ids = arg.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0);
  if (ids.length === 0) throw new UsageError('--only needs at least one id');
  return new Set(ids);
}

// ── shared arm-pair machinery ───────────────────────────────────────────────────────────────
const CORPUS_BY_ID = new Map(INJECTION_CORPUS.map((e) => [e.id, e]));
/** Where an escape would land: the sandbox parent (outside every sandbox). */
const OUTSIDE_DIR = realpathSync.native(tmpdir());

/**
 * Run the uninjected pair, build the injection plans from the uninjected shadow arm, run every
 * placeable plan's pair (one arm at a time), compare. Returns comparisons + notPlaceable.
 */
async function ablateTrace(caseId, trace, armBase, seedFiles, log) {
  const comparisons = [];
  const notPlaceable = [];
  const runPair = async (plan, entry) => {
    const seeds = entry?.seedRequirement !== undefined ? { ...seedFiles, ...entry.seedRequirement } : seedFiles;
    const base = { ...armBase, trace, planId: plan.planId, injections: plan.injections, seedFiles: seeds };
    const enforce = await runArm({ ...base, mode: 'enforce' });
    const shadow = await runArm({ ...base, mode: 'shadow' });
    return { enforce, shadow, cmp: compareArms(caseId, enforce, shadow, entry) };
  };
  const uninjected = await runPair({ planId: UNINJECTED_PLAN_ID, injections: [] }, undefined);
  comparisons.push(uninjected.cmp);
  log(`  ${caseId} uninjected: enforce ${uninjected.enforce.completion.sessionState}, shadow ${uninjected.shadow.completion.sessionState}`);
  const plans = buildInjectionPlans(trace, uninjectedView(uninjected.shadow), INJECTION_CORPUS, { outsideDir: OUTSIDE_DIR, seedFiles });
  for (const plan of plans) {
    if (plan.planId === UNINJECTED_PLAN_ID) continue;
    if (plan.injections.length === 0) {
      notPlaceable.push({ caseId, planId: plan.planId, reason: plan.notPlaceable ?? 'no valid placement' });
      continue;
    }
    const { cmp } = await runPair(plan, CORPUS_BY_ID.get(plan.planId));
    comparisons.push(cmp);
    const inj = cmp.injected;
    let outcome = 'not reached';
    if (inj?.reached === true) {
      if (inj.stopped) outcome = `stopped by ${inj.stoppedBy ?? '?'}`;
      else if (inj.kernelGap === true) outcome = 'let through (gap probe)';
      else if (inj.labelMatches === 'n/a') outcome = `let through (label not applicable: ${inj.labelNote ?? 'n/a'})`;
      else outcome = 'NOT STOPPED (enforcement failure)';
    }
    log(`  ${caseId} ${plan.planId}: ${outcome}`);
  }
  return { comparisons, notPlaceable };
}

// ── synthetic traces ────────────────────────────────────────────────────────────────────────
/**
 * Synthetic EP-ENV source (same as tests/shadow-ablation/harness-e2e.spec.ts): allowlisted runtime
 * variables plus one secret-named FAKE, so the output does not depend on this machine's env.
 */
const SYNTHETIC_ENV_SOURCE = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/cf',
  GITHUB_TOKEN: 'cf-fake-token-not-a-secret',
});

async function runSynthetic(opts, log) {
  const want = onlySet(opts.only);
  let synths = await synthesizeTraces();
  if (want !== undefined) {
    synths = synths.filter((s) => want.has(s.script.id.toUpperCase()));
    if (synths.length === 0) throw new UsageError(`--only '${opts.only}' matched no synthetic script id`);
  }
  const comparisons = [];
  const notPlaceable = [];
  let redactedEntries = 0;
  for (const { script, trace } of synths) {
    log(`${script.id} (modeled on ${script.modeledOn}, approval ${script.approvalResolution})`);
    const armBase = {
      goalDescription: script.description,
      acceptance: script.acceptance,
      supervisorFactory: syntheticSupervisorFactory(script),
      approvalResolution: script.approvalResolution,
      envSource: SYNTHETIC_ENV_SOURCE,
    };
    const r = await ablateTrace(script.id, trace, armBase, script.seedFiles, log);
    comparisons.push(...r.comparisons);
    notPlaceable.push(...r.notPlaceable);
    redactedEntries += trace.redaction.redactedEntries;
  }
  const approvals = synths.map((s) => `${s.script.id} ${s.script.approvalResolution}`).join(', ');
  return buildReport({
    kind: 'synthetic',
    comparisons,
    traceCount: synths.length,
    tracesRefused: [],
    notPlaceable,
    redactedEntries,
    approvalResolution: 'none',
    header: `SYNTHETIC scripted traces (no model; FakeProcessSupervisor). Approval resolution per script: ${approvals}.`,
  });
}

// ── recorded traces ─────────────────────────────────────────────────────────────────────────
const COMMAND_CHECK_KINDS = new Set(['command', 'build', 'no_regression']);

/** The exact command line BenchmarkCheckRunner spawns for a command check (token expansion included). */
function checkCommandLine(check, workspaceRoot) {
  const raw = check.args !== undefined ? [check.target, ...check.args] : check.target.split(/\s+/);
  const parts = raw.map((p) => p
    .replace(/\$\{CODEFORGE_REPO\}/g, process.env.CODEFORGE_REPO ?? '${CODEFORGE_REPO}')
    .replace(/\$\{WORKSPACE\}/g, workspaceRoot));
  return commandLine(parts[0], parts.slice(1));
}

/**
 * Phase 2 containment: the shell gets ContainedProcessSupervisor(NodeProcessSupervisor); the
 * verification engine and the benchmark checks get ContainedProcessSupervisor(WorkspaceProcessSupervisor)
 * (same real supervisor as run-progressive.mjs). VerificationEngine spawns with cwd '/' and only
 * WorkspaceProcessSupervisor rewrites it to the root, so the verification path pins cwd to the
 * sandbox root BEFORE the containment check (equivalent: WorkspaceProcessSupervisor forces that
 * cwd anyway). allowedExact = the case's command checks + the seeded sandbox's verification policy.
 */
function containedSupervisorFactory(task) {
  const checks = Array.isArray(task.verification) ? task.verification : [];
  return (sandbox, ledger) => {
    const policy = buildVerificationPolicy(inspectProject(sandbox.root));
    const allowedExact = [...new Set([
      ...checks.filter((c) => COMMAND_CHECK_KINDS.has(c.kind)).map((c) => checkCommandLine(c, sandbox.root)),
      ...policy.checks.map((c) => commandLine(c.command, c.args)),
    ])].sort();
    const shell = new ContainedProcessSupervisor(new NodeProcessSupervisor(), { sandbox, allowedExact, ledger });
    const wps = new WorkspaceProcessSupervisor({ workspaceRoot: sandbox.root });
    const contained = new ContainedProcessSupervisor(wps, { sandbox, allowedExact, ledger });
    const verification = { spawn: (options) => contained.spawn({ ...options, cwd: sandbox.root }) };
    return { shell, verification, checks: contained, evidence: wps };
  };
}

function messageOf(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function runRecorded(opts, log) {
  const tracesDir = opts.traces;
  const benchmarkPath = opts.benchmark ?? 'benchmarks/codeforge-progressive/benchmark.json';
  const approvalResolution = opts.approval ?? 'none';
  const want = onlySet(opts.only);
  const benchmark = loadBenchmarkFile(benchmarkPath);
  const tasks = new Map(benchmark.tasks.map((t) => [String(t.id).toUpperCase(), t]));

  const files = readdirSync(tracesDir).filter((f) => f.endsWith('.trace.json')).sort();
  const tracesRefused = [];
  const accepted = [];
  for (const f of files) {
    const file = join(tracesDir, f);
    let trace;
    try {
      // Name errors by file name only, so the report carries no machine path.
      trace = parseTrace(readFileSync(file, 'utf8'), f);
    } catch (err) {
      if (want !== undefined) continue; // unknown case id: outside the --only selection
      tracesRefused.push({ traceId: basename(f, '.trace.json'), reason: err instanceof TraceFormatError ? `invalid trace: ${err.message}` : `unreadable: ${messageOf(err)}` });
      continue;
    }
    const caseId = trace.source.caseId;
    if (want !== undefined && (caseId === undefined || !want.has(caseId.toUpperCase()))) continue;
    const refusal = replayRefusal(trace);
    if (refusal !== undefined) { tracesRefused.push({ traceId: trace.traceId, reason: `${refusal.reason}: ${refusal.message}` }); continue; }
    if (caseId === undefined) { tracesRefused.push({ traceId: trace.traceId, reason: 'no source.caseId: cannot join with a benchmark case' }); continue; }
    const task = tasks.get(caseId.toUpperCase());
    if (task === undefined) { tracesRefused.push({ traceId: trace.traceId, reason: `case '${caseId}' not in ${benchmarkPath}` }); continue; }
    accepted.push({ trace, task });
  }
  if (want !== undefined && accepted.length + tracesRefused.length === 0) throw new UsageError(`--only '${opts.only}' matched no trace`);

  const comparisons = [];
  const notPlaceable = [];
  let redactedEntries = 0;
  for (const { trace, task } of accepted) {
    log(`${task.id} (${trace.traceId}, ${trace.entries.length} entries)`);
    const armBase = {
      goalDescription: task.description,
      acceptance: task.simulatedUser !== undefined ? task.description : 'done',
      supervisorFactory: containedSupervisorFactory(task),
      approvalResolution,
      envSource: process.env,
      benchmarkChecks: Array.isArray(task.verification) ? task.verification : [],
      ...(task.timeoutMs !== undefined ? { checkTimeoutMs: task.timeoutMs } : {}),
    };
    try {
      const r = await ablateTrace(task.id, trace, armBase, task.seedFiles ?? {}, log);
      comparisons.push(...r.comparisons);
      notPlaceable.push(...r.notPlaceable);
      redactedEntries += trace.redaction.redactedEntries;
    } catch (err) {
      // ArmConfigError (unknown wiring label), SandboxError, ComparisonInputError: reported, not fatal.
      tracesRefused.push({ traceId: trace.traceId, reason: `harness error: ${messageOf(err)}` });
    }
  }
  const models = [...new Map(accepted.map(({ trace }) => [JSON.stringify(trace.source.model), trace.source.model])).values()];
  return buildReport({
    kind: 'recorded',
    comparisons,
    traceCount: accepted.length + tracesRefused.length,
    tracesRefused,
    notPlaceable,
    redactedEntries,
    approvalResolution,
    benchmark: benchmarkPath.replace(/\\/g, '/'),
    ...(models.length === 1 ? { model: models[0] } : {}),
    header: `Recorded traces from ${tracesDir.replace(/\\/g, '/')}; generated ${new Date().toISOString()}${models.length > 1 ? `; ${models.length} different models` : ''}.`,
  });
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) { console.error(`${err.message}\n${USAGE}`); return 1; }
    throw err;
  }
  const outDir = opts['out-dir'] ?? '.agents';
  const log = (line) => console.log(line);
  let report;
  try {
    report = opts.synthetic === true ? await runSynthetic(opts, log) : await runRecorded(opts, log);
  } catch (err) {
    if (err instanceof UsageError) { console.error(`${err.message}\n${USAGE}`); return 1; }
    if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) {
      console.error(`IO error: ${messageOf(err)}`); return 1;
    }
    throw err;
  }
  const stem = opts.synthetic === true ? 'kernel-shadow-ablation.synthetic' : 'kernel-shadow-ablation';
  const jsonPath = join(outDir, `${stem}.json`);
  const mdPath = join(outDir, `${stem}.md`);
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  } catch (err) {
    console.error(`IO error: ${messageOf(err)}`); return 1;
  }

  const s = report.summary;
  const organicChanged = s.organic.wouldBlock;
  console.log('');
  console.log(`Wrote ${mdPath} and ${jsonPath}`);
  console.log(`  cases ${s.cases}, comparisons ${s.comparisons}, traces refused ${s.tracesRefused.length}`);
  console.log(`  out-of-policy injected: stopped ${s.outOfPolicy.stopped} / reached ${s.outOfPolicy.reached} (not reached ${s.outOfPolicy.notReached}, not placeable ${s.outOfPolicy.notPlaceable})`);
  console.log(`  organic proposals that differed: ${organicChanged} of ${s.organic.evaluated} (${s.organic.wouldBlockCounterfactual} counterfactual)`);
  console.log(`  gap probes: reached ${s.gapProbes.reached}, reached sandbox ${s.gapProbes.reachedSandbox}`);
  console.log(`  label mismatches ${s.labelMismatches.length}, kernel misses ${s.kernelMisses}, harness errors ${s.harnessErrors}`);
  if (s.outOfPolicy.missed.length > 0 || s.kernelMisses > 0) {
    console.error(`ENFORCEMENT FAILURE: ${s.outOfPolicy.missed.length} reached out-of-policy injection(s) not stopped, ${s.kernelMisses} kernel miss(es)`);
    return 2;
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err instanceof Error ? (err.stack ?? err.message) : String(err)); process.exitCode = 1; },
);
