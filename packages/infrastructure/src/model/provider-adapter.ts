// provider-adapter — the shared ProviderSpec type + the deterministic factory that turns a spec
// into a concrete ModelGateway adapter. Kept in its own module so BOTH the SwitchableModelGateway
// (runtime model/provider switch) and the RoutingModelGateway (per-purpose routing) build adapters
// the same way, with no duplication and no import cycle.
//
// DC-002 / secret handling: the API key lives only inside the spec used to construct the adapter;
// it is passed to the adapter's Authorization header and is never logged here.
import type { ModelGateway } from '@codeforge/agent-core';
import { OllamaModelGateway, type OllamaConfig } from './ollama-gateway.js';
import { OpenAiCompatibleModelGateway, type OpenAiCompatibleConfig } from './openai-compatible-gateway.js';

/** Which adapter family a ProviderSpec targets. */
export type ModelProvider = 'ollama' | 'openai-compatible';

/**
 * A full description of what to run: which provider, which model, where, and (for cloud providers)
 * the API key + optional extra headers. Held only to construct an adapter; never logged.
 */
export interface ProviderSpec {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Ollama base URL, or the OpenAI-compatible …/v1 base URL. Provider default used when omitted. */
  readonly endpoint?: string;
  /** API key for a cloud / OpenAI-compatible provider (ignored by Ollama). */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Ollama generation options (temperature, num_ctx, …). */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Extra headers for an OpenAI-compatible provider (e.g. OpenRouter attribution). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Force tool-native structured JSON for an openai-compatible provider (see
   * OpenAiCompatibleConfig.preferToolJson). When omitted, `buildAdapter` auto-enables it for a
   * Groq endpoint, whose `gpt-oss-*` models answer via a tool call. Explicit value always wins.
   */
  readonly preferToolJson?: boolean;
}

export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * Build a concrete ModelGateway adapter from a ProviderSpec. Pure + deterministic. Throws (before
 * any adapter is returned) for an unknown provider or an openai-compatible spec with no endpoint,
 * so a caller can validate a switch before committing to it.
 */
export function buildAdapter(spec: ProviderSpec): ModelGateway {
  if (spec.provider === 'ollama') {
    const cfg: OllamaConfig = {
      endpoint: spec.endpoint ?? DEFAULT_OLLAMA_ENDPOINT,
      model: spec.model,
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.options !== undefined ? { options: spec.options } : {}),
    };
    return new OllamaModelGateway(cfg);
  }
  if (spec.provider === 'openai-compatible') {
    if (spec.endpoint === undefined || spec.endpoint.trim().length === 0) {
      throw new Error('openai-compatible provider requires an endpoint (the …/v1 base URL)');
    }
    // Auto-enable tool-native JSON for Groq (its gpt-oss-* models answer via a tool call), unless
    // the spec sets preferToolJson explicitly. Other providers (OpenAI, OpenRouter, local) default
    // to plain response_format — unchanged behavior.
    const preferToolJson = spec.preferToolJson ?? /(^|\.)groq\.com/i.test(spec.endpoint);
    const cfg: OpenAiCompatibleConfig = {
      baseUrl: spec.endpoint,
      model: spec.model,
      ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.headers !== undefined ? { headers: spec.headers } : {}),
      preferToolJson,
    };
    return new OpenAiCompatibleModelGateway(cfg);
  }
  throw new Error(`unknown model provider: ${String((spec as { provider: unknown }).provider)}`);
}

/** A stable key for an adapter cache: identical specs share one adapter instance. */
export function specCacheKey(spec: ProviderSpec): string {
  // The key does NOT include the API key (specs that differ only by key are rare and a shared
  // adapter would be wrong) — include a presence flag instead so a key change still re-keys.
  return JSON.stringify({
    p: spec.provider, m: spec.model, e: spec.endpoint ?? '', t: spec.timeoutMs ?? 0,
    o: spec.options ?? null, h: spec.headers ?? null, k: spec.apiKey !== undefined,
    j: spec.preferToolJson ?? null,
  });
}
