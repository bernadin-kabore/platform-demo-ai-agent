import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Kubernetes and Terraform manifests are arbitrarily shaped; the checks
      // in src/evals walk them defensively rather than against generated types.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off', // TypeScript's own checker covers this; see npm run typecheck
    },
  },
);
