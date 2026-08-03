/*
 * The repo had no linter. The code was consistent anyway, because it has had one
 * author who was careful — but "consistent because somebody remembered" is not a
 * property you can keep, so this is the part of that consistency a machine can hold
 * on to.
 *
 * Three deliberate choices, since each of them costs something:
 *
 *   - **Type-aware linting is on** (`projectService`). It is the slower option and it
 *     means every linted file must belong to a tsconfig, which across three
 *     workspaces is a thing that can break. It earns it: `no-floating-promises`,
 *     `no-misused-promises` and `no-unnecessary-type-assertion` are the rules that
 *     found real things here, and none of them can work without types.
 *   - **`typescript-eslint` at its `recommended` tier**, not `strict`. `strict` is a
 *     style opinion as much as a correctness one, and imposing one retroactively on
 *     finished code is how a linter becomes something people run with `--fix` and
 *     stop reading.
 *   - **`eslint-plugin-react-hooks`**, which is the reason this file exists at all.
 *     This is a hook-heavy front end — a `useReducer` roster table, several custom
 *     hooks in `hooks.ts`, module-level stores read through `useSyncExternalStore` —
 *     and a wrong dependency array is the bug class it is impossible to see by
 *     reading. `exhaustive-deps` is an **error** here, not the plugin's default
 *     warning: a warning in a codebase with no CI gate for warnings is a comment.
 *
 * Formatting is Prettier's, not ESLint's: `eslint-config-prettier` goes last and
 * switches off every rule the two could disagree about. See `prettier.config.js` and
 * `.prettierignore` — Prettier deliberately does not touch Markdown.
 */

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/** Everything the `node:test` runner hands back a promise from. */
const NODE_TEST_CALLS = ['after', 'afterEach', 'before', 'beforeEach', 'describe', 'it', 'test']

export default tseslint.config(
  {
    // Generated, vendored, built, or written at runtime — nothing here is authored.
    ignores: [
      'web/dist/',
      'web/dist.prev-*/',
      'web/public/coc/',
      'web/src/*.generated.ts',
      'server/data/',
      'data/',
    ],
  },

  // A suppression that no longer suppresses anything is a comment that lies about
  // the code, so it fails the build like any other finding.
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },

  js.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      /*
       * `describe()` and `it()` from `node:test` return promises that the runner
       * itself awaits, and nothing in a test file ever wants to await them. Without
       * this allowance the rule reports every one of them — 1,099 findings across 42
       * test files, which is more than enough noise to get a rule switched off, and
       * this is a rule worth keeping: it is the one that catches a dropped `await` on
       * a write.
       */
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: NODE_TEST_CALLS },
          ],
        },
      ],

      /*
       * Three rules above `recommended`. Each is here because it had a specific
       * reason, and each reported either nothing or one thing — which is the bar for
       * adding a rule to finished code.
       *
       * `consistent-type-imports`, because `verbatimModuleSyntax` is on: a value
       * import is emitted as a real runtime import even when every binding in it is
       * used only as a type. Its one hit was `TtlCache` in `server/src/app.ts`, a
       * file that already wrote `import type` four times over — so this is the fifth,
       * and the module is no longer pulled in at runtime for a type annotation.
       *
       * `switch-exhaustiveness-check`, because the domain is discriminated unions
       * (`AuthEvent`, `CardCategory`, trade status) and a switch that quietly stops
       * covering one of them after a member is added is the failure it prevents.
       *
       * `eqeqeq`, which found nothing, because the codebase already never uses `==`.
       * That is the point: it costs nothing now and holds the line later.
       */
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: 'error',

      /*
       * Deliberately **not** enabled, having been tried: `prefer-nullish-coalescing`.
       * It reported six sites and every one of them was right to use `||` —
       * `env.HOST?.trim() || DEFAULT_BIND_HOST`, `email?.trim() || null`,
       * `asString(body['displayName']).trim() || …`. The whole point of those is that
       * an empty string counts as absent; `??` would keep the empty string and the
       * rule's "safer operator" would be the bug.
       */
    },
  },

  {
    /*
     * `require-await` cannot tell a mistake from an `async` function that exists to
     * satisfy a promise-returning interface without needing to await anything —
     * which is what every hit was: fake `CocClient` methods returning canned data,
     * and fake work-queue jobs. Off in tests only; still on in `src`, where an
     * `async` with no `await` usually is a dropped `await`.
     */
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  { files: ['scripts/**/*.mjs', '*.js'], languageOptions: { globals: globals.node } },
  { files: ['server/**/*.ts'], languageOptions: { globals: globals.node } },
  { files: ['web/**/*.ts', 'web/**/*.tsx'], languageOptions: { globals: globals.browser } },

  {
    files: ['web/src/**/*.ts', 'web/src/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // The point of the exercise. See the header.
      'react-hooks/exhaustive-deps': 'error',

      /*
       * The two React Compiler rules below are off, and both for the same reason:
       * **this app does not run the compiler.** `@vitejs/plugin-react` is used
       * without `babel-plugin-react-compiler`, so the rules are reporting on an
       * optimisation that never happens.
       *
       * `preserve-manual-memoization` is purely a compiler diagnostic — its message
       * is literally "Compilation Skipped". With no compiler, nothing is skipped.
       *
       * `set-state-in-effect` is a real design smell in general, and it is off
       * reluctantly. It reported six sites, all of them documented deliberate
       * synchronisation: three copies of "the page count shrank, clamp the page
       * control to it" (CardsView, TradeSuggestions, TradeTracker), and three in
       * `hooks.ts` that reset state when the thing it describes goes away — a loader
       * becoming null, a sign-out, a user id changing. Each would need a genuine
       * redesign (derive during render, or key the component) rather than a
       * suppression, and doing six of those inside a lint change is how a lint
       * change breaks something. They are listed in the review notes instead, which
       * is where a design change belongs.
       */
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  // Last, so it wins: turns off the rules that would argue with Prettier.
  prettier,
)
