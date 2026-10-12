// SwitchableRuntimeModelSelector — applies a mission-recommended model id to the switchable
// gateway via an id→ProviderSpec map. Unknown/empty/already-active ids are no-ops. The fetch stub
// routes by URL so a real switch is observable.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SwitchableModelGateway, SwitchableRuntimeModelSelector, type ProviderSpec } from '@codeforge/infrastructure';
import type { ModelRequest } from '@codeforge/agent-core';

function req(): ModelRequest {
  return { purpose: 'plan', systemPrompt: 's', taskPrompt: 't', maxOutputTokens: 64, temperature: 0 };
}

let urls: string[] = [];
function stubFetch(): void {
  urls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (url.includes('/api/generate')) return new Response(JSON.stringify({ model: 'm', response: '{}', done: true }), { status: 200 });
    if (url.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    return new Response('nf', { status: 404 });
  });
}
afterEach(() => { vi.unstubAllGlobals(); urls = []; });

const SPECS = new Map<string, ProviderSpec>([
  ['qwen2.5-coder', { provider: 'ollama', model: 'qwen2.5-coder', endpoint: 'http://localhost:11434' }],
  ['gpt-strong', { provider: 'openai-compatible', model: 'gpt-strong', endpoint: 'https://api.example.com/v1', apiKey: 'sk-x' }],
]);

describe('SwitchableRuntimeModelSelector', () => {
  it('switches the gateway to the mapped provider/model for a known id', async () => {
    stubFetch();
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    const sel = new SwitchableRuntimeModelSelector({ gateway: gw, specsById: SPECS });

    sel.selectModel('gpt-strong');
    expect(gw.provider).toBe('openai-compatible');
    expect(gw.model).toBe('gpt-strong');
    await gw.generate(req());
    expect(urls[0]).toContain('/chat/completions');
  });

  it('is a no-op for an unknown id (model unchanged)', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    const sel = new SwitchableRuntimeModelSelector({ gateway: gw, specsById: SPECS });
    sel.selectModel('model-we-dont-have');
    expect(gw.model).toBe('qwen2.5-coder');
    expect(gw.provider).toBe('ollama');
  });

  it('is a no-op for an id already active', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    let switches = 0;
    const sel = new SwitchableRuntimeModelSelector({ gateway: gw, specsById: SPECS, onSwitch: () => { switches++; } });
    sel.selectModel('qwen2.5-coder'); // already active
    expect(switches).toBe(0);
    expect(gw.model).toBe('qwen2.5-coder');
  });

  it('is a no-op for an empty id', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    const sel = new SwitchableRuntimeModelSelector({ gateway: gw, specsById: SPECS });
    sel.selectModel('   ');
    expect(gw.model).toBe('qwen2.5-coder');
  });

  it('reports an applied switch via onSwitch WITHOUT the API key', () => {
    const gw = new SwitchableModelGateway({ endpoint: 'http://localhost:11434', initialModel: 'qwen2.5-coder' });
    const notes: string[] = [];
    const sel = new SwitchableRuntimeModelSelector({ gateway: gw, specsById: SPECS, onSwitch: (n) => notes.push(n) });
    sel.selectModel('gpt-strong');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('gpt-strong');
    expect(notes[0]).not.toContain('sk-x');
  });
});
