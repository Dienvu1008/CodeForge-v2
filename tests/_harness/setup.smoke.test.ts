import { describe, it, expect } from 'vitest';

// SETUP smoke test: verifies the monorepo + Vitest + TS resolution are wired.
// Not an invariant test. Replaced/expanded once C1/C3 land.
describe('phase-0 setup', () => {
  it('runs Vitest', () => {
    expect(1 + 1).toBe(2);
  });

  it('resolves workspace packages', async () => {
    const core = await import('@codeforge/agent-core');
    const infra = await import('@codeforge/infrastructure');
    const testing = await import('@codeforge/testing');
    expect(core).toBeTypeOf('object');
    expect(infra).toBeTypeOf('object');
    expect(testing).toBeTypeOf('object');
  });
});
