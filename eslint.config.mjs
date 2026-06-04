// =============================================================================
// ESLint flat config.
//
// Goal: catch genuine bugs (React hooks misuse, unreachable code, fallthroughs)
// without drowning a large existing codebase in stylistic noise. Style-only and
// intentional-pattern rules (explicit `any`, empty `catch {}` blocks) are
// relaxed; correctness rules stay as errors so CI fails on real problems.
// =============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output, deps, generated assets, and the companion bundle.
    ignores: [
      'dist/**',
      'release/**',
      'build/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      '**/*.config.js',
      '**/*.config.ts',
      '**/*.config.mjs',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The codebase carries many intentional `eslint-disable @typescript-eslint/
    // no-explicit-any` (and similar) directives for rules relaxed below. Leave
    // them in place instead of reporting/stripping them as "unused".
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // ---- Correctness (errors) ----
      ...reactHooks.configs.recommended.rules,
      'no-fallthrough': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-unsafe-optional-chaining': 'error',
      // Terminal/PTY/ANSI code legitimately matches control characters
      // (\x00, \x1b, \x07) in regexes — this is intentional, not a typo.
      'no-control-regex': 'off',

      // ---- Relaxed: intentional patterns in this codebase ----
      // `any` is used deliberately at native/electron/webview boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      // Empty `catch {}` / `catch { /* noop */ }` is a deliberate best-effort idiom.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // ts-expect-error / ts-ignore comments are used at typed-boundary casts.
      '@typescript-eslint/ban-ts-comment': 'off',
      // Non-null assertions appear at DOM/getElementById and known-present maps.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // require() appears in a few native-module lazy loads.
      '@typescript-eslint/no-require-imports': 'off',

      // ---- Hygiene (warnings — visible, non-blocking) ----
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': 'off',
    },
  },
  {
    // Tests lean on mocks/any and intentionally throw — relax further.
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
)
