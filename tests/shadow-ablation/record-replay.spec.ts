/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation — RecordingModelGateway / ReplayModelGateway (design C2–C3,
// Properties 3–5). Requirements 1.1, 1.2, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6.
//
// The inner gateway is the real `FakeModel` (sequence + `setError`); traces for the replay-only
// properties are generated directly in the v1 format. No mocks: every assertion observes the real
// gateways' return values, thrown errors and `status()`.
import { describe, it, expect } from 'vitest';
import {
  ModelError,
  type ModelErrorCode,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
} from '@codeforge/agent-core';
import { redact } from '@codeforge/infrastructure';
import { FakeModel } from '@codeforge/testing';
import {
  DecisionLedger,
  RecordingModelGateway,
  ReplayModelGateway,
  REPLAY_EXHAUSTED,
  REPLAY_MISMATCH,
  TRACE_FORMAT_VERSION,
  promptDigest,
  type InjectionAt,
  type ModelTraceV1,
  type ServedStep,
  type TraceEntry,
  type TraceOutcome,
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
/** Async `forAll`: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(seed: number, runs: number, body: (rng: Rng, iteration: number) => Promise<void>): Promise<void> {
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

const RUNS = 120;

// ── generators ──────────────────────────────────────────────────────────────────────────────

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
// Plain words: nothing secret-shaped, so redaction is a no-op on generated text (still compared
// through `redact` below, so a change in the Redactor cannot make the property lie).
const WORDS = ['alpha', 'beta', 'read', 'file', 'src', 'ok', 'tool', 'done', 'plan', 'step', '{', '}', ':', '"x"'];

function genText(rng: Rng, min: number, max: number): string {
  const n = int(rng, min, max);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(rng, WORDS));
  return out.join(' ');
}

/** Purpose generator biased toward `execute` (the purpose injections and onStep care about). */
function genPurpose(rng: Rng): ModelPurpose {
  return bool(rng, 0.45) ? 'execute' : pick(rng, PURPOSES);
}

function genRequest(rng: Rng, purpose: ModelPurpose): ModelRequest {
  return {
    purpose,
    systemPrompt: genText(rng, 0, 4),
    taskPrompt: genText(rng, 1, 6),
    ...(bool(rng, 0.6) ? { contextSnapshotId: `snap-${int(rng, 0, 5)}` } : {}),
    maxOutputTokens: 256,
    temperature: 0,
  };
}

const IDENTITY = { name: 'trace-model', version: '1.0.0', endpoint: 'fake://trace' };

function makeTrace(entries: readonly TraceEntry[]): ModelTraceV1 {
  return {
    formatVersion: TRACE_FORMAT_VERSION,
    traceId: 'synthetic:record-replay',
    source: { kind: 'synthetic', model: IDENTITY },
    wiring: { autonomy: 'full', maxToolCalls: 12, recovery: 'full', interaction: 'off', lsp: false },
    redaction: { applied: true, redactedEntries: 0 },
    concurrent: false,
    entries,
  };
}

/** A trace entry plus the request that "produced" it (so replays can send matching requests). */
interface GenEntry {
  readonly entry: TraceEntry;
  readonly request: ModelRequest;
}

function genTrace(rng: Rng, maxLen: number, pError = 0.2): GenEntry[] {
  const n = int(rng, 0, maxLen);
  const out: GenEntry[] = [];
  for (let seq = 0; seq < n; seq++) {
    const request = genRequest(rng, genPurpose(rng));
    const outcome: TraceOutcome = bool(rng, pError)
      ? { kind: 'error', code: pick(rng, ERROR_CODES), message: `err-${seq}-${genText(rng, 0, 2)}` }
      : { kind: 'response', raw: `R${seq}: ${genText(rng, 0, 5)}` };
    out.push({
      entry: {
        seq,
        purpose: request.purpose,
        ...(request.contextSnapshotId !== undefined ? { contextSnapshotId: request.contextSnapshotId } : {}),
        promptSha256: promptDigest(request.systemPrompt, request.taskPrompt),
        outcome,
        redacted: false,
      },
      request,
    });
  }
  return out;
}

type Settled = { readonly ok: true; readonly res: ModelResponse } | { readonly ok: false; readonly err: unknown };

async function settle(gw: { generate(r: ModelRequest): Promise<ModelResponse> }, req: ModelRequest): Promise<Settled> {
  try {
    return { ok: true, res: await gw.generate(req) };
  } catch (err) {
    return { ok: false, err };
  }
}

function modelErr(s: Settled): ModelError {
  if (s.ok) throw new Error(`expected a ModelError, got response ${JSON.stringify(s.res.raw)}`);
  if (!(s.err instanceof ModelError)) throw new Error(`expected a ModelError, got ${String(s.err)}`);
  return s.err;
}

function okRaw(s: Settled): string {
  if (!s.ok) throw new Error(`expected a response, got ${String(s.err)}`);
  return s.res.raw;
}

// ── Property 3 ──────────────────────────────────────────────────────────────────────────────

describe('RecordingModelGateway + ReplayModelGateway', () => {
  // Feature: kernel-shadow-ablation, Property 3: Recording is transparent and replay reproduces it
  // **Validates: Requirements 1.1, 1.2, 3.1**
  it('Property 3: recording is transparent and replay reproduces it', async () => {
    await forAllAsync(0x5a3c0003, RUNS, async (rng) => {
      const n = int(rng, 0, 12);
      // Script: per call, a response raw or a ModelError (the same instance goes to both fakes).
      const script: Array<{ request: ModelRequest; error?: ModelError; raw?: string }> = [];
      for (let i = 0; i < n; i++) {
        const request = genRequest(rng, genPurpose(rng));
        if (bool(rng, 0.25)) {
          script.push({ request, error: new ModelError(pick(rng, ERROR_CODES), `inner-err-${i} ${genText(rng, 0, 2)}`) });
        } else {
          script.push({ request, raw: `resp-${i} ${genText(rng, 0, 6)}` });
        }
      }
      const raws = script.flatMap((s) => (s.raw !== undefined ? [s.raw] : []));
      const bare = new FakeModel().setSequence(raws);
      const inner = new FakeModel().setSequence(raws);
      const rec = new RecordingModelGateway(inner, {
        source: { kind: 'synthetic', model: inner.identity },
        wiring: { autonomy: 'full', maxToolCalls: 12, recovery: 'full', interaction: 'off', lsp: false },
        traceId: 'synthetic:p3',
      });
      expect(rec.identity).toEqual(inner.identity);

      for (const step of script) {
        if (step.error !== undefined) {
          bare.setError(step.error);
          inner.setError(step.error);
        }
        const b = await settle(bare, step.request);
        const r = await settle(rec, step.request);
        if (b.ok) {
          expect(r.ok).toBe(true);
          if (r.ok) expect(r.res).toEqual(b.res);
        } else {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.err).toBe(b.err); // the same error object is rethrown
        }
      }
      // The inner gateway saw exactly the requests the caller sent (forwarded unchanged).
      expect(inner.history.map((h) => h.request)).toEqual(script.map((s) => s.request));

      const trace = rec.trace();
      expect(trace.concurrent).toBe(false);
      expect(trace.entries.map((e) => e.seq)).toEqual(script.map((_, i) => i));

      const replay = new ReplayModelGateway(trace);
      for (const [i, step] of script.entries()) {
        const r = await settle(replay, step.request);
        if (step.error !== undefined) {
          const err = modelErr(r);
          expect(err.code).toBe(step.error.code);
          expect(err.message).toBe(redact(step.error.message));
        } else {
          expect(okRaw(r), `call ${i}`).toBe(redact(step.raw ?? ''));
        }
      }
      const st = replay.status();
      expect(st.mismatch).toBeUndefined();
      expect(st.drift).toEqual([]);
      expect(st.served).toBe(n);
      expect(st.total).toBe(n);
      expect(st.exhausted).toBe(false);
      expect(st.steps.map((s) => s.source)).toEqual(script.map(() => 'organic'));
    });
  });

  // ── Property 4 ────────────────────────────────────────────────────────────────────────────

  // Feature: kernel-shadow-ablation, Property 4: Replay never invents behavior
  // **Validates: Requirements 3.2, 3.3, 3.5**
  it('Property 4: replay never invents behavior', async () => {
    await forAllAsync(0x5a3c0004, RUNS, async (rng) => {
      const gen = genTrace(rng, 8);
      const entries = gen.map((g) => g.entry);
      const total = entries.length;
      const injections: InjectionAt[] = [];
      const nInj = bool(rng, 0.5) ? int(rng, 1, 3) : 0;
      for (let k = 0; k < nInj; k++) {
        injections.push({ beforeSeq: int(rng, 0, total + 1), corpusId: `INJ-${k}`, raw: `INJECTED-${k}` });
      }
      const allowedRaws = new Set<string>([
        ...entries.flatMap((e) => (e.outcome.kind === 'response' ? [e.outcome.raw] : [])),
        ...injections.map((x) => x.raw),
      ]);
      const replay = new ReplayModelGateway(makeTrace(entries), injections);

      const calls = int(rng, 0, total + nInj + 4);
      let exhaustedAt = -1;
      let mismatchAt = -1;
      for (let c = 0; c < calls; c++) {
        const before = replay.status();
        const nextEntry = entries[before.served];
        // Mostly follow the trace; sometimes deviate (mismatch) or ask for execute (injections).
        const purpose = nextEntry !== undefined && bool(rng, 0.8) ? nextEntry.purpose : genPurpose(rng);
        const r = await settle(replay, genRequest(rng, purpose));
        const after = replay.status();

        if (mismatchAt >= 0) {
          expect(modelErr(r).message).toBe(REPLAY_MISMATCH);
          expect(modelErr(r).code).toBe('MODEL_UNAVAILABLE');
          expect(after).toEqual(before);
          continue;
        }
        if (exhaustedAt >= 0) {
          expect(modelErr(r).message).toBe(REPLAY_EXHAUSTED);
          expect(modelErr(r).code).toBe('MODEL_UNAVAILABLE');
          expect(after.exhausted).toBe(true);
          expect(after.steps).toEqual(before.steps);
          continue;
        }

        const newSteps = after.steps.slice(before.steps.length);
        expect(newSteps.length).toBeLessThanOrEqual(1);
        const step = newSteps[0];
        if (step === undefined) {
          // Nothing served: a replay signal.
          const err = modelErr(r);
          expect(err.code).toBe('MODEL_UNAVAILABLE');
          if (err.message === REPLAY_MISMATCH) {
            mismatchAt = c;
            expect(nextEntry).toBeDefined();
            expect(after.mismatch).toEqual({ seq: before.served, expected: nextEntry?.purpose, received: purpose });
            expect(purpose).not.toBe(nextEntry?.purpose);
            expect(after.exhausted).toBe(false);
          } else {
            expect(err.message).toBe(REPLAY_EXHAUSTED);
            exhaustedAt = c;
            expect(before.served).toBe(total);
            expect(after.exhausted).toBe(true);
            expect(after.mismatch).toBeUndefined();
          }
          expect(after.served).toBe(before.served);
        } else if (step.source === 'injected') {
          expect(purpose).toBe('execute');
          expect(step.purpose).toBe('execute');
          const inj = injections.find((x) => x.corpusId === step.corpusId);
          expect(inj).toBeDefined();
          expect(okRaw(r)).toBe(inj?.raw);
          expect(after.served).toBe(before.served);
        } else {
          // Organic: the next entry, in order, with its recorded outcome.
          expect(step.seq).toBe(before.served);
          expect(after.served).toBe(before.served + 1);
          const entry = entries[before.served];
          expect(entry).toBeDefined();
          if (entry?.outcome.kind === 'error') {
            expect(modelErr(r).code).toBe(entry.outcome.code);
            expect(modelErr(r).message).toBe(entry.outcome.message);
          } else {
            expect(okRaw(r)).toBe(entry?.outcome.raw);
          }
        }
        if (r.ok) expect(allowedRaws.has(r.res.raw)).toBe(true);
        if (r.ok) expect(r.res.model).toEqual(IDENTITY);
      }

      // Status counters are consistent with the served step list.
      const st = replay.status();
      const organic = st.steps.filter((s) => s.source === 'organic');
      const injected = st.steps.filter((s) => s.source === 'injected');
      expect(st.total).toBe(total);
      expect(st.served).toBeLessThanOrEqual(total);
      expect(organic.length).toBe(st.served);
      expect(organic.map((s) => s.seq)).toEqual(organic.map((_, i) => i));
      expect(st.steps.map((s) => s.servedIndex)).toEqual(st.steps.map((_, i) => i));
      expect(new Set(injected.map((s) => s.corpusId)).size).toBe(injected.length);
      expect(injected.length).toBeLessThanOrEqual(injections.length);
      expect(st.exhausted).toBe(exhaustedAt >= 0);
      expect(st.mismatch !== undefined).toBe(mismatchAt >= 0);
      // Requests followed the recorded prompts only by chance, so drift is not asserted here; it
      // never names an entry that was not served.
      for (const d of st.drift) expect(d.seq).toBeLessThan(st.served);
    });
  });

  // ── Property 5 ────────────────────────────────────────────────────────────────────────────

  // Feature: kernel-shadow-ablation, Property 5: Injections are served exactly where planned
  // **Validates: Requirements 3.6**
  it('Property 5: injections are served exactly where planned', async () => {
    await forAllAsync(0x5a3c0005, RUNS, async (rng) => {
      const gen = genTrace(rng, 8);
      const entries = gen.map((g) => g.entry);
      const total = entries.length;
      // Valid Injection_Points: before an execute entry, or after the last entry (>= total).
      const points = [...entries.filter((e) => e.purpose === 'execute').map((e) => e.seq), total, total + 1, total + 2];
      const injections: InjectionAt[] = [];
      const nInj = int(rng, 0, 4);
      for (let k = 0; k < nInj; k++) {
        injections.push({ beforeSeq: pick(rng, points), corpusId: `INJ-${k}`, raw: `INJECTED-${k}` });
      }

      // Expected served list: organic entries in order, each injection immediately before its
      // beforeSeq entry (equal points keep the given order); the >= total ones after the last entry.
      const ordered = injections
        .map((inj, i) => ({ inj, i }))
        .sort((a, b) => a.inj.beforeSeq - b.inj.beforeSeq || a.i - b.i)
        .map(({ inj }) => inj);
      type Planned = { kind: 'organic'; g: GenEntry } | { kind: 'injected'; inj: InjectionAt };
      const planned: Planned[] = [];
      for (const g of gen) {
        for (const inj of ordered) if (inj.beforeSeq === g.entry.seq) planned.push({ kind: 'injected', inj });
        planned.push({ kind: 'organic', g });
      }
      for (const inj of ordered) if (inj.beforeSeq >= total) planned.push({ kind: 'injected', inj });

      const hookCalls: Array<{ step: number; source: string; corpusId: string | undefined }> = [];
      const replay = new ReplayModelGateway(makeTrace(entries), injections, {
        onStep: (step, source, corpusId) => hookCalls.push({ step, source, corpusId }),
      });

      const expectedHook: typeof hookCalls = [];
      for (const [idx, p] of planned.entries()) {
        if (p.kind === 'injected') {
          const r = await settle(replay, genRequest(rng, 'execute'));
          expect(okRaw(r), `served ${idx}`).toBe(p.inj.raw);
          expectedHook.push({ step: idx, source: 'injected', corpusId: p.inj.corpusId });
        } else {
          const r = await settle(replay, p.g.request);
          const o = p.g.entry.outcome;
          if (o.kind === 'error') {
            expect(modelErr(r).code).toBe(o.code);
          } else {
            expect(okRaw(r), `served ${idx}`).toBe(o.raw);
            if (p.g.entry.purpose === 'execute') expectedHook.push({ step: idx, source: 'organic', corpusId: undefined });
          }
        }
      }
      // Next call: exhausted (every injection was served exactly once).
      expect(modelErr(await settle(replay, genRequest(rng, 'execute'))).message).toBe(REPLAY_EXHAUSTED);

      const st = replay.status();
      const expectedSteps: ServedStep[] = planned.map((p, servedIndex) =>
        p.kind === 'injected'
          ? { servedIndex, source: 'injected', corpusId: p.inj.corpusId, purpose: 'execute' }
          : { servedIndex, source: 'organic', seq: p.g.entry.seq, purpose: p.g.entry.purpose },
      );
      expect(st.steps).toEqual(expectedSteps);
      expect(st.served).toBe(total);
      expect(st.drift).toEqual([]);
      expect(st.mismatch).toBeUndefined();
      expect(hookCalls).toEqual(expectedHook);
    });
  });

  // ── Examples ──────────────────────────────────────────────────────────────────────────────

  it('records Prompt_Drift (changed prompt / contextSnapshotId) and still serves the entry', async () => {
    const req: ModelRequest = {
      purpose: 'execute',
      systemPrompt: 'sys',
      taskPrompt: 'task',
      contextSnapshotId: 'snap-1',
      maxOutputTokens: 256,
      temperature: 0,
    };
    const digest = promptDigest(req.systemPrompt, req.taskPrompt);
    const trace = makeTrace([
      { seq: 0, purpose: 'plan', contextSnapshotId: 'snap-1', promptSha256: digest, outcome: { kind: 'response', raw: 'P0' }, redacted: false },
      { seq: 1, purpose: 'execute', contextSnapshotId: 'snap-1', promptSha256: digest, outcome: { kind: 'response', raw: 'E1' }, redacted: false },
      { seq: 2, purpose: 'execute', promptSha256: digest, outcome: { kind: 'response', raw: 'E2' }, redacted: false },
    ]);
    const replay = new ReplayModelGateway(trace);
    expect(okRaw(await settle(replay, { ...req, purpose: 'plan', taskPrompt: 'changed task' }))).toBe('P0');
    expect(okRaw(await settle(replay, { ...req, contextSnapshotId: 'snap-2' }))).toBe('E1');
    expect(okRaw(await settle(replay, { ...req, systemPrompt: 'other' }))).toBe('E2');
    const st = replay.status();
    expect(st.drift).toEqual([
      { seq: 0, field: 'promptSha256' },
      { seq: 1, field: 'contextSnapshotId' },
      { seq: 2, field: 'promptSha256' },
      { seq: 2, field: 'contextSnapshotId' },
    ]);
    expect(st.mismatch).toBeUndefined();
    expect(st.served).toBe(3);
  });

  it('accepts a DecisionLedger as onStep (setStep is called as a method)', async () => {
    const digest = promptDigest('s', 't');
    const trace = makeTrace([
      { seq: 0, purpose: 'plan', promptSha256: digest, outcome: { kind: 'response', raw: 'P' }, redacted: false },
      { seq: 1, purpose: 'execute', promptSha256: digest, outcome: { kind: 'response', raw: 'E' }, redacted: false },
    ]);
    const ledger = new DecisionLedger();
    const replay = new ReplayModelGateway(trace, [{ beforeSeq: 1, corpusId: 'INJ-X', raw: 'I' }], { onStep: ledger });
    const req = (purpose: ModelPurpose): ModelRequest => ({
      purpose,
      systemPrompt: 's',
      taskPrompt: 't',
      maxOutputTokens: 256,
      temperature: 0,
    });
    expect(okRaw(await settle(replay, req('plan')))).toBe('P');
    expect(ledger.currentStep()).toBe(-1); // non-execute: hook not called
    expect(okRaw(await settle(replay, req('execute')))).toBe('I');
    expect(ledger.currentStep()).toBe(1);
    expect(okRaw(await settle(replay, req('execute')))).toBe('E');
    expect(ledger.currentStep()).toBe(2);
  });
});
