// GeminiModelGateway — a ModelGateway adapter for Google's Gemini models via the Generative
// Language API (`POST <baseUrl>/models/<model>:generateContent`). Gemini does NOT speak the OpenAI
// Chat Completions wire protocol for every key type (its OpenAI-compat endpoint 404s for AI Studio
// ephemeral keys), and its native shape differs: an `x-goog-api-key` header, a `contents`/`parts`
// body, and `candidates[].content.parts[].text` output. This adapter speaks that native shape.
//
// It implements the SAME ModelGateway contract the Ollama / OpenAI-compatible adapters do
// (MG-001 / DC-002): the domain never imports a provider SDK; everything goes through this
// boundary and returns raw, UNTRUSTED text (SE-010) that the caller validates. Node built-in fetch.
//
// Enforces:
//   MG-001: single boundary — no other component calls the provider.
//   MG-004: model identity (name/version/endpoint) recorded in every response.
//   MG-005: timeout → MODEL_TIMEOUT; unreachable / non-2xx → MODEL_UNAVAILABLE.
//   SE-010: the returned text is untrusted — the StructuredOutputParser validates it.
//   SE-003: request options are never interpolated from model output.
//
// Secret handling: the API key is sent only in the `x-goog-api-key` header and is NEVER logged or
// placed in an error message (error messages carry status + a short body snippet only).
import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity } from '@codeforge/agent-core';
import { ModelError } from '@codeforge/agent-core';

// ── Config ───────────────────────────────────────────────────────────────────

export interface GeminiConfig {
  /** Model id, e.g. 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'. */
  readonly model: string;
  /** API key sent as the `x-goog-api-key` header. */
  readonly apiKey: string;
  /**
   * Base URL up to and including the API version, WITHOUT a trailing `/models/...`. Default:
   * 'https://generativelanguage.googleapis.com/v1beta'.
   */
  readonly baseUrl?: string;
  /** Hard request timeout in ms (SE-007 spirit). Default: 120_000. */
  readonly timeoutMs?: number;
  /** Extra generationConfig fields passed verbatim (e.g. topP). Never from model output (SE-003). */
  readonly generationConfig?: Readonly<Record<string, unknown>>;
}

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// ── Gemini generateContent wire shapes (minimal subset) ───────────────────────

interface GeminiPart { readonly text?: string }

interface GeminiResponse {
  readonly candidates?: ReadonlyArray<{
    readonly content?: { readonly parts?: ReadonlyArray<GeminiPart> };
    readonly finishReason?: string;
  }>;
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
  readonly error?: { readonly message?: string };
}

/**
 * Join all text parts of the first candidate into one string. Gemini may split a response across
 * several parts (and a reasoning model may interleave thought + answer); concatenating yields the
 * full text, which the caller's StructuredOutputParser (extractJson) then slices if JSON was asked.
 * Returns undefined when there is no textual content. The result is untrusted (SE-010).
 */
function extractText(res: GeminiResponse): string | undefined {
  const parts = res.candidates?.[0]?.content?.parts;
  if (parts === undefined) return undefined;
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  return text.length > 0 ? text : undefined;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export class GeminiModelGateway implements ModelGateway {
  private readonly _baseUrl: string;
  private readonly _model: string;
  private readonly _apiKey: string;
  private readonly _timeoutMs: number;
  private readonly _generationConfig: Readonly<Record<string, unknown>>;

  readonly identity: ModelIdentity;

  constructor(config: GeminiConfig) {
    this._baseUrl = (config.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
    this._model = config.model;
    this._apiKey = config.apiKey;
    this._timeoutMs = config.timeoutMs ?? 120_000;
    this._generationConfig = config.generationConfig ?? {};
    this.identity = { name: config.model, version: '0', endpoint: this._baseUrl };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const wantsJson = request.responseSchema !== undefined;

    // Gemini separates the system instruction from the conversation turns. The system prompt is
    // T0/T2 trusted; the task prompt is T1 (untrusted workspace content was already delimited by
    // the PromptBoundary before this ModelRequest was built — SE-001/002).
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: request.taskPrompt }] }],
      generationConfig: {
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        // Gemini honours a strict JSON mime type well (unlike the Groq gpt-oss family), so when a
        // schema is requested we ask for application/json directly.
        ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
        ...this._generationConfig,
      },
    };

    const url = `${this._baseUrl}/models/${encodeURIComponent(this._model)}:generateContent`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this._apiKey,
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
      throw new ModelError('MODEL_UNAVAILABLE', `Provider unreachable at ${this._baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 429/503 (rate limit / overloaded) and 4xx all map to MODEL_UNAVAILABLE from the runtime's
      // perspective (no usable model this call). The snippet never contains the key (it is only
      // in the header). Recovery policy decides whether to retry.
      throw new ModelError('MODEL_UNAVAILABLE', `Gemini returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let parsed: GeminiResponse;
    try {
      parsed = (await res.json()) as GeminiResponse;
    } catch {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'Gemini response body is not valid JSON');
    }

    if (parsed.error?.message !== undefined) {
      throw new ModelError('MODEL_UNAVAILABLE', `Gemini error: ${parsed.error.message.slice(0, 200)}`);
    }

    const raw = extractText(parsed);
    if (raw === undefined) {
      // No text — e.g. the candidate was blocked by a safety filter or truncated with no content.
      const reason = parsed.candidates?.[0]?.finishReason;
      throw new ModelError('MODEL_OUTPUT_INVALID', `Gemini response has no text parts${reason !== undefined ? ` (finishReason: ${reason})` : ''}`);
    }

    const promptTokens = parsed.usageMetadata?.promptTokenCount;
    const outputTokens = parsed.usageMetadata?.candidatesTokenCount;

    return {
      raw, // SE-010: untrusted, validated by the caller
      model: this.identity, // MG-004
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }
}
