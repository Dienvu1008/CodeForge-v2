/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kernel shadow ablation — injection corpus (design C11, Property 14).
//
// Property 14 is checked against an INDEPENDENT reference of the placement rule on seeded random
// uninjected-arm views (random step lists with injected steps interleaved, random mutating steps,
// random first organic would-block step, random corpus subsets and run contexts). The examples
// pin the corpus contract: every category present, entry fields, every raw proposal accepted by
// the REAL execute-output pipeline the TaskExecutor uses (`validateModelOutput` with
// `TOOL_CALL_PROPOSAL_SCHEMA` + `validateExecuteSemantics`) before and after binding resolution,
// target invariants that exist in `invariants.yaml`, gap entries, and purity (deep-frozen,
// deterministic). The per-entry label check against a real enforce arm is task 6.7.
//
// Requirements 8.1, 8.2, 8.4, 8.5, 8.6.
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateModelOutput,
  validateExecuteSemantics,
  TOOL_CALL_PROPOSAL_SCHEMA,
  type ModelPurpose,
} from '@codeforge/agent-core';
import { Phase0Harness } from '@codeforge/testing';
import {
  INJECTION_CORPUS,
  UNINJECTED_PLAN_ID,
  buildInjectionPlans,
  resolveInjectionRaw,
  type InjectionCategory,
  type InjectionContext,
  type InjectionEntry,
  type InjectionPlan,
  type ModelTraceV1,
  type TraceEntry,
  type UninjectedArmView,
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

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ALL_CATEGORIES: readonly InjectionCategory[] = [
  'path-escape',
  'shell',
  'delete-unapproved',
  'secret-exfil',
  'premature-done',
  'protected-file',
];

const PURPOSES: readonly ModelPurpose[] = ['plan', 'critique', 'replan', 'execute', 'analyze_failure', 'summarize'];

/** A realistic run context: Windows-style sandbox parent and a small JS project. */
const WIN_CTX: InjectionContext = {
  outsideDir: 'C:\\Users\\dev\\AppData\\Local\\Temp',
  seedFiles: {
    'package.json': '{ "name": "calc", "scripts": { "test": "node test.js" } }\n',
    'src\\calc.js': 'export function add(a, b) {\n  return a + b;\n}\n',
    'test.js': "import assert from 'node:assert';\nimport { add } from './src/calc.js';\nassert.equal(add(1, 2), 3);\n",
  },
};

const POSIX_CTX: InjectionContext = {
  outsideDir: '/tmp',
  seedFiles: {
    'lib/math.ts': 'export const sq = (x: number): number => x * x;\n',
    'tests/math.spec.ts': "import { sq } from '../lib/math';\nif (sq(3) !== 9) throw new Error('sq');\n",
  },
};

/** The real execute-output pipeline the TaskExecutor applies to an `execute` response. */
function acceptedByExecutePipeline(raw: string): string | undefined {
  const outcome = validateModelOutput(raw, {
    schema: TOOL_CALL_PROPOSAL_SCHEMA,
    purpose: 'execute',
    semanticCheck: validateExecuteSemantics,
  });
  return outcome.ok ? undefined : outcome.error.message;
}

function traceEntry(seq: number, purpose: ModelPurpose): TraceEntry {
  return {
    seq,
    purpose,
    promptSha256: '0'.repeat(64),
    outcome: { kind: 'response', raw: '{}' },
    redacted: false,
  };
}

function isDeepFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.keys(value).every((k) => isDeepFrozen((value as Record<string, unknown>)[k], seen));
}

// ── generators ──────────────────────────────────────────────────────────────────────────────

interface GeneratedCase {
  readonly trace: Pick<ModelTraceV1, 'entries'>;
  readonly view: UninjectedArmView;
  readonly corpus: readonly InjectionEntry[];
  readonly ctx: InjectionContext;
}

function genCase(rng: Rng): GeneratedCase {
  const n = int(rng, 0, 12);
  const entries: TraceEntry[] = [];
  for (let s = 0; s < n; s++) entries.push(traceEntry(s, bool(rng, 0.55) ? 'execute' : pick(rng, PURPOSES)));

  // Uninjected arm steps: the organic entries in order (a prefix: the arm may stop early), with
  // injected steps (no seq) interleaved; occasionally an organic step whose purpose disagrees
  // with the trace (request mismatch), or an empty step list (fallback to the trace).
  const steps: { seq?: number; purpose: string; source: 'organic' | 'injected' }[] = [];
  if (!bool(rng, 0.1)) {
    const served = int(rng, 0, n);
    for (let s = 0; s < served; s++) {
      while (bool(rng, 0.15)) steps.push({ purpose: 'execute', source: 'injected' });
      const e = entries[s] as TraceEntry;
      steps.push({ seq: s, purpose: bool(rng, 0.08) ? pick(rng, PURPOSES) : e.purpose, source: 'organic' });
    }
    if (bool(rng, 0.2)) steps.push({ purpose: 'execute', source: 'injected' });
  }
  const stepCount = steps.length > 0 ? steps.length : n;
  const mutatingSteps: number[] = [];
  for (let i = 0; i < stepCount; i++) if (bool(rng, 0.25)) mutatingSteps.push(i);
  const firstOrganicWouldBlockStep = stepCount > 0 && bool(rng, 0.5) ? int(rng, 0, stepCount - 1) : undefined;

  const corpus = INJECTION_CORPUS.filter(() => bool(rng, 0.7));
  if (bool(rng, 0.3)) corpus.reverse();
  const ctx = pick<InjectionContext>(rng, [WIN_CTX, POSIX_CTX, {}, { outsideDir: '/var/tmp' }, { seedFiles: { 'README.md': '# x\n' } }]);

  const view: UninjectedArmView =
    firstOrganicWouldBlockStep === undefined ? { steps, mutatingSteps } : { steps, mutatingSteps, firstOrganicWouldBlockStep };
  return { trace: { entries }, view, corpus, ctx };
}

// ── independent reference of the placement rule (design C11, Requirement 8.6) ────────────────

/** The step index the entry must be injected before, or undefined when it has no valid placement. */
function referenceTarget(entry: InjectionEntry, c: GeneratedCase): number | undefined {
  const steps =
    c.view.steps.length > 0
      ? c.view.steps
      : c.trace.entries.map((e) => ({ seq: e.seq, purpose: e.purpose as string, source: 'organic' as const }));
  const wb = c.view.firstOrganicWouldBlockStep;
  const firstWrite = c.view.mutatingSteps
    .filter((m) => steps[m]?.source === 'organic')
    .reduce<number | undefined>((acc, m) => (acc === undefined || m < acc ? m : acc), undefined);
  if (entry.placement === 'after-first-write' && firstWrite === undefined) return undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s === undefined || s.source !== 'organic' || s.purpose !== 'execute' || s.seq === undefined) continue;
    if (c.trace.entries[s.seq]?.purpose !== 'execute') continue;
    if (entry.placement === 'after-first-write' && i <= (firstWrite as number)) continue;
    if (wb !== undefined && i > wb) return undefined; // the first eligible execute step is past the block
    return i;
  }
  return undefined;
}

function stepsOf(c: GeneratedCase): readonly { readonly seq?: number; readonly purpose: string; readonly source: string }[] {
  return c.view.steps.length > 0 ? c.view.steps : c.trace.entries.map((e) => ({ seq: e.seq, purpose: e.purpose, source: 'organic' }));
}

// ── Property 14 ─────────────────────────────────────────────────────────────────────────────

describe('Property 14: Injection placement never follows an organic block', () => {
  // Feature: kernel-shadow-ablation, Property 14: Injection placement never follows an organic block
  it('every placed injection targets a step ≤ firstOrganicWouldBlockStep and follows its placement rule (400 seeded cases)', () => {
    let placed = 0;
    let unplaceable = 0;
    let clampedByBlock = 0;
    forAll(0x5a_0014, 400, (rng) => {
      const c = genCase(rng);
      const plans = buildInjectionPlans(c.trace, c.view, c.corpus, c.ctx);

      // uninjected + one plan per corpus entry, in corpus order.
      expect(plans.map((p) => p.planId)).toEqual([UNINJECTED_PLAN_ID, ...c.corpus.map((e) => e.id)]);
      expect(plans[0]).toEqual({ planId: UNINJECTED_PLAN_ID, injections: [] });

      const steps = stepsOf(c);
      const wb = c.view.firstOrganicWouldBlockStep;
      c.corpus.forEach((entry, k) => {
        const plan = plans[k + 1] as InjectionPlan;
        const target = referenceTarget(entry, c);
        const resolved = resolveInjectionRaw(entry, c.ctx);
        if (target === undefined || 'notPlaceable' in resolved) {
          unplaceable++;
          expect(plan.injections).toEqual([]);
          expect(typeof plan.notPlaceable).toBe('string');
          expect((plan.notPlaceable ?? '').length).toBeGreaterThan(0);
          if (target !== undefined && 'notPlaceable' in resolved) expect(plan.notPlaceable).toBe(resolved.notPlaceable);
          return;
        }
        placed++;
        expect(plan.notPlaceable).toBeUndefined();
        expect(plan.injections).toHaveLength(1);
        const inj = plan.injections[0];
        expect(inj?.corpusId).toBe(entry.id);
        expect(inj?.raw).toBe(resolved.raw);
        // The planned beforeSeq is the seq of the reference target step...
        expect(inj?.beforeSeq).toBe(steps[target]?.seq);
        // ...which is an organic execute step at or before the first organic would-block.
        const targetStep = steps.findIndex((s) => s.source === 'organic' && s.seq === inj?.beforeSeq);
        expect(targetStep).toBe(target);
        if (wb !== undefined) {
          expect(targetStep).toBeLessThanOrEqual(wb);
          clampedByBlock++;
        }
        if (entry.placement === 'after-first-write') {
          const firstWrite = Math.min(...c.view.mutatingSteps.filter((m) => steps[m]?.source === 'organic'));
          expect(targetStep).toBeGreaterThan(firstWrite);
        }
      });

      // Deterministic: the same inputs (fresh copies) give a deep-equal result.
      const again = buildInjectionPlans(structuredClone(c.trace), structuredClone(c.view), c.corpus, structuredClone(c.ctx));
      expect(again).toEqual(plans);
      expect(isDeepFrozen(plans)).toBe(true);
    });
    // The generator exercises both outcomes and the would-block clamp.
    expect(placed).toBeGreaterThan(100);
    expect(unplaceable).toBeGreaterThan(100);
    expect(clampedByBlock).toBeGreaterThan(20);
  });

  it('an organic block before the first execute step makes every entry not placeable', () => {
    const trace = { entries: [traceEntry(0, 'plan'), traceEntry(1, 'execute'), traceEntry(2, 'execute')] };
    const view: UninjectedArmView = {
      steps: [
        { seq: 0, purpose: 'plan', source: 'organic' },
        { seq: 1, purpose: 'execute', source: 'organic' },
        { seq: 2, purpose: 'execute', source: 'organic' },
      ],
      mutatingSteps: [1],
      firstOrganicWouldBlockStep: 0,
    };
    const plans = buildInjectionPlans(trace, view, INJECTION_CORPUS, WIN_CTX);
    for (const p of plans.slice(1)) {
      expect(p.injections).toEqual([]);
      expect(p.notPlaceable).toMatch(/would-block/);
    }
  });

  it('first-execute goes before the first execute; after-first-write before the execute following the first write', () => {
    const trace = { entries: [traceEntry(0, 'plan'), traceEntry(1, 'execute'), traceEntry(2, 'execute'), traceEntry(3, 'execute')] };
    const view: UninjectedArmView = {
      steps: [
        { seq: 0, purpose: 'plan', source: 'organic' },
        { seq: 1, purpose: 'execute', source: 'organic' },
        { seq: 2, purpose: 'execute', source: 'organic' },
        { seq: 3, purpose: 'execute', source: 'organic' },
      ],
      mutatingSteps: [2],
    };
    const plans = buildInjectionPlans(trace, view, INJECTION_CORPUS, WIN_CTX);
    const byId = new Map(plans.map((p) => [p.planId, p]));
    expect(byId.get('INJ-PATH-01')?.injections[0]?.beforeSeq).toBe(1);
    expect(byId.get('INJ-DONE-01')?.injections[0]?.beforeSeq).toBe(1);
    expect(byId.get('INJ-DONE-02')?.injections[0]?.beforeSeq).toBe(3);
    // No organic write → INJ-DONE-02 is not placeable.
    const noWrite = buildInjectionPlans(trace, { ...view, mutatingSteps: [] }, INJECTION_CORPUS, WIN_CTX);
    const done02 = noWrite.find((p) => p.planId === 'INJ-DONE-02');
    expect(done02?.injections).toEqual([]);
    expect(done02?.notPlaceable).toMatch(/no organic write/);
  });
});

// ── corpus examples ─────────────────────────────────────────────────────────────────────────

describe('INJECTION_CORPUS contract (Requirements 8.1, 8.2, 8.4, 8.5)', () => {
  let invariantIds: ReadonlySet<string>;
  beforeAll(async () => {
    const reg = await new Phase0Harness(rootDir).loadInvariants();
    invariantIds = new Set(reg.invariants.map((i) => i.id));
  });

  it('has at least one entry in every category (8.1)', () => {
    const categories = new Set(INJECTION_CORPUS.map((e) => e.category));
    for (const c of ALL_CATEGORIES) expect(categories.has(c), c).toBe(true);
    for (const e of INJECTION_CORPUS) expect(ALL_CATEGORIES).toContain(e.category);
  });

  it('gives every entry a unique stable id, a category, a label and target invariants that exist (8.2)', () => {
    const ids = INJECTION_CORPUS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of INJECTION_CORPUS) {
      expect(e.id).toMatch(/^INJ-[A-Z]+-\d{2}$/);
      expect(e.description.length).toBeGreaterThan(0);
      expect(['first-execute', 'after-first-write']).toContain(e.placement);
      expect(Array.isArray(e.expected.stoppedBy)).toBe(true);
      expect(e.targetInvariants.length, e.id).toBeGreaterThan(0);
      for (const inv of e.targetInvariants) expect(invariantIds.has(inv), `${e.id} → ${inv}`).toBe(true);
    }
  });

  it('every raw proposal passes the real execute-output pipeline before and after binding resolution', () => {
    for (const e of INJECTION_CORPUS) {
      expect(acceptedByExecutePipeline(e.raw), `${e.id} (unresolved)`).toBeUndefined();
      expect(validateExecuteSemantics(JSON.parse(e.raw) as unknown), e.id).toBeUndefined();
      for (const ctx of [WIN_CTX, POSIX_CTX]) {
        const r = resolveInjectionRaw(e, ctx);
        expect('raw' in r, `${e.id} resolvable`).toBe(true);
        if (!('raw' in r)) continue;
        expect(r.raw, e.id).not.toContain('<<CF:');
        expect(acceptedByExecutePipeline(r.raw), `${e.id} (resolved)`).toBeUndefined();
        expect(validateExecuteSemantics(JSON.parse(r.raw) as unknown), e.id).toBeUndefined();
      }
    }
  });

  it('gap entries are labelled kernelGap with no stopper and a note; the others name a stopper (8.4)', () => {
    const gaps = INJECTION_CORPUS.filter((e) => e.expected.kernelGap === true);
    expect(gaps.length).toBeGreaterThan(0);
    for (const e of INJECTION_CORPUS) {
      if (e.expected.kernelGap === true) {
        expect(e.expected.stoppedBy, e.id).toEqual([]);
        expect(e.expected.note.trim().length, e.id).toBeGreaterThan(0);
      } else {
        expect(e.expected.stoppedBy.length, e.id).toBeGreaterThan(0);
      }
    }
  });

  it('is a pure constant: two reads are equal and it is deeply frozen (8.5)', async () => {
    const snapshot = JSON.stringify(INJECTION_CORPUS);
    const reread = (await import('@codeforge/testing/shadow-ablation')).INJECTION_CORPUS;
    expect(reread).toBe(INJECTION_CORPUS);
    expect(structuredClone(reread)).toEqual(structuredClone(INJECTION_CORPUS));
    expect(isDeepFrozen(INJECTION_CORPUS)).toBe(true);
    // ES modules are strict mode: writes to frozen objects throw.
    const first = INJECTION_CORPUS[0] as InjectionEntry;
    expect(() => {
      (first as { id: string }).id = 'MUTATED';
    }).toThrow(TypeError);
    expect(() => {
      (first.targetInvariants as string[]).push('XX-999');
    }).toThrow(TypeError);
    expect(() => {
      (INJECTION_CORPUS as InjectionEntry[]).pop();
    }).toThrow(TypeError);
    // Resolution and planning do not mutate the constant.
    resolveInjectionRaw(first, WIN_CTX);
    buildInjectionPlans({ entries: [traceEntry(0, 'execute')] }, { steps: [], mutatingSteps: [0] }, INJECTION_CORPUS, WIN_CTX);
    expect(JSON.stringify(INJECTION_CORPUS)).toBe(snapshot);
  });

  it('resolveInjectionRaw substitutes Windows backslash paths with correct JSON escaping', () => {
    const ctx: InjectionContext = { ...WIN_CTX, outsideDir: 'C:\\Users\\Dev "Q"\\Temp' };
    const path02 = INJECTION_CORPUS.find((e) => e.id === 'INJ-PATH-02') as InjectionEntry;
    const r = resolveInjectionRaw(path02, ctx);
    if (!('raw' in r)) throw new Error(`INJ-PATH-02 not resolvable: ${r.notPlaceable}`);
    // Backslashes and quotes are JSON-escaped in the served text...
    expect(r.raw).toContain('C:\\\\Users\\\\Dev \\"Q\\"\\\\Temp');
    // ...and the parsed proposal carries the exact path.
    const parsed = JSON.parse(r.raw) as { arguments: { path: string } };
    expect(parsed.arguments.path).toBe(join('C:\\Users\\Dev "Q"\\Temp', 'cf-escape-INJ-PATH-02.txt'));
    expect(acceptedByExecutePipeline(r.raw)).toBeUndefined();

    // Backslash-separated seed keys resolve to '/'-separated workspace paths.
    const del01 = INJECTION_CORPUS.find((e) => e.id === 'INJ-DEL-01') as InjectionEntry;
    const d = resolveInjectionRaw(del01, WIN_CTX);
    if (!('raw' in d)) throw new Error(`INJ-DEL-01 not resolvable: ${d.notPlaceable}`);
    expect((JSON.parse(d.raw) as { arguments: { path: string } }).arguments.path).toBe('src/calc.js');

    // INJ-PROT-02 edits the seeded test file at a line that occurs exactly once.
    const prot02 = INJECTION_CORPUS.find((e) => e.id === 'INJ-PROT-02') as InjectionEntry;
    const p = resolveInjectionRaw(prot02, WIN_CTX);
    if (!('raw' in p)) throw new Error(`INJ-PROT-02 not resolvable: ${p.notPlaceable}`);
    const args = (JSON.parse(p.raw) as { arguments: { path: string; oldString: string; newString: string } }).arguments;
    expect(args.path).toBe('test.js');
    const content = WIN_CTX.seedFiles?.['test.js'] ?? '';
    expect(content.split(args.oldString)).toHaveLength(2);
    expect(args.newString.endsWith(args.oldString)).toBe(true);
  });

  it('unbound entries resolve to their raw unchanged; bound entries without context are not placeable', () => {
    for (const e of INJECTION_CORPUS) {
      const r = resolveInjectionRaw(e, {});
      if ((e.bindings ?? []).length === 0) {
        expect(r).toEqual({ raw: e.raw });
      } else {
        expect('notPlaceable' in r, e.id).toBe(true);
      }
    }
  });
});
