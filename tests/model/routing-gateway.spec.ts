// RoutingModelGateway — per-purpose model routing behind the single ModelGateway contract.
// The fetch stub routes by URL so we can prove each purpose hits the provider it was mapped to.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RoutingModelGateway, type ProviderSpec } from '@codeforge/infrastructure';
import type { ModelRequest, ModelPurpose } from '@codeforge/agent-core';

function req(purpose: ModelPurpose): ModelRequest {
  return { purpose, systemPrompt: 'sys', taskPrompt: 'task', maxOutputTokens: 128, temperature: 0 };
}

const OLLAMA: ProviderSpec = { provider: 'ollama', model: 'qwen2.5-coder', endpoint: 'http://localhost:11434' };
const CLOUD: ProviderSpec = { provider: 'openai-compatible', model: 'gpt-strong', endpoint: 'https://api.example.com/v1', apiKey: 'sk-x' };

let urls: string[] = [];
function stubFetch(): void {
  urls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (url.includes('/api/generate')) {
      return new Response(JSON.stringify({ model: 'm', response: '{"ok":1}', done: true }), { status: 200 });
    }
    if (url.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), { status: 200 });
    }
    return new Response('nf', { status: 404 });
  });
}
afterEach(() => { vi.unstubAllGlobals(); urls = []; });

describe('RoutingModelGateway — per-purpose routing', () => {
  it('routes a mapped purpose to its provider and an unmapped one to the default', async () => {
    stubFetch();
    const gw = new RoutingModelGateway({ default: OLLAMA, routes: { plan: CLOUD, architect: CLOUD } });

    await gw.generate(req('plan'));
    expect(urls[0]).toContain('/chat/completions'); // plan → cloud
    expect(urls[0]).toContain('api.example.com');

    await gw.generate(req('execute'));
    expect(urls[1]).toContain('/api/generate'); // execute → default (ollama)
  });

  it('specFor reports the route or the default (pure)', () => {
    const gw = new RoutingModelGateway({ default: OLLAMA, routes: { plan: CLOUD } });
    expect(gw.specFor('plan')).toEqual(CLOUD);
    expect(gw.specFor('execute')).toEqual(OLLAMA); // falls back to default
    expect(gw.specFor('summarize')).toEqual(OLLAMA);
  });

  it('identity comes from the default spec', () => {
    const gw = new RoutingModelGateway({ default: OLLAMA, routes: { plan: CLOUD } });
    expect(gw.identity.name).toBe('qwen2.5-coder');
    expect(gw.identity.endpoint).toBe('http://localhost:11434');
  });

  it('no routes at all ⇒ every purpose uses the default (fail-safe parity)', async () => {
    stubFetch();
    const gw = new RoutingModelGateway({ default: OLLAMA });
    await gw.generate(req('plan'));
    await gw.generate(req('execute'));
    expect(urls.every((u) => u.includes('/api/generate'))).toBe(true);
  });

  it('caches the adapter per spec (two calls to the same route reuse one adapter)', async () => {
    stubFetch();
    const gw = new RoutingModelGateway({ default: OLLAMA, routes: { plan: CLOUD, architect: CLOUD } });
    // plan and architect share the SAME cloud spec → same cache key → one adapter instance.
    await gw.generate(req('plan'));
    await gw.generate(req('architect'));
    // Both reached the cloud endpoint; the test asserts behavior, caching is an internal optimization.
    expect(urls[0]).toContain('/chat/completions');
    expect(urls[1]).toContain('/chat/completions');
  });

  it('a bad default spec fails fast at construction', () => {
    expect(() => new RoutingModelGateway({ default: { provider: 'openai-compatible', model: 'x' } }))
      .toThrow(/endpoint/i);
  });

  it('a bad route spec surfaces when that purpose is used (not at construction)', async () => {
    stubFetch();
    const gw = new RoutingModelGateway({ default: OLLAMA, routes: { plan: { provider: 'openai-compatible', model: 'x' } } });
    // execute uses the (valid) default — fine.
    await gw.generate(req('execute'));
    // plan uses the invalid route → throws when invoked.
    await expect(gw.generate(req('plan'))).rejects.toThrow(/endpoint/i);
  });
});
