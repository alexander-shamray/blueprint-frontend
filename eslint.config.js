// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
  {
    files: ['src/app/features/**/*.ts'],
    rules: {
      // Coarse check: catches any `@features/<name>` or `@features/<name>/...`
      // import, and any relative escape with a trailing segment (`../cart/x`).
      // It cannot tell "my own feature" from "another feature" — it has no
      // knowledge of which feature folder the importing file lives in — so it
      // also fires on a legitimate same-feature alias import (e.g.
      // `@features/products/utils` from inside `products/`), and it still
      // cannot catch a *bare* relative escape with no trailing segment
      // (`../cart`, no `/x` after it). `boundaries.spec.ts` is the precise
      // check for both of those: it resolves each specifier against the
      // importing file's real directory, so it knows the owner feature and
      // never over- or under-blocks. Treat this rule as a fast local signal,
      // not the source of truth.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@features/*', '../*/'],
          message:
            'A feature never imports another feature (spec §3). Shared state belongs in core — that is why the cart store lives there.',
        }],
      }],
    },
  },
  {
    files: ['src/app/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@features/*'],
          message: 'core knows nothing about screens (spec §3).',
        }],
      }],
    },
  },
]);
