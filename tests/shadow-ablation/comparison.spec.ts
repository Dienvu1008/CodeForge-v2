/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation — comparison (C13) and report (C14), Properties 8, 9, 10 and 15.
//
// Property 8 is arm-level: generated BENIGN scripts (plan JSON + in-sandbox write_file /
// read_file / edit_file / list_dir + allowlisted `run_command node test.js` + done, ≤ 8 steps) are
// recorded through the enforce wiring with `synthesizeTrace`, then replayed in an enforce arm and
// a shadow arm with scripted FakeProcessSupervisors (`syntheticSupervisorFactory`); nothing would
// be blocked, so the two arms must be indistinguishable. Properties 9, 10 and 15 are pure: they
// run `findDivergence` / `compareArms` / `buildReport` / `renderMarkdown` on hand-built `ArmResult`
// fixtures with generated ledgers, served steps, mismatches, drift, secrets and table-hostile text.
// Examples: the four comparison parts, the zero-organic interpretation sentence, the ENFORCEMENT
// FAILURE banner for a synthetic missed stop, and the `not reached` row with its stopping step.
//
// Requirements 5.8, 8.7, 9.1, 9.2, 9.3, 9.4, 10.1, 10.3, 10.5, 10.6, 10.7, 10.8, 10.9.
import { describe, it, expect } from 'vitest';
import type { ModelPurpose } from '@codeforge/agent-core';
import { REDACTION_RULES } from '@codeforge/infrastructure';
import {
  ARGS_PREVIEW_MAX,
  ENFORCEMENT_FAILURE_BANNER,
  ENFORCEMENT_POINT_ORDER,
  INJECTION_CORPUS,
  UNINJECTED_PLAN_ID,
  NO_OPEN_GAP_PROBE_SENTENCE,
  ZERO_ORGANIC_SENTENCE,
  buildReport,
  compareArms,
  findDivergence,
  parseReportJson,
  renderMarkdown,
  runArm,
  synthesizeTrace,
  syntheticSupervisorFactory,
  type ArmCompletion,
  type ArmResult,
  type CaseComparison,
  type ContainmentEvent,
  type EnforcementPointId,
  type ExecutedAction,
  type GuardEvent,
  type InjectionEntry,
  type KernelDecision,
  type LedgerEntry,
  type ReplayStatus,
  type ReportJsonV1,
  type ServedStep,
  type SyntheticScript,
} from '@codeforge/testing/shadow-ablation';

// ── seeded PRNG (same mulberry32 generators as tests/mission/clarification-generators.ts; kept
// local because tests/tsconfig.json does not include tests/mission/**) ─────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function bool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}
function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}
/** Run `body` `runs` times; on failure re-throw with iteration + seed (reproducible counterexample). */
function forAll(seed: number, runs: number, body: (rng: Rng, iteration: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}
/** Async twin of `forAll`: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(
  seed: number,
  runs: number,
  body: (rng: Rng, iteration: number) => Promise<void>,
): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

const ALNUM = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
const HEX = [...'0123456789abcdef'];

function genChars(rng: Rng, alphabet: readonly string[], min: number, max: number): string {
  const len = int(rng, min, max);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, alphabet);
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

// ── Property 8: arm-level benign traces ─────────────────────────────────────────────────────

const PACKAGE_JSON = '{"name":"pg","private":true,"scripts":{"test":"node test.js"}}\n';

function planJson(description: string): string {
  return JSON.stringify({ tasks: [{ id: 'T1', description, strategy: 'generate' }], edges: [], reason: 'generated benign script' });
}
function toolCall(toolName: string, args: Readonly<Record<string, unknown>>, reasoning: string): string {
  return JSON.stringify({ type: 'tool_call', toolName, arguments: args, reasoning });
}

/**
 * A benign script: every proposal stays in the sandbox and is allowed by every enforcement point
 * under `full` autonomy. The first tool call is a write (so the P12.11 premature-done challenge
 * never fires) and the goal names no path (so P12.13 never fires). ≤ 8 served steps in total:
 * plan + 1..6 tool calls + done.
 */
function genBenignScript(rng: Rng, iteration: number): SyntheticScript {
  const files = new Map<string, string>([['src/base.js', 'module.exports = { value: 1000 };\n']]);
  let counter = 0;
  const freshValue = (): number => iteration * 1000 + ++counter;
  const responses: string[] = [planJson('Add generated helper modules and keep the tests green')];
  const toolCount = int(rng, 1, 6);
  for (let j = 0; j < toolCount; j++) {
    const kind = j === 0 ? 'write' : pick(rng, ['write', 'overwrite', 'read', 'edit', 'list', 'run'] as const);
    const existing = [...files.keys()];
    if (kind === 'write' || (kind === 'overwrite' && existing.length === 0)) {
      const path = `src/gen_${iteration}_${j}.js`;
      const content = `// generated ${iteration}/${j}\nmodule.exports = { value: ${freshValue()} };\n`;
      files.set(path, content);
      responses.push(toolCall('write_file', { path, content }, 'add a helper module'));
    } else if (kind === 'overwrite') {
      const path = pick(rng, existing);
      const content = `// rewritten ${iteration}/${j}\nmodule.exports = { value: ${freshValue()} };\n`;
      files.set(path, content);
      responses.push(toolCall('write_file', { path, content }, 'rewrite a helper module'));
    } else if (kind === 'read') {
      responses.push(toolCall('read_file', { path: pick(rng, existing) }, 'inspect a module'));
    } else if (kind === 'edit') {
      const path = pick(rng, existing);
      const content = files.get(path) ?? '';
      const m = /value: (\d+)/.exec(content);
      const oldString = m?.[0] ?? 'value: 0';
      const newString = `value: ${freshValue()}`;
      files.set(path, content.replace(oldString, newString));
      responses.push(toolCall('edit_file', { path, oldString, newString }, 'bump a value'));
    } else if (kind === 'list') {
      responses.push(toolCall('list_dir', { path: pick(rng, ['src', '.']) }, 'look around'));
    } else {
      responses.push(toolCall('run_command', { command: 'node', args: ['test.js'] }, 'run the tests'));
    }
  }
  responses.push(JSON.stringify({ type: 'done', summary: `Generated ${toolCount} benign step(s).` }));
  return {
    id: `GEN-${iteration}`,
    modeledOn: 'PG-12',
    description: 'Add generated helper modules and keep the tests green.',
    acceptance: 'done',
    seedFiles: {
      'package.json': PACKAGE_JSON,
      'test.js': "console.log('ok');\n",
      'src/base.js': 'module.exports = { value: 1000 };\n',
    },
    responses,
    processRules: [
      { command: /^node$/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
      { command: /^npm/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
    ],
    autonomy: 'full',
    maxToolCalls: 12,
    recovery: 'full',
    approvalResolution: 'none',
  };
}

/**
 * 50 iterations, each = one recording run + two replay arms (~0.2 s per iteration locally, so
 * ~10 s): fewer than the pure properties' ≥100 to keep headroom under the 60 s per-test budget on
 * slower machines and in the parallel full suite.
 */
const ARM_LEVEL_RUNS = 50;

describe('Property 8 (arm-level, generated benign traces)', () => {
  // Feature: kernel-shadow-ablation, Property 8: Shadow is transparent when nothing would be blocked
  it(
    'enforce and shadow arms are identical on benign traces: no wouldBlock, same decisions, actions, completion and workspace, no divergence',
    async () => {
      await forAllAsync(0x5a0008, ARM_LEVEL_RUNS, async (rng, i) => {
        const script = genBenignScript(rng, i);
        const { trace } = await synthesizeTrace(script);
        expect(trace.entries.length).toBeLessThanOrEqual(8);
        const common = {
          trace,
          seedFiles: script.seedFiles,
          goalDescription: script.description,
          acceptance: script.acceptance,
          supervisorFactory: syntheticSupervisorFactory(script),
          approvalResolution: script.approvalResolution,
        } as const;
        const e = await runArm({ mode: 'enforce', ...common });
        const s = await runArm({ mode: 'shadow', ...common });

        // Sanity: the script really is benign and fully replayed.
        expect(e.harnessError).toBeUndefined();
        expect(s.harnessError).toBeUndefined();
        expect(e.completion.doneAccepted).toBe(true);
        for (const arm of [e, s]) {
          expect(arm.replay.served).toBe(arm.replay.total);
          expect(arm.replay.mismatch).toBeUndefined();
          expect(arm.ledger.entries.some((x) => x.effective === 'block')).toBe(false);
        }

        // Zero wouldBlock in the shadow arm.
        expect(s.ledger.entries.filter((x) => x.wouldBlock)).toEqual([]);
        // Identical per-step decisions, executed actions, guards, containment.
        expect(s.ledger.entries).toEqual(e.ledger.entries);
        expect(s.ledger.executed).toEqual(e.ledger.executed);
        expect(s.ledger.guards).toEqual(e.ledger.guards);
        expect(s.ledger.containment).toEqual(e.ledger.containment);
        expect(s.replay.steps).toEqual(e.replay.steps);
        // Identical completion and workspace.
        expect(s.completion).toEqual(e.completion);
        expect(s.workspace.hash).toBe(e.workspace.hash);
        expect(s.workspace.files).toEqual(e.workspace.files);

        // No divergence, nothing counterfactual, nothing only in one arm.
        expect(findDivergence(e, s)).toBeUndefined();
        const c = compareArms(script.id, e, s);
        expect(c.divergence).toBeUndefined();
        expect(c.proposals.length).toBeGreaterThan(0);
        for (const row of c.proposals) {
          expect(row.agree).toBe(true);
          expect(row.counterfactual).toBe(false);
          expect(row.shadow?.wouldBlock).toBe(false);
          expect(row.executedShadow).toBe(row.executedEnforce);
        }
        expect(c.executed.onlyShadow).toEqual([]);
        expect(c.executed.onlyEnforce).toEqual([]);
        expect(c.workspace.identical).toBe(true);
        expect([...c.workspace.added, ...c.workspace.removed, ...c.workspace.modified]).toEqual([]);
        expect(c.injected).toBeUndefined();
      });
    },
    60_000,
  );
});

// ── Hand-built ArmResult fixtures ───────────────────────────────────────────────────────────

const COMPLETION: ArmCompletion = {
  sessionState: 'COMPLETED',
  runFinalStates: ['SUCCEEDED'],
  doneProposed: 1,
  doneAccepted: true,
  doneRejectedBy: [],
  verificationStatus: 'PASS',
  taskPassed: true,
};

interface ArmSpec {
  readonly mode: 'enforce' | 'shadow';
  readonly planId?: string;
  readonly traceId?: string;
  readonly steps: readonly ServedStep[];
  readonly entries?: readonly LedgerEntry[];
  readonly executed?: readonly ExecutedAction[];
  readonly containment?: readonly ContainmentEvent[];
  readonly guards?: readonly GuardEvent[];
  readonly mismatch?: ReplayStatus['mismatch'];
  readonly drift?: ReplayStatus['drift'];
  readonly completion?: ArmCompletion;
  readonly files?: Readonly<Record<string, string>>;
  readonly hash?: string;
  readonly harnessError?: string;
}

function makeArm(spec: ArmSpec): ArmResult {
  const guards = [...(spec.guards ?? [])];
  const organic = spec.steps.filter((x) => x.source === 'organic').length;
  return {
    mode: spec.mode,
    planId: spec.planId ?? UNINJECTED_PLAN_ID,
    traceId: spec.traceId ?? 'trace:T',
    ledger: {
      entries: [...(spec.entries ?? [])],
      executed: [...(spec.executed ?? [])],
      containment: [...(spec.containment ?? [])],
      guards,
    },
    replay: {
      served: organic,
      total: organic,
      exhausted: false,
      ...(spec.mismatch !== undefined ? { mismatch: spec.mismatch } : {}),
      drift: [...(spec.drift ?? [])],
      steps: [...spec.steps],
    },
    completion: spec.completion ?? COMPLETION,
    workspace: { hash: spec.hash ?? 'H-same', files: spec.files ?? { 'src/a.js': 'sha-a' } },
    guards,
    inactive: ['EP-SCHEMA', 'IDEMPOTENCY'],
    notes: [],
    ...(spec.harnessError !== undefined ? { harnessError: { code: 'HARNESS_ERROR', message: spec.harnessError } } : {}),
  };
}

/** Served steps: index 0 is the plan; `injectAt` (if any) is an injected execute step. */
function servedSteps(n: number, injectAt?: number, corpusId?: string): ServedStep[] {
  const out: ServedStep[] = [];
  let seq = 0;
  for (let k = 0; k < n; k++) {
    if (k === injectAt) {
      out.push({ servedIndex: k, source: 'injected', corpusId: corpusId ?? 'INJ-?', purpose: 'execute' });
    } else {
      const purpose: ModelPurpose = k === 0 ? 'plan' : 'execute';
      out.push({ servedIndex: k, source: 'organic', seq: seq++, purpose });
    }
  }
  return out;
}

function entry(
  step: number,
  point: EnforcementPointId,
  decision: KernelDecision,
  effective: LedgerEntry['effective'],
  wouldBlock: boolean,
  extra: Partial<Pick<LedgerEntry, 'tool' | 'argsPreview' | 'reason' | 'source' | 'corpusId'>> = {},
): LedgerEntry {
  return {
    step,
    source: extra.source ?? 'organic',
    ...(extra.corpusId !== undefined ? { corpusId: extra.corpusId } : {}),
    tool: extra.tool ?? 'write_file',
    argsPreview: extra.argsPreview ?? '{"path":"src/a.js"}',
    point,
    decision,
    reason: extra.reason ?? (decision === 'allow' ? 'allowed' : `${point} says ${decision}`),
    effective,
    wouldBlock,
  };
}

function action(step: number, extra: Partial<ExecutedAction> = {}): ExecutedAction {
  return {
    step,
    tool: extra.tool ?? 'write_file',
    argsPreview: extra.argsPreview ?? '{"path":"src/a.js"}',
    outcome: extra.outcome ?? 'SUCCEEDED',
    effect: extra.effect ?? 'sandbox',
    touched: extra.touched ?? ['src/a.js'],
  };
}

// ── Generators for the pure properties ──────────────────────────────────────────────────────

const TOOLS = ['write_file', 'read_file', 'edit_file', 'delete_file', 'run_command', 'list_dir', 'done'] as const;
const DECISIONS: readonly KernelDecision[] = ['allow', 'require_approval', 'block', 'filter'];
const NON_ALLOW_POINTS: readonly EnforcementPointId[] = ENFORCEMENT_POINT_ORDER.filter((p) => p !== 'EP-ENV' && p !== 'EP-SCHEMA');

interface GeneratedSecret {
  readonly text: string;
  /** Fragments (≥ 12 chars) that must not survive redaction. */
  readonly parts: readonly string[];
}

const URLSAFE = [...ALNUM, '_', '-'];
const TOKEN_CHARS = [...ALNUM, '.', '_', '-'];
const B64 = [...ALNUM, '+', '/'];
const UPPER_DIGIT = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

/** One generator per REDACTION_RULES shape (same shapes as trace-format.spec.ts). */
const SECRET_SHAPES: Readonly<Record<string, (rng: Rng) => GeneratedSecret>> = {
  jwt: (rng) => {
    const a = genChars(rng, URLSAFE, 12, 40);
    const b = genChars(rng, URLSAFE, 12, 40);
    const c = genChars(rng, URLSAFE, 12, 40);
    const text = `eyJ${a}.eyJ${b}.${c}`;
    return { text, parts: [text, a, b, c] };
  },
  bearer: (rng) => {
    const tok = genChars(rng, TOKEN_CHARS, 16, 48);
    return { text: `Authorization: Bearer ${tok}`, parts: [tok] };
  },
  'private-key': (rng) => {
    const type = pick(rng, ['RSA ', 'EC ', 'OPENSSH ']);
    const lines = Array.from({ length: int(rng, 1, 3) }, () => genChars(rng, B64, 16, 64));
    const text = `-----BEGIN ${type}PRIVATE KEY-----\n${lines.join('\n')}\n-----END ${type}PRIVATE KEY-----`;
    return { text, parts: lines };
  },
  'aws-access-key': (rng) => {
    const tail = genChars(rng, UPPER_DIGIT, 16, 16);
    return { text: `AKIA${tail}`, parts: [`AKIA${tail}`, tail] };
  },
  'generic-secret': (rng) => {
    const key = pick(rng, ['password', 'secret', 'token', 'api_key', 'API_KEY']);
    const value = genChars(rng, ALNUM, 16, 32);
    return { text: `${key}=${value}`, parts: [value] };
  },
  'connection-string': (rng) => {
    const scheme = pick(rng, ['postgres', 'mysql', 'mongodb', 'redis']);
    const user = genChars(rng, ALNUM, 4, 10);
    const pass = genChars(rng, ALNUM, 12, 24);
    const host = `${genChars(rng, ALNUM, 12, 20)}.example`;
    const rest = `${user}:${pass}@${host}:${int(rng, 1000, 9999)}/db`;
    return { text: `${scheme}://${rest}`, parts: [rest, pass, host] };
  },
};

/** Collects the secrets and markers generated for one iteration. */
class Forbidden {
  readonly fragments: string[] = [];

  secret(rng: Rng): string {
    const rule = pick(rng, REDACTION_RULES);
    const s = (SECRET_SHAPES[rule.name] as (r: Rng) => GeneratedSecret)(rng);
    this.fragments.push(...s.parts);
    return s.text;
  }

  /** A unique marker placed after ≥ 210 non-secret characters, so the 200-char clip removes it. */
  tailMarker(rng: Rng): string {
    const marker = `MARKER${genChars(rng, HEX, 32, 32)}`;
    this.fragments.push(marker);
    return `${'lorem ipsum '.repeat(18)}${marker}`;
  }
}

/** Data text: filler words, optionally a secret, `|` / newline / backslash, a long tail marker. */
function genData(rng: Rng, f: Forbidden): string {
  const words = Array.from({ length: int(rng, 0, 5) }, () => pick(rng, ['alpha', 'src/a.js', '{"x":1}', 'ok', 'a|b', 'line\nbreak', 'back\\slash', '<b>']));
  if (bool(rng, 0.5)) words.splice(int(rng, 0, words.length), 0, f.secret(rng));
  let text = words.join(' ');
  if (bool(rng, 0.3)) text = `${text} ${f.tailMarker(rng)}`;
  return text;
}

/** Shadow-arm view of an enforce decision at an enforcement point. */
function shadowOf(e: LedgerEntry): LedgerEntry {
  if (e.effective === 'block') return { ...e, effective: 'allow', wouldBlock: true };
  return { ...e };
}

function genEnforceEntries(rng: Rng, step: number, f: Forbidden, source: 'organic' | 'injected', corpusId?: string): LedgerEntry[] {
  const n = int(rng, 0, 3);
  const tool = pick(rng, TOOLS);
  const argsPreview = genData(rng, f);
  const out: LedgerEntry[] = [];
  for (let j = 0; j < n; j++) {
    const decision = pick(rng, DECISIONS);
    const point = decision === 'filter' ? 'EP-ENV' : pick(rng, NON_ALLOW_POINTS);
    const effective: LedgerEntry['effective'] =
      decision === 'allow' ? 'allow' : decision === 'filter' ? 'filter' : decision === 'block' ? 'block' : pick(rng, ['allow', 'block'] as const);
    out.push(entry(step, point, decision, effective, false, {
      tool, argsPreview, reason: genData(rng, f), source, ...(corpusId !== undefined ? { corpusId } : {}),
    }));
  }
  return out;
}

function genActions(rng: Rng, step: number, f: Forbidden): ExecutedAction[] {
  if (!bool(rng, 0.5)) return [];
  return [action(step, {
    tool: pick(rng, TOOLS),
    argsPreview: genData(rng, f),
    effect: pick(rng, ['sandbox', 'simulated', 'none'] as const),
    outcome: pick(rng, ['SUCCEEDED', 'FAILED', 'TIMEOUT'] as const),
    touched: bool(rng) ? [pick(rng, ['src/a.js', 'src/b.js', '../out.txt'])] : [],
  })];
}

function genContainment(rng: Rng, step: number, f: Forbidden): ContainmentEvent[] {
  if (!bool(rng, 0.25)) return [];
  const kind = pick(rng, ['escape-simulated', 'command-simulated', 'kernelMiss'] as const);
  return [{
    step,
    kind,
    op: pick(rng, ['write', 'read', 'delete', 'spawn']),
    target: genData(rng, f),
    ...(bool(rng) ? { sha256: genChars(rng, HEX, 64, 64) } : {}),
  }];
}

function genCompletion(rng: Rng, f: Forbidden): ArmCompletion {
  return {
    sessionState: pick(rng, ['COMPLETED', 'ABORTED', 'AWAITING_HUMAN', 'HARNESS_ERROR'] as const),
    runFinalStates: Array.from({ length: int(rng, 0, 2) }, () => pick(rng, ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'SUSPENDED'] as const)),
    doneProposed: int(rng, 0, 3),
    doneAccepted: bool(rng),
    doneRejectedBy: bool(rng, 0.3) ? [`EP-COMPLETION:${genData(rng, f)}`] : [],
    ...(bool(rng) ? { verificationStatus: pick(rng, ['PASS', 'FAIL', 'ERROR']) } : {}),
    taskPassed: bool(rng),
  };
}

interface GeneratedPair {
  readonly caseId: string;
  readonly e: ArmResult;
  readonly s: ArmResult;
  readonly entry?: InjectionEntry;
}

/**
 * A random comparable pair: shared served prefix, possibly an injected step, random ledgers
 * (the shadow arm copies the enforce decisions with blocks turned into wouldBlock, or makes up
 * its own), random executed actions / containment / guards, optional mismatch and drift.
 */
function genPair(rng: Rng, f: Forbidden, caseId: string): GeneratedPair {
  const n = int(rng, 1, 8);
  const corpusEntry = bool(rng, 0.4) ? pick(rng, INJECTION_CORPUS) : undefined;
  const injectAt = corpusEntry !== undefined && n > 1 ? int(rng, 1, n - 1) : undefined;
  const all = servedSteps(n, injectAt, corpusEntry?.id);
  const eLen = bool(rng, 0.3) ? int(rng, 1, n) : n;
  const sLen = bool(rng, 0.2) ? int(rng, 1, n) : n;
  const eSteps = all.slice(0, eLen);
  const sSteps = all.slice(0, sLen);
  const eEntries: LedgerEntry[] = [];
  const sEntries: LedgerEntry[] = [];
  const eExec: ExecutedAction[] = [];
  const sExec: ExecutedAction[] = [];
  const eCont: ContainmentEvent[] = [];
  const sCont: ContainmentEvent[] = [];
  const eGuards: GuardEvent[] = [];
  const sGuards: GuardEvent[] = [];
  for (let k = 1; k < n; k++) {
    const st = all[k] as ServedStep;
    const src = st.source;
    const cid = st.corpusId;
    const en = genEnforceEntries(rng, k, f, src, cid);
    const sh = bool(rng, 0.7) ? en.map(shadowOf) : genEnforceEntries(rng, k, f, src, cid).map(shadowOf);
    const ex = genActions(rng, k, f);
    const sx = bool(rng, 0.7) ? ex.map((a) => ({ ...a })) : genActions(rng, k, f);
    if (k < eLen) {
      eEntries.push(...en);
      eExec.push(...ex);
      eCont.push(...genContainment(rng, k, f));
      if (bool(rng, 0.1)) eGuards.push({ step: k, guard: pick(rng, ['P12.11', 'P12.13'] as const) });
    }
    if (k < sLen) {
      sEntries.push(...sh);
      sExec.push(...sx);
      sCont.push(...genContainment(rng, k, f));
      if (bool(rng, 0.1)) sGuards.push({ step: k, guard: pick(rng, ['P12.11', 'P12.13'] as const) });
    }
  }
  const planId = corpusEntry?.id ?? UNINJECTED_PLAN_ID;
  const mismatch = (): ReplayStatus['mismatch'] =>
    bool(rng, 0.2) ? { seq: int(rng, 0, 8), expected: 'execute', received: pick(rng, ['plan', 'replan', 'critique'] as const) } : undefined;
  const drift = (): ReplayStatus['drift'] =>
    Array.from({ length: int(rng, 0, 2) }, () => ({ seq: int(rng, 0, 8), field: pick(rng, ['promptSha256', 'contextSnapshotId'] as const) }));
  const files = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of ['src/a.js', 'src/b.js', 'src/c.js']) if (bool(rng, 0.7)) out[p] = pick(rng, ['sha-1', 'sha-2']);
    return out;
  };
  const em = mismatch();
  const sm = mismatch();
  const e = makeArm({
    mode: 'enforce', planId, steps: eSteps, entries: eEntries, executed: eExec, containment: eCont, guards: eGuards,
    ...(em !== undefined ? { mismatch: em } : {}), drift: drift(), completion: genCompletion(rng, f), files: files(),
    hash: pick(rng, ['H1', 'H2']), ...(bool(rng, 0.1) ? { harnessError: genData(rng, f) } : {}),
  });
  const s = makeArm({
    mode: 'shadow', planId, steps: sSteps, entries: sEntries, executed: sExec, containment: sCont, guards: sGuards,
    ...(sm !== undefined ? { mismatch: sm } : {}), drift: drift(), completion: genCompletion(rng, f), files: files(),
    hash: pick(rng, ['H1', 'H2']), ...(bool(rng, 0.1) ? { harnessError: genData(rng, f) } : {}),
  });
  return { caseId, e, s, ...(corpusEntry !== undefined ? { entry: corpusEntry } : {}) };
}

function withoutDrift(a: ArmResult): ArmResult {
  return { ...a, replay: { ...a.replay, drift: [] } };
}

// ── Property 9 ──────────────────────────────────────────────────────────────────────────────

describe('Property 9 (pure)', () => {
  // Feature: kernel-shadow-ablation, Property 9: Identical prefix before the divergence point
  it('findDivergence returns the first differing step; every row before it agrees and is not counterfactual', () => {
    forAll(0x5a0009, 150, (rng) => {
      const f = new Forbidden();
      const d = int(rng, 1, 6);
      const injected = bool(rng, 0.3);
      const corpusEntry = injected ? pick(rng, INJECTION_CORPUS) : undefined;
      const tailE = int(rng, 0, 3);
      const tailS = int(rng, 0, 3);
      const all = servedSteps(d + 1 + Math.max(tailE, tailS), injected ? d : undefined, corpusEntry?.id);
      const prefixEntries: LedgerEntry[] = [];
      const prefixExec: ExecutedAction[] = [];
      for (let k = 1; k < d; k++) {
        // Identical, non-blocking decisions in both arms (allow, or the EP-ENV filter).
        const n = int(rng, 0, 3);
        for (let j = 0; j < n; j++) {
          prefixEntries.push(bool(rng, 0.8)
            ? entry(k, pick(rng, NON_ALLOW_POINTS), 'allow', 'allow', false)
            : entry(k, 'EP-ENV', 'filter', 'filter', false, { tool: 'run_command' }));
        }
        prefixExec.push(...genActions(rng, k, f));
      }
      // The divergence step: identical allows at earlier points, then enforce block vs shadow wouldBlock.
      const stopPoint = pick(rng, NON_ALLOW_POINTS);
      const src = injected ? 'injected' : 'organic';
      const cid = corpusEntry?.id;
      const before = ENFORCEMENT_POINT_ORDER.slice(0, ENFORCEMENT_POINT_ORDER.indexOf(stopPoint))
        .filter((p) => p !== 'EP-ENV' && bool(rng, 0.4))
        .map((p) => entry(d, p, 'allow', 'allow', false, { source: src, ...(cid !== undefined ? { corpusId: cid } : {}) }));
      const blockE = entry(d, stopPoint, pick(rng, ['block', 'require_approval'] as const), 'block', false, {
        source: src, ...(cid !== undefined ? { corpusId: cid } : {}),
      });
      const blockS: LedgerEntry = { ...blockE, effective: 'allow', wouldBlock: true };
      const suffix = (len: number): { entries: LedgerEntry[]; exec: ExecutedAction[] } => {
        const entries: LedgerEntry[] = [];
        const exec: ExecutedAction[] = [];
        for (let k = d + 1; k <= d + len; k++) {
          entries.push(...genEnforceEntries(rng, k, f, 'organic'));
          exec.push(...genActions(rng, k, f));
        }
        return { entries, exec };
      };
      const sufE = suffix(tailE);
      const sufS = suffix(tailS);
      const planId = corpusEntry?.id ?? UNINJECTED_PLAN_ID;
      const e = makeArm({
        mode: 'enforce', planId, steps: all.slice(0, d + 1 + tailE),
        entries: [...prefixEntries, ...before, blockE, ...sufE.entries],
        executed: [...prefixExec.map((a) => ({ ...a })), ...sufE.exec],
        ...(bool(rng, 0.2) ? { mismatch: { seq: d + tailE, expected: 'execute' as const, received: 'plan' as const } } : {}),
      });
      const s = makeArm({
        mode: 'shadow', planId, steps: all.slice(0, d + 1 + tailS),
        entries: [...prefixEntries.map((x) => ({ ...x })), ...before.map((x) => ({ ...x })), blockS, ...sufS.entries],
        executed: [...prefixExec.map((a) => ({ ...a })), action(d), ...sufS.exec],
      });

      const div = findDivergence(e, s);
      expect(div?.step).toBe(d);
      expect(div?.kind).toBe(injected ? 'injected' : 'decision');
      expect(div?.point).toBe(stopPoint);

      const c = compareArms('C', e, s, corpusEntry);
      expect(c.divergence).toEqual(div);
      for (const row of c.proposals) {
        if (row.step < d) {
          expect(row.agree).toBe(true);
          expect(row.counterfactual).toBe(false);
          expect(row.enforce?.effective).toBe(row.shadow?.effective);
          expect(row.shadow?.wouldBlock).toBe(false);
          expect(row.executedEnforce).toBe(row.executedShadow);
        } else if (row.step === d) {
          expect(row.agree).toBe(false);
          expect(row.counterfactual).toBe(false);
          expect(row.enforce?.effective).toBe('block');
          expect(row.shadow?.wouldBlock).toBe(true);
        } else {
          expect(row.counterfactual).toBe(true);
        }
      }
      // The trajectory diff covers steps ≤ d; the prefix contributes nothing to it.
      expect(c.executed.throughStep).toBe(d);
      for (const a of [...c.executed.onlyShadow, ...c.executed.onlyEnforce]) {
        expect(a.step).toBeGreaterThanOrEqual(d);
        expect(a.step).toBeLessThanOrEqual(d);
      }
      expect(c.executed.wouldHaveReached.actions).toEqual([action(d)]);
    });
  });
});

// ── Property 10 ─────────────────────────────────────────────────────────────────────────────

function firstInjected(a: ArmResult): number | undefined {
  const i = a.replay.steps.findIndex((x) => x.source === 'injected');
  return i < 0 ? undefined : i;
}

describe('Property 10 (pure)', () => {
  // Feature: kernel-shadow-ablation, Property 10: Counterfactual marking is exact
  it('a row is counterfactual iff its step is after the divergence, the first injected step or the first mismatch; drift never sets it', () => {
    forAll(0x5a0010, 200, (rng) => {
      const f = new Forbidden();
      const { caseId, e, s, entry: ce } = genPair(rng, f, 'C');
      const div = findDivergence(e, s);
      const injs = [firstInjected(e), firstInjected(s)].filter((x): x is number => x !== undefined);
      const mms = [e, s].filter((a) => a.replay.mismatch !== undefined).map((a) => a.replay.steps.length);
      const bounds = [div?.step, injs.length > 0 ? Math.min(...injs) : undefined, mms.length > 0 ? Math.min(...mms) : undefined];

      const c = compareArms(caseId, e, s, ce);
      for (const row of c.proposals) {
        const expected = bounds.some((b) => b !== undefined && row.step > b);
        expect(row.counterfactual, `step ${row.step}, bounds ${JSON.stringify(bounds)}`).toBe(expected);
      }
      // Drift never sets the flag: the same pair without drift marks exactly the same rows.
      const c0 = compareArms(caseId, withoutDrift(e), withoutDrift(s), ce);
      expect(c0.proposals.map((r) => [r.step, r.counterfactual])).toEqual(c.proposals.map((r) => [r.step, r.counterfactual]));
      expect(c0.divergence).toEqual(c.divergence);
      expect(c0.counterfactualCut).toEqual(c.counterfactualCut);
    });
  });
});

// ── Property 15 ─────────────────────────────────────────────────────────────────────────────

/** Number of `|` not escaped by an odd run of backslashes. */
function unescapedPipes(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) n++;
  }
  return n;
}

/** Every markdown table: rows are single lines with the header's cell count. */
function assertTablesClean(md: string): void {
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith('| ') || !(lines[i + 1] ?? '').startsWith('| ---')) continue;
    const cols = unescapedPipes(line);
    let j = i + 1;
    for (; j < lines.length && lines[j] !== ''; j++) {
      const row = lines[j] as string;
      expect(row.startsWith('| ') && row.endsWith(' |'), `table row ${j}: ${row}`).toBe(true);
      expect(unescapedPipes(row), `table row ${j}: ${row}`).toBe(cols);
    }
    i = j;
  }
}

interface Recount {
  cases: number; evaluated: number; wouldBlock: number; wbCf: number;
  oopInjected: number; oopReached: number; oopStopped: number; oopNotReached: number;
  gapInjected: number; gapReached: number; escape: number; command: number; miss: number; harness: number;
}

function recount(r: ReportJsonV1): Recount {
  const corpus = new Map(INJECTION_CORPUS.map((x) => [x.id, x]));
  const out: Recount = { cases: new Set(r.cases.map((c) => c.caseId)).size, evaluated: 0, wouldBlock: 0, wbCf: 0, oopInjected: 0, oopReached: 0, oopStopped: 0, oopNotReached: 0, gapInjected: 0, gapReached: 0, escape: 0, command: 0, miss: 0, harness: 0 };
  for (const c of r.cases) {
    if (c.planId === UNINJECTED_PLAN_ID) {
      for (const row of c.proposals) {
        if (row.source !== 'organic') continue;
        out.evaluated += 1;
        if (row.shadow?.wouldBlock === true) {
          out.wouldBlock += 1;
          if (row.counterfactual) out.wbCf += 1;
        }
      }
    }
    const inj = c.injected;
    if (inj !== undefined) {
      const gap = inj.kernelGap ?? corpus.get(inj.corpusId)?.expected.kernelGap === true;
      if (gap) {
        out.gapInjected += 1;
        if (inj.reached) out.gapReached += 1;
      } else {
        out.oopInjected += 1;
        // A reached entry whose label is not applicable (premature done at PASS) is not out of policy.
        if (inj.reached && inj.labelMatches === 'n/a' && inj.kernelGap !== undefined) continue;
        if (inj.reached) {
          out.oopReached += 1;
          if (inj.stopped) out.oopStopped += 1;
        } else out.oopNotReached += 1;
      }
    }
    for (const ev of c.containment) {
      if (ev.kind === 'escape-simulated') out.escape += 1;
      else if (ev.kind === 'command-simulated') out.command += 1;
      else out.miss += 1;
    }
    if (c.harnessErrors.enforce !== undefined) out.harness += 1;
    if (c.harnessErrors.shadow !== undefined) out.harness += 1;
  }
  return out;
}

function allPreviews(c: CaseComparison): string[] {
  return [
    ...c.proposals.map((p) => p.argsPreview),
    ...c.executed.onlyShadow.map((a) => a.argsPreview),
    ...c.executed.onlyEnforce.map((a) => a.argsPreview),
    ...c.executed.wouldHaveReached.actions.map((a) => a.argsPreview),
  ];
}

describe('Property 15 (pure)', () => {
  // Feature: kernel-shadow-ablation, Property 15: Comparison and report are pure, consistent and clean
  it('compareArms / buildReport are deterministic and non-mutating, the JSON re-renders identically, tallies recount, and output is clean', () => {
    forAll(0x5a0015, 120, (rng, i) => {
      const f = new Forbidden();
      const pairs = Array.from({ length: int(rng, 1, 4) }, () => genPair(rng, f, pick(rng, ['PG-01', 'PG-05', 'SYN-01'])));
      const snapshot = JSON.stringify(pairs);
      for (const p of pairs) deepFreeze(p);

      const comparisons = pairs.map((p) => compareArms(p.caseId, p.e, p.s, p.entry));
      const again = pairs.map((p) => compareArms(p.caseId, p.e, p.s, p.entry));
      expect(again).toEqual(comparisons);
      expect(JSON.stringify(pairs)).toBe(snapshot);

      const input = deepFreeze({ kind: pick(rng, ['recorded', 'synthetic'] as const), comparisons, traceCount: pairs.length, header: `run ${i} ${f.secret(rng)}` });
      const compSnapshot = JSON.stringify(comparisons);
      const r = buildReport(input);
      expect(buildReport(input)).toEqual(r);
      expect(JSON.stringify(comparisons)).toBe(compSnapshot);

      const json = JSON.stringify(r);
      const md = renderMarkdown(r);
      expect(renderMarkdown(r)).toBe(md);
      expect(renderMarkdown(parseReportJson(json))).toBe(md);

      // Summary tallies equal a recount from the cases.
      const n = recount(r);
      const s = r.summary;
      expect(s.cases).toBe(n.cases);
      expect(s.comparisons).toBe(pairs.length);
      expect(s.organic.evaluated).toBe(n.evaluated);
      expect(s.organic.wouldBlock).toBe(n.wouldBlock);
      expect(s.organic.list.length).toBe(n.wouldBlock);
      expect(s.organic.wouldBlockCounterfactual).toBe(n.wbCf);
      expect(s.outOfPolicy.injected).toBe(n.oopInjected);
      expect(s.outOfPolicy.reached).toBe(n.oopReached);
      expect(s.outOfPolicy.stopped).toBe(n.oopStopped);
      expect(s.outOfPolicy.notReached).toBe(n.oopNotReached);
      expect(s.outOfPolicy.missed.length).toBe(n.oopReached - n.oopStopped);
      expect(s.gapProbes.injected).toBe(n.gapInjected);
      expect(s.gapProbes.reached).toBe(n.gapReached);
      expect(s.containment).toEqual({ escapeSimulated: n.escape, commandSimulated: n.command, kernelMiss: n.miss });
      expect(s.kernelMisses).toBe(n.miss);
      expect(s.harnessErrors).toBe(n.harness);

      // Clean: no generated secret fragment and no tail marker anywhere; previews clipped.
      for (const frag of f.fragments) {
        expect(json.includes(frag), `JSON leaks ${frag}`).toBe(false);
        expect(md.includes(frag), `markdown leaks ${frag}`).toBe(false);
      }
      for (const c of r.cases) {
        for (const p of allPreviews(c)) expect(p.length).toBeLessThanOrEqual(ARGS_PREVIEW_MAX + 1);
      }
      assertTablesClean(md);
      if (s.organic.wouldBlock === 0) expect(md).toContain(ZERO_ORGANIC_SENTENCE);
      else expect(md).not.toContain(ZERO_ORGANIC_SENTENCE);
      expect(md.includes(ENFORCEMENT_FAILURE_BANNER)).toBe(s.outOfPolicy.missed.length > 0);
    });
  });
});

// ── Examples ────────────────────────────────────────────────────────────────────────────────

const OOP_PATH_ENTRY = INJECTION_CORPUS.find(
  (x) => x.expected.kernelGap !== true && (x.expected.stoppedBy as readonly string[]).includes('EP-PATH'),
) as InjectionEntry;

describe('comparison and report examples', () => {
  it('all four comparison parts are present: (a) proposals, (b) executed, (c) completion, (d) workspace', () => {
    const steps = servedSteps(3);
    const e = makeArm({
      mode: 'enforce', steps,
      entries: [entry(1, 'EP-TOOL-POLICY', 'allow', 'allow', false), entry(2, 'EP-TOOL-POLICY', 'require_approval', 'block', false, { tool: 'delete_file' })],
      executed: [action(1)],
      completion: { ...COMPLETION, doneAccepted: false, runFinalStates: ['SUSPENDED'], sessionState: 'AWAITING_HUMAN', taskPassed: false },
      files: { 'src/a.js': 'sha-a', 'src/old.js': 'sha-old' }, hash: 'H-enforce',
    });
    const s = makeArm({
      mode: 'shadow', steps,
      entries: [entry(1, 'EP-TOOL-POLICY', 'allow', 'allow', false), entry(2, 'EP-TOOL-POLICY', 'require_approval', 'allow', true, { tool: 'delete_file' })],
      executed: [action(1), action(2, { tool: 'delete_file', touched: ['src/old.js'] })],
      files: { 'src/a.js': 'sha-a2', 'src/new.js': 'sha-new' }, hash: 'H-shadow',
    });
    const c = compareArms('PG-DEP1', e, s);
    expect(c.proposals.map((p) => [p.step, p.agree, p.counterfactual])).toEqual([[1, true, false], [2, false, false]]);
    expect(c.executed.onlyShadow.map((a) => a.tool)).toEqual(['delete_file']);
    expect(c.executed.onlyEnforce).toEqual([]);
    expect(c.executed.wouldHaveReached.touched).toEqual(['src/old.js']);
    expect(c.completion.enforce.sessionState).toBe('AWAITING_HUMAN');
    expect(c.completion.shadow.sessionState).toBe('COMPLETED');
    expect(c.workspace).toMatchObject({
      enforceHash: 'H-enforce', shadowHash: 'H-shadow', identical: false,
      added: ['src/new.js'], removed: ['src/old.js'], modified: ['src/a.js'], includesCounterfactualAfterStep: 2,
    });
    const md = renderMarkdown(buildReport({ kind: 'synthetic', comparisons: [c], traceCount: 1 }));
    for (const heading of ['Decisions per proposal (primary metric):', 'Executed actions compared through step 2:', 'Completion:', 'Final workspace (full run):']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('added src/new.js; removed src/old.js; modified src/a.js');
    expect(md).not.toContain(ZERO_ORGANIC_SENTENCE);
  });

  it('states the zero-organic interpretation sentence when no organic proposal would be blocked', () => {
    const steps = servedSteps(3);
    const entries = [entry(1, 'EP-TOOL-POLICY', 'allow', 'allow', false), entry(2, 'EP-COMPLETION', 'allow', 'allow', false, { tool: 'done' })];
    const e = makeArm({ mode: 'enforce', steps, entries, executed: [action(1)] });
    const s = makeArm({ mode: 'shadow', steps, entries, executed: [action(1)] });
    const r = buildReport({ kind: 'recorded', comparisons: [compareArms('PG-01', e, s)], traceCount: 1 });
    expect(r.summary.organic).toMatchObject({ evaluated: 2, wouldBlock: 0 });
    const md = renderMarkdown(r);
    expect(md).toContain(ZERO_ORGANIC_SENTENCE);
    expect(md).not.toContain(ENFORCEMENT_FAILURE_BANNER);
  });

  it('renders a "no open gap probe" section (not an empty table) when no gap probe was injected', () => {
    const steps = servedSteps(3);
    const entries = [entry(1, 'EP-TOOL-POLICY', 'allow', 'allow', false)];
    const e = makeArm({ mode: 'enforce', steps, entries, executed: [action(1)] });
    const s = makeArm({ mode: 'shadow', steps, entries, executed: [action(1)] });
    const r = buildReport({ kind: 'synthetic', comparisons: [compareArms('PG-01', e, s)], traceCount: 1 });
    expect(r.summary.gapProbes).toMatchObject({ injected: 0, reached: 0, notPlaceable: 0 });
    const md = renderMarkdown(r);
    expect(md).toContain(NO_OPEN_GAP_PROBE_SENTENCE);
    expect(md).toContain('- Gap probes: none (no open gap probe in the corpus)');
    expect(md).not.toContain('No gap probe was run.');
    expect(md).not.toContain('| Case | Entry | Category | Reached | Stopped by | Enforce effects');
    expect(md).not.toContain('reported, not fixed');
  });

  it('shows the ENFORCEMENT FAILURE banner when a reached out-of-policy injection is not stopped', () => {
    expect(OOP_PATH_ENTRY).toBeDefined();
    const id = OOP_PATH_ENTRY.id;
    const steps = servedSteps(3, 2, id);
    // A (synthetic) broken kernel: EP-PATH allowed the injected traversal in the enforce arm.
    const injectedEntries = [
      entry(2, 'EP-TOOL-POLICY', 'allow', 'allow', false, { source: 'injected', corpusId: id }),
      entry(2, 'EP-PATH', 'allow', 'allow', false, { source: 'injected', corpusId: id }),
    ];
    const organic = [entry(1, 'EP-TOOL-POLICY', 'allow', 'allow', false)];
    const e = makeArm({ mode: 'enforce', planId: id, steps, entries: [...organic, ...injectedEntries], executed: [action(1), action(2)] });
    const s = makeArm({ mode: 'shadow', planId: id, steps, entries: [...organic, ...injectedEntries], executed: [action(1), action(2)] });
    const c = compareArms('PG-01', e, s, OOP_PATH_ENTRY);
    expect(c.injected).toMatchObject({ corpusId: id, reached: true, stopped: false, labelMatches: false, step: 2 });
    const r = buildReport({ kind: 'synthetic', comparisons: [c], traceCount: 1 });
    expect(r.summary.outOfPolicy).toMatchObject({ reached: 1, stopped: 0 });
    expect(r.summary.outOfPolicy.missed).toEqual([{ caseId: 'PG-01', corpusId: id, step: 2 }]);
    const md = renderMarkdown(r);
    expect(md).toContain(`**${ENFORCEMENT_FAILURE_BANNER}**`);
    expect(md).toContain(`PG-01/${id} (step 2)`);

    // The same pair with the enforce arm stopping it: no banner.
    const okE = makeArm({
      mode: 'enforce', planId: id, steps,
      entries: [...organic, injectedEntries[0] as LedgerEntry, entry(2, 'EP-PATH', 'block', 'block', false, { source: 'injected', corpusId: id, reason: 'PATH_ESCAPE' })],
      executed: [action(1)],
    });
    const okS = makeArm({
      mode: 'shadow', planId: id, steps,
      entries: [...organic, injectedEntries[0] as LedgerEntry, entry(2, 'EP-PATH', 'block', 'allow', true, { source: 'injected', corpusId: id, reason: 'PATH_ESCAPE' })],
      executed: [action(1), action(2, { effect: 'simulated' })],
    });
    const okC = compareArms('PG-01', okE, okS, OOP_PATH_ENTRY);
    expect(okC.injected).toMatchObject({ reached: true, stopped: true, stoppedBy: 'EP-PATH', labelMatches: true, shadowWouldBlock: true });
    expect(renderMarkdown(buildReport({ kind: 'synthetic', comparisons: [okC], traceCount: 1 }))).not.toContain(ENFORCEMENT_FAILURE_BANNER);
  });

  it('lists an injection the enforce arm never reached as `not reached` with the stopping step', () => {
    const id = OOP_PATH_ENTRY.id;
    const all = servedSteps(3, 2, id);
    // The enforce arm stops on an organic EP-PATH block at step 1 and serves nothing after it.
    const e = makeArm({
      mode: 'enforce', planId: id, steps: all.slice(0, 2),
      entries: [entry(1, 'EP-PATH', 'block', 'block', false, { reason: 'PATH_ESCAPE' })],
      completion: { ...COMPLETION, sessionState: 'ABORTED', runFinalStates: ['FAILED'], doneAccepted: false, taskPassed: false },
    });
    const s = makeArm({
      mode: 'shadow', planId: id, steps: all,
      entries: [
        entry(1, 'EP-PATH', 'block', 'allow', true, { reason: 'PATH_ESCAPE' }),
        entry(2, 'EP-PATH', 'block', 'allow', true, { source: 'injected', corpusId: id, reason: 'PATH_ESCAPE' }),
      ],
      executed: [action(1, { effect: 'simulated' }), action(2, { effect: 'simulated' })],
    });
    const c = compareArms('PG-01', e, s, OOP_PATH_ENTRY);
    expect(c.injected).toMatchObject({ reached: false, stopped: false, labelMatches: 'n/a', notReachedStep: 1, shadowReached: true });
    expect(c.injected?.notReachedBecause).toContain('enforce arm stopped at step 1');
    const row2 = c.proposals.find((p) => p.step === 2);
    expect(row2).toMatchObject({ source: 'injected', corpusId: id, agree: 'n/a', counterfactual: true });
    expect(row2?.enforce).toBeUndefined();

    const r = buildReport({ kind: 'synthetic', comparisons: [c], traceCount: 1 });
    expect(r.summary.outOfPolicy).toMatchObject({ injected: 1, reached: 0, notReached: 1 });
    expect(r.summary.outOfPolicy.notReachedList).toEqual([
      { caseId: 'PG-01', corpusId: id, step: 1, because: c.injected?.notReachedBecause },
    ]);
    const md = renderMarkdown(r);
    expect(md).toContain('### Injections not reached');
    expect(md).toMatch(new RegExp(`\\| PG-01 \\| ${id} \\| 1 \\| enforce arm stopped at step 1`));
    // The per-case decision table shows the enforce cell of the unreached step as `not reached`.
    expect(md).toMatch(new RegExp(`\\| 2 \\| injected ${id} \\| .* \\| not reached \\|`));
    expect(md).not.toContain(ENFORCEMENT_FAILURE_BANNER);
  });
});
