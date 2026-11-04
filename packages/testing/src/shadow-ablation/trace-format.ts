/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Model trace format v1 (kernel-shadow-ablation, design C1). Measurement-only (SA-001).
//
// A Model_Trace holds, in call order, every model request purpose and the REDACTED raw response
// (or model error) of one benchmark case session. Prompts are stored as SHA-256 digests only,
// never as text (Requirement 2.3). Pure module: `node:crypto` is the only import with a runtime
// effect; no clock, no randomness, no filesystem.
import { createHash } from 'node:crypto';
import type {
  AutonomyLevel,
  ModelErrorCode,
  ModelIdentity,
  ModelPurpose,
} from '@codeforge/agent-core';

export const TRACE_FORMAT_VERSION = 'codeforge.model-trace/1' as const;

export interface TraceWiring {
  /** Progressive_Runner: 'full'. */
  readonly autonomy: AutonomyLevel;
  /** Progressive_Runner: 12. */
  readonly maxToolCalls: number;
  /** Ablation label: 'full', 'none', 'no-recovery', 'no-replan', ... (open set). */
  readonly recovery: string;
  readonly interaction: 'off' | 'assume' | 'ask';
  readonly lsp: boolean;
}

export type TraceOutcome =
  | {
      readonly kind: 'response';
      readonly raw: string;
      readonly promptTokens?: number;
      readonly outputTokens?: number;
    }
  | { readonly kind: 'error'; readonly code: ModelErrorCode; readonly message: string };

export interface TraceEntry {
  /** 0..n-1, contiguous; equals the array index. */
  readonly seq: number;
  readonly purpose: ModelPurpose;
  readonly contextSnapshotId?: string;
  /** sha256(systemPrompt + '\u0000' + taskPrompt), lowercase hex. */
  readonly promptSha256: string;
  /** raw / message already redacted. */
  readonly outcome: TraceOutcome;
  /** true if redaction changed this entry. */
  readonly redacted: boolean;
}

export interface TraceSource {
  readonly kind: 'recorded' | 'synthetic';
  readonly benchmark?: string;
  readonly caseId?: string;
  readonly split?: 'train' | 'holdout';
  readonly model: ModelIdentity;
  /** Header only; never compared. */
  readonly recordedAt?: string;
}

export interface ModelTraceV1 {
  readonly formatVersion: typeof TRACE_FORMAT_VERSION;
  /** '<caseId>' or 'synthetic:<scriptId>'. */
  readonly traceId: string;
  readonly source: TraceSource;
  readonly wiring: TraceWiring;
  readonly redaction: { readonly applied: true; readonly redactedEntries: number };
  readonly concurrent: boolean;
  readonly entries: readonly TraceEntry[];
}

/** Rejection of a trace file; names the file and the first failing field path. */
export class TraceFormatError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    message: string,
  ) {
    super(`${file}: invalid trace field '${field}': ${message}`);
    this.name = 'TraceFormatError';
  }
}

// ── Union value lists (agent-core exports the types only) ───────────────────────────────────
// `satisfies` rejects a value that is not in the union; the `Exhaustive` checks below reject a
// union member missing from the list, so drift in agent-core fails `tsc`.

const MODEL_PURPOSES = [
  'plan',
  'critique',
  'replan',
  'execute',
  'analyze_failure',
  'summarize',
  'architect',
] as const satisfies readonly ModelPurpose[];

const MODEL_ERROR_CODES = [
  'MODEL_OUTPUT_INVALID',
  'MODEL_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'MODEL_CONTEXT_OVERFLOW',
  'MODEL_TOOL_CALL_INVALID',
] as const satisfies readonly ModelErrorCode[];

const AUTONOMY_LEVELS = ['full', 'edits', 'readonly'] as const satisfies readonly AutonomyLevel[];

const INTERACTION_MODES = ['off', 'assume', 'ask'] as const satisfies readonly TraceWiring['interaction'][];
const SOURCE_KINDS = ['recorded', 'synthetic'] as const satisfies readonly TraceSource['kind'][];
const SPLITS = ['train', 'holdout'] as const satisfies readonly NonNullable<TraceSource['split']>[];

type Exhaustive<Union, List extends readonly unknown[]> = [Exclude<Union, List[number]>] extends [never]
  ? true
  : never;
const exhaustivePurposes: Exhaustive<ModelPurpose, typeof MODEL_PURPOSES> = true;
const exhaustiveErrorCodes: Exhaustive<ModelErrorCode, typeof MODEL_ERROR_CODES> = true;
const exhaustiveAutonomy: Exhaustive<AutonomyLevel, typeof AUTONOMY_LEVELS> = true;
void exhaustivePurposes;
void exhaustiveErrorCodes;
void exhaustiveAutonomy;

// ── Digest ──────────────────────────────────────────────────────────────────────────────────

/** SHA-256 (lowercase hex) of `systemPrompt + '\u0000' + taskPrompt`. */
export function promptDigest(systemPrompt: string, taskPrompt: string): string {
  return createHash('sha256').update(`${systemPrompt}\u0000${taskPrompt}`, 'utf8').digest('hex');
}

// ── Serialization (stable key order) ───────────────────────────────────────────────────────

function canonicalOutcome(o: TraceOutcome): Record<string, unknown> {
  if (o.kind === 'error') return { kind: 'error', code: o.code, message: o.message };
  const out: Record<string, unknown> = { kind: 'response', raw: o.raw };
  if (o.promptTokens !== undefined) out['promptTokens'] = o.promptTokens;
  if (o.outputTokens !== undefined) out['outputTokens'] = o.outputTokens;
  return out;
}

function canonicalEntry(e: TraceEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { seq: e.seq, purpose: e.purpose };
  if (e.contextSnapshotId !== undefined) out['contextSnapshotId'] = e.contextSnapshotId;
  out['promptSha256'] = e.promptSha256;
  out['outcome'] = canonicalOutcome(e.outcome);
  out['redacted'] = e.redacted;
  return out;
}

function canonicalSource(s: TraceSource): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: s.kind };
  if (s.benchmark !== undefined) out['benchmark'] = s.benchmark;
  if (s.caseId !== undefined) out['caseId'] = s.caseId;
  if (s.split !== undefined) out['split'] = s.split;
  out['model'] = { name: s.model.name, version: s.model.version, endpoint: s.model.endpoint };
  if (s.recordedAt !== undefined) out['recordedAt'] = s.recordedAt;
  return out;
}

/** Serialize with a fixed key order (independent of construction order), 2-space JSON + '\n'. */
export function serializeTrace(t: ModelTraceV1): string {
  const canonical = {
    formatVersion: t.formatVersion,
    traceId: t.traceId,
    source: canonicalSource(t.source),
    wiring: {
      autonomy: t.wiring.autonomy,
      maxToolCalls: t.wiring.maxToolCalls,
      recovery: t.wiring.recovery,
      interaction: t.wiring.interaction,
      lsp: t.wiring.lsp,
    },
    redaction: { applied: t.redaction.applied, redactedEntries: t.redaction.redactedEntries },
    concurrent: t.concurrent,
    entries: t.entries.map(canonicalEntry),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

// ── Parsing / validation ────────────────────────────────────────────────────────────────────

const SHA256_HEX = /^[0-9a-f]{64}$/;

type Obj = Readonly<Record<string, unknown>>;

/** Field-path-aware readers; each throws a TraceFormatError naming the first failing field. */
class Reader {
  constructor(private readonly file: string) {}

  fail(field: string, message: string): never {
    throw new TraceFormatError(this.file, field, message);
  }

  obj(v: unknown, field: string): Obj {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail(field, 'expected an object');
    return v as Obj;
  }

  str(o: Obj, key: string, path: string): string {
    const v = o[key];
    if (v === undefined) this.fail(path, 'missing required field');
    if (typeof v !== 'string') this.fail(path, 'expected a string');
    return v;
  }

  optStr(o: Obj, key: string, path: string): string | undefined {
    return o[key] === undefined ? undefined : this.str(o, key, path);
  }

  bool(o: Obj, key: string, path: string): boolean {
    const v = o[key];
    if (v === undefined) this.fail(path, 'missing required field');
    if (typeof v !== 'boolean') this.fail(path, 'expected a boolean');
    return v;
  }

  int(o: Obj, key: string, path: string): number {
    const v = o[key];
    if (v === undefined) this.fail(path, 'missing required field');
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      this.fail(path, 'expected a non-negative integer');
    }
    return v;
  }

  optInt(o: Obj, key: string, path: string): number | undefined {
    return o[key] === undefined ? undefined : this.int(o, key, path);
  }

  oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[]): T {
    const v = this.str(o, key, path);
    if (!(allowed as readonly string[]).includes(v)) {
      this.fail(path, `unknown value '${v}' (expected one of ${allowed.join(', ')})`);
    }
    return v as T;
  }

  optOneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[]): T | undefined {
    return o[key] === undefined ? undefined : this.oneOf(o, key, path, allowed);
  }
}

function parseSource(r: Reader, v: unknown): TraceSource {
  const o = r.obj(v, 'source');
  const kind = r.oneOf(o, 'kind', 'source.kind', SOURCE_KINDS);
  const benchmark = r.optStr(o, 'benchmark', 'source.benchmark');
  const caseId = r.optStr(o, 'caseId', 'source.caseId');
  const split = r.optOneOf(o, 'split', 'source.split', SPLITS);
  if (o['model'] === undefined) r.fail('source.model', 'missing required field');
  const m = r.obj(o['model'], 'source.model');
  const model: ModelIdentity = {
    name: r.str(m, 'name', 'source.model.name'),
    version: r.str(m, 'version', 'source.model.version'),
    endpoint: r.str(m, 'endpoint', 'source.model.endpoint'),
  };
  const recordedAt = r.optStr(o, 'recordedAt', 'source.recordedAt');
  return {
    kind,
    ...(benchmark !== undefined ? { benchmark } : {}),
    ...(caseId !== undefined ? { caseId } : {}),
    ...(split !== undefined ? { split } : {}),
    model,
    ...(recordedAt !== undefined ? { recordedAt } : {}),
  };
}

function parseWiring(r: Reader, v: unknown): TraceWiring {
  const o = r.obj(v, 'wiring');
  return {
    autonomy: r.oneOf(o, 'autonomy', 'wiring.autonomy', AUTONOMY_LEVELS),
    maxToolCalls: r.int(o, 'maxToolCalls', 'wiring.maxToolCalls'),
    recovery: r.str(o, 'recovery', 'wiring.recovery'),
    interaction: r.oneOf(o, 'interaction', 'wiring.interaction', INTERACTION_MODES),
    lsp: r.bool(o, 'lsp', 'wiring.lsp'),
  };
}

function parseOutcome(r: Reader, v: unknown, path: string): TraceOutcome {
  const o = r.obj(v, path);
  const kind = r.oneOf(o, 'kind', `${path}.kind`, ['response', 'error'] as const);
  if (kind === 'error') {
    return {
      kind,
      code: r.oneOf(o, 'code', `${path}.code`, MODEL_ERROR_CODES),
      message: r.str(o, 'message', `${path}.message`),
    };
  }
  const raw = r.str(o, 'raw', `${path}.raw`);
  const promptTokens = r.optInt(o, 'promptTokens', `${path}.promptTokens`);
  const outputTokens = r.optInt(o, 'outputTokens', `${path}.outputTokens`);
  return {
    kind,
    raw,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function parseEntry(r: Reader, v: unknown, index: number): TraceEntry {
  const path = `entries[${index}]`;
  const o = r.obj(v, path);
  const seq = r.int(o, 'seq', `${path}.seq`);
  if (seq !== index) r.fail(`${path}.seq`, `non-contiguous sequence number ${seq} (expected ${index})`);
  const purpose = r.oneOf(o, 'purpose', `${path}.purpose`, MODEL_PURPOSES);
  const contextSnapshotId = r.optStr(o, 'contextSnapshotId', `${path}.contextSnapshotId`);
  const promptSha256 = r.str(o, 'promptSha256', `${path}.promptSha256`);
  if (!SHA256_HEX.test(promptSha256)) r.fail(`${path}.promptSha256`, 'expected 64 lowercase hex characters');
  if (o['outcome'] === undefined) r.fail(`${path}.outcome`, 'missing required field');
  const outcome = parseOutcome(r, o['outcome'], `${path}.outcome`);
  const redacted = r.bool(o, 'redacted', `${path}.redacted`);
  return {
    seq,
    purpose,
    ...(contextSnapshotId !== undefined ? { contextSnapshotId } : {}),
    promptSha256,
    outcome,
    redacted,
  };
}

/**
 * Parse and validate a trace file's text. Throws `TraceFormatError(file, field)` on: invalid
 * JSON (field `$`), wrong `formatVersion`, a missing or mistyped required field, an unknown
 * enum value (purpose, outcome kind, error code, ...), or a `seq` that differs from its index.
 */
export function parseTrace(json: string, file: string): ModelTraceV1 {
  const r = new Reader(file);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    r.fail('$', `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const root = r.obj(data, '$');

  const version = r.str(root, 'formatVersion', 'formatVersion');
  if (version !== TRACE_FORMAT_VERSION) {
    r.fail('formatVersion', `unknown format version '${version}' (expected '${TRACE_FORMAT_VERSION}')`);
  }
  const traceId = r.str(root, 'traceId', 'traceId');
  if (root['source'] === undefined) r.fail('source', 'missing required field');
  const source = parseSource(r, root['source']);
  if (root['wiring'] === undefined) r.fail('wiring', 'missing required field');
  const wiring = parseWiring(r, root['wiring']);
  if (root['redaction'] === undefined) r.fail('redaction', 'missing required field');
  const red = r.obj(root['redaction'], 'redaction');
  if (red['applied'] !== true) r.fail('redaction.applied', 'expected true');
  const redactedEntries = r.int(red, 'redactedEntries', 'redaction.redactedEntries');
  const concurrent = r.bool(root, 'concurrent', 'concurrent');
  const rawEntries = root['entries'];
  if (rawEntries === undefined) r.fail('entries', 'missing required field');
  if (!Array.isArray(rawEntries)) r.fail('entries', 'expected an array');
  const entries = (rawEntries as readonly unknown[]).map((e, i) => parseEntry(r, e, i));

  return {
    formatVersion: TRACE_FORMAT_VERSION,
    traceId,
    source,
    wiring,
    redaction: { applied: true, redactedEntries },
    concurrent,
    entries,
  };
}
