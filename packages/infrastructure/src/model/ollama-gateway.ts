// OllamaModelGateway — P2-MG1. SECURITY_MODEL §10, Coding Agent Architecture §19.
//
// The Ollama HTTP adapter. Implements the ModelGateway contract so the domain never
// imports Ollama directly (MG-001 / DC-002). All LLM calls go through this class.
//
// Enforces:
//   MG-001: single boundary — no other component calls Ollama.
//   MG-004: model identity (name/version/endpoint) recorded in every response.
//   MG-005: timeout → ModelError('MODEL_TIMEOUT'); unavailable → MODEL_UNAVAILABLE.
//   SE-010 (structural): raw response is returned as-is — caller validates (MG-002/006).
//
// Uses Node built-in `fetch` (available Node 18+). No external HTTP deps.
//
// P10.6: streaming. The request now uses `"stream": true` and the gateway assembles the
// NDJSON token chunks into the full response text. This is DISPLAY-ONLY streaming — the
// decision path is unchanged: generate() still returns the COMPLETE assembled text, which
// the StructuredOutputParser validates deterministically (temperature stays as supplied,
// typically 0). An optional onToken callback lets a caller observe tokens as they arrive
// (progress), but it never affects the returned value or any decision.

import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity } from '@codeforge/agent-core';
import { ModelError } from '@codeforge/agent-core';

// ── OllamaConfig ──────────────────────────────────────────────────────────────

export interface OllamaConfig {
  /** Base URL of the Ollama server, e.g. 'http://localhost:11434'. */
  readonly endpoint: string;
  /** Model name to use, e.g. 'qwen2.5-coder:7b'. */
  readonly model: string;
  /** Hard request timeout in milliseconds (SE-007 spirit). Default: 120_000. */
  readonly timeoutMs?: number;
  /**
   * Additional Ollama options passed verbatim in the request body
   * (temperature, num_ctx, etc.). Never interpolated from model output (SE-003).
   */
  readonly options?: Readonly<Record<string, unknown>>;
  /**
   * P10.6: optional display-only token callback, invoked with each streamed chunk as it
   * arrives. Purely observational — it does NOT affect the assembled result or any
   * decision. Errors thrown here are swallowed so progress reporting can't break a call.
   */
  readonly onToken?: (chunk: string) => void;
}

// ── OllamaGenerateRequest / Response (Ollama REST API shape) ──────────────────

interface OllamaGenerateRequest {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
  readonly format?: 'json';
  /**
   * Disable "thinking" for hybrid reasoning models (qwen3, deepseek-r1, …). The runtime needs a
   * STRUCTURED answer, not chain-of-thought: left enabled, these models spend the whole
   * num_predict budget on hidden reasoning and return an EMPTY `response` → "not valid JSON".
   * Ollama ignores this flag for non-reasoning models, so it is safe to always send.
   */
  readonly think?: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
}

interface OllamaGenerateResponse {
  readonly model: string;
  readonly response: string;
  readonly done: boolean;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly total_duration?: number;
}

// ── OllamaModelGateway ────────────────────────────────────────────────────────

export class OllamaModelGateway implements ModelGateway {
  private readonly _endpoint: string;
  private readonly _model: string;
  private readonly _timeoutMs: number;
  private readonly _options: Readonly<Record<string, unknown>>;
  private readonly _onToken: ((chunk: string) => void) | undefined;

  readonly identity: ModelIdentity;

  constructor(config: OllamaConfig) {
    this._endpoint = config.endpoint.replace(/\/$/, '');
    this._model    = config.model;
    this._timeoutMs = config.timeoutMs ?? 120_000;
    this._options  = config.options ?? {};
    this._onToken  = config.onToken;

    this.identity = {
      name:     config.model,
      version:  '0', // resolved lazily; Ollama doesn't expose version in /api/generate
      endpoint: this._endpoint,
    };
  }

  /**
   * Send a generation request to Ollama. Returns the raw text response
   * (SE-010: UNTRUSTED — caller must validate via StructuredOutputParser).
   *
   * Throws:
   *   ModelError('MODEL_TIMEOUT')     — request exceeded timeoutMs.
   *   ModelError('MODEL_UNAVAILABLE') — Ollama unreachable / non-2xx.
   *   ModelError('MODEL_OUTPUT_INVALID') — response body unparseable.
   */
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prompt = this.buildPrompt(request);
    const body: OllamaGenerateRequest = {
      model:   this._model,
      prompt,
      stream:  true, // P10.6: stream NDJSON chunks; assembled below (display-only).
      // Reasoning models must answer directly (see `think` doc) — otherwise an empty response.
      think:   false,
      // Use JSON format hint when a responseSchema is provided.
      ...(request.responseSchema !== undefined ? { format: 'json' } : {}),
      options: {
        temperature:  request.temperature,
        num_predict:  request.maxOutputTokens,
        ...this._options,
      },
    };

    const url = `${this._endpoint}/api/generate`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let raw: Response;
    try {
      raw = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ModelError('MODEL_TIMEOUT', `Ollama request timed out after ${this._timeoutMs}ms`);
      }
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        `Ollama unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // NOTE: the abort timer is intentionally left armed here — it is cleared inside
    // readStreamText (success or abort), so a hung BODY stream still times out (SE-007).

    if (!raw.ok) {
      const text = await raw.text().catch(() => '');
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        `Ollama returned HTTP ${raw.status}: ${text.slice(0, 200)}`,
      );
    }

    // P10.6: read the NDJSON stream and assemble the full response. Each line is one
    // Ollama chunk: { response: "<token(s)>", done: bool, ... }. We concatenate the
    // `response` fields (display-only onToken per chunk) and take the token counts from
    // the final (done) chunk. The COMPLETE text is returned — determinism unchanged.
    const bodyText = await this.readStreamText(raw, timer);
    clearTimeout(timer);

    let assembled = '';
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    let sawResponseField = false;

    const lines = bodyText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Ollama response body is empty');
    }
    for (const line of lines) {
      let chunk: OllamaGenerateResponse;
      try {
        chunk = JSON.parse(line) as OllamaGenerateResponse;
      } catch {
        throw new ModelError('MODEL_OUTPUT_INVALID', 'Ollama stream line is not valid JSON');
      }
      if (typeof chunk.response === 'string') {
        sawResponseField = true;
        assembled += chunk.response;
        if (chunk.response.length > 0 && this._onToken !== undefined) {
          try { this._onToken(chunk.response); } catch { /* display-only — never fatal */ }
        }
      }
      if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count;
      if (chunk.eval_count !== undefined) outputTokens = chunk.eval_count;
    }

    if (!sawResponseField) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Ollama response missing "response" field');
    }

    return {
      raw:   assembled,           // SE-010: untrusted, validated by caller
      model: this.identity,       // MG-004: identity recorded
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }

  /**
   * Read the response body as text, honouring the abort timer. Prefers the streaming
   * reader (so onToken sees chunks as they arrive) and falls back to text() when the body
   * is not a readable stream (e.g. in tests). Maps an abort to MODEL_TIMEOUT.
   */
  private async readStreamText(raw: Response, timer: ReturnType<typeof setTimeout>): Promise<string> {
    const stream = raw.body;
    if (stream === null) {
      return raw.text();
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ModelError('MODEL_TIMEOUT', `Ollama stream timed out after ${this._timeoutMs}ms`);
      }
      throw new ModelError('MODEL_UNAVAILABLE', `Ollama stream error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reader.releaseLock();
    }
  }

  // ── prompt construction ───────────────────────────────────────────────────

  private buildPrompt(request: ModelRequest): string {
    // System prompt is T0/T2 trusted content; task prompt is T1.
    // Untrusted workspace content was already delimited by PromptBoundary
    // (SE-001/002) before the ModelRequest was constructed — we preserve it.
    return `${request.systemPrompt}\n\n${request.taskPrompt}`;
  }
}
