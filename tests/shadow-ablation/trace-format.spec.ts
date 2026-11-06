/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation — trace format (C1) and RecordingModelGateway (C2), Properties 1–2.
//
// Property 1 round-trips generated valid traces through serializeTrace/parseTrace and rejects
// generated single-field corruptions with a TraceFormatError naming the file and the field path.
// Property 2 records generated sessions through a RecordingModelGateway over the real FakeModel
// with secrets (one generator per infrastructure REDACTION_RULES shape) embedded in raw responses
// and ModelError messages, and prompts carrying unique markers; the serialized trace must contain
// neither. Examples cover `concurrent`, writeTraceFile, identity passthrough and traceFileName.
//
// Requirements 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelError,
  type AutonomyLevel,
  type ModelErrorCode,
  type ModelGateway,
  type ModelIdentity,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
} from '@codeforge/agent-core';
import { REDACTION_RULES } from '@codeforge/infrastructure';
import { FakeModel } from '@codeforge/testing';
import {
  RecordingModelGateway,
  TRACE_FORMAT_VERSION,
  TraceFormatError,
  parseTrace,
  serializeTrace,
  traceFileName,
  writeTraceFile,
  type ModelTraceV1,
  type TraceEntry,
  type TraceOutcome,
  type TraceSource,
  type TraceWiring,
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

// ── shared generators ─────────────────────────────────────────────────────────────────────────

// Local copies of the agent-core unions (agent-core exports the types only).
const PURPOSES: readonly ModelPurpose[] = [
  'plan',
  'critique',
  'replan',
  'execute',
  'analyze_failure',
  'summarize',
  'architect',
];
const ERROR_CODES: readonly ModelErrorCode[] = [
  'MODEL_OUTPUT_INVALID',
  'MODEL_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'MODEL_CONTEXT_OVERFLOW',
  'MODEL_TOOL_CALL_INVALID',
];
const AUTONOMY: readonly AutonomyLevel[] = ['full', 'edits', 'readonly'];
const INTERACTION: readonly TraceWiring['interaction'][] = ['off', 'assume', 'ask'];

const ALNUM = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
/** Includes JSON-hostile characters so the round trip exercises escaping. */
const TEXT_POOL = [...'abcXYZ019 _-.:/{}[],', '"', '\\', '\n', '\t', '\r', '\u0000', 'é', '日', '😀'];

function genChars(rng: Rng, alphabet: readonly string[], min: number, max: number): string {
  const len = int(rng, min, max);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, alphabet);
  return out;
}
function genText(rng: Rng, min: number, max: number): string {
  return genChars(rng, TEXT_POOL, min, max);
}
function genSha(rng: Rng): string {
  return genChars(rng, [...'0123456789abcdef'], 64, 64);
}
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const IDENTITY: ModelIdentity = { name: 'qwen-test', version: '1.2.3', endpoint: 'http://127.0.0.1:11434' };
const WIRING: TraceWiring = { autonomy: 'full', maxToolCalls: 12, recovery: 'full', interaction: 'off', lsp: false };

function genOutcome(rng: Rng): TraceOutcome {
  if (bool(rng, 0.3)) return { kind: 'error', code: pick(rng, ERROR_CODES), message: genText(rng, 0, 40) };
  return {
    kind: 'response',
    raw: genText(rng, 0, 80),
    ...(bool(rng) ? { promptTokens: int(rng, 0, 100_000) } : {}),
    ...(bool(rng) ? { outputTokens: int(rng, 0, 100_000) } : {}),
  };
}

function genEntry(rng: Rng, seq: number): TraceEntry {
  return {
    seq,
    purpose: pick(rng, PURPOSES),
    ...(bool(rng) ? { contextSnapshotId: `snap-${genText(rng, 0, 12)}` } : {}),
    promptSha256: genSha(rng),
    outcome: genOutcome(rng),
    redacted: bool(rng),
  };
}

function genSource(rng: Rng): TraceSource {
  return {
    kind: pick(rng, ['recorded', 'synthetic'] as const),
    ...(bool(rng) ? { benchmark: `benchmarks/${genText(rng, 0, 12)}/benchmark.json` } : {}),
    ...(bool(rng) ? { caseId: genText(rng, 0, 16) } : {}),
    ...(bool(rng) ? { split: pick(rng, ['train', 'holdout'] as const) } : {}),
    model: { name: genText(rng, 0, 12), version: genText(rng, 0, 8), endpoint: genText(rng, 0, 20) },
    ...(bool(rng) ? { recordedAt: '2026-03-11T15:00:00.000Z' } : {}),
  };
}

function genTrace(rng: Rng): ModelTraceV1 {
  const n = int(rng, 0, 6);
  const entries = Array.from({ length: n }, (_, i) => genEntry(rng, i));
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    traceId: bool(rng) ? `synthetic:${genText(rng, 0, 10)}` : genText(rng, 0, 16),
    source: genSource(rng),
    wiring: {
      autonomy: pick(rng, AUTONOMY),
      maxToolCalls: int(rng, 0, 64),
      recovery: bool(rng) ? pick(rng, ['full', 'none', 'no-recovery', 'no-replan']) : genText(rng, 0, 10),
      interaction: pick(rng, INTERACTION),
      lsp: bool(rng),
    },
    redaction: { applied: true, redactedEntries: int(rng, 0, n) },
    concurrent: bool(rng),
    entries,
  };
}

function req(purpose: ModelPurpose, systemPrompt: string, taskPrompt: string, snapshot?: string): ModelRequest {
  return {
    purpose,
    ...(snapshot !== undefined ? { contextSnapshotId: snapshot } : {}),
    systemPrompt,
    taskPrompt,
    maxOutputTokens: 512,
    temperature: 0,
  };
}

// ── Property 1: corruption model ─────────────────────────────────────────────────────────────

type Key = string | number;
type Kind = 'str' | 'int' | 'bool' | 'obj' | 'arr' | 'enum' | 'sha' | 'version' | 'applied';

interface FieldSpec {
  readonly path: readonly Key[];
  readonly kind: Kind;
  readonly required: boolean;
}

/** `['entries', 2, 'seq']` → `entries[2].seq` (the parser's field-path syntax). */
function fieldPath(path: readonly Key[]): string {
  return path.map((k, i) => (typeof k === 'number' ? `[${k}]` : i === 0 ? k : `.${k}`)).join('');
}

/** Every field present in `t` that the parser validates. */
function fieldSpecs(t: ModelTraceV1): FieldSpec[] {
  const f = (path: Key[], kind: Kind, required = true): FieldSpec => ({ path, kind, required });
  const specs: FieldSpec[] = [
    f(['formatVersion'], 'version'),
    f(['traceId'], 'str'),
    f(['source'], 'obj'),
    f(['source', 'kind'], 'enum'),
    f(['source', 'model'], 'obj'),
    f(['source', 'model', 'name'], 'str'),
    f(['source', 'model', 'version'], 'str'),
    f(['source', 'model', 'endpoint'], 'str'),
    f(['wiring'], 'obj'),
    f(['wiring', 'autonomy'], 'enum'),
    f(['wiring', 'maxToolCalls'], 'int'),
    f(['wiring', 'recovery'], 'str'),
    f(['wiring', 'interaction'], 'enum'),
    f(['wiring', 'lsp'], 'bool'),
    f(['redaction'], 'obj'),
    f(['redaction', 'applied'], 'applied'),
    f(['redaction', 'redactedEntries'], 'int'),
    f(['concurrent'], 'bool'),
    f(['entries'], 'arr'),
  ];
  if (t.source.benchmark !== undefined) specs.push(f(['source', 'benchmark'], 'str', false));
  if (t.source.caseId !== undefined) specs.push(f(['source', 'caseId'], 'str', false));
  if (t.source.split !== undefined) specs.push(f(['source', 'split'], 'enum', false));
  if (t.source.recordedAt !== undefined) specs.push(f(['source', 'recordedAt'], 'str', false));
  t.entries.forEach((e, i) => {
    const p = (...rest: Key[]): Key[] => ['entries', i, ...rest];
    specs.push(
      f(p(), 'obj', false), // an entry cannot be "missing"; removal is a seq gap (below)
      f(p('seq'), 'int'),
      f(p('purpose'), 'enum'),
      f(p('promptSha256'), 'sha'),
      f(p('outcome'), 'obj'),
      f(p('outcome', 'kind'), 'enum'),
      f(p('redacted'), 'bool'),
    );
    if (e.contextSnapshotId !== undefined) specs.push(f(p('contextSnapshotId'), 'str', false));
    if (e.outcome.kind === 'error') {
      specs.push(f(p('outcome', 'code'), 'enum'), f(p('outcome', 'message'), 'str'));
    } else {
      specs.push(f(p('outcome', 'raw'), 'str'));
      if (e.outcome.promptTokens !== undefined) specs.push(f(p('outcome', 'promptTokens'), 'int', false));
      if (e.outcome.outputTokens !== undefined) specs.push(f(p('outcome', 'outputTokens'), 'int', false));
    }
  });
  return specs;
}

const WRONG_TYPE: Record<Kind, readonly unknown[]> = {
  str: [42, true, null, {}, []],
  enum: [7, false, null, ['plan']],
  int: [-1, 1.5, '3', true, null],
  bool: ['true', 0, null, {}],
  obj: ['x', 1, [], null],
  arr: ['x', 1, {}, null],
  sha: [1, null],
  version: [1, null, {}],
  applied: [false, 'true', 1, null],
};

type Json = Record<string, unknown> | unknown[];

function parentOf(root: Json, path: readonly Key[]): Record<Key, unknown> {
  let cur: unknown = root;
  for (const k of path.slice(0, -1)) cur = (cur as Record<Key, unknown>)[k];
  return cur as Record<Key, unknown>;
}

interface Corruption {
  readonly label: string;
  readonly field: string;
  readonly apply: (root: Record<string, unknown>) => void;
}

/** Generate one single-field corruption of `t` together with the field the parser must name. */
function genCorruption(rng: Rng, t: ModelTraceV1): Corruption {
  const n = t.entries.length;
  const choices: Array<() => Corruption> = [];
  const specs = fieldSpecs(t);

  // wrong version
  choices.push(() => {
    const v = pick(rng, ['codeforge.model-trace/2', 'codeforge.model-trace/0', '', 'codeforge.model-trace']);
    return {
      label: `formatVersion=${JSON.stringify(v)}`,
      field: 'formatVersion',
      apply: (root) => {
        root['formatVersion'] = v;
      },
    };
  });
  // missing required field
  choices.push(() => {
    const spec = pick(rng, specs.filter((s) => s.required));
    return {
      label: `delete ${fieldPath(spec.path)}`,
      field: fieldPath(spec.path),
      apply: (root) => {
        delete parentOf(root, spec.path)[spec.path[spec.path.length - 1] as Key];
      },
    };
  });
  // wrong type
  choices.push(() => {
    const spec = pick(rng, specs);
    const v = pick(rng, WRONG_TYPE[spec.kind]);
    return {
      label: `${fieldPath(spec.path)}=${JSON.stringify(v)}`,
      field: fieldPath(spec.path),
      apply: (root) => {
        parentOf(root, spec.path)[spec.path[spec.path.length - 1] as Key] = v;
      },
    };
  });
  // unknown enum value
  choices.push(() => {
    const spec = pick(rng, specs.filter((s) => s.kind === 'enum'));
    const v = pick(rng, ['zz-unknown', 'PLAN', 'reply', 'Full', '']);
    return {
      label: `${fieldPath(spec.path)}=${JSON.stringify(v)}`,
      field: fieldPath(spec.path),
      apply: (root) => {
        parentOf(root, spec.path)[spec.path[spec.path.length - 1] as Key] = v;
      },
    };
  });
  if (n > 0) {
    // seq gap: shift one seq, or drop a non-last entry so the next one sits at the wrong index
    choices.push(() => {
      const i = int(rng, 0, n - 1);
      const v = pick(rng, [i + 1, i + 2, i + 100, ...(i > 0 ? [i - 1] : [])]);
      return {
        label: `entries[${i}].seq=${v}`,
        field: `entries[${i}].seq`,
        apply: (root) => {
          ((root['entries'] as Array<Record<string, unknown>>)[i] as Record<string, unknown>)['seq'] = v;
        },
      };
    });
    if (n > 1) {
      choices.push(() => {
        const j = int(rng, 0, n - 2);
        return {
          label: `splice entries[${j}]`,
          field: `entries[${j}].seq`,
          apply: (root) => {
            (root['entries'] as unknown[]).splice(j, 1);
          },
        };
      });
    }
    // bad sha
    choices.push(() => {
      const i = int(rng, 0, n - 1);
      const sha = (t.entries[i] as TraceEntry).promptSha256;
      const v = pick(rng, [sha.slice(1), `${sha}0`, `g${sha.slice(1)}`, 'A'.repeat(64), '', ` ${sha.slice(1)}`]);
      return {
        label: `entries[${i}].promptSha256=${JSON.stringify(v)}`,
        field: `entries[${i}].promptSha256`,
        apply: (root) => {
          ((root['entries'] as Array<Record<string, unknown>>)[i] as Record<string, unknown>)['promptSha256'] = v;
        },
      };
    });
  }
  return pick(rng, choices)();
}

describe('trace format (C1)', () => {
  // Feature: kernel-shadow-ablation, Property 1: Trace serialization round trip and validation
  it('Property 1a: parseTrace(serializeTrace(t)) deep-equals t for generated valid traces', () => {
    forAll(0x7ace01, 200, (rng) => {
      const t = genTrace(rng);
      const text = serializeTrace(t);
      expect(text.endsWith('\n')).toBe(true);
      const back = parseTrace(text, 'gen.trace.json');
      expect(back).toStrictEqual(t);
      // Serialization is stable: re-serializing the parsed value yields the same bytes.
      expect(serializeTrace(back)).toBe(text);
    });
  });

  // Feature: kernel-shadow-ablation, Property 1: Trace serialization round trip and validation
  it('Property 1b: single-field corruptions are rejected with TraceFormatError naming file and field', () => {
    forAll(0x7ace02, 400, (rng, i) => {
      const t = genTrace(rng);
      const c = genCorruption(rng, t);
      const root = JSON.parse(serializeTrace(t)) as Record<string, unknown>;
      c.apply(root);
      const file = `corrupt-${i}.trace.json`;
      let caught: unknown;
      try {
        parseTrace(JSON.stringify(root, null, 2), file);
      } catch (err) {
        caught = err;
      }
      expect(caught, `accepted corruption ${c.label}`).toBeInstanceOf(TraceFormatError);
      const e = caught as TraceFormatError;
      expect({ label: c.label, file: e.file, field: e.field }).toEqual({ label: c.label, file, field: c.field });
      expect(e.message).toContain(file);
      expect(e.message).toContain(c.field);
    });
  });

  it('rejects text that is not JSON or not an object at field `$`', () => {
    for (const bad of ['', '{', 'null', '[]', '"trace"', '42']) {
      let caught: unknown;
      try {
        parseTrace(bad, 'bad.trace.json');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TraceFormatError);
      expect((caught as TraceFormatError).field).toBe('$');
      expect((caught as TraceFormatError).file).toBe('bad.trace.json');
    }
  });
});

// ── Property 2: secrets per REDACTION_RULES shape ────────────────────────────────────────────

interface GeneratedSecret {
  /** Text embedded in the model output. */
  readonly text: string;
  /** Newline-free fragments (≥ 12 chars) that must not survive redaction. */
  readonly parts: readonly string[];
}

const URLSAFE = [...ALNUM, '_', '-'];
const TOKEN_CHARS = [...ALNUM, '.', '_', '-'];
const B64 = [...ALNUM, '+', '/'];
const UPPER_DIGIT = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];

/** One generator per REDACTION_RULES entry (keyed by rule name; coverage asserted below). */
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
    return { text: `Authorization: Bearer${pick(rng, [' ', '  ', '\t'])}${tok}`, parts: [tok] };
  },
  'private-key': (rng) => {
    // '' is the bare PKCS#8 header `-----BEGIN PRIVATE KEY-----`.
    const type = pick(rng, ['', 'RSA ', 'EC ', 'OPENSSH ', 'DSA ', 'ENCRYPTED ']);
    const lines = Array.from({ length: int(rng, 1, 4) }, () => genChars(rng, B64, 16, 64));
    const text = `-----BEGIN ${type}PRIVATE KEY-----\n${lines.join('\n')}\n-----END ${type}PRIVATE KEY-----`;
    return { text, parts: lines };
  },
  'aws-access-key': (rng) => {
    const tail = genChars(rng, UPPER_DIGIT, 16, 16);
    return { text: `AKIA${tail}`, parts: [`AKIA${tail}`, tail] };
  },
  'generic-secret': (rng) => {
    const key = pick(rng, ['password', 'Password', 'secret', 'SECRET', 'token', 'api_key', 'api-key', 'apikey', 'API_KEY']);
    const value = genChars(rng, ALNUM, 16, 32);
    const sep = pick(rng, ['=', ': ', ' = ', ':"', "='", ' : ']);
    const close = sep.endsWith('"') ? '"' : sep.endsWith("'") ? "'" : '';
    return { text: `${key}${sep}${value}${close}`, parts: [value] };
  },
  'connection-string': (rng) => {
    const scheme = pick(rng, ['postgres', 'mysql', 'mongodb', 'redis', 'POSTGRES']);
    const user = genChars(rng, ALNUM, 4, 10);
    const pass = genChars(rng, ALNUM, 12, 24);
    const host = `${genChars(rng, ALNUM, 12, 20)}.example`;
    const rest = `${user}:${pass}@${host}:${int(rng, 1000, 9999)}/db`;
    return { text: `${scheme}://${rest}`, parts: [rest, pass, host] };
  },
};

const FILLER = ['alpha', 'beta', 'gamma', 'delta', 'lorem', 'ipsum', 'patch', 'file', 'line', 'ok', '{"x":1}'];

function genFiller(rng: Rng, min: number, max: number): string[] {
  return Array.from({ length: int(rng, min, max) }, () => pick(rng, FILLER));
}

/** Filler words with `secret` at a random word position (space-separated so rule boundaries hold). */
function embed(rng: Rng, secret: string | undefined): string {
  const words = genFiller(rng, 0, 8);
  if (secret !== undefined) words.splice(int(rng, 0, words.length), 0, secret);
  return words.join(' ');
}

describe('RecordingModelGateway (C2) — redaction and prompt digests', () => {
  it('the secret generators cover every REDACTION_RULES shape, and each output matches its rule', () => {
    expect(Object.keys(SECRET_SHAPES).sort()).toEqual(REDACTION_RULES.map((r) => r.name).sort());
    forAll(0x5ec001, 100, (rng) => {
      for (const rule of REDACTION_RULES) {
        const s = (SECRET_SHAPES[rule.name] as (r: Rng) => GeneratedSecret)(rng);
        expect(new RegExp(rule.pattern.source, rule.pattern.flags).test(s.text), `${rule.name}: ${s.text}`).toBe(true);
        for (const p of s.parts) expect(p.length).toBeGreaterThanOrEqual(12);
      }
    });
  });

  // Feature: kernel-shadow-ablation, Property 2: No secret and no prompt text in a trace
  it('Property 2: serialized traces contain no generated secret and no prompt marker', async () => {
    const shapeNames = Object.keys(SECRET_SHAPES);
    await forAllAsync(0x5ec002, 120, async (rng, iteration) => {
      const fake = new FakeModel();
      const rec = new RecordingModelGateway(fake, {
        source: { kind: 'recorded', benchmark: 'benchmarks/codeforge-progressive/benchmark.json', model: fake.identity },
        wiring: WIRING,
        traceId: `case-${iteration}`,
      });
      const calls = int(rng, 1, 6);
      const markers: string[] = [];
      const prompts: string[] = [];
      const secretParts: string[] = [];
      const expected: Array<{ redacted: boolean; kind: 'response' | 'error'; digest: string; purpose: ModelPurpose }> = [];

      for (let c = 0; c < calls; c++) {
        const sysMarker = `SYSMARK${genChars(rng, ALNUM, 16, 16)}`;
        const taskMarker = `TASKMARK${genChars(rng, ALNUM, 16, 16)}`;
        const systemPrompt = [...genFiller(rng, 0, 3), sysMarker, ...genFiller(rng, 0, 3)].join(' ');
        const taskPrompt = [...genFiller(rng, 0, 3), taskMarker, ...genFiller(rng, 0, 3)].join(' ');
        markers.push(sysMarker, taskMarker);
        prompts.push(systemPrompt, taskPrompt);

        const secret = bool(rng, 0.7)
          ? (SECRET_SHAPES[pick(rng, shapeNames)] as (r: Rng) => GeneratedSecret)(rng)
          : undefined;
        const payload = embed(rng, secret?.text);
        if (secret !== undefined) {
          for (const p of secret.parts) expect(payload).toContain(p); // non-vacuous
          secretParts.push(...secret.parts);
        }
        const purpose = pick(rng, PURPOSES);
        const request = req(purpose, systemPrompt, taskPrompt, bool(rng) ? `ctx-${c}` : undefined);
        const isError = bool(rng, 0.3);
        if (isError) {
          const err = new ModelError(pick(rng, ERROR_CODES), payload);
          fake.setError(err);
          await expect(rec.generate(request)).rejects.toBe(err);
        } else {
          fake.setSequence([payload]);
          const res = await rec.generate(request);
          expect(res.raw).toBe(payload); // caller still sees the unredacted inner response
        }
        expected.push({
          redacted: secret !== undefined,
          kind: isError ? 'error' : 'response',
          digest: sha256(`${systemPrompt}\u0000${taskPrompt}`),
          purpose,
        });
      }

      const t = rec.trace();
      const text = serializeTrace(t);
      const stored = t.entries.map((e) => (e.outcome.kind === 'error' ? e.outcome.message : e.outcome.raw));

      for (const m of markers) expect(text, `prompt marker ${m} leaked`).not.toContain(m);
      for (const p of prompts) expect(text).not.toContain(JSON.stringify(p).slice(1, -1));
      for (const s of secretParts) {
        expect(text, `secret fragment ${s} leaked`).not.toContain(s);
        for (const v of stored) expect(v).not.toContain(s);
      }

      expect(t.entries.map((e) => e.seq)).toEqual(expected.map((_, i) => i));
      expect(t.entries.map((e) => e.purpose)).toEqual(expected.map((x) => x.purpose));
      expect(t.entries.map((e) => e.outcome.kind)).toEqual(expected.map((x) => x.kind));
      expect(t.entries.map((e) => e.promptSha256)).toEqual(expected.map((x) => x.digest));
      expect(t.entries.map((e) => e.redacted)).toEqual(expected.map((x) => x.redacted));
      expect(t.redaction).toEqual({ applied: true, redactedEntries: expected.filter((x) => x.redacted).length });
      expect(t.concurrent).toBe(false);
      // The recorded trace is itself a valid trace file.
      expect(parseTrace(text, 'recorded.trace.json')).toStrictEqual(t);
    });
  });
});

// ── examples ─────────────────────────────────────────────────────────────────────────────────

interface Pending {
  readonly request: ModelRequest;
  readonly resolve: (r: ModelResponse) => void;
  readonly reject: (e: unknown) => void;
}

/** Inner gateway whose calls settle only when the test says so. */
class DeferredGateway implements ModelGateway {
  readonly identity: ModelIdentity = IDENTITY;
  readonly pending: Pending[] = [];
  generate(request: ModelRequest): Promise<ModelResponse> {
    return new Promise((resolve, reject) => this.pending.push({ request, resolve, reject }));
  }
  at(i: number): Pending {
    const p = this.pending[i];
    if (p === undefined) throw new Error(`no pending call #${i}`);
    return p;
  }
}

function recorder(inner: ModelGateway, traceId = 'case-1'): RecordingModelGateway {
  return new RecordingModelGateway(inner, {
    source: { kind: 'recorded', caseId: traceId, split: 'train', model: inner.identity },
    wiring: WIRING,
    traceId,
  });
}

describe('RecordingModelGateway (C2) — examples', () => {
  it('marks the trace concurrent when a call starts before an earlier one settles; entries keep call order', async () => {
    const inner = new DeferredGateway();
    const rec = recorder(inner);
    const a = rec.generate(req('plan', 'sys', 'first'));
    const b = rec.generate(req('execute', 'sys', 'second'));
    expect(inner.pending).toHaveLength(2);
    inner.at(1).resolve({ raw: 'B', model: IDENTITY });
    await b;
    inner.at(0).resolve({ raw: 'A', model: IDENTITY });
    await a;
    const t = rec.trace();
    expect(t.concurrent).toBe(true);
    expect(t.entries.map((e) => [e.seq, e.purpose, e.outcome.kind === 'response' ? e.outcome.raw : '']))
      .toEqual([
        [0, 'plan', 'A'],
        [1, 'execute', 'B'],
      ]);
  });

  it('sequential calls leave concurrent false', async () => {
    const inner = new DeferredGateway();
    const rec = recorder(inner);
    const a = rec.generate(req('plan', 's', 't'));
    inner.at(0).resolve({ raw: 'A', model: IDENTITY });
    await a;
    const b = rec.generate(req('critique', 's', 't'));
    inner.at(1).reject(new ModelError('MODEL_TIMEOUT', 'slow'));
    await expect(b).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    const t = rec.trace();
    expect(t.concurrent).toBe(false);
    expect(t.entries.map((e) => e.outcome)).toEqual([
      { kind: 'response', raw: 'A' },
      { kind: 'error', code: 'MODEL_TIMEOUT', message: 'slow' },
    ]);
  });

  it('exposes the inner identity unchanged', () => {
    const fake = new FakeModel();
    expect(recorder(fake).identity).toBe(fake.identity);
    const inner = new DeferredGateway();
    expect(recorder(inner).identity).toStrictEqual(IDENTITY);
  });

  describe('writeTraceFile', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'cf-trace-format-'));
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('writes one parseable file per session into a (created) directory', async () => {
      const dir = join(tmp, 'nested', 'traces');
      const sessions = ['case-a', 'synthetic:script/1'];
      const written: Array<{ path: string; trace: ModelTraceV1 }> = [];
      for (const id of sessions) {
        const fake = new FakeModel().setSequence(['{"step":1}', 'token=abcdef1234567890XYZ done']);
        const rec = recorder(fake, id);
        await rec.generate(req('plan', 'system text', `task for ${id}`));
        await rec.generate(req('execute', 'system text', `task for ${id}`, 'snap-1'));
        const path = writeTraceFile(dir, rec.trace());
        written.push({ path, trace: rec.trace() });
      }
      expect(readdirSync(dir).sort()).toEqual(sessions.map(traceFileName).sort());
      for (const { path, trace } of written) {
        expect(path).toBe(join(dir, traceFileName(trace.traceId)));
        expect(parseTrace(readFileSync(path, 'utf8'), path)).toStrictEqual(trace);
        expect(trace.redaction.redactedEntries).toBe(1);
        expect(readFileSync(path, 'utf8')).not.toContain('abcdef1234567890XYZ');
      }
    });
  });

  it('traceFileName maps every character outside [A-Za-z0-9._-] to `_`', () => {
    expect(traceFileName('case-01')).toBe('case-01.trace.json');
    expect(traceFileName('synthetic:inj/../x y')).toBe('synthetic_inj_.._x_y.trace.json');
    expect(traceFileName('')).toBe('_.trace.json');
    forAll(0xf11e, 100, (rng) => {
      const name = traceFileName(genText(rng, 0, 24));
      expect(name).toMatch(/^[A-Za-z0-9._-]+\.trace\.json$/);
      expect(name).not.toMatch(/[/\\:]/);
    });
  });
});
