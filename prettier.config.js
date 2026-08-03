/*
 * These three settings are not preferences. They were measured off the code that was
 * already here, because a formatter introduced to a finished codebase either matches
 * what the author was doing or produces one enormous diff that reviews as noise.
 *
 *   printWidth 100 — the code was written to a 100-column budget. Reformatting the
 *     whole repo at each width from 96 to 104 and counting the lines Prettier would
 *     change gives a clean minimum at 100 (1,095 lines) with 99 and 101 both worse
 *     (1,247 and 1,200), so this is the number that was in the author's head.
 *   semi false — there is not one statement-terminating semicolon in the repo.
 *   singleQuote true — with JSX attributes left on double quotes, which is
 *     `jsxSingleQuote: false`, the default, and also what the code already does.
 *
 * Everything else is Prettier's default *and matches the existing code*, which is
 * worth stating because it was checked rather than assumed: trailing commas
 * everywhere including function parameters, `arrowParens: 'always'` (`(entry) =>`,
 * never `entry =>`), two-space indent, `bracketSpacing`, and the closing `>` of a
 * multi-line JSX element on its own line. Unset rather than restated, so it tracks
 * Prettier instead of freezing a copy of it.
 *
 * See .prettierignore for what is deliberately not formatted — Markdown above all.
 * And note that `format:check` is *not* in CI: 61 files still differ from Prettier's
 * output at these settings, almost all of it hand-wrapped English inside JSX and
 * hand-tabulated data literals, and bringing them into line would be the mass reflow
 * this config exists to avoid. The workflow says the same thing at the point where
 * the step would go.
 */

/** @type {import('prettier').Config} */
export default {
  printWidth: 100,
  semi: false,
  singleQuote: true,
}
