// SwitchableModelGateway — runtime model + provider switching over the single ModelGateway
// contract (MG-001). The fetch stub routes by URL so we can prove a switch actually changes which
// adapter (and thus which provider endpoint) the next generate() targets.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SwitchableModelGateway } from '@codeforge/infrastructure';
import type { ModelRequest } from '@codeforge/agent-core';

function req(): ModelRequest {
  return { purpose: 'plan', systemPrompt: 'sys', taskPrompt: 'task', maxOutputTokens: 128, temperature: 0 };
}

/** Record every fetched URL; answer Ollama vs OpenAI shapes based on the path. */
let urls: string[] = [];
function stubFetch(): void {
  urls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (url.includes('/api/generate')) {
      return new Response(JSON.stringify({ model: 'm', response: '{"ok":1}', done: true, prompt_eval_count: 1, eval_count: 1 }), { status: 200 });
    }
    if (url.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => { vi.unstubAllGlobals(); urls = []; });

describe('SwitchableModelGateway — backwards-compatible Ollama default', () => {
  it('starts on Ollama and reports the initial model', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    expect(gw.provider).toBe('ollama');
    expect(gw.model).toBe('qwen2.5-coder');
  });

  it('generate() hits the Ollama endpoint by default', async () => {
    stubFetch();
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    const r = await gw.generate(req());
    expect(r.raw).toBe('{"ok":1}');
    expect(urls[0]).toContain('/api/generate');
  });

  it('setModel swaps the model within the ollama provider', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'a' });
    expect(gw.setModel('b')).toBe('b');
    expect(gw.model).toBe('b');
    expect(gw.provider).toBe('ollama');
  });

  it('setModel is a no-op for an empty or identical name', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'a' });
    expect(gw.setModel('')).toBe('a');
    expect(gw.setModel('a')).toBe('a');
  });
});

describe('SwitchableModelGateway — cross-provider switch', () => {
  it('setProvider switches to an OpenAI-compatible endpoint for the next call', async () => {
    stubFetch();
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });

    gw.setProvider({ provider: 'openai-compatible', model: 'gpt-test', endpoint: 'https://api.example.com/v1', apiKey: 'sk-x' });
    expect(gw.provider).toBe('openai-compatible');
    expect(gw.model).toBe('gpt-test');

    await gw.generate(req());
    expect(urls[0]).toContain('/chat/completions');
    expect(urls[0]).toContain('api.example.com');
  });

  it('can switch back to ollama', async () => {
    stubFetch();
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    gw.setProvider({ provider: 'openai-compatible', model: 'gpt-test', endpoint: 'https://api.example.com/v1' });
    gw.setProvider({ provider: 'ollama', model: 'llama3', endpoint: 'http://localhost:11434' });
    expect(gw.provider).toBe('ollama');
    await gw.generate(req());
    expect(urls[0]).toContain('/api/generate');
  });

  it('rejecting an invalid provider spec keeps the current adapter working (fail-safe)', async () => {
    stubFetch();
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    // openai-compatible without an endpoint must throw and NOT replace the live Ollama adapter.
    expect(() => gw.setProvider({ provider: 'openai-compatible', model: 'gpt-test' })).toThrow();
    expect(gw.provider).toBe('ollama');
    await gw.generate(req());
    expect(urls[0]).toContain('/api/generate');
  });
});
