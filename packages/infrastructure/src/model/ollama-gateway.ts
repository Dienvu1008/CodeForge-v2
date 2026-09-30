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
// Streaming is deferred to Phase 3; this impl uses the non-streaming `/api/generate`
// endpoint with `"stream": false`.

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
}

// ── OllamaGenerateRequest / Response (Ollama REST API shape) ──────────────────

interface OllamaGenerateRequest {
  readonly model: string;
  readonly prompt: string;
  readonly stream: false;
  readonly format?: 'json';
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

  readonly identity: ModelIdentity;

  constructor(config: OllamaConfig) {
    this._endpoint = config.endpoint.replace(/\/$/, '');
    this._model    = config.model;
    this._timeoutMs = config.timeoutMs ?? 120_000;
    this._options  = config.options ?? {};

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
      stream:  false,
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
    } finally {
      clearTimeout(timer);
    }

    if (!raw.ok) {
      const text = await raw.text().catch(() => '');
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        `Ollama returned HTTP ${raw.status}: ${text.slice(0, 200)}`,
      );
    }

    let parsed: OllamaGenerateResponse;
    try {
      parsed = (await raw.json()) as OllamaGenerateResponse;
    } catch {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Ollama response body is not valid JSON');
    }

    if (typeof parsed.response !== 'string') {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Ollama response missing "response" field');
    }

    return {
      raw:   parsed.response,     // SE-010: untrusted, validated by caller
      model: this.identity,       // MG-004: identity recorded
      ...(parsed.prompt_eval_count !== undefined ? { promptTokens: parsed.prompt_eval_count } : {}),
      ...(parsed.eval_count !== undefined ? { outputTokens: parsed.eval_count } : {}),
    };
  }

  // ── prompt construction ───────────────────────────────────────────────────

  private buildPrompt(request: ModelRequest): string {
    // System prompt is T0/T2 trusted content; task prompt is T1.
    // Untrusted workspace content was already delimited by PromptBoundary
    // (SE-001/002) before the ModelRequest was constructed — we preserve it.
    return `${request.systemPrompt}\n\n${request.taskPrompt}`;
  }
}
