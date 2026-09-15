import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    // Determinism: no random seeds, no wall-clock dependence in Phase 0 tests.
    sequence: { shuffle: false },
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/index.ts'],
    },
  },
});
