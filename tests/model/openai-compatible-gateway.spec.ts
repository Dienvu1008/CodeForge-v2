// OpenAiCompatibleModelGateway — adapter for any OpenAI Chat Completions-compatible provider.
// Tests the success path, request shape (messages/response_format/Authorization), token usage,
// and the error mappings. Uses vi.stubGlobal to mock global fetch — no real network / key.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiCompatibleModelGateway, type OpenAiCompatibleConfig } from '@codeforge/infrastructure';
import { ModelError } from '@codeforge/agent-core';
import type { ModelRequest } from '@codeforge/agent-core';

const CONFIG: OpenAiCompatibleConfig = {
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-test',
  apiKey: 'sk-secret-123',
  timeoutMs: 500,
};

function req(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: 'plan',
    systemPrompt: 'You are a coding agent.',
    taskPrompt: 'Plan the feature.',
    maxOutputTokens: 512,
    temperature: 0,
    ...overrides,
  };
}

/** A minimal OpenAI chat-completion JSON body with the given assistant content. */
function completion(content: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });
}

/** Capture the last fetch call so request-shape assertions are possible. */
let lastCall: { url: string; init: RequestInit } | undefined;

function stubFetch(status: number, body: string, opts: { delay?: number } = {}): void {
  lastCall = undefined;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    lastCall = { url, init: init ?? {} };
    if (opts.delay !== undefined) await new Promise<void>((r) => setTimeout(r, opts.delay));
    if (init?.signal?.aborted) {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    }
    return new Response(body, { status });
  });
}

/** A chat-completion body where the assistant answered via a tool call (no plain content). */
function toolCompletion(argsJson: string, name = 'emit_json'): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name, arguments: argsJson } }] } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });
}

afterEach(() => { vi.unstubAllGlobals(); lastCall = undefined; });

describe('OpenAiCompatibleModelGateway — success path', () => {
  it('returns the assistant content as raw untrusted text + token usage', async () => {
    stubFetch(200, completion('{"type":"done","summary":"ok"}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    const result = await gw.generate(req());
    expect(result.raw).toBe('{"type":"done","summary":"ok"}');
    expect(result.model.name).toBe('gpt-test');
    expect(result.model.endpoint).toBe('https://api.example.com/v1');
    expect(result.promptTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
  });

  it('POSTs to <baseUrl>/chat/completions with system+user messages', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await gw.generate(req());
    expect(lastCall?.url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.model).toBe('gpt-test');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Plan the feature.' },
    ]);
    expect(body.stream).toBe(false);
  });

  it('sends the API key only in the Authorization header (never in the body)', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await gw.generate(req());
    const headers = lastCall?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-secret-123');
    expect(String(lastCall?.init.body)).not.toContain('sk-secret-123');
  });

  it('requests a JSON object response_format when a responseSchema is supplied', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await gw.generate(req({ responseSchema: { type: 'object' } }));
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when no schema is supplied', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await gw.generate(req());
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.response_format).toBeUndefined();
  });

  it('works keyless (no Authorization header) for local servers', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway({ baseUrl: 'http://localhost:1234/v1', model: 'local' });
    await gw.generate(req());
    const headers = lastCall?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('OpenAiCompatibleModelGateway — tool-native JSON (Groq gpt-oss family)', () => {
  it('reads JSON from a tool call when content is empty (fallback, flag off)', async () => {
    // A tool-trained model answered via tool_calls even without being asked — adapter recovers it.
    stubFetch(200, toolCompletion('{"tasks":[{"id":"T1"}]}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    const result = await gw.generate(req({ responseSchema: { type: 'object' } }));
    expect(result.raw).toBe('{"tasks":[{"id":"T1"}]}');
    expect(result.outputTokens).toBe(7);
  });

  it('plain content still wins over a tool call when both are present', async () => {
    stubFetch(200, JSON.stringify({
      choices: [{ message: { content: '{"from":"content"}', tool_calls: [{ function: { name: 'emit_json', arguments: '{"from":"tool"}' } }] } }],
    }));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    const result = await gw.generate(req({ responseSchema: { type: 'object' } }));
    expect(result.raw).toBe('{"from":"content"}');
  });

  it('preferToolJson never forces a tool call — it still sends plain response_format', async () => {
    stubFetch(200, completion('{"ok":true}'));
    const gw = new OpenAiCompatibleModelGateway({ ...CONFIG, preferToolJson: true });
    await gw.generate(req({ responseSchema: { type: 'object' } }));
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('preferToolJson recovers JSON from a 400 tool_use_failed failed_generation', async () => {
    // Groq rejects the turn on a tool-call technicality but the model produced correct JSON.
    stubFetch(400, JSON.stringify({
      error: { code: 'tool_use_failed', message: 'Tool choice is required, but model did not call a tool', failed_generation: '{"tasks":[{"id":"T1"}]}' },
    }));
    const gw = new OpenAiCompatibleModelGateway({ ...CONFIG, preferToolJson: true });
    const result = await gw.generate(req({ responseSchema: { type: 'object' } }));
    expect(result.raw).toBe('{"tasks":[{"id":"T1"}]}');
  });

  it('does NOT recover when failed_generation is not valid JSON (still MODEL_UNAVAILABLE)', async () => {
    stubFetch(400, JSON.stringify({ error: { code: 'tool_use_failed', failed_generation: 'not json {{{' } }));
    const gw = new OpenAiCompatibleModelGateway({ ...CONFIG, preferToolJson: true });
    await expect(gw.generate(req({ responseSchema: { type: 'object' } }))).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('does NOT recover a 400 when preferToolJson is off (plain provider, fail-safe)', async () => {
    stubFetch(400, JSON.stringify({ error: { failed_generation: '{"tasks":[]}' } }));
    const gw = new OpenAiCompatibleModelGateway(CONFIG); // flag off
    await expect(gw.generate(req({ responseSchema: { type: 'object' } }))).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('flag off + schema still uses response_format (fail-safe parity, unchanged)', async () => {
    stubFetch(200, completion('{}'));
    const gw = new OpenAiCompatibleModelGateway(CONFIG); // preferToolJson defaults false
    await gw.generate(req({ responseSchema: { type: 'object' } }));
    const body = JSON.parse(String(lastCall?.init.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.tools).toBeUndefined();
  });
});

describe('OpenAiCompatibleModelGateway — error mapping', () => {
  it('maps a timeout to MODEL_TIMEOUT', async () => {
    stubFetch(200, completion('{}'), { delay: 50 });
    const gw = new OpenAiCompatibleModelGateway({ ...CONFIG, timeoutMs: 1 });
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('maps a non-2xx (e.g. 401) to MODEL_UNAVAILABLE without leaking the key', async () => {
    stubFetch(401, JSON.stringify({ error: { message: 'invalid api key' } }));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    let caught: unknown;
    try { await gw.generate(req()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ModelError);
    expect((caught as ModelError).code).toBe('MODEL_UNAVAILABLE');
    expect((caught as ModelError).message).not.toContain('sk-secret-123');
  });

  it('maps an unparseable body to MODEL_OUTPUT_INVALID', async () => {
    stubFetch(200, 'not json at all');
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });

  it('maps a missing content field to MODEL_OUTPUT_INVALID', async () => {
    stubFetch(200, JSON.stringify({ choices: [{ message: {} }] }));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });

  it('surfaces a provider error field as MODEL_UNAVAILABLE', async () => {
    stubFetch(200, JSON.stringify({ error: { message: 'rate limited' } }));
    const gw = new OpenAiCompatibleModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });
});
