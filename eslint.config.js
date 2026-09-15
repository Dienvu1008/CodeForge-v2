// ESLint flat config (v9). TypeScript + dependency-direction guard.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'tests/workspace/vectors/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Allow intentionally-unused args/vars prefixed with `_` (interface-impl stubs,
    // required-but-unused params). Standard convention.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // CommonJS tooling configs (dependency-cruiser, etc.).
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    // Node ESM build/generator scripts (not shipped in runtime).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    // Domain layer must not import adapters (belt-and-suspenders with dependency-cruiser).
    files: ['packages/agent-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@codeforge/infrastructure*',
            '@codeforge/models*',
            '@codeforge/tools*',
            'node:fs',
            'node:child_process',
            'better-sqlite3',
          ],
        },
      ],
    },
  },
);
