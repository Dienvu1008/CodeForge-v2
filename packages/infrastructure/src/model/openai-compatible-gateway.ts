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
}

// ── OpenAI Chat Completions wire shapes (minimal subset) ──────────────────────

interface ChatMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string | null } }>;
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export class OpenAiCompatibleModelGateway implements ModelGateway {
  private readonly _baseUrl: string;
  private readonly _model: string;
  private readonly _apiKey: string | undefined;
  private readonly _timeoutMs: number;
  private readonly _headers: Readonly<Record<string, string>>;
  private readonly _extraBody: Readonly<Record<string, unknown>>;

  readonly identity: ModelIdentity;

  constructor(config: OpenAiCompatibleConfig) {
    this._baseUrl = config.baseUrl.replace(/\/$/, '');
    this._model = config.model;
    this._apiKey = config.apiKey;
    this._timeoutMs = config.timeoutMs ?? 120_000;
    this._headers = config.headers ?? {};
    this._extraBody = config.extraBody ?? {};
    this.identity = { name: config.model, version: '0', endpoint: this._baseUrl };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const messages: ChatMessage[] = [
      // The system prompt is T0/T2 trusted; the task prompt is T1. Untrusted workspace content
      // was already delimited by the PromptBoundary before this ModelRequest was built (SE-001/002).
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.taskPrompt },
    ];

    const body: Record<string, unknown> = {
      model: this._model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: false,
      // Ask for a JSON object when the caller supplies a schema. Providers that don't support
      // response_format ignore it; the caller still validates the text deterministically.
      ...(request.responseSchema !== undefined ? { response_format: { type: 'json_object' } } : {}),
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

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Provider response missing choices[0].message.content');
    }

    const promptTokens = parsed.usage?.prompt_tokens;
    const outputTokens = parsed.usage?.completion_tokens;

    return {
      raw: content, // SE-010: untrusted, validated by the caller
      model: this.identity, // MG-004
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }
}
