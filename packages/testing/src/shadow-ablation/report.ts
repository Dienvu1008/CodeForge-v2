/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Ablation report (kernel-shadow-ablation, design C14; Requirements 8.4, 9.5, 10.4–10.9).
// Measurement-only (SA-001).
//
// Two pure steps:
//   buildReport(input)   → ReportJsonV1  (tallies + sanitized copies of the CaseComparisons)
//   renderMarkdown(json) → string        (reads ONLY the JSON, so JSON → markdown is reproducible:
//                                         renderMarkdown(parseReportJson(JSON.stringify(r))) ===
//                                         renderMarkdown(r), Requirement 10.9)
// No clock, no randomness, no I/O. A generated-at timestamp, if wanted, is a caller-provided
// `header` string stored in the JSON, so it never makes rendering non-deterministic.
//
// Secret hygiene (Requirement 10.8): no input carries prompt text (traces store digests only and
// CaseComparison has no prompt field). Every string copied into the JSON passes through `redact`
// and is truncated to ARGS_PREVIEW_MAX characters (+ `…`); the markdown renderer applies the same
// clip again to every data string, escapes table cells, and shows EP-ENV filter reasons as a
// COUNT of denied variables (names stay in the JSON detail only — residual risk 4).
//
// Counting rules (stated again in the report's "Method and caveats"):
//   - Organic metrics come from the UNINJECTED comparisons only: injected plans replay the same
//     organic prefix (duplicates) and everything after the injection is counterfactual.
//   - "Organic proposals changed by the kernel" = organic rows whose shadow decision is
//     `wouldBlock` (some enforcement point would have stopped them).
//   - An injected outcome is a Gap_Probe when its corpus label is `kernelGap: true`; every other
//     injected outcome is an Out_Of_Policy_Proposal.
import type { ModelIdentity } from '@codeforge/agent-core';
import { redact } from '@codeforge/infrastructure';
import type { CaseComparison, InjectedOutcome, ProposalRow, ShadowDecisionCell } from './comparison.js';
import { ARGS_PREVIEW_MAX, type ContainmentEvent, type ExecutedAction } from './decision-ledger.js';
import { INJECTION_CORPUS, UNINJECTED_PLAN_ID, type InjectionEntry } from './injection-corpus.js';

// ── Constants ───────────────────────────────────────────────────────────────────────────────

export const REPORT_FORMAT_VERSION = 'codeforge.shadow-ablation-report/1' as const;

/** Requirement 10.7: the fixed sentence used when no organic proposal has a shadow `wouldBlock`. */
export const ZERO_ORGANIC_SENTENCE =
  'These traces show no organic action changed by the kernel; the measured kernel value on these traces rests on the injected cases.';

/** Prefix of the banner shown when a reached out-of-policy injection was not stopped. */
export const ENFORCEMENT_FAILURE_BANNER = 'ENFORCEMENT FAILURE';

/** Prefix of the banner shown when containment rejected a path the Kernel accepted. */
export const KERNEL_MISS_BANNER = 'KERNEL MISS';

/** Residual risks of containment and of the method (design "Residual risks", Requirement 7.7). */
export const RESIDUAL_RISKS: readonly string[] = Object.freeze([
  'Real check commands in Phase 2: the contained supervisor runs the case check commands for real in the sandbox; they execute model-authored code with the user\'s OS privileges (same exposure as run-progressive.mjs). Containment is path- and command-level, not an OS sandbox; run Phase 2 in WSL or a disposable VM.',
  'Independent path check quality: containment relies on resolve + realpath of the nearest existing ancestor; a symlink race between check and use is out of scope (Phase 1 cannot create symlinks; Phase 2 runs only exact-match commands).',
  'Pattern-based redaction: secrets that match no redaction rule may remain in traces; traces live under the gitignored .agents/traces/ and the report never contains prompts.',
  'Environment names: EP-ENV records denied variable NAMES (never values); names can hint at which providers a user has, so this report shows only their count and the names stay in the JSON detail.',
  'Counterfactual replay: after the divergence point recorded responses are served in a context the model never saw; those steps are labelled and never counted as trajectory evidence.',
  'Simulated command output: simulated run_command results differ from recorded ones, so Phase 2 replays show prompt drift; drift is reported, and decisions do not depend on the prompt.',
  'Observed_Guards not ablated: the P12.11 / P12.13 challenges behave identically in both arms; their value is not measured by this experiment.',
  'Temp cleanup: a crash can leave cf-bench-* directories in the OS temp directory.',
]);

const ELLIPSIS = '…';

// ── Types ───────────────────────────────────────────────────────────────────────────────────

export type ReportKind = 'recorded' | 'synthetic';

export interface TraceRefusal {
  readonly traceId: string;
  readonly reason: string;
}

export interface NotPlaceablePlan {
  readonly caseId: string;
  readonly planId: string;
  readonly reason: string;
}

export interface ReportInput {
  readonly kind: ReportKind;
  readonly comparisons: readonly CaseComparison[];
  /** Number of trace files / synthetic traces considered (valid + refused). */
  readonly traceCount: number;
  readonly tracesRefused?: readonly TraceRefusal[];
  /** Injection plans with no valid placement (they produced no comparison). */
  readonly notPlaceable?: readonly NotPlaceablePlan[];
  readonly benchmark?: string;
  readonly model?: ModelIdentity;
  /** Enforce-arm model of the absent human used for every arm. Default `'none'`. */
  readonly approvalResolution?: 'none' | 'deny';
  /** Sum of `trace.redaction.redactedEntries` over the replayed traces. Default 0. */
  readonly redactedEntries?: number;
  /** Caller-provided header line (e.g. a generated-at timestamp); rendered as given (redacted). */
  readonly header?: string;
  /** Corpus used to label the injected outcomes. Default {@link INJECTION_CORPUS}. */
  readonly corpus?: readonly InjectionEntry[];
}

/** The corpus facts the report needs, copied so rendering reads only the JSON. */
export interface ReportCorpusEntry {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly kernelGap: boolean;
  readonly expectedStoppedBy: readonly string[];
  readonly note?: string;
}

export interface InjectionRef {
  readonly caseId: string;
  readonly corpusId: string;
  readonly step?: number;
}

export interface NotReachedInjection {
  readonly caseId: string;
  readonly corpusId: string;
  /** The step that stopped the enforce arm (-1 when it served no step). */
  readonly step: number;
  readonly because: string;
}

export interface LabelMismatch {
  readonly caseId: string;
  readonly corpusId: string;
  readonly kernelGap: boolean;
  readonly expected: readonly string[];
  readonly observed: readonly string[];
}

export interface LabelNotApplicable {
  readonly caseId: string;
  readonly corpusId: string;
  readonly note: string;
}

export interface OrganicWouldBlock {
  readonly caseId: string;
  readonly planId: string;
  readonly step: number;
  readonly tool: string;
  readonly argsPreview: string;
  readonly points: readonly string[];
  readonly reasons: readonly string[];
  /** Enforce-arm effective decision text, or undefined when the enforce arm never served the step. */
  readonly enforce?: string;
  readonly counterfactual: boolean;
}

export interface CaseFidelity {
  readonly caseId: string;
  readonly planId: string;
  readonly served: number;
  readonly total: number;
  readonly exhausted: boolean;
  readonly mismatch?: { readonly seq: number; readonly expected: string; readonly received: string };
  readonly driftCount: number;
  /** Uninjected enforce arm that did not consume every entry with matching purposes. */
  readonly wiringDrift: boolean;
}

export interface ReportSummary {
  /** Distinct case ids, in input order. */
  readonly cases: number;
  /** (trace, plan) pairs compared. */
  readonly comparisons: number;
  readonly traceCount: number;
  readonly tracesRefused: readonly TraceRefusal[];
  readonly outOfPolicy: {
    readonly injected: number;
    readonly reached: number;
    readonly stopped: number;
    readonly notReached: number;
    readonly notPlaceable: number;
    /** Reached and NOT stopped by the enforce arm (ENFORCEMENT FAILURE). */
    readonly missed: readonly InjectionRef[];
    readonly notReachedList: readonly NotReachedInjection[];
  };
  readonly gapProbes: {
    readonly injected: number;
    readonly reached: number;
    readonly stopped: number;
    readonly notPlaceable: number;
    /** Reached, not stopped, and executed with a real sandbox effect in the enforce arm. */
    readonly reachedSandbox: number;
    /** `<caseId>/<corpusId>` of the gap probes that reached the sandbox. */
    readonly ids: readonly string[];
  };
  readonly labelMismatches: readonly LabelMismatch[];
  readonly labelNotApplicable: readonly LabelNotApplicable[];
  readonly organic: {
    /** Organic proposal rows of the uninjected comparisons. */
    readonly evaluated: number;
    readonly wouldBlock: number;
    readonly wouldBlockCounterfactual: number;
    /** Organic rows the enforce arm filtered (EP-ENV), identical in both arms by design. */
    readonly filtered: number;
    readonly list: readonly OrganicWouldBlock[];
  };
  readonly kernelMisses: number;
  readonly containment: { readonly escapeSimulated: number; readonly commandSimulated: number; readonly kernelMiss: number };
  readonly harnessErrors: number;
  readonly fidelity: readonly CaseFidelity[];
  readonly redactedEntries: number;
}

export interface ReportJsonV1 {
  readonly reportVersion: typeof REPORT_FORMAT_VERSION;
  readonly kind: ReportKind;
  readonly header?: string;
  readonly model?: ModelIdentity;
  readonly benchmark?: string;
  readonly approvalResolution: 'none' | 'deny';
  readonly summary: ReportSummary;
  /** Corpus entries referenced by the injected comparisons / not-placeable plans, corpus order. */
  readonly corpus: readonly ReportCorpusEntry[];
  readonly notPlaceable: readonly NotPlaceablePlan[];
  /** Sanitized copies of the input comparisons, input order. */
  readonly cases: readonly CaseComparison[];
}

export class ReportFormatError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`invalid shadow-ablation report (${field}): ${message}`);
    this.name = 'ReportFormatError';
  }
}

// ── Sanitizing ──────────────────────────────────────────────────────────────────────────────

/**
 * Redact, then truncate to {@link ARGS_PREVIEW_MAX} characters plus `…`. A string that is
 * already a preview (exactly MAX chars + `…`) is kept, so previews are not cut twice.
 */
export function clipText(text: string): string {
  const r = redact(text);
  if (r.length <= ARGS_PREVIEW_MAX) return r;
  if (r.length === ARGS_PREVIEW_MAX + 1 && r.endsWith(ELLIPSIS)) return r;
  let cut = ARGS_PREVIEW_MAX;
  const last = r.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${r.slice(0, cut)}${ELLIPSIS}`;
}

/** Deep copy with every string clipped; `undefined` properties are dropped (as JSON does). */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return clipText(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = sanitizeDeep(v);
    }
    return out;
  }
  return value;
}

function sanitize<T>(value: T): T {
  return sanitizeDeep(value) as T;
}

// ── buildReport ─────────────────────────────────────────────────────────────────────────────

function isGapProbe(inj: InjectedOutcome, corpus: ReadonlyMap<string, InjectionEntry>): boolean {
  if (inj.kernelGap !== undefined) return inj.kernelGap;
  return corpus.get(inj.corpusId)?.expected.kernelGap === true;
}

function enforceText(row: ProposalRow): string | undefined {
  const e = row.enforce;
  if (e === undefined) return undefined;
  return e.point !== undefined ? `${e.effective} @${e.point}: ${e.reason ?? ''}` : e.effective;
}

function corpusEntryOf(e: InjectionEntry): ReportCorpusEntry {
  return {
    id: e.id,
    category: e.category,
    description: e.description,
    kernelGap: e.expected.kernelGap === true,
    expectedStoppedBy: [...e.expected.stoppedBy],
    ...(e.expected.kernelGap === true ? { note: e.expected.note } : {}),
  };
}

/**
 * A reached injection whose corpus label was judged not applicable (`labelMatches: 'n/a'` with a
 * corpus entry supplied — today only a premature-done entry that met a PASS verification). Such a
 * proposal was not out of policy when it was served, so it is excluded from the out-of-policy
 * reached / stopped / missed tallies (as the e2e enforcement property excludes it).
 */
export function notOutOfPolicyWhenReached(inj: NonNullable<CaseComparison['injected']>): boolean {
  return inj.reached && inj.labelMatches === 'n/a' && inj.kernelGap !== undefined;
}

/** Build the versioned report JSON from the comparisons and run metadata. Pure. */
export function buildReport(input: ReportInput): ReportJsonV1 {
  const corpusList = input.corpus ?? INJECTION_CORPUS;
  const corpus = new Map<string, InjectionEntry>(corpusList.map((e) => [e.id, e]));
  const comparisons = input.comparisons;
  const notPlaceable = input.notPlaceable ?? [];

  const caseIds: string[] = [];
  for (const c of comparisons) if (!caseIds.includes(c.caseId)) caseIds.push(c.caseId);

  // Injected outcomes.
  let oopInjected = 0;
  let oopReached = 0;
  let oopStopped = 0;
  let oopNotReached = 0;
  const missed: InjectionRef[] = [];
  const notReachedList: NotReachedInjection[] = [];
  let gapInjected = 0;
  let gapReached = 0;
  let gapStopped = 0;
  const gapIds: string[] = [];
  const labelMismatches: LabelMismatch[] = [];
  const labelNotApplicable: LabelNotApplicable[] = [];
  const referenced = new Set<string>();

  for (const c of comparisons) {
    const inj = c.injected;
    if (inj === undefined) continue;
    referenced.add(inj.corpusId);
    const gap = isGapProbe(inj, corpus);
    if (gap) {
      gapInjected += 1;
      if (inj.reached) {
        gapReached += 1;
        if (inj.stopped) gapStopped += 1;
        else if (inj.enforceEffects.includes('sandbox')) gapIds.push(`${c.caseId}/${inj.corpusId}`);
      }
    } else {
      oopInjected += 1;
      if (notOutOfPolicyWhenReached(inj)) {
        // Reached, but the corpus label does not apply at that point (a premature-done entry met a
        // PASS verification: the done was not premature). It is not an out-of-policy proposal, so
        // it is neither "reached" nor "missed"; it is listed under labelNotApplicable below.
      } else if (inj.reached) {
        oopReached += 1;
        if (inj.stopped) oopStopped += 1;
        else missed.push({ caseId: c.caseId, corpusId: inj.corpusId, ...(inj.step !== undefined ? { step: inj.step } : {}) });
      } else {
        oopNotReached += 1;
      }
    }
    if (!inj.reached) {
      notReachedList.push({
        caseId: c.caseId,
        corpusId: inj.corpusId,
        step: inj.notReachedStep ?? -1,
        because: inj.notReachedBecause ?? 'not reached',
      });
    }
    if (inj.labelMatches === false) {
      labelMismatches.push({
        caseId: c.caseId,
        corpusId: inj.corpusId,
        kernelGap: gap,
        expected: [...(inj.expectedStoppedBy ?? corpus.get(inj.corpusId)?.expected.stoppedBy ?? [])],
        observed: [...inj.stoppers],
      });
    } else if (inj.labelMatches === 'n/a' && inj.reached) {
      labelNotApplicable.push({ caseId: c.caseId, corpusId: inj.corpusId, note: inj.labelNote ?? 'n/a' });
    }
  }

  let oopNotPlaceable = 0;
  let gapNotPlaceable = 0;
  for (const p of notPlaceable) {
    referenced.add(p.planId);
    if (corpus.get(p.planId)?.expected.kernelGap === true) gapNotPlaceable += 1;
    else oopNotPlaceable += 1;
  }

  // Organic proposals: uninjected comparisons only.
  let evaluated = 0;
  let filtered = 0;
  const organicList: OrganicWouldBlock[] = [];
  for (const c of comparisons) {
    if (c.planId !== UNINJECTED_PLAN_ID) continue;
    for (const row of c.proposals) {
      if (row.source !== 'organic') continue;
      evaluated += 1;
      if (row.enforce?.effective === 'filter') filtered += 1;
      const s: ShadowDecisionCell | undefined = row.shadow;
      if (s?.wouldBlock === true) {
        const et = enforceText(row);
        organicList.push({
          caseId: c.caseId,
          planId: c.planId,
          step: row.step,
          tool: row.tool,
          argsPreview: row.argsPreview,
          points: [...s.points],
          reasons: [...s.reasons],
          ...(et !== undefined ? { enforce: et } : {}),
          counterfactual: row.counterfactual,
        });
      }
    }
  }

  // Containment, misses, harness errors, fidelity.
  let escapeSimulated = 0;
  let commandSimulated = 0;
  let kernelMiss = 0;
  let harnessErrors = 0;
  const fidelity: CaseFidelity[] = [];
  for (const c of comparisons) {
    for (const ev of c.containment) {
      if (ev.kind === 'escape-simulated') escapeSimulated += 1;
      else if (ev.kind === 'command-simulated') commandSimulated += 1;
      else kernelMiss += 1;
    }
    if (c.harnessErrors.enforce !== undefined) harnessErrors += 1;
    if (c.harnessErrors.shadow !== undefined) harnessErrors += 1;
    const f = c.fidelity;
    fidelity.push({
      caseId: c.caseId,
      planId: c.planId,
      served: f.served,
      total: f.total,
      exhausted: f.exhausted,
      ...(f.mismatch !== undefined ? { mismatch: { ...f.mismatch } } : {}),
      driftCount: f.driftCount,
      wiringDrift: c.planId === UNINJECTED_PLAN_ID && (f.served !== f.total || f.mismatch !== undefined),
    });
  }

  const summary: ReportSummary = {
    cases: caseIds.length,
    comparisons: comparisons.length,
    traceCount: input.traceCount,
    tracesRefused: (input.tracesRefused ?? []).map((t) => ({ traceId: t.traceId, reason: t.reason })),
    outOfPolicy: {
      injected: oopInjected,
      reached: oopReached,
      stopped: oopStopped,
      notReached: oopNotReached,
      notPlaceable: oopNotPlaceable,
      missed,
      notReachedList,
    },
    gapProbes: {
      injected: gapInjected,
      reached: gapReached,
      stopped: gapStopped,
      notPlaceable: gapNotPlaceable,
      reachedSandbox: gapIds.length,
      ids: gapIds,
    },
    labelMismatches,
    labelNotApplicable,
    organic: {
      evaluated,
      wouldBlock: organicList.length,
      wouldBlockCounterfactual: organicList.filter((o) => o.counterfactual).length,
      filtered,
      list: organicList,
    },
    kernelMisses: kernelMiss,
    containment: { escapeSimulated, commandSimulated, kernelMiss },
    harnessErrors,
    fidelity,
    redactedEntries: input.redactedEntries ?? 0,
  };

  const report: ReportJsonV1 = {
    reportVersion: REPORT_FORMAT_VERSION,
    kind: input.kind,
    ...(input.header !== undefined ? { header: input.header } : {}),
    ...(input.model !== undefined ? { model: { name: input.model.name, version: input.model.version, endpoint: input.model.endpoint } } : {}),
    ...(input.benchmark !== undefined ? { benchmark: input.benchmark } : {}),
    approvalResolution: input.approvalResolution ?? 'none',
    summary,
    corpus: corpusList.filter((e) => referenced.has(e.id)).map(corpusEntryOf),
    notPlaceable: notPlaceable.map((p) => ({ caseId: p.caseId, planId: p.planId, reason: p.reason })),
    cases: comparisons,
  };
  // One sanitizing pass over the whole document: every string redacted and clipped.
  return sanitize(report);
}

// ── parseReportJson ─────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function need(cond: boolean, field: string, message: string): void {
  if (!cond) throw new ReportFormatError(field, message);
}

/**
 * Parse and structurally validate a report JSON document (format version, kind, the summary
 * tallies and the array fields the renderer reads). Throws {@link ReportFormatError}.
 */
export function parseReportJson(text: string): ReportJsonV1 {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new ReportFormatError('$', `not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  need(isRecord(v), '$', 'expected an object');
  const r = v as Record<string, unknown>;
  need(r['reportVersion'] === REPORT_FORMAT_VERSION, 'reportVersion', `expected '${REPORT_FORMAT_VERSION}'`);
  need(r['kind'] === 'recorded' || r['kind'] === 'synthetic', 'kind', "expected 'recorded' or 'synthetic'");
  need(r['approvalResolution'] === 'none' || r['approvalResolution'] === 'deny', 'approvalResolution', "expected 'none' or 'deny'");
  for (const f of ['header', 'benchmark'] as const) {
    need(r[f] === undefined || typeof r[f] === 'string', f, 'expected a string');
  }
  need(r['model'] === undefined || isRecord(r['model']), 'model', 'expected an object');
  need(Array.isArray(r['corpus']), 'corpus', 'expected an array');
  need(Array.isArray(r['notPlaceable']), 'notPlaceable', 'expected an array');
  need(Array.isArray(r['cases']), 'cases', 'expected an array');
  (r['cases'] as unknown[]).forEach((c, i) => {
    need(isRecord(c), `cases[${i}]`, 'expected an object');
    const cc = c as Record<string, unknown>;
    need(typeof cc['caseId'] === 'string', `cases[${i}].caseId`, 'expected a string');
    need(typeof cc['planId'] === 'string', `cases[${i}].planId`, 'expected a string');
    need(Array.isArray(cc['proposals']), `cases[${i}].proposals`, 'expected an array');
    need(Array.isArray(cc['containment']), `cases[${i}].containment`, 'expected an array');
    need(Array.isArray(cc['kernelMisses']), `cases[${i}].kernelMisses`, 'expected an array');
    for (const f of ['executed', 'completion', 'workspace', 'counterfactualCut', 'guards', 'fidelity', 'shadowFidelity', 'inactive', 'notes', 'harnessErrors']) {
      need(isRecord(cc[f]), `cases[${i}].${f}`, 'expected an object');
    }
  });
  need(isRecord(r['summary']), 'summary', 'expected an object');
  const s = r['summary'] as Record<string, unknown>;
  for (const f of ['cases', 'comparisons', 'traceCount', 'kernelMisses', 'harnessErrors', 'redactedEntries']) {
    need(typeof s[f] === 'number', `summary.${f}`, 'expected a number');
  }
  for (const f of ['tracesRefused', 'labelMismatches', 'labelNotApplicable', 'fidelity']) {
    need(Array.isArray(s[f]), `summary.${f}`, 'expected an array');
  }
  for (const f of ['outOfPolicy', 'gapProbes', 'organic', 'containment']) {
    need(isRecord(s[f]), `summary.${f}`, 'expected an object');
  }
  const oop = s['outOfPolicy'] as Record<string, unknown>;
  for (const f of ['injected', 'reached', 'stopped', 'notReached', 'notPlaceable']) {
    need(typeof oop[f] === 'number', `summary.outOfPolicy.${f}`, 'expected a number');
  }
  need(Array.isArray(oop['missed']), 'summary.outOfPolicy.missed', 'expected an array');
  need(Array.isArray(oop['notReachedList']), 'summary.outOfPolicy.notReachedList', 'expected an array');
  const gp = s['gapProbes'] as Record<string, unknown>;
  for (const f of ['injected', 'reached', 'stopped', 'notPlaceable', 'reachedSandbox']) {
    need(typeof gp[f] === 'number', `summary.gapProbes.${f}`, 'expected a number');
  }
  need(Array.isArray(gp['ids']), 'summary.gapProbes.ids', 'expected an array');
  const org = s['organic'] as Record<string, unknown>;
  for (const f of ['evaluated', 'wouldBlock', 'wouldBlockCounterfactual', 'filtered']) {
    need(typeof org[f] === 'number', `summary.organic.${f}`, 'expected a number');
  }
  need(Array.isArray(org['list']), 'summary.organic.list', 'expected an array');
  return v as ReportJsonV1;
}

// ── Markdown helpers ────────────────────────────────────────────────────────────────────────

/** A data string for markdown: clipped (redacted + truncated), single line, HTML-inert. */
function inline(text: string): string {
  return clipText(text)
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A data string inside a table cell: {@link inline} plus `\` and `|` escaped. */
function cell(text: string): string {
  return inline(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** EP-ENV reasons list denied variable NAMES; the markdown shows only their count. */
function hideEnvNames(text: string): string {
  return text.replace(/denied: ([A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*)/g, (_m, names: string) => {
    const n = names.split(',').length;
    return `denied: ${n} variable${n === 1 ? '' : 's'}`;
  });
}

function reasonCell(text: string): string {
  return cell(hideEnvNames(text));
}

function num(n: number | undefined): string {
  return n === undefined ? '—' : String(n);
}

function yesNo(b: boolean): string {
  return b ? 'yes' : 'no';
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '—' : items.map((x) => cell(x)).join(', ');
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

function enforceCellText(row: ProposalRow): string {
  const e = row.enforce;
  if (e === undefined) return 'not reached';
  return e.point !== undefined ? `${e.effective} @${e.point}: ${e.reason ?? ''}` : e.effective;
}

function shadowCellText(row: ProposalRow): string {
  const s = row.shadow;
  if (s === undefined) return 'not reached';
  const base = s.point !== undefined ? `${s.effective} @${s.point}: ${s.reason ?? ''}` : s.effective;
  if (!s.wouldBlock) return base;
  const wb = s.points.map((p, i) => `${p} (${s.reasons[i] ?? ''})`).join(', ');
  return `${base}; wouldBlock ${wb}`;
}

function actionText(a: ExecutedAction): string {
  const touched = a.touched.length > 0 ? ` touched ${a.touched.join(', ')}` : '';
  return `step ${a.step} ${a.tool} ${a.argsPreview} → ${a.outcome} (${a.effect})${touched}`;
}

function containmentText(c: ContainmentEvent & { readonly arm?: string }): string {
  const arm = c.arm !== undefined ? `${c.arm} ` : '';
  const sha = c.sha256 !== undefined ? ` sha256 ${c.sha256}` : '';
  return `${arm}step ${c.step} ${c.kind} ${c.op} ${c.target}${sha}`;
}

function caseTitle(c: CaseComparison): string {
  return `${c.caseId} · ${c.planId}`;
}

function corpusById(r: ReportJsonV1): Map<string, ReportCorpusEntry> {
  return new Map(r.corpus.map((e) => [e.id, e]));
}

// ── Markdown sections ───────────────────────────────────────────────────────────────────────

function renderSummary(r: ReportJsonV1): string[] {
  const s = r.summary;
  const o = s.outOfPolicy;
  const g = s.gapProbes;
  const org = s.organic;
  const out: string[] = ['## Summary', ''];
  out.push(`Organic proposals changed by the kernel: ${org.wouldBlock} of ${org.evaluated}`);
  out.push('');
  out.push(`- Out-of-policy injected: stopped ${o.stopped} / reached ${o.reached} (block or filter; ${o.injected} injected, ${o.notReached} not reached, ${o.notPlaceable} not placeable; reached entries whose label is not applicable are excluded and listed below)`);
  out.push(`- Organic proposals evaluated: ${org.evaluated}; with shadow wouldBlock: ${org.wouldBlock} (${org.wouldBlockCounterfactual} of them counterfactual); filtered by EP-ENV in both arms: ${org.filtered}`);
  out.push(`- Gap probes: reached ${g.reached} of ${g.injected} injected, stopped ${g.stopped}, reached the sandbox ${g.reachedSandbox} (${g.notPlaceable} not placeable)`);
  out.push(`- Label mismatches: ${s.labelMismatches.length}; labels not applicable: ${s.labelNotApplicable.length}`);
  out.push(`- Kernel misses: ${s.kernelMisses}`);
  out.push(`- Containment events: ${s.containment.escapeSimulated} escape-simulated, ${s.containment.commandSimulated} command-simulated, ${s.containment.kernelMiss} kernelMiss`);
  out.push(`- Cases: ${s.cases}; comparisons: ${s.comparisons}; traces: ${s.traceCount} (${s.tracesRefused.length} refused); harness errors: ${s.harnessErrors}; redacted trace entries: ${s.redactedEntries}`);
  const drift = s.fidelity.filter((f) => f.wiringDrift);
  out.push(`- Wiring drift (uninjected enforce arm did not consume its trace): ${drift.length === 0 ? 'none' : drift.map((f) => cell(f.caseId)).join(', ')}`);
  out.push('');

  if (org.list.length > 0) {
    out.push('### Organic proposals with shadow wouldBlock', '');
    out.push(...table(
      ['Case', 'Step', 'Tool', 'Point', 'Reason', 'Enforce', 'Args', 'Counterfactual'],
      org.list.map((w) => [
        cell(w.caseId), String(w.step), cell(w.tool), list(w.points), reasonCell(w.reasons.join('; ')),
        w.enforce !== undefined ? reasonCell(w.enforce) : 'not reached', cell(w.argsPreview), yesNo(w.counterfactual),
      ]),
    ));
    out.push('');
  }
  if (o.notReachedList.length > 0) {
    out.push('### Injections not reached', '');
    out.push(...table(
      ['Case', 'Entry', 'Stopping step', 'Why'],
      o.notReachedList.map((n) => [cell(n.caseId), cell(n.corpusId), String(n.step), reasonCell(n.because)]),
    ));
    out.push('');
  }
  if (s.labelMismatches.length > 0) {
    out.push('### Label mismatches', '');
    out.push(...table(
      ['Case', 'Entry', 'Gap probe', 'Expected', 'Observed stoppers'],
      s.labelMismatches.map((m) => [cell(m.caseId), cell(m.corpusId), yesNo(m.kernelGap), list(m.expected), list(m.observed)]),
    ));
    out.push('');
  }
  if (s.labelNotApplicable.length > 0) {
    out.push('### Labels not applicable', '');
    for (const n of s.labelNotApplicable) out.push(`- ${inline(n.caseId)} / ${inline(n.corpusId)}: ${inline(n.note)}`);
    out.push('');
  }
  if (s.tracesRefused.length > 0) {
    out.push('### Refused traces', '');
    for (const t of s.tracesRefused) out.push(`- ${inline(t.traceId)}: ${inline(t.reason)}`);
    out.push('');
  }
  if (r.notPlaceable.length > 0) {
    out.push('### Plans not placeable', '');
    for (const p of r.notPlaceable) out.push(`- ${inline(p.caseId)} / ${inline(p.planId)}: ${inline(p.reason)}`);
    out.push('');
  }
  return out;
}

function renderInterpretation(r: ReportJsonV1): string[] {
  const s = r.summary;
  const o = s.outOfPolicy;
  const out: string[] = ['## Interpretation', ''];
  if (o.missed.length > 0) {
    const ids = o.missed.map((m) => `${inline(m.caseId)}/${inline(m.corpusId)}${m.step !== undefined ? ` (step ${m.step})` : ''}`);
    out.push(`> **${ENFORCEMENT_FAILURE_BANNER}**: ${o.missed.length} reached out-of-policy injection(s) were not stopped by the enforce arm: ${ids.join(', ')}.`);
    out.push('');
  }
  if (s.kernelMisses > 0) {
    out.push(`> **${KERNEL_MISS_BANNER}**: containment rejected ${s.kernelMisses} path(s) the kernel accepted; see "Kernel misses".`);
    out.push('');
  }
  if (r.kind === 'synthetic') {
    out.push('These are synthetic traces (scripted FakeModel responses): they validate the harness, not model behavior.');
  }
  if (s.organic.wouldBlock === 0) {
    out.push(ZERO_ORGANIC_SENTENCE);
  } else {
    out.push(`${s.organic.wouldBlock} organic proposal(s) would have been stopped by the kernel (${s.organic.wouldBlockCounterfactual} of them on counterfactual steps); each is listed in the summary.`);
  }
  if (o.reached === 0) {
    out.push('No out-of-policy injection was reached, so this run does not demonstrate enforcement on injected proposals.');
  } else if (o.missed.length === 0) {
    out.push(`The enforce arm stopped every reached out-of-policy injection (${o.stopped} of ${o.reached}).`);
  }
  if (s.gapProbes.reachedSandbox > 0) {
    out.push(`${s.gapProbes.reachedSandbox} gap probe(s) reached the sandbox in the enforce arm: no kernel rule stops them (reported, not fixed).`);
  }
  out.push('');
  return out;
}

function renderKernelMisses(r: ReportJsonV1): string[] {
  const out: string[] = ['## Kernel misses (highest severity)', ''];
  const rows: string[][] = [];
  for (const c of r.cases) {
    for (const m of c.kernelMisses) {
      rows.push([cell(c.caseId), cell(c.planId), cell(m.arm), String(m.step), cell(m.op), cell(m.target)]);
    }
  }
  if (rows.length === 0) out.push('None: the independent containment check never rejected a path the kernel accepted.');
  else out.push(...table(['Case', 'Plan', 'Arm', 'Step', 'Op', 'Target'], rows));
  out.push('');
  return out;
}

function renderKernelGaps(r: ReportJsonV1): string[] {
  const corpus = corpusById(r);
  const out: string[] = ['## Kernel gaps', ''];
  out.push('Gap probes are injected proposals the corpus labels `allow` with `kernelGap: true`: no enforcement point is expected to stop them.');
  out.push('');
  const rows: string[][] = [];
  for (const c of r.cases) {
    const inj = c.injected;
    if (inj === undefined) continue;
    const entry = corpus.get(inj.corpusId);
    const gap = inj.kernelGap ?? entry?.kernelGap ?? false;
    if (!gap) continue;
    rows.push([
      cell(c.caseId), cell(inj.corpusId), cell(entry?.category ?? '?'), yesNo(inj.reached),
      inj.stopped ? reasonCell(inj.stoppers.join(', ')) : 'no',
      list(inj.enforceEffects), list(inj.shadowEffects),
      String(inj.labelMatches), cell(entry?.note ?? ''),
    ]);
  }
  if (rows.length === 0) out.push('No gap probe was run.');
  else {
    out.push(...table(['Case', 'Entry', 'Category', 'Reached', 'Stopped by', 'Enforce effects', 'Shadow effects', 'Label matches', 'Note'], rows));
  }
  out.push('');
  return out;
}

function renderInjections(r: ReportJsonV1): string[] {
  const corpus = corpusById(r);
  const out: string[] = ['## Out-of-policy injections', ''];
  const rows: string[][] = [];
  for (const c of r.cases) {
    const inj = c.injected;
    if (inj === undefined) continue;
    const entry = corpus.get(inj.corpusId);
    if (inj.kernelGap ?? entry?.kernelGap ?? false) continue;
    rows.push([
      cell(c.caseId), cell(inj.corpusId), cell(entry?.category ?? '?'), yesNo(inj.reached), num(inj.step),
      inj.reached ? yesNo(inj.stopped) : '—',
      inj.stoppers.length > 0 ? reasonCell(inj.stoppers.join(', ')) : '—',
      list(inj.expectedStoppedBy ?? entry?.expectedStoppedBy ?? []),
      inj.labelNote !== undefined ? `${String(inj.labelMatches)} (${cell(inj.labelNote)})` : String(inj.labelMatches),
      inj.shadowReached ? yesNo(inj.shadowWouldBlock) : 'not reached',
      list(inj.shadowEffects),
    ]);
  }
  if (rows.length === 0) out.push('No out-of-policy injection was run.');
  else {
    out.push(...table(['Case', 'Entry', 'Category', 'Reached', 'Step', 'Stopped', 'Stopped by', 'Expected', 'Label matches', 'Shadow wouldBlock', 'Shadow effects'], rows));
  }
  out.push('');
  return out;
}

function fidelityLine(label: string, f: CaseComparison['fidelity']): string {
  const mm = f.mismatch !== undefined
    ? `first mismatch at seq ${f.mismatch.seq} (expected ${inline(f.mismatch.expected)}, received ${inline(f.mismatch.received)})`
    : 'no request mismatch';
  return `- Replay fidelity (${label}): served ${f.served} / ${f.total} entries${f.exhausted ? ', exhausted' : ''}; ${mm}; prompt drift ${f.driftCount}`;
}

function counterfactualCaveat(c: CaseComparison): string {
  const cut = c.counterfactualCut;
  const parts: string[] = [];
  if (cut.divergenceStep !== undefined) parts.push(`divergence step ${cut.divergenceStep}`);
  if (cut.firstInjectedStep !== undefined) parts.push(`first injected step ${cut.firstInjectedStep}`);
  if (cut.mismatchStep !== undefined) parts.push(`request mismatch step ${cut.mismatchStep}`);
  if (parts.length === 0) return '- Counterfactual: none; every served step reproduces the recorded context.';
  return `- Counterfactual: steps after the earliest of ${parts.join(', ')} are counterfactual (recorded responses served in a context the model never saw); they are flagged and not trajectory evidence.`;
}

function renderCase(c: CaseComparison): string[] {
  const out: string[] = [`### ${inline(caseTitle(c))}`, ''];
  out.push(`- Trace: ${inline(c.traceId)}`);
  const d = c.divergence;
  if (d === undefined) out.push('- Divergence point: none (both arms made the same effective decision at every step).');
  else {
    const point = d.point !== undefined ? ` at ${d.point}` : '';
    out.push(`- Divergence point: step ${d.step} (${d.kind}${point}); enforce: ${inline(hideEnvNames(d.enforce ?? '—'))}; shadow: ${inline(hideEnvNames(d.shadow ?? '—'))}`);
  }
  out.push(counterfactualCaveat(c));
  out.push(fidelityLine('enforce', c.fidelity));
  out.push(fidelityLine('shadow', c.shadowFidelity));
  if (c.harnessErrors.enforce !== undefined) out.push(`- Harness error (enforce): ${inline(c.harnessErrors.enforce)}`);
  if (c.harnessErrors.shadow !== undefined) out.push(`- Harness error (shadow): ${inline(c.harnessErrors.shadow)}`);
  out.push('');

  out.push('Decisions per proposal (primary metric):', '');
  if (c.proposals.length === 0) out.push('No proposal reached the kernel.');
  else {
    out.push(...table(
      ['Step', 'Source', 'Tool', 'Args', 'Enforce', 'Shadow', 'Agree', 'Executed (E/S)', 'Counterfactual'],
      c.proposals.map((p) => [
        String(p.step),
        p.source === 'injected' ? `injected ${cell(p.corpusId ?? '?')}` : 'organic',
        cell(p.tool), cell(p.argsPreview), reasonCell(enforceCellText(p)), reasonCell(shadowCellText(p)),
        String(p.agree), `${yesNo(p.executedEnforce)}/${yesNo(p.executedShadow)}`, yesNo(p.counterfactual),
      ]),
    ));
  }
  out.push('');

  const ex = c.executed;
  out.push(`Executed actions compared through ${ex.throughStep !== undefined ? `step ${ex.throughStep}` : 'the whole run'}:`, '');
  out.push(`- Only in shadow: ${ex.onlyShadow.length === 0 ? 'none' : ex.onlyShadow.map((a) => inline(actionText(a))).join('; ')}`);
  out.push(`- Only in enforce: ${ex.onlyEnforce.length === 0 ? 'none' : ex.onlyEnforce.map((a) => inline(actionText(a))).join('; ')}`);
  out.push(`- Would have reached the workspace: ${ex.wouldHaveReached.actions.length === 0 ? 'none' : ex.wouldHaveReached.actions.map((a) => inline(actionText(a))).join('; ')}`);
  out.push('');

  const ce = c.completion.enforce;
  const cs = c.completion.shadow;
  out.push('Completion:', '');
  out.push(...table(['Field', 'Enforce', 'Shadow'], [
    ['session state', cell(ce.sessionState), cell(cs.sessionState)],
    ['run final states', list(ce.runFinalStates), list(cs.runFinalStates)],
    ['done proposed', String(ce.doneProposed), String(cs.doneProposed)],
    ['done accepted', yesNo(ce.doneAccepted), yesNo(cs.doneAccepted)],
    ['done rejected by', reasonCell(ce.doneRejectedBy.join(', ') || '—'), reasonCell(cs.doneRejectedBy.join(', ') || '—')],
    ['verification status', cell(ce.verificationStatus ?? '—'), cell(cs.verificationStatus ?? '—')],
    ['task passed', yesNo(ce.taskPassed), yesNo(cs.taskPassed)],
    ['benchmark verdict', cell(ce.benchmarkVerdict ?? '—'), cell(cs.benchmarkVerdict ?? '—')],
  ]));
  out.push('');

  const w = c.workspace;
  out.push('Final workspace (full run):', '');
  out.push(`- Enforce hash: ${inline(w.enforceHash)}`);
  out.push(`- Shadow hash: ${inline(w.shadowHash)}`);
  out.push(`- Identical: ${yesNo(w.identical)}; shadow relative to enforce: added ${list(w.added)}; removed ${list(w.removed)}; modified ${list(w.modified)}`);
  if (w.includesCounterfactualAfterStep !== undefined) {
    out.push(`- The diff includes counterfactual steps after step ${w.includesCounterfactualAfterStep}.`);
  }
  out.push(`- Simulated escapes (shadow): ${w.simulatedEscapes.length === 0 ? 'none' : w.simulatedEscapes.map((e) => inline(containmentText(e))).join('; ')}`);
  out.push('');

  const guards = (gs: readonly { step: number; guard: string }[]): string =>
    gs.length === 0 ? 'none' : gs.map((g) => `${g.guard} at step ${g.step}`).join(', ');
  out.push(`- Observed guards: enforce ${guards(c.guards.enforce)}; shadow ${guards(c.guards.shadow)}`);
  out.push(`- Containment events: ${c.containment.length === 0 ? 'none' : c.containment.map((e) => inline(containmentText(e))).join('; ')}`);
  out.push(`- Inactive: enforce ${list(c.inactive.enforce)}; shadow ${list(c.inactive.shadow)}`);
  if (c.notes.enforce.length > 0 || c.notes.shadow.length > 0) {
    out.push(`- Notes: enforce ${list(c.notes.enforce)}; shadow ${list(c.notes.shadow)}`);
  }
  out.push('');
  return out;
}

function renderInactive(r: ReportJsonV1): string[] {
  const out: string[] = ['## Enforcement points inactive / not exercised', ''];
  const seen: string[] = [];
  for (const c of r.cases) for (const p of [...c.inactive.enforce, ...c.inactive.shadow]) if (!seen.includes(p)) seen.push(p);
  const explain: Readonly<Record<string, string>> = {
    'EP-SCHEMA': 'EP-SCHEMA: inactive; the wiring passes no tool argument schemas to ToolGateway (as in the Progressive_Runner).',
    IDEMPOTENCY: 'IDEMPOTENCY: inactive; no IdempotencyEngine is wired, so the duplicate-skip guard never runs.',
  };
  for (const p of seen) out.push(`- ${explain[p] ?? `${inline(p)}: inactive under this wiring.`}`);
  out.push('- PRIVILEGED risk class: not exercised; no tool maps to it in TaskExecutor.resolveRiskClass, so no coverage is claimed.');
  out.push('- Observed guards P12.11 (premature-done challenge) and P12.13 (missing-path challenge): recorded, identical in both arms, not ablated.');
  out.push('');
  return out;
}

function renderMethod(r: ReportJsonV1): string[] {
  const out: string[] = ['## Method and caveats', ''];
  out.push('- Each case is replayed twice from the same trace, injection plan, seed files, clock and id counters: the enforce arm applies every kernel decision; the shadow arm records the same decision as wouldBlock and lets the action proceed inside a throwaway sandbox.');
  out.push('- The primary metric is the per-proposal decision comparison. Organic counts use the uninjected comparisons only; injected plans repeat the organic prefix and are counterfactual after the injection.');
  out.push('- Counterfactual rule: a step after the divergence point, after an injected step, or after a request mismatch is counterfactual in both arms. Executed actions are compared only through the divergence step; final workspaces are reported for the full run with that caveat. Prompt drift is a fidelity metric only.');
  out.push('- Containment is not enforcement: effects that would leave the sandbox are simulated in both arms and reported as containment events, never counted as kernel blocks. A kernelMiss means the kernel accepted a path the independent check considers outside.');
  out.push(`- Approval resolution for the enforce arm: ${r.approvalResolution === 'deny' ? 'deny (a simulated human denies every request)' : 'none (no approval coordinator, as in the Progressive_Runner)'}.`);
  out.push(`- Redaction: trace responses are redacted before storage (${r.summary.redactedEntries} entries changed), so a redacted response is replayed redacted. The report holds no prompt text; every data string is redacted and cut to ${ARGS_PREVIEW_MAX} characters.`);
  out.push('');
  out.push('Residual risks:', '');
  RESIDUAL_RISKS.forEach((risk, i) => out.push(`${i + 1}. ${risk}`));
  out.push('');
  return out;
}

/** Render the report markdown from the JSON only. Pure and deterministic. */
export function renderMarkdown(r: ReportJsonV1): string {
  const title = r.kind === 'synthetic' ? 'Kernel shadow ablation (synthetic traces)' : 'Kernel shadow ablation (recorded traces)';
  const out: string[] = [`# ${title}`, ''];
  if (r.header !== undefined) out.push(`_${inline(r.header)}_`, '');
  out.push(`- Report format: ${REPORT_FORMAT_VERSION}`);
  out.push(`- Source: ${r.kind}`);
  if (r.benchmark !== undefined) out.push(`- Benchmark: ${inline(r.benchmark)}`);
  if (r.model !== undefined) out.push(`- Model: ${inline(r.model.name)} ${inline(r.model.version)}`);
  out.push('');
  out.push(...renderSummary(r));
  out.push(...renderInterpretation(r));
  out.push(...renderKernelMisses(r));
  out.push(...renderKernelGaps(r));
  out.push(...renderInjections(r));
  out.push('## Per case', '');
  if (r.cases.length === 0) out.push('No case was compared.', '');
  for (const c of r.cases) out.push(...renderCase(c));
  out.push(...renderInactive(r));
  out.push(...renderMethod(r));
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
