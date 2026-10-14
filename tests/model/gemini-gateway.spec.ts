// GeminiModelGateway — native Generative Language API adapter. Tests the success path, request
// shape (systemInstruction/contents/generationConfig/x-goog-api-key header), token usage, JSON
// mime type, multi-part concat, and error mappings. Uses vi.stubGlobal to mock fetch — no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiModelGateway, buildAdapter, type GeminiConfig } from '@codeforge/infrastructure';
import { ModelError } from '@codeforge/agent-core';
import type { ModelRequest } from '@codeforge/agent-core';

const CONFIG: GeminiConfig = { model: 'gemini-flash-latest', apiKey: 'AIza-secret-xyz', timeoutMs: 500 };

function req(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return { purpose: 'plan', systemPrompt: 'You are a coding agent.', taskPrompt: 'Plan the feature.', maxOutputTokens: 512, temperature: 0, ...overrides };
}

/** A minimal Gemini generateContent body with the given candidate text (optionally split parts). */
function completion(parts: string[], usage = { promptTokenCount: 11, candidatesTokenCount: 7 }): string {
  return JSON.stringify({ candidates: [{ content: { parts: parts.map((t) => ({ text: t })) }, finishReason: 'STOP' }], usageMetadata: usage });
}

let lastCall: { url: string; init: RequestInit } | undefined;
function stubFetch(status: number, body: string, opts: { delay?: number } = {}): void {
  lastCall = undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    lastCall = { url, init: init ?? {} };
    if (opts.delay !== undefined) await new Promise<void>((r) => setTimeout(r, opts.delay));
    if (init?.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return new Response(body, { status });
  });
}
afterEach(() => { vi.unstubAllGlobals(); lastCall = undefined; });

describe('GeminiModelGateway — success path', () => {
  it('returns candidate text as raw untrusted output + token usage', async () => {
    stubFetch(200, completion(['{"type":"done","summary":"ok"}']));
    const gw = new GeminiModelGateway(CONFIG);
    const result = await gw.generate(req());
    expect(result.raw).toBe('{"type":"done","summary":"ok"}');
    expect(result.model.name).toBe('gemini-flash-latest');
    expect(result.promptTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
  });

  it('concatenates multiple text parts', async () => {
    stubFetch(200, completion(['We need to ', '{"ok":true}']));
    const gw = new GeminiModelGateway(CONFIG);
    const result = await gw.generate(req());
    expect(result.raw).toBe('We need to {"ok":true}');
  });

  it('POSTs to <baseUrl>/models/<model>:generateContent with systemInstruction + user turn', async () => {
    stubFetch(200, completion(['{}']));
    const gw = new GeminiModelGateway(CONFIG);
    await gw.generate(req());
    expect(lastCall?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.systemInstruction.parts[0].text).toBe('You are a coding agent.');
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toBe('Plan the feature.');
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
  });

  it('sends the API key only in the x-goog-api-key header (never in the body)', async () => {
    stubFetch(200, completion(['{}']));
    const gw = new GeminiModelGateway(CONFIG);
    await gw.generate(req());
    const headers = lastCall?.init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('AIza-secret-xyz');
    expect(headers.Authorization).toBeUndefined();
    expect(String(lastCall?.init.body)).not.toContain('AIza-secret-xyz');
  });

  it('requests application/json responseMimeType when a schema is supplied', async () => {
    stubFetch(200, completion(['{}']));
    const gw = new GeminiModelGateway(CONFIG);
    await gw.generate(req({ responseSchema: { type: 'object' } }));
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('omits responseMimeType when no schema is supplied', async () => {
    stubFetch(200, completion(['hi']));
    const gw = new GeminiModelGateway(CONFIG);
    await gw.generate(req());
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });
});

describe('GeminiModelGateway — error mapping', () => {
  it('maps a timeout to MODEL_TIMEOUT', async () => {
    stubFetch(200, completion(['{}']), { delay: 50 });
    const gw = new GeminiModelGateway({ ...CONFIG, timeoutMs: 1 });
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('maps a non-2xx (e.g. 429) to MODEL_UNAVAILABLE without leaking the key', async () => {
    stubFetch(429, JSON.stringify({ error: { message: 'rate limited' } }));
    const gw = new GeminiModelGateway(CONFIG);
    let caught: unknown;
    try { await gw.generate(req()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ModelError);
    expect((caught as ModelError).code).toBe('MODEL_UNAVAILABLE');
    expect((caught as ModelError).message).not.toContain('AIza-secret-xyz');
  });

  it('maps an unparseable body to MODEL_OUTPUT_INVALID', async () => {
    stubFetch(200, 'not json at all');
    const gw = new GeminiModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });

  it('maps a candidate with no text parts to MODEL_OUTPUT_INVALID (e.g. safety block)', async () => {
    stubFetch(200, JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }));
    const gw = new GeminiModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
});

describe('buildAdapter — gemini provider', () => {
  it('builds a GeminiModelGateway that drives generateContent', async () => {
    stubFetch(200, completion(['{"ok":true}']));
    const gw = buildAdapter({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'k' });
    const r = await gw.generate(req());
    expect(r.raw).toBe('{"ok":true}');
    expect(String(lastCall?.url)).toContain('/models/gemini-2.5-flash:generateContent');
  });

  it('throws when a gemini spec has no apiKey', () => {
    expect(() => buildAdapter({ provider: 'gemini', model: 'gemini-2.5-flash' })).toThrow(/apiKey/i);
  });

  it('uses a custom endpoint when provided', async () => {
    stubFetch(200, completion(['{}']));
    const gw = buildAdapter({ provider: 'gemini', model: 'm', apiKey: 'k', endpoint: 'https://proxy.example/v1beta' });
    await gw.generate(req());
    expect(String(lastCall?.url)).toBe('https://proxy.example/v1beta/models/m:generateContent');
  });
});
