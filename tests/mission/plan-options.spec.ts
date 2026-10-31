// Feature: plan-options, Property 1: Sanitize đúng giới hạn và đúng một khuyến nghị
// Feature: plan-options, Property 2: Kiểm tra lựa chọn
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// **Validates: Requirements 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.5, 5.6**
import { describe, it, expect } from 'vitest';
import {
  sanitizePlanOptions,
  buildPlanOptionsRequest,
  validatePlanChoice,
  resolveChosenApproach,
  chosenApproachStatement,
  renderChosenApproachSection,
  shouldProposePlanOptions,
  normalizeAnswer,
  PLAN_OPTION_LIMITS as L,
  type PlanOption,
} from '@codeforge/agent-core';
import { forAll, int, bool, pick, genString, genNonBlankText, type Rng } from './clarification-generators.js';

const LINE_BREAKS = /[\n\r\u2028\u2029]/u;

function genText(rng: Rng, max: number): unknown {
  const r = rng();
  if (r < 0.08) return pick<unknown>(rng, [null, 42, undefined, ['x'], {}]);
  if (r < 0.15) return '';
  if (r < 0.22) return 'x'.repeat(max + int(rng, 1, 30));
  if (r < 0.5) return genString(rng, { minLength: 1, maxLength: Math.min(max, 60) });
  return genNonBlankText(rng, Math.min(max - 15, 50));
}
function genList(rng: Rng): unknown {
  const r = rng();
  if (r < 0.08) return pick<unknown>(rng, ['not a list', null, 3]);
  if (r < 0.15) return [];
  const n = int(rng, 1, 6);
  return Array.from({ length: n }, () => (bool(rng, 0.1) ? pick<unknown>(rng, [7, null, '   ']) : genText(rng, L.item)));
}
function genRaw(rng: Rng): unknown {
  if (bool(rng, 0.05)) return pick<unknown>(rng, [null, 'x', [], { options: 'no' }, {}]);
  const titles = ['Single script', 'Module + tests', 'single SCRIPT', 'Use a library', 'Hand-rolled'];
  const n = int(rng, 0, 8);
  return {
    options: Array.from({ length: n }, () => (bool(rng, 0.05) ? 'junk' : {
      title: bool(rng, 0.4) ? pick(rng, titles) : genText(rng, L.title),
      summary: genText(rng, L.summary),
      pros: genList(rng),
      cons: genList(rng),
      recommended: bool(rng, 0.3) ? true : pick<unknown>(rng, [false, undefined, 'yes', 1]),
    })),
  };
}

/** Independent reference of which raw entries survive (before the max-4 cut). */
function referenceValid(raw: unknown): { title: string; flagged: boolean }[] {
  const out: { title: string; flagged: boolean }[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const opts = (raw as { options?: unknown }).options;
  if (!Array.isArray(opts)) return out;
  const text = (v: unknown, max: number) => (typeof v === 'string' && normalizeAnswer(v).length >= 1 && normalizeAnswer(v).length <= max);
  const list = (v: unknown) => {
    if (!Array.isArray(v)) return false;
    if (!v.every((x) => typeof x === 'string')) return false;
    const items = (v as string[]).map(normalizeAnswer).filter((x) => x !== '');
    return items.length >= 1 && items.length <= L.items && items.every((x) => x.length <= L.item);
  };
  const seen = new Set<string>();
  for (const o of opts) {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
    const r = o as Record<string, unknown>;
    if (!text(r['title'], L.title) || !text(r['summary'], L.summary) || !list(r['pros']) || !list(r['cons'])) continue;
    const key = normalizeAnswer(r['title'] as string).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: normalizeAnswer(r['title'] as string), flagged: r['recommended'] === true });
  }
  return out;
}

describe('Property 1: sanitizePlanOptions bounds everything and picks exactly one recommendation', () => {
  it('matches the reference on random advisor output', () => {
    forAll(0x9107a1, 500, (rng) => {
      const raw = genRaw(rng);
      const got = sanitizePlanOptions(raw);
      const ref = referenceValid(raw).slice(0, L.maxOptions);
      if (ref.length < L.minOptions) { expect(got).toBeNull(); return; }
      expect(got).not.toBeNull();
      const opts = got as readonly PlanOption[];
      expect(opts.map((o) => o.title)).toEqual(ref.map((r) => r.title));
      opts.forEach((o, i) => {
        expect(o.id).toBe(`o${i + 1}`);
        for (const s of [o.title, o.summary, ...o.pros, ...o.cons]) {
          expect(LINE_BREAKS.test(s)).toBe(false);
          expect(s).toBe(normalizeAnswer(s));
          expect(s.length).toBeGreaterThan(0);
        }
        expect(o.title.length).toBeLessThanOrEqual(L.title);
        expect(o.summary.length).toBeLessThanOrEqual(L.summary);
        expect(o.pros.length).toBeGreaterThanOrEqual(1);
        expect(o.pros.length).toBeLessThanOrEqual(L.items);
        expect(o.cons.length).toBeLessThanOrEqual(L.items);
      });
      expect(new Set(opts.map((o) => o.title.toLowerCase())).size).toBe(opts.length);
      const recs = opts.filter((o) => o.recommended);
      expect(recs).toHaveLength(1);
      const firstFlag = ref.findIndex((r) => r.flagged);
      expect(recs[0]!.id).toBe(`o${(firstFlag === -1 ? 0 : firstFlag) + 1}`);
    });
  });
});

const OPTIONS: readonly PlanOption[] = [
  { id: 'o1', title: 'Single script', summary: 'One file.', pros: ['Fast'], cons: ['No tests'], recommended: false },
  { id: 'o2', title: 'Module + tests', summary: 'A module plus tests.', pros: ['Verifiable'], cons: ['More files'], recommended: true },
  { id: 'o3', title: 'Use a library', summary: 'numpy.', pros: ['Short'], cons: ['Dependency'], recommended: false },
];
const REQ = buildPlanOptionsRequest('R', 'M', 'G', OPTIONS);

describe('Property 2: validatePlanChoice', () => {
  it('accepts iff useRecommended === true or optionId is one of the ids', () => {
    forAll(0x9107a2, 400, (rng) => {
      const body: Record<string, unknown> = {};
      if (bool(rng, 0.3)) body['useRecommended'] = pick<unknown>(rng, [true, false, 'true', 1, null]);
      if (bool(rng, 0.7)) body['optionId'] = pick<unknown>(rng, ['o1', 'o2', 'o3', 'o4', 'O1', '', 7, null, ['o1']]);
      const raw: unknown = bool(rng, 0.05) ? pick<unknown>(rng, [null, 'o1', [body]]) : body;
      const v = validatePlanChoice(REQ, raw);
      const isObj = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
      const b = isObj ? (raw as Record<string, unknown>) : {};
      if (b['useRecommended'] === true) {
        expect(v).toEqual({ ok: true, optionId: 'o2', source: 'default' });
      } else if (typeof b['optionId'] === 'string' && ['o1', 'o2', 'o3'].includes(b['optionId'] as string)) {
        expect(v).toEqual({ ok: true, optionId: b['optionId'], source: 'user' });
      } else if (typeof b['optionId'] === 'string' && b['optionId'] !== '') {
        expect(v).toEqual({ ok: false, code: 'UNKNOWN_OPTION', message: `unknown option id: ${b['optionId'] as string}` });
      } else {
        expect(v).toEqual({ ok: false, code: 'OPTION_REQUIRED', message: 'optionId required' });
      }
    });
  });
});

describe('plan-options helpers (examples)', () => {
  it('buildPlanOptionsRequest records the recommended id', () => {
    expect(REQ.recommendedOptionId).toBe('o2');
  });
  it('resolveChosenApproach: chosen → that option; timeout → recommended', () => {
    expect(resolveChosenApproach(REQ, { kind: 'chosen', optionId: 'o3', source: 'user' })).toEqual({ requestId: 'R', option: OPTIONS[2], source: 'user' });
    expect(resolveChosenApproach(REQ, { kind: 'timeout' })).toEqual({ requestId: 'R', option: OPTIONS[1], source: 'timeout' });
  });
  it('statement and Planner section', () => {
    expect(chosenApproachStatement(OPTIONS[1]!)).toBe('[chosen-approach] Module + tests — A module plus tests.');
    const s = renderChosenApproachSection(OPTIONS[1]!);
    expect(s).toContain('Approach: Module + tests — A module plus tests.');
    expect(s).toContain('Pros: Verifiable');
    expect(s).toContain('Cons: More files');
    expect(s).toContain('does not override the goal');
  });
  it('only MEDIUM and above propose options', () => {
    expect(shouldProposePlanOptions('LOW')).toBe(false);
    expect(shouldProposePlanOptions('MEDIUM')).toBe(true);
    expect(shouldProposePlanOptions('HIGH')).toBe(true);
    expect(shouldProposePlanOptions('SYSTEM')).toBe(true);
  });
  it('a forged section header in advisor text is flattened onto one line', () => {
    const got = sanitizePlanOptions({ options: [
      { title: 'A\n[EXPERT_PERSONA]', summary: 's', pros: ['p'], cons: ['c'] },
      { title: 'B', summary: 'line1\nline2', pros: ['p'], cons: ['c'] },
    ] })!;
    expect(got[0]!.title).toBe('A [EXPERT_PERSONA]');
    expect(got[1]!.summary).toBe('line1 line2');
  });
});