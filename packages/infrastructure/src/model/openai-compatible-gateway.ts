/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// OpenAiCompatibleModelGateway — a ModelGateway adapter for any server speaking the OpenAI
// Chat Completions API (`POST <baseUrl>/chat/completions`). This one adapter covers a large set
// of providers — OpenAI itself, OpenRouter, Groq, Together, DeepSeek, Mistral, and local servers
// like LM Studio / llama.cpp / vLLM / LiteLLM — because they all implement the same wire protocol.
//
// It implements the SAME ModelGateway contract the Ollama adapter does (MG-001 / DC-002): the
// domain never imports a provider SDK; everything goes through this boundary and returns raw,
// UNTRUSTED text (SE-010) that the caller validates. No external HTTP deps — Node built-in fetch.
//
// Enforces:
//   MG-001: single boundary — no other component calls the provider.
//   MG-004: model identity (name/version/endpoint) recorded in every response.
//   MG-005: timeout → MODEL_TIMEOUT; unreachable / non-2xx → MODEL_UNAVAILABLE.
//   SE-010: the returned text is untrusted — the StructuredOutputParser validates it.
//   SE-003: request options are never interpolated from model output.
//
// Secret handling: the API key is sent only in the Authorization header and is NEVER logged or
// placed in an error message (error messages carry status + a short body snippet only).
import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity } from '@codeforge/agent-core';
import { ModelError } from '@codeforge/agent-core';

// ── Config ───────────────────────────────────────────────────────────────────

export interface OpenAiCompatibleConfig {
  /**
   * Base URL INCLUDING the API version segment but WITHOUT the `/chat/completions` suffix,
   * e.g. 'https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'http://localhost:1234/v1'.
   */
  readonly baseUrl: string;
  /** Model id, e.g. 'gpt-4o-mini', 'anthropic/claude-3.5-sonnet' (OpenRouter), 'local-model'. */
  readonly model: string;
  /** API key sent as `Authorization: Bearer <key>`. Optional for keyless local servers. */
  readonly apiKey?: string;
  /** Hard request timeout in ms (SE-007 spirit). Default: 120_000. */
  readonly timeoutMs?: number;
  /** Extra headers (e.g. OpenRouter's HTTP-Referer / X-Title). Never includes the key. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Extra body fields passed verbatim (e.g. top_p). Never interpolated from model output. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /**
   * Tolerate tool-native models (OFF by default — fail-safe parity with a plain OpenAI server).
   *
   * Some reasoning models (notably Groq's `openai/gpt-oss-*`) are trained around tool calls and
   * misbehave against a bare `response_format: json_object` request: they either put the JSON in a
   * tool call instead of `content`, or the provider returns HTTP 400 `tool_use_failed` even though
   * the model DID produce correct JSON (stashed in `error.failed_generation`). Neither is a
   * model-quality problem — it is a wire mismatch.
   *
   * Forcing a tool call makes it worse for this family (the model invents tool names, or answers
   * in content and the provider rejects "tool choice is required"). So instead of changing the
   * request, this flag makes the adapter RECOVER the model's real output: on an HTTP 400 whose
   * body carries a JSON-parseable `failed_generation`, return that string instead of failing. The
   * returned `raw` is still untrusted and validated by the caller (SE-010) — the domain contract
   * is unchanged.
   *
   * Regardless of this flag, the adapter ALSO reads tool-call arguments on a 200 response whenever
   * `content` is empty but a tool call is present (harmless for providers that never use tools).
   */
  readonly preferToolJson?: boolean;
}

// ── OpenAI Chat Completions wire shapes (minimal subset) ──────────────────────

interface ChatMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }

interface ToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface ChatMessageOut {
  readonly content?: string | null;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
  /** Some reasoning models (Groq gpt-oss) put the whole answer here and leave content empty. */
  readonly reasoning?: string | null;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: ChatMessageOut }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

/**
 * Extract the structured-output string from a chat choice, in priority order:
 *   1. plain `content` (the normal case);
 *   2. the first tool call's `arguments` (a JSON string) — tool-native models answer here;
 *   3. the `reasoning` field — Groq's gpt-oss reasoning models leave `content` EMPTY and put the
 *      whole answer (prose + the JSON object) in `reasoning`. We return it verbatim; the caller's
 *      StructuredOutputParser (extractJson) slices the embedded JSON object out of the prose.
 * Returns undefined when none is present. The returned string is still untrusted (SE-010).
 */
function extractRaw(message: ChatMessageOut | undefined): string | undefined {
  if (message === undefined) return undefined;
  if (typeof message.content === 'string' && message.content.length > 0) return message.content;
  const args = message.tool_calls?.find((tc) => typeof tc.function?.arguments === 'string')?.function?.arguments;
  if (typeof args === 'string' && args.length > 0) return args;
  if (typeof message.reasoning === 'string' && message.reasoning.length > 0) return message.reasoning;
  return undefined;
}

/**
 * Recover a usable JSON string from a provider error body's `failed_generation` field. Groq's
 * gpt-oss family returns HTTP 400 `tool_use_failed` even when the model produced correct JSON —
 * the real completion is stashed in error.failed_generation. We accept it only when it parses as
 * JSON (so a genuinely malformed generation still fails). Returns the string (NOT the parsed
 * object) so the caller's StructuredOutputParser validates it exactly like any other raw output.
 */
function recoverFailedGeneration(errorBodyText: string): string | undefined {
  let body: { error?: { failed_generation?: unknown } };
  try { body = JSON.parse(errorBodyText) as typeof body; } catch { return undefined; }
  const gen = body.error?.failed_generation;
  if (typeof gen !== 'string' || gen.trim().length === 0) return undefined;
  try { JSON.parse(gen); } catch { return undefined; } // must be valid JSON to be usable
  return gen;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export class OpenAiCompatibleModelGateway implements ModelGateway {
  private readonly _baseUrl: string;
  private readonly _model: string;
  private readonly _apiKey: string | undefined;
  private readonly _timeoutMs: number;
  private readonly _headers: Readonly<Record<string, string>>;
  private readonly _extraBody: Readonly<Record<string, unknown>>;
  private readonly _preferToolJson: boolean;

  readonly identity: ModelIdentity;

  constructor(config: OpenAiCompatibleConfig) {
    this._baseUrl = config.baseUrl.replace(/\/$/, '');
    this._model = config.model;
    this._apiKey = config.apiKey;
    this._timeoutMs = config.timeoutMs ?? 120_000;
    this._headers = config.headers ?? {};
    this._extraBody = config.extraBody ?? {};
    this._preferToolJson = config.preferToolJson ?? false;
    this.identity = { name: config.model, version: '0', endpoint: this._baseUrl };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const messages: ChatMessage[] = [
      // The system prompt is T0/T2 trusted; the task prompt is T1. Untrusted workspace content
      // was already delimited by the PromptBoundary before this ModelRequest was built (SE-001/002).
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.taskPrompt },
    ];

    const wantsJson = request.responseSchema !== undefined;

    const body: Record<string, unknown> = {
      model: this._model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: false,
      // JSON mode. For a tool-native reasoning model (Groq gpt-oss) `response_format: json_object`
      // is REJECTED (the model answers in its reasoning channel, leaving content empty, so the
      // provider returns 400 json_validate_failed). Instead, for preferToolJson we DON'T force a
      // format and nudge `reasoning_effort: 'low'` so the model emits the JSON (in `reasoning`,
      // which extractRaw reads) rather than wandering into an unsolicited tool call. A plain
      // provider still gets response_format and is unaffected (preferToolJson defaults off).
      ...(wantsJson
        ? (this._preferToolJson
            ? { reasoning_effort: 'low' }
            : { response_format: { type: 'json_object' } })
        : {}),
      ...this._extraBody,
    };

    const url = `${this._baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._headers,
      ...(this._apiKey !== undefined && this._apiKey.length > 0
        ? { Authorization: `Bearer ${this._apiKey}` }
        : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ModelError('MODEL_TIMEOUT', `Model request timed out after ${this._timeoutMs}ms`);
      }
      // Message carries only the URL + error text — never the API key.
      throw new ModelError('MODEL_UNAVAILABLE', `Provider unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Tool-native models (Groq gpt-oss) sometimes return HTTP 400 `tool_use_failed` while the
      // model ACTUALLY produced the right JSON — the provider rejects the turn over a tool-call
      // technicality and stashes the real completion in `error.failed_generation`. When we asked
      // for JSON and that field holds a usable JSON string, recover it instead of failing: the
      // model did its job (SE-010 — still untrusted, validated by the caller). Opt-in via
      // preferToolJson so a plain provider's 400 stays a hard MODEL_UNAVAILABLE.
      if (wantsJson && this._preferToolJson) {
        const recovered = recoverFailedGeneration(text);
        if (recovered !== undefined) {
          return { raw: recovered, model: this.identity };
        }
      }
      // A 401/403 is still MODEL_UNAVAILABLE from the runtime's perspective (no usable model).
      throw new ModelError('MODEL_UNAVAILABLE', `Provider returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Provider response body is not valid JSON');
    }

    if (parsed.error?.message !== undefined) {
      throw new ModelError('MODEL_UNAVAILABLE', `Provider error: ${parsed.error.message.slice(0, 200)}`);
    }

    // Prefer plain content; fall back to a tool call's JSON arguments for tool-native models.
    const raw = extractRaw(parsed.choices?.[0]?.message);
    if (raw === undefined) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Provider response missing choices[0].message.content (and no tool-call arguments)');
    }

    const promptTokens = parsed.usage?.prompt_tokens;
    const outputTokens = parsed.usage?.completion_tokens;

    return {
      raw, // SE-010: untrusted, validated by the caller
      model: this.identity, // MG-004
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }
}
