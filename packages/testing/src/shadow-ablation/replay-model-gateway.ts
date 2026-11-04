/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ReplayModelGateway (kernel-shadow-ablation, design C3; Requirement 3). Measurement-only (SA-001).
//
// A ModelGateway double that serves the entries of ONE recorded Model_Trace in order and says
// clearly when it runs out (`REPLAY_EXHAUSTED`) or no longer matches (`REPLAY_MISMATCH`), so a
// replayed run never silently invents model behavior. Both signals are thrown as
// `ModelError('MODEL_UNAVAILABLE', ...)`, which TaskExecutor / Planner already turn into a FAILED
// run — a replay never hangs.
//
// Optional injections (Injected_Proposals) are served as execute-purpose responses immediately
// before the entry at their Injection_Point and tagged `injected` with their corpus id. The type is
// structural on purpose: this module does not import the injection corpus module (and vice versa).
//
// Deterministic (FM-2/3/8): no network, no clock, no randomness. `FakeModel` is not subclassed:
// its `setSequence` has no purpose check or exhaustion signal.
import {
  ModelError,
  type ModelGateway,
  type ModelIdentity,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
} from '@codeforge/agent-core';
import { promptDigest, type ModelTraceV1, type TraceEntry } from './trace-format.js';

/** Message of the `ModelError('MODEL_UNAVAILABLE')` thrown after the last entry was served. */
export const REPLAY_EXHAUSTED = 'REPLAY_EXHAUSTED';
/** Message of the `ModelError('MODEL_UNAVAILABLE')` thrown on (and after) a purpose mismatch. */
export const REPLAY_MISMATCH = 'REPLAY_MISMATCH';

/**
 * One Injected_Proposal at its Injection_Point. Structural on purpose: the replay does not import
 * the corpus module.
 *
 * `beforeSeq` is the `seq` of the organic entry the injection is served before. `beforeSeq ===
 * total` (or larger) means "after the last organic entry": it is served on the next execute
 * request once every organic entry was served, before the gateway reports exhaustion.
 */
export interface InjectionAt {
  readonly beforeSeq: number;
  readonly corpusId: string;
  readonly raw: string;
}

/** One served step, organic (a trace entry) or injected (an Injected_Proposal). */
export interface ServedStep {
  /** Index of this step in `ReplayStatus.steps` (also the ledger step for execute responses). */
  readonly servedIndex: number;
  readonly source: 'organic' | 'injected';
  /** Organic steps: the served trace entry's `seq`. */
  readonly seq?: number;
  /** Injected steps: the corpus id of the Injected_Proposal. */
  readonly corpusId?: string;
  readonly purpose: ModelPurpose;
}

export interface ReplayMismatch {
  readonly seq: number;
  readonly expected: ModelPurpose;
  readonly received: ModelPurpose;
}

export interface PromptDrift {
  readonly seq: number;
  readonly field: 'promptSha256' | 'contextSnapshotId';
}

export interface ReplayStatus {
  /** Organic trace entries served so far (responses and recorded errors; injections excluded). */
  readonly served: number;
  /** Number of entries in the trace. */
  readonly total: number;
  /**
   * true once a request arrived after every organic entry (and every due injection) was served.
   * Sticky: every later call throws `REPLAY_EXHAUSTED`.
   */
  readonly exhausted: boolean;
  /** The first request mismatch (sticky: every later call throws `REPLAY_MISMATCH`). */
  readonly mismatch?: ReplayMismatch;
  /** Prompt_Drift records, in serving order (fidelity metric only). */
  readonly drift: readonly PromptDrift[];
  /** Every served step, organic and injected, in serving order. */
  readonly steps: readonly ServedStep[];
}

/** Structurally compatible with `DecisionLedger.setStep` (decision-ledger.ts). */
export type ReplayStepFn = (step: number, source: 'organic' | 'injected', corpusId?: string) => void;

/**
 * Step hook: a function, or any object with a `setStep` method (e.g. a `DecisionLedger` passed
 * directly — it is called as a method, so `this` stays bound).
 */
export type ReplayStepHook =
  | ReplayStepFn
  | { setStep(step: number, source: 'organic' | 'injected', corpusId?: string): void };

export interface ReplayOptions {
  /**
   * Called with the step index BEFORE returning each execute-purpose response (organic or
   * injected), so downstream enforcement observers attribute their ledger entries to the proposal
   * being processed. Not called for non-execute responses or for thrown errors.
   */
  readonly onStep?: ReplayStepHook;
}

export class ReplayModelGateway implements ModelGateway {
  /** The recorded model identity (`trace.source.model`). */
  readonly identity: ModelIdentity;

  private readonly entries: readonly TraceEntry[];
  /** Pending injections, stable-sorted by `beforeSeq` (equal points keep their given order). */
  private readonly pending: InjectionAt[];
  private readonly onStep: ReplayStepHook | undefined;
  private cursor = 0;
  private exhausted = false;
  private mismatch: ReplayMismatch | undefined;
  private readonly drift: PromptDrift[] = [];
  private readonly steps: ServedStep[] = [];

  constructor(trace: ModelTraceV1, injections: readonly InjectionAt[] = [], options: ReplayOptions = {}) {
    this.identity = trace.source.model;
    this.entries = trace.entries;
    this.pending = injections
      .map((inj, i) => ({ inj, i }))
      .sort((a, b) => a.inj.beforeSeq - b.inj.beforeSeq || a.i - b.i)
      .map(({ inj }) => inj);
    this.onStep = options.onStep;
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    // async-by-contract; the body is synchronous so serving order equals call order.
    try {
      return Promise.resolve(this.serve(request));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  status(): ReplayStatus {
    return {
      served: this.cursor,
      total: this.entries.length,
      exhausted: this.exhausted,
      ...(this.mismatch !== undefined ? { mismatch: this.mismatch } : {}),
      drift: [...this.drift],
      steps: [...this.steps],
    };
  }

  private serve(request: ModelRequest): ModelResponse {
    if (this.mismatch !== undefined) throw new ModelError('MODEL_UNAVAILABLE', REPLAY_MISMATCH);
    // Sticky: once exhaustion was reported, nothing (not even a pending injection) is served.
    if (this.exhausted) throw new ModelError('MODEL_UNAVAILABLE', REPLAY_EXHAUSTED);

    // Injection due at (or already past, if its point was reached on a non-execute request) the
    // current position, and this is an execute request: serve it before the organic entry.
    // `beforeSeq >= total` becomes due once every organic entry was served (clamped to total).
    const next = this.pending[0];
    if (
      next !== undefined &&
      request.purpose === 'execute' &&
      Math.min(next.beforeSeq, this.entries.length) <= this.cursor
    ) {
      this.pending.shift();
      const servedIndex = this.pushStep({ source: 'injected', corpusId: next.corpusId, purpose: 'execute' });
      this.notify(servedIndex, 'injected', next.corpusId);
      return { raw: next.raw, model: this.identity };
    }

    const entry = this.entries[this.cursor];
    if (entry === undefined) {
      this.exhausted = true;
      throw new ModelError('MODEL_UNAVAILABLE', REPLAY_EXHAUSTED);
    }

    if (entry.purpose !== request.purpose) {
      this.mismatch = { seq: entry.seq, expected: entry.purpose, received: request.purpose };
      throw new ModelError('MODEL_UNAVAILABLE', REPLAY_MISMATCH);
    }

    if (promptDigest(request.systemPrompt, request.taskPrompt) !== entry.promptSha256) {
      this.drift.push({ seq: entry.seq, field: 'promptSha256' });
    }
    if (request.contextSnapshotId !== entry.contextSnapshotId) {
      this.drift.push({ seq: entry.seq, field: 'contextSnapshotId' });
    }

    this.cursor += 1;
    const servedIndex = this.pushStep({ source: 'organic', seq: entry.seq, purpose: entry.purpose });

    const outcome = entry.outcome;
    if (outcome.kind === 'error') throw new ModelError(outcome.code, outcome.message);

    if (entry.purpose === 'execute') this.notify(servedIndex, 'organic');
    return {
      raw: outcome.raw,
      model: this.identity,
      ...(outcome.promptTokens !== undefined ? { promptTokens: outcome.promptTokens } : {}),
      ...(outcome.outputTokens !== undefined ? { outputTokens: outcome.outputTokens } : {}),
    };
  }

  private pushStep(step: Omit<ServedStep, 'servedIndex'>): number {
    const servedIndex = this.steps.length;
    this.steps.push(Object.freeze({ servedIndex, ...step }));
    return servedIndex;
  }

  private notify(step: number, source: 'organic' | 'injected', corpusId?: string): void {
    const hook = this.onStep;
    if (hook === undefined) return;
    if (typeof hook === 'function') hook(step, source, corpusId);
    else hook.setStep(step, source, corpusId);
  }
}
