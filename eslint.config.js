// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules.
 *
 * Type checking already runs, under a strict tsconfig, so a rule that only
 * restates what `tsc` proves earns nothing here. What the linter is for is the
 * class of mistake a type checker cannot see: a promise nobody waits for, a
 * `catch` that swallows what it caught, an `await` on a value that was never
 * asynchronous. Every one of those compiles.
 *
 * The type-checked rule set is used rather than the syntactic one for the same
 * reason. Without type information a linter can only guess whether an
 * expression is a promise, and the guess is wrong exactly where this service
 * cares: the click write that is deliberately not awaited, and the request
 * pipeline that must await everything else.
 *
 * There are no `eslint-disable` comments in this project, and adding one is the
 * wrong repair. A rule that is wrong for this codebase is narrowed here, in the
 * open, where the next person can see the decision and argue with it.
 */
export default tseslint.config(
  {
    // Nothing generated, vendored, or installed is ours to lint.
    ignores: ['node_modules/', 'coverage/', 'dist/'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Reads the same tsconfig the type check uses, so the linter and `tsc`
        // can never disagree about which files exist or how strict they are.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // A floating promise is the failure this service is most exposed to: the
      // pipeline is asynchronous end to end, and a forgotten `await` turns a
      // failed database write into a silent success. The one deliberate case,
      // the click write on the redirect path, is marked with `void` at the call
      // site, which this rule accepts and a reader can see.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // `describe` and `it` from `node:test` return promises that the
          // runner owns and no caller is meant to await. Awaiting them is
          // actively wrong for `describe`, whose body is collected rather than
          // run. Listing them here is narrower than turning the rule off in
          // tests, which is where the rule earns most of its keep.
          allowForKnownSafeCalls: [
            {
              from: 'package',
              package: 'node:test',
              name: ['describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach'],
            },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',

      // Unused code is either a mistake or a leftover. The underscore prefix is
      // the escape hatch for a parameter that exists to satisfy a signature.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Every type in this codebase is a `type` alias with readonly members,
      // which is a decision rather than an oversight: an alias cannot be
      // reopened by a later declaration, so what a type means is settled where
      // it is written. The rule is kept, pointed the other way, so the
      // consistency it enforces is the one this project chose.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],

      // A number in a template literal is unambiguous, and this service builds
      // header values and log messages from counts and durations constantly.
      // What the rule is really guarding against is an object stringifying to
      // `[object Object]`, and that stays an error.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // `process.env['PORT']` and `body['url']` read from index signatures,
      // where bracket notation is what makes it visible that the value may be
      // absent. Dot notation on a declared property is still required.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
    },
  },

  {
    // This file is not in the type checker's project, and adding it would mean
    // type checking a config that has no runtime role in the service. Linting
    // it without type information is the honest trade.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // Tests assert on values whose types are deliberately loose, because that is
    // what a caller sends. Requiring the same type discipline as source would
    // mean writing casts to describe malformed input, which is the input under
    // test.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
