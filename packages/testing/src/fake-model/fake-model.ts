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

export interface ModelCall {
  readonly request: ModelRequest;
  readonly at: number; // logical call index (NOT wall-clock) — deterministic
}

interface ResponseRule {
  readonly pattern: RegExp;
  readonly response: string;
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
  private sequence: string[] = [];
  private sequenceIndex = 0;
  private pendingError: ModelError | null = null;
  private readonly _history: ModelCall[] = [];

  /** Map a prompt pattern to a fixed raw response. */
  setResponse(promptPattern: RegExp, response: string): this {
    this.rules.push({ pattern: promptPattern, response });
    return this;
  }

  /** Queue a fixed sequence of raw responses, consumed in order. */
  setSequence(responses: readonly string[]): this {
    this.sequence = [...responses];
    this.sequenceIndex = 0;
    return this;
  }

  /** Make the next generate() reject with this error (consumed once). */
  setError(error: ModelError): this {
    this.pendingError = error;
    return this;
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
    this._history.length = 0;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this._history.push({ request, at: this._history.length });

    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }

    if (this.sequenceIndex < this.sequence.length) {
      const raw = this.sequence[this.sequenceIndex] ?? '';
      this.sequenceIndex += 1;
      return this.wrap(raw, request);
    }

    for (const rule of this.rules) {
      if (rule.pattern.test(request.taskPrompt) || rule.pattern.test(request.systemPrompt)) {
        return this.wrap(rule.response, request);
      }
    }

    // Deterministic default: echo the purpose. Never random.
    return this.wrap(`{"purpose":"${request.purpose}"}`, request);
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
