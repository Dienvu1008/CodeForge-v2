// model-routes-config — parse + validate a per-purpose routing config, resolving API keys from
// env refs (apiKeyEnv) so a secret is never written in the file. Pure parse tested with a fake env.
import { describe, it, expect } from 'vitest';
import { parseModelRoutes, ModelRoutesConfigError } from '@codeforge/infrastructure';

const ENV = { OPENAI_API_KEY: 'sk-live-123' } as unknown as NodeJS.ProcessEnv;

describe('parseModelRoutes — happy path', () => {
  it('resolves default + per-purpose routes, reading the key from the named env var', () => {
    const cfg = parseModelRoutes({
      default: { provider: 'ollama', model: 'qwen2.5-coder', endpoint: 'http://localhost:11434' },
      routes: {
        plan: { provider: 'openai-compatible', model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      },
    }, ENV);

    expect(cfg.default.provider).toBe('ollama');
    expect(cfg.routes?.plan?.provider).toBe('openai-compatible');
    // The key was pulled from the env var, not from the file.
    expect(cfg.routes?.plan?.apiKey).toBe('sk-live-123');
    expect(cfg.routes?.execute).toBeUndefined(); // unmapped → will use default at runtime
  });

  it('allows a config with no routes (just a default)', () => {
    const cfg = parseModelRoutes({ default: { provider: 'ollama', model: 'llama3' } }, ENV);
    expect(cfg.default.model).toBe('llama3');
    expect(cfg.routes).toEqual({});
  });
});

describe('parseModelRoutes — validation', () => {
  it('rejects a non-object config', () => {
    expect(() => parseModelRoutes('nope', ENV)).toThrow(ModelRoutesConfigError);
  });

  it('requires a default', () => {
    expect(() => parseModelRoutes({ routes: {} }, ENV)).toThrow(/default is required/);
  });

  it('rejects an unknown provider', () => {
    expect(() => parseModelRoutes({ default: { provider: 'anthropic-native', model: 'x' } }, ENV))
      .toThrow(/provider must be one of/);
  });

  it('rejects an openai-compatible spec without an endpoint', () => {
    expect(() => parseModelRoutes({ default: { provider: 'openai-compatible', model: 'gpt' } }, ENV))
      .toThrow(/requires an endpoint/);
  });

  it('rejects an unknown purpose key in routes', () => {
    expect(() => parseModelRoutes({
      default: { provider: 'ollama', model: 'm' },
      routes: { planning: { provider: 'ollama', model: 'm' } },
    }, ENV)).toThrow(/unknown purpose/);
  });

  it('errors (naming the env var, not the value) when the key env var is unset', () => {
    let caught: unknown;
    try {
      parseModelRoutes({
        default: { provider: 'ollama', model: 'm' },
        routes: { plan: { provider: 'openai-compatible', model: 'gpt', endpoint: 'https://x/v1', apiKeyEnv: 'MISSING_KEY' } },
      }, ENV);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ModelRoutesConfigError);
    expect((caught as Error).message).toContain('MISSING_KEY');
    expect((caught as Error).message).not.toContain('sk-live-123');
  });

  it('rejects a non-positive timeoutMs', () => {
    expect(() => parseModelRoutes({ default: { provider: 'ollama', model: 'm', timeoutMs: 0 } }, ENV))
      .toThrow(/timeoutMs/);
  });
});
