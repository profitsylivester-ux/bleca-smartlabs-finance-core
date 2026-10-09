import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

/**
 * The kernel / module separation is the single most important architectural rule
 * in PHASE_1_PLAN.md 2.2: the one-way dependency rule.
 *
 *   modules/**  ->  lib/**  ->  infrastructure
 *   lib/**      -X->  modules/**, app/**
 *   modules/A   -X->  modules/B/server/**
 *
 * These zones are enforced here at lint time. They are *also* enforced by
 * src/tests/unit/import-graph.test.ts, which walks the real import graph; lint
 * alone can be bypassed with a dynamic import or a tsconfig path alias, the
 * graph test cannot.
 */
const kernelZones = [
  {
    name: 'bleca/kernel-must-not-import-modules-or-app',
    files: ['src/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*', '**/modules/*/**'],
              message:
                'Kernel (src/lib) must not import from modules/. Dependency direction is modules -> lib only.',
            },
            {
              group: ['@/modules/*', '@/modules/*/**', '@/app/*', '@/app/**'],
              message:
                'Kernel (src/lib) must not import from the presentation layer. Dependency direction is app -> modules -> lib.',
            },
            {
              group: ['../modules/*', '../app/*'],
              message: 'Kernel (src/lib) must not import from modules/ or app/.',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'bleca/modules-must-not-import-prisma-client-directly',
    files: ['src/modules/*/**/*.{ts,tsx}'],
    rules: {
      /**
       * Modules may use the shared `prisma` from '@/lib/db/prisma' - that is the
       * single instance and the place the tenant extension lives. What they may
       * not do is import the generated client directly, which bypasses both.
       */
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '@/generated/prisma*', '@/generated/prisma/*'],
              message:
                "Import the shared client from '@/lib/db/prisma' (or '@/lib/kernel'), so there is one connection and the tenant filter is always applied.",
            },
          ],
        },
      ],
    },
  },
  {
    name: 'bleca/no-secrets-in-source',
    files: ['**/*.{ts,tsx,js,mjs}'],
    // The rule's own selector strings mention the patterns it looks for.
    ignores: ['eslint.config.mjs', 'e2e/**', 'prisma/seed.ts', '**/__tests__/**', 'src/tests/**'],
    rules: {
      /**
       * Deliberately simple patterns, one per provider prefix.
       *
       * An earlier version used an inline (?i) flag and character classes for
       * case-insensitivity; ESLint parses attribute selectors with esquery, which
       * supports neither, and the failure was a hard parse error that took the
       * whole lint run down rather than skipping one rule.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^sk_live_[a-zA-Z0-9]{16,}$/]',
          message: 'Looks like a committed secret. Secrets belong in env vars only.',
        },
        {
          selector: 'Literal[value=/^pk_live_[a-zA-Z0-9]{16,}$/]',
          message: 'Looks like a committed secret. Secrets belong in env vars only.',
        },
        {
          selector: 'Literal[value=/BEGIN PRIVATE KEY/]',
          message: 'Looks like a committed private key. Keys belong in a secret store.',
        },
        {
          selector: 'Literal[value=/^eyJhbGciOi/]',
          message: 'Looks like a committed JWT. Tokens belong in env vars only.',
        },
      ],
    },
  },
  {
    name: 'bleca/service-functions-must-authorize',
    files: ['src/modules/*/server/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AwaitExpression[argument.object.name=/^(prisma|db)$/]',
          message:
            'Service functions must go through lib/db helpers, which carry the tenant filter and audit hook.',
        },
      ],
    },
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...kernelZones,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'node_modules/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'src/generated/**',
  ]),
]);

export default eslintConfig;
