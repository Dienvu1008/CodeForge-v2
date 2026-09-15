// FakeModel (C9) — EVALUATION_MODEL §5, PHASE_0_ACCEPTANCE §3.12 (FM-1..FM-8).
//
// A deterministic ModelGateway double so the runtime can be tested WITHOUT a real LLM.
// FM-8: never calls Ollama / any network. FM-2/FM-3: deterministic. No random, no wall-clock.
import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelIdentity,
  ModelError,
} from '@codeforge/agent-core';

/**
 * A recorded model interaction. Rich enough to drive UX rendering and timeout
 * assertions without any wall-clock dependence: `at` is a logical call index and
 * `delayMs` is the *configured* latency this call would have taken (the FakeModel
 * never actually sleeps — it reports the number so a deterministic runtime timeout
 * test can reason about it).
 */
export interface ModelCall {
  readonly request: ModelRequest;
  readonly at: number; // logical call index (NOT wall-clock) — deterministic
  /** The raw output returned for this call (undefined if the call threw). */
  readonly response?: string;
  /** The error thrown for this call, if any. */
  readonly errorCode?: string;
  /** Configured latency for this call in ms (logical; not actually awaited). */
  readonly delayMs: number;
}

/** A response may be a fixed string or a pure function of the request. */
export type ResponseValue = string | ((request: ModelRequest) => string);

interface ResponseRule {
  readonly pattern: RegExp;
  readonly response: ResponseValue;
}

const FAKE_IDENTITY: ModelIdentity = {
  name: 'fake-model',
  version: '0.0.0',
  endpoint: 'fake://local',
};

/**
 * Deterministic ModelGateway test double.
 *
 * Configure behavior with setResponse/setSequence/setError. `generate` resolves the raw
 * output using (in order): a queued error, the next sequence entry, the first matching
 * response rule, else a default echo. Everything is deterministic and reproducible.
 */
export class FakeModel implements ModelGateway {
  public readonly identity: ModelIdentity = FAKE_IDENTITY;

  private rules: ResponseRule[] = [];
  private sequence: ResponseValue[] = [];
  private sequenceIndex = 0;
  private pendingError: ModelError | null = null;
  private defaultDelayMs = 0;
  private delaySequence: number[] = [];
  private delayIndex = 0;
  private readonly _history: ModelCall[] = [];

  /** Map a prompt pattern to a fixed raw response, or a pure function of the request. */
  setResponse(promptPattern: RegExp, response: ResponseValue): this {
    this.rules.push({ pattern: promptPattern, response });
    return this;
  }

  /** Queue a fixed sequence of raw responses (or response functions), consumed in order. */
  setSequence(responses: readonly ResponseValue[]): this {
    this.sequence = [...responses];
    this.sequenceIndex = 0;
    return this;
  }

  /** Make the next generate() reject with this error (consumed once). */
  setError(error: ModelError): this {
    this.pendingError = error;
    return this;
  }

  /**
   * Configure a logical latency (ms) attached to every call's history entry.
   * DETERMINISTIC: the FakeModel does NOT sleep — it records the number so a
   * runtime timeout test can assert "this call would exceed the budget" without
   * touching the wall clock (FM-8 / no wall-clock).
   */
  setDelay(ms: number): this {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`delay must be a non-negative number, got ${ms}`);
    }
    this.defaultDelayMs = ms;
    return this;
  }

  /** Queue per-call logical latencies, consumed in order (falls back to setDelay). */
  setDelaySequence(delays: readonly number[]): this {
    for (const d of delays) {
      if (!Number.isFinite(d) || d < 0) {
        throw new RangeError(`delay must be a non-negative number, got ${d}`);
      }
    }
    this.delaySequence = [...delays];
    this.delayIndex = 0;
    return this;
  }

  /** Sum of logical latencies recorded across all calls so far. */
  get totalDelayMs(): number {
    return this._history.reduce((sum, c) => sum + c.delayMs, 0);
  }

  get callCount(): number {
    return this._history.length;
  }

  get lastPrompt(): string | undefined {
    const last = this._history[this._history.length - 1];
    return last ? last.request.taskPrompt : undefined;
  }

  get history(): readonly ModelCall[] {
    return this._history;
  }

  reset(): void {
    this.rules = [];
    this.sequence = [];
    this.sequenceIndex = 0;
    this.pendingError = null;
    this.defaultDelayMs = 0;
    this.delaySequence = [];
    this.delayIndex = 0;
    this._history.length = 0;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const at = this._history.length;
    const delayMs = this.nextDelay();

    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      this._history.push({ request, at, delayMs, errorCode: err.code });
      throw err;
    }

    const raw = this.resolveRaw(request);
    this._history.push({ request, at, delayMs, response: raw });
    return this.wrap(raw, request);
  }

  /** Resolve the raw output for a request without recording history (pure). */
  private resolveRaw(request: ModelRequest): string {
    if (this.sequenceIndex < this.sequence.length) {
      const entry = this.sequence[this.sequenceIndex] ?? '';
      this.sequenceIndex += 1;
      return typeof entry === 'function' ? entry(request) : entry;
    }
    for (const rule of this.rules) {
      if (rule.pattern.test(request.taskPrompt) || rule.pattern.test(request.systemPrompt)) {
        return typeof rule.response === 'function' ? rule.response(request) : rule.response;
      }
    }
    // Deterministic default: echo the purpose. Never random.
    return `{"purpose":"${request.purpose}"}`;
  }

  private nextDelay(): number {
    if (this.delayIndex < this.delaySequence.length) {
      const d = this.delaySequence[this.delayIndex] ?? 0;
      this.delayIndex += 1;
      return d;
    }
    return this.defaultDelayMs;
  }

  private wrap(raw: string, request: ModelRequest): ModelResponse {
    return {
      raw,
      model: this.identity,
      promptTokens: request.systemPrompt.length + request.taskPrompt.length,
      outputTokens: raw.length,
    };
  }
}
