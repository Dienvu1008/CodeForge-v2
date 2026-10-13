// model-registry-config — parse + validate a multi-model registry file into a ModelRegistry (for
// the router) + an id→ProviderSpec map (for the selector). Keys come from env refs. Pure parse.
import { describe, it, expect } from 'vitest';
import { parseModelRegistry, ModelRegistryConfigError } from '@codeforge/infrastructure';

const ENV = { OPENAI_API_KEY: 'sk-live' } as unknown as NodeJS.ProcessEnv;

const BASE = {
  preferred: 'small',
  models: [
    { id: 'small', tier: 'SMALL', provider: 'ollama', endpoint: 'http://localhost:11434',
      capabilities: { reasoning: 'LOW', coding: 'MEDIUM', architecture: 'LOW', context: 'SMALL', toolUse: 'MEDIUM', speed: 'FAST' } },
    { id: 'strong', tier: 'STRONG', provider: 'ollama', endpoint: 'http://localhost:11434',
      capabilities: { reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', speed: 'SLOW' } },
  ],
};

describe('parseModelRegistry — happy path', () => {
  it('builds a registry with both models and an id→spec map', () => {
    const r = parseModelRegistry(BASE, ENV);
    expect(r.registry.list().map((m) => m.id).sort()).toEqual(['small', 'strong']);
    expect(r.specsById.get('strong')?.provider).toBe('ollama');
    expect(r.defaultModelId).toBe('small'); // = preferred
    expect(r.preferredModelId).toBe('small');
  });

  it('defaults the start model to the first entry when no preferred is given', () => {
    const r = parseModelRegistry({ models: BASE.models }, ENV);
    expect(r.defaultModelId).toBe('small');
    expect(r.preferredModelId).toBeUndefined();
  });

  it('resolves a cloud entry key from the named env var (never from the file)', () => {
    const r = parseModelRegistry({
      models: [
        { id: 'gpt', tier: 'STRONG', provider: 'openai-compatible', endpoint: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',
          capabilities: { reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', speed: 'MEDIUM' } },
      ],
    }, ENV);
    expect(r.specsById.get('gpt')?.apiKey).toBe('sk-live');
  });
});

describe('parseModelRegistry — validation', () => {
  it('rejects an empty models array', () => {
    expect(() => parseModelRegistry({ models: [] }, ENV)).toThrow(/non-empty array/);
  });
  it('rejects a bad tier', () => {
    expect(() => parseModelRegistry({ models: [{ id: 'x', tier: 'HUGE', provider: 'ollama', capabilities: BASE.models[0]!.capabilities }] }, ENV))
      .toThrow(/tier must be/);
  });
  it('rejects a bad capability level', () => {
    const caps = { ...BASE.models[0]!.capabilities, reasoning: 'EXTREME' };
    expect(() => parseModelRegistry({ models: [{ id: 'x', tier: 'SMALL', provider: 'ollama', capabilities: caps }] }, ENV))
      .toThrow(/LOW\|MEDIUM\|HIGH/);
  });
  it('rejects openai-compatible without an endpoint', () => {
    expect(() => parseModelRegistry({ models: [{ id: 'x', tier: 'SMALL', provider: 'openai-compatible', capabilities: BASE.models[0]!.capabilities }] }, ENV))
      .toThrow(/requires an endpoint/);
  });
  it('rejects a preferred id not in the list', () => {
    expect(() => parseModelRegistry({ ...BASE, preferred: 'nope' }, ENV)).toThrow(/not one of the listed/);
  });
  it('errors by env var NAME (not value) when a key env var is unset', () => {
    let caught: unknown;
    try {
      parseModelRegistry({ models: [{ id: 'gpt', tier: 'STRONG', provider: 'openai-compatible', endpoint: 'https://x/v1', apiKeyEnv: 'MISSING',
        capabilities: BASE.models[1]!.capabilities }] }, ENV);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ModelRegistryConfigError);
    expect((caught as Error).message).toContain('MISSING');
    expect((caught as Error).message).not.toContain('sk-live');
  });
});
