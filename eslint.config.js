// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['**/*.ts', '**/*.mts'],
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
    rules: {
      // Every user-facing string in a template is marked for translation, so the
      // eleventh screen cannot arrive unmarked (#103, client-architecture.md
      // §17). `ignoreAttributes` replaces the rule's own list, so that list is
      // repeated here with the attributes this application carries that are not
      // prose: test hooks, an icon name, layout and input modes, a slot, a tab
      // route, a live-region politeness, a default route and a swipe side. A
      // new attribute that is not prose is added here with that argument; one
      // that is prose is marked in the template. Ids are not required by this
      // rule: `i18n-coverage.spec.ts` requires each marker to carry one.
      '@angular-eslint/template/i18n': [
        'error',
        {
          checkId: false,
          checkText: true,
          checkAttributes: true,
          ignoreAttributes: [
            'autocomplete', 'charset', 'class', 'color', 'colspan', 'dir', 'fill', 'for',
            'formArrayName', 'formControlName', 'formGroupName', 'height', 'href', 'id', 'lang',
            'list', 'name', 'ngClass', 'ngProjectAs', 'role', 'routerLink', 'routerLinkActive',
            'src', 'stroke', 'stroke-width', 'style', 'svgIcon', 'tabindex', 'target', 'type',
            'value', 'viewBox', 'width', 'xmlns',
            'aria-live', 'data-field', 'data-testid', 'defaultHref', 'expand', 'icon', 'inputmode',
            'lines', 'side', 'slot', 'tab',
          ],
        },
      ],
    },
  },
  {
    // A test's host component is a fixture, not a screen: its text is whatever
    // the case needs. Inline templates are linted as `<file>.ts/<n>_inline-...html`.
    files: ['**/*.spec.ts/*.html'],
    rules: { '@angular-eslint/template/i18n': 'off' },
  },
  {
    // The page shell is a document: its meta, link and title elements carry
    // values for the browser, not strings a screen shows, and a translation
    // would be a second build of the document rather than a message in it.
    files: ['src/index.html'],
    rules: { '@angular-eslint/template/i18n': 'off' },
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
