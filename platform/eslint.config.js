/**
 * Minimal lint gate: correctness rules only, not a style rewrite. The browser
 * shim is linted with browser globals; panel/sdk/vendor stay out of scope.
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'vendor/**',
      'panel/**',
      'sdk/**',
      'tools/**',
      '_*.mjs',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, puter: 'readonly', CAD_HUB_HOSTING_BASE: 'readonly' },
    },
    rules: {
      // Existing code carries a few unused parameters/imports on purpose
      // (seams, compatibility shims); make them visible without failing.
      'no-unused-vars': ['warn', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      // Newer recommended rules that are not correctness gates for this tree.
      'no-useless-assignment': 'off',
      'no-constant-binary-expression': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    files: ['lib/shim/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];
