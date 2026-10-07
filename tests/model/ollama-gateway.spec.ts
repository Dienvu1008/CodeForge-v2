// P2-MG1 — OllamaModelGateway (MG-001/004/005, SE-010).
// Tests: success path, MODEL_TIMEOUT, MODEL_UNAVAILABLE, non-2xx, bad JSON.
// Uses vi.stubGlobal to mock global fetch — no real network required.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaModelGateway, type OllamaConfig } from '@codeforge/infrastructure';
import { ModelError } from '@codeforge/agent-core';
import type { ModelRequest } from '@codeforge/agent-core';

// ── helpers ───────────────────────────────────────────────────────────────────

const CONFIG: OllamaConfig = {
  endpoint: 'http://localhost:11434',
  model: 'qwen2.5-coder:7b',
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

/** Build a minimal Ollama /api/generate JSON response. */
function ollamaResponse(text: string, model = CONFIG.model): string {
  return JSON.stringify({
    model,
    response: text,
    done: true,
    prompt_eval_count: 10,
    eval_count: 5,
  });
}

/** Stub global fetch with a canned response. Returns an AbortController-aware mock. */
function stubFetch(
  status: number,
  body: string,
  opts: { delay?: number } = {},
): void {
  vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
    if (opts.delay !== undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, opts.delay));
    }
    // If the request was already aborted, throw AbortError.
    if (options?.signal?.aborted) {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    return new Response(body, { status });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Success path
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaModelGateway — success path', () => {
  it('returns raw response text (SE-010: untrusted, not parsed)', async () => {
    stubFetch(200, ollamaResponse('{"kind":"generate"}'));
    const gw = new OllamaModelGateway(CONFIG);
    const result = await gw.generate(req());
    // Raw string — not parsed. Caller must validate (MG-002/MG-006).
    expect(result.raw).toBe('{"kind":"generate"}');
    expect(typeof result.raw).toBe('string');
  });

  it('MG-004: records model identity in every response', async () => {
    stubFetch(200, ollamaResponse('{}'));
    const gw = new OllamaModelGateway(CONFIG);
    const result = await gw.generate(req());
    expect(result.model.name).toBe(CONFIG.model);
    expect(result.model.endpoint).toBe(CONFIG.endpoint);
  });

  it('records token counts from Ollama response', async () => {
    stubFetch(200, ollamaResponse('hello'));
    const gw = new OllamaModelGateway(CONFIG);
    const result = await gw.generate(req());
    expect(result.promptTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it('identity is accessible before any generate() call', () => {
    const gw = new OllamaModelGateway(CONFIG);
    expect(gw.identity.name).toBe(CONFIG.model);
    expect(gw.identity.endpoint).toBe(CONFIG.endpoint);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MG-005 error cases
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaModelGateway — MG-005 error cases', () => {
  it('MODEL_UNAVAILABLE on non-2xx HTTP status', async () => {
    stubFetch(503, 'service unavailable');
    const gw = new OllamaModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toBeInstanceOf(ModelError);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('MODEL_UNAVAILABLE when fetch throws (connection refused)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const gw = new OllamaModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('MODEL_OUTPUT_INVALID when response body is not valid JSON', async () => {
    stubFetch(200, 'this is not json at all');
    const gw = new OllamaModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });

  it('MODEL_OUTPUT_INVALID when response field is missing', async () => {
    stubFetch(200, '{"model":"x","done":true}'); // no "response" field
    const gw = new OllamaModelGateway(CONFIG);
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MG-005 timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaModelGateway — MG-005 timeout (SE-007)', () => {
  it('MODEL_TIMEOUT when response exceeds timeoutMs', async () => {
    // Delay longer than gateway timeout (500ms).
    vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 2000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
      return new Response('{}', { status: 200 });
    });

    const gw = new OllamaModelGateway({ ...CONFIG, timeoutMs: 50 });
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  }, 5000);
});

// ─────────────────────────────────────────────────────────────────────────────
// MG-001: single boundary — OllamaModelGateway implements ModelGateway
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaModelGateway — MG-001: implements ModelGateway', () => {
  it('has generate() and identity (satisfies ModelGateway contract)', () => {
    const gw = new OllamaModelGateway(CONFIG);
    expect(typeof gw.generate).toBe('function');
    expect(gw.identity).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P10.6 streaming — NDJSON chunk assembly (display-only; determinism preserved)
// ─────────────────────────────────────────────────────────────────────────────

describe('OllamaModelGateway — P10.6 streaming', () => {
  it('assembles multi-chunk NDJSON into the full response', async () => {
    const ndjson = [
      JSON.stringify({ model: CONFIG.model, response: '{"ki', done: false }),
      JSON.stringify({ model: CONFIG.model, response: 'nd":"gen', done: false }),
      JSON.stringify({ model: CONFIG.model, response: 'erate"}', done: true, prompt_eval_count: 12, eval_count: 7 }),
    ].join('\n');
    stubFetch(200, ndjson);

    const gw = new OllamaModelGateway(CONFIG);
    const result = await gw.generate(req());

    expect(result.raw).toBe('{"kind":"generate"}'); // assembled from 3 chunks
    expect(result.promptTokens).toBe(12);            // from the final (done) chunk
    expect(result.outputTokens).toBe(7);
  });

  it('invokes onToken for each streamed chunk (display-only)', async () => {
    const ndjson = [
      JSON.stringify({ model: CONFIG.model, response: 'a', done: false }),
      JSON.stringify({ model: CONFIG.model, response: 'b', done: false }),
      JSON.stringify({ model: CONFIG.model, response: 'c', done: true }),
    ].join('\n');
    stubFetch(200, ndjson);

    const tokens: string[] = [];
    const gw = new OllamaModelGateway({ ...CONFIG, onToken: (t) => tokens.push(t) });
    const result = await gw.generate(req());

    expect(result.raw).toBe('abc');
    expect(tokens).toEqual(['a', 'b', 'c']);
  });
});
