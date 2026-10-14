// provider-adapter — buildAdapter() factory + specCacheKey(). Focused on the openai-compatible
// branch's tool-native-JSON auto-enable for Groq (whose gpt-oss-* models answer via a tool call),
// verified through the request body an adapter actually sends. No real network / key.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildAdapter, specCacheKey, type ProviderSpec } from '@codeforge/infrastructure';
import type { ModelRequest } from '@codeforge/agent-core';

function req(): ModelRequest {
  return { purpose: 'plan', systemPrompt: 'sys', taskPrompt: 'task', maxOutputTokens: 256, temperature: 0, responseSchema: { type: 'object' } };
}

/** A 400 tool_use_failed body carrying a valid JSON failed_generation (Groq gpt-oss behavior). */
const BODY_400_WITH_JSON = JSON.stringify({ error: { code: 'tool_use_failed', failed_generation: '{"tasks":[]}' } });

function stub(status: number, body: string): void {
  vi.stubGlobal('fetch', async () => new Response(body, { status }));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('buildAdapter — openai-compatible tool-native JSON auto-enable (Groq)', () => {
  it('auto-enables for a Groq endpoint: recovers JSON from a 400 failed_generation', async () => {
    stub(400, BODY_400_WITH_JSON);
    const gw = buildAdapter({ provider: 'openai-compatible', model: 'openai/gpt-oss-120b', endpoint: 'https://api.groq.com/openai/v1', apiKey: 'k' });
    const r = await gw.generate(req());
    expect(r.raw).toBe('{"tasks":[]}');
  });

  it('does NOT auto-enable for a non-Groq endpoint: a 400 stays a hard failure', async () => {
    stub(400, BODY_400_WITH_JSON);
    const gw = buildAdapter({ provider: 'openai-compatible', model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1', apiKey: 'k' });
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('an explicit preferToolJson:false overrides the Groq auto-enable', async () => {
    stub(400, BODY_400_WITH_JSON);
    const gw = buildAdapter({ provider: 'openai-compatible', model: 'm', endpoint: 'https://api.groq.com/openai/v1', apiKey: 'k', preferToolJson: false });
    await expect(gw.generate(req())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });
});

describe('specCacheKey — preferToolJson participates in the key', () => {
  it('two specs that differ only by preferToolJson get different cache keys', () => {
    const base: ProviderSpec = { provider: 'openai-compatible', model: 'm', endpoint: 'https://x/v1' };
    expect(specCacheKey({ ...base, preferToolJson: true })).not.toBe(specCacheKey({ ...base, preferToolJson: false }));
  });
});
