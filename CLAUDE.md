# coc

A Clash of Clans API explorer. Hono API on Node, React + Vite front end, `node:sqlite` for
everything persistent. Three workspaces: `shared/`, `server/`, `web/`.

The shared working rules are deliberately **not** imported here. They live in
`~/repos-jcc/claude-kit/rules/` and are imported by `~/repos-jcc/CLAUDE.md`, one directory up.
Claude Code walks up the tree from the working directory and concatenates every `CLAUDE.md` it
finds, parent first, so those rules are already in context by the time this file is read.
Importing them again would load them twice.

Everything below is what is true of *this* codebase.

## The documentation is the documentation

`README.md` indexes `docs/`, one file per topic — setup, authentication, layout, the API, the UI,
shared data, the card event, the trade tracker, game art, weekly progress tracking and base
order. It is unusually complete and it is current. Read the topic file before asking about an area, and do not restate it here.

The code comments carry the same weight. Where a comment explains why something is the way it is,
it is usually recording an incident. Treat it as evidence, not decoration.

## Invariant instances

The general rules are in `claude-kit`. These are this repo's instances of them.

- **The season is never read from a request.** It is `CARD_SEASON`, `shared/src/card-types.ts:18`,
  applied at `server/src/cards/routes.ts:123` and `:169` and echoed in every response.
- **Session rows are verifiers.** `sessions.id` is `sha256(token)` — `hashToken`,
  `server/src/auth/store.ts:43`. The raw token exists only in the cookie.
- **`/api/*` is deny-by-default.** The public allowlist is `PUBLIC_API_PATHS`,
  `server/src/app.ts:148`. Adding to it is a security decision.
- **Migrations are append-only**, keyed on `PRAGMA user_version` — `MIGRATIONS`,
  `server/src/db.ts:744`. `v1` creates a table `v9` drops; both must stay, because a fresh
  database passes through both in one boot.
- **The runtime pin lives in three files and they move together**: `.nvmrc` (22.23.2),
  `package.json` `engines` (`>=22.23.2 <23`), and `.npmrc` (`engine-strict=true`, which is what
  makes the other two binding). A failed install naming your Node version is that working.
- **Three modules in `web/src/` are machine-written** and must not be hand-edited:
  `cards.generated.ts`, `wiki-art.generated.ts`, and — the one the naming does not warn you about
  — `coc-assets.ts`. Each has a hand-written half where the tests point. Regenerate with the
  `assets:*` / `cards:generate` scripts.
- **Zero `any` across ~35k lines.** Keep it there.

## Local rules

- **Ask before every commit whether it belongs on What's New.** `docs/ui.md` documents the
  `No-Changelog` body-line opt-out (`skipsChangelog`, `web/src/changelog.ts`) — but which commits
  get it is not Claude's call to make silently. Ask, per commit, before committing.
- **Card counts are stored sparsely.** Absent means zero; a count of 0 deletes the row. Never
  store a 0. Sixty rows per base would be sixty times the writes to say almost nothing.
- **Authorization lives in one pure function.** `mayWriteBaseCounts`,
  `server/src/cards/write-access.ts:64`, is the only interesting auth decision in the app. Do not
  reimplement it inline in a handler.
- **Rules live in pure modules with adjacent tests**, never inline in a component — see
  `docs/layout.md` for the list. A new rule gets a module and a `.test.ts`, not a `useMemo`.
- **Prettier is deliberately not in CI.** `verify.yml` argues the case at length: the code was
  laid out by hand within the same 100 columns Prettier targets, and running it would rewrite
  ~1,100 lines and bury every real change. Do not run `npm run format` as a drive-by.
- **There are no CSS modules here.** Styling is `styles.css` plus 34 inline `style={{}}`
  occurrences across 17 components, which is why the CSP carries `'unsafe-inline'`
  (`deploy/nginx-coc.conf`). Do not introduce a third styling mechanism.
- **A table's row-limit select and its pager are one control, not two.** They sit together in a
  `<div className="roster-footer">` below the table — see `CardsView.tsx`'s leaderboard or
  `SavedClansView.tsx`. Never put the row-limit select in the card header while the pager stays at
  the bottom; `ProgressGridView.tsx` shipped that way once and had to be moved.

## Files that bite, and how

Not a hot-file list in the rework sense — this repo is days old and has no ticket history to
measure reopens against, so a list claiming "most bugs live here" would be borrowing the authority
of evidence it does not have. These are named for a specific way each one has misled a reader, or
can.

- **`web/src/styles.css`** (~4.3k lines, the most-churned file in the repo) — **selectors recur far
  apart, so grep to the end; the first match is not the last word.** `.topbar` is declared three
  times: twice at the top level roughly 2,900 lines apart — once with no background, once painting
  it — and a third time, a narrower override, inside a `max-width: 600px` block near the end of the
  file. A grep that stopped at the first produced a confident, wrong answer about how the banner
  was styled, and that shaped a design decision before it was caught. Brace-depth scanning is what
  found the truth.

  **Anchor searches with `^\s*`, not `^`.** Declarations inside a `@media` block are indented, so
  a line-start anchor silently skips them. `.card` is declared at the top level and again inside
  the `max-width: 600px` block roughly 3,500 lines later, changing its padding — and a `^\.card`
  grep finds only the first. That one caught a reader on 2026-08-04 who had written this very
  bullet hours earlier.

  **Knowing about the later declaration is not enough — position decides the cascade.** A new
  `@media (max-width: 480px) { .card-jump__wide { display: none } }` placed beside the rule it
  modifies did nothing at all, because `.chip` is declared again ~2,500 lines below it inside
  `@media (max-width: 900px), (pointer: coarse)` with `display: inline-flex`. Equal specificity,
  later wins. The media query matched, the rule was in the stylesheet, the element had the class,
  and the computed style still came back `flex` — there is no symptom to grep for. This was found by
  measuring in a browser, not by reading. **In this file, write a rule that must win as a compound
  selector** (`.card-jump .card-jump__wide`) so it outranks the recurrences rather than racing them;
  placing it late works today and breaks the next time somebody appends a block.

  No line numbers here on purpose. The first draft of this bullet cited them, and they were stale
  within the hour — a commit landing earlier in the file moved both. A warning about a churning
  file must not be pinned to positions in it; name the selector, which is stable.
- **`web/src/hooks.ts`** — routing and `useAsync`, so it runs during render and inside effects with
  **no error boundary anywhere above it**. A throw here is not a broken panel, it is a blank page.
  Both crashes found on 2026-08-04 were in this file: `decodeURIComponent` on a truncated escape,
  and a loader that threw before returning a promise.
- **`server/src/db.ts`** — migrations are append-only and an applied one can never be edited. The
  reasoning is in the file header; read it before adding a step, and never renumber.
- **`web/src/components/CardsView.tsx`** (1,303 lines and growing — it was 990 when first added to
  this list) — the card page's controller, sharing three components with the player page
  (`BaseCardEditor`, `CardTile`, `TradeSuggestions`). A change here frequently lands there too, and
  two people editing it at once do not compose. It is now the largest component in the app by a
  wide margin and past the line count (`RosterTable.tsx`'s own doc comment cites 660) that file was
  split out from `ClanView.tsx` at — a plausible next split, not yet done.

The first two are recorded from incidents; the last two are reasoned from the code and have not yet
cost anything. Add to this list when a file misleads you, and say what it did.

## Testing

`npm test` runs all three workspaces — 1,640 tests (21 shared, 532 server, 1,087 web), `node:test`,
no framework. Tests sit adjacent
to their module. Run the whole suite, not a workspace.

Run it on the pinned Node. A non-interactive shell does not fire the `fnm --use-on-cd` hook and
silently gets whatever Node is on `PATH`, so a green suite there says nothing about the runtime
production uses. `zsh -i -c 'cd <repo> && npm test'` is the form that pins it.

Known gap, so it is not rediscovered as a surprise: **8 of 32 components have tests**. The pure
modules are well covered, and `hooks.ts` and `api.ts` now are too. What remains untested is not
uniformly presentational, though — `Login.tsx`, `TradeTracker.tsx`, `TradeSuggestions.tsx`,
`ProgressGridView.tsx` and `ForcedPasswordChange.tsx` each wire up real interaction or business
logic (their *underlying* pure logic is tested elsewhere; the component wiring itself is not). A
full-repo review found this framing overstating the gap's safety; treat "untested" as "the wiring
around already-tested logic," not "nothing here can break."

## Deploying

**Committing to `main` is deploying.** The droplet runs `coc-update.timer` every five minutes,
which fast-forwards to `origin/main` and runs `deploy/update.sh`. There is no push-triggered CI
deploy; `verify.yml` only typechecks, lints, tests and builds.

`deploy/update.sh` checks outcomes rather than exit codes, restores the previous `web/dist` if a
build or health check fails, and supports `--rollback` / `--resume`. `deploy/README.md` is the
host itself: Nginx, TLS, the systemd units.

One trap worth knowing: the fast-forward happens *before* `npm ci`, so a failed install leaves the
tree advanced and the service un-restarted. The next timer run then sees local equal to remote and
reports "Already up to date" forever. Recovery is `./deploy/update.sh --force`.

### This project overrides "Commit and push only when asked"

`claude-kit/rules/git.md`'s standing rule treats committing and pushing as two separate asks.
**For this project only**, that default is lifted: a request to commit means commit and push,
without waiting to be asked twice. If something comes up while committing that is worth pausing
on first — a failing test, a diff that doesn't match what was asked, a question about which
commit a change belongs on — stop and raise it before pushing, the same as any other blocker.
Otherwise push follows the commit in the same turn.

This is the same reasoning as the sudo override below: committing to `main` already *is*
deploying here (previous section), so treating push as a separate, later ask only inserts a
manual step between "the work is ready" and "the work is live" on a project with exactly one
operator and no review gate to wait for. It does not relax anything else about committing —
stage deliberately (`git add -A`, then read the diff before committing), still confirm before
amending or force-pushing, and still stop if the change itself looks wrong.

### This project overrides "production is hands-off by default"

`claude-kit/rules/working-style.md`'s standing rule is to hand over commands for the operator to
run rather than SSH into a live system directly. **For this project only**, that default is
lifted: [the specific droplet address, account name and sudo posture were removed from this historical revision on 2026-08-09 — see the current CLAUDE.md]



This authorizes running commands against the droplet directly — installing systemd units,
checking service status, reading logs, applying a scoped data merge — the things this file and
`deploy/README.md` already describe. It does not relax anything else: still take a backup before a
write that could lose data, still say plainly what a command will do before running something with
real effect, and the general prohibitions (destructive actions without a clear, reversible path
back) still hold. The point of this exception is removing the copy-paste round trip for routine
operational work on a project with exactly one operator, not removing judgment about what a command
actually does before it runs.
