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

- **The season is never read from a request.** It is `CARD_SEASON` in `shared/src/card-types.ts`,
  applied everywhere `server/src/cards/routes.ts` touches a row and echoed in every response.
- **Session rows are verifiers.** `sessions.id` is `sha256(token)` — `hashToken` in
  `server/src/auth/store.ts`. The raw token exists only in the cookie. Sessions also carry a hard
  ceiling on their own age (`SESSION_ABSOLUTE_TTL_MS`, same file) independent of the sliding
  30-day renewal, so a cookie used regularly cannot stay valid forever the way the sliding window
  alone would let it.
- **`/api/*` is deny-by-default.** The public allowlist is `PUBLIC_API_PATHS` in
  `server/src/app.ts`. Adding to it is a security decision.
- **Migrations are append-only**, keyed on `PRAGMA user_version` — `MIGRATIONS` and
  `SCHEMA_VERSION` in `server/src/db.ts`. `v1` creates a table `v9` drops; both must stay, because
  a fresh database passes through both in one boot. Check that file directly for the current
  version and table set rather than trusting a count anywhere else, including `docs/`.
- **The runtime pin lives in three files and they move together**: `.nvmrc` (22.23.2),
  `package.json` `engines` (`>=22.23.2 <23`), and `.npmrc` (`engine-strict=true`, which is what
  makes the other two binding). A failed install naming your Node version is that working.
- **Three modules in `web/src/` are machine-written** and must not be hand-edited:
  `cards.generated.ts`, `wiki-art.generated.ts`, and — the one the naming does not warn you about
  — `coc-assets.ts`. Each has a hand-written half where the tests point. Regenerate with the
  `assets:*` / `cards:generate` scripts.
- **Zero `any`.** `grep -rE ': any\b|as any|<any>' --include='*.ts' --include='*.tsx' shared server/src web/src`
  (excluding the three generated modules above, which are machine-written either way) should come
  back empty. Keep it that way.

## Local rules

- **Every user-facing report or artifact gets a `.docx` copy.** `claude-kit/rules/working-style.md`
  now names the `~/Downloads/coc/` folder itself directly; what's project-specific is the format —
  generate the `.docx` with `pandoc` (confirmed present on this machine at
  `/opt/homebrew/bin/pandoc`) from the Markdown/HTML source, not by hand-authoring XML.
- **Ask before every commit whether it belongs on What's New.** `docs/ui.md` documents the
  `No-Changelog` body-line opt-out (`skipsChangelog`, `web/src/changelog.ts`) — but which commits
  get it is not Claude's call to make silently. Ask, per commit, before committing.
- **Card counts are stored sparsely.** Absent means zero; a count of 0 deletes the row. Never
  store a 0. Sixty rows per base would be sixty times the writes to say almost nothing.
- **Authorization decisions live in pure functions, one per feature, never inline in a handler.**
  `mayWriteBaseCounts` (`server/src/cards/write-access.ts`) was the first and is still the model;
  `cards/trade-access.ts` and `change-requests/access.ts` follow it directly, and the admin-only
  gates in `shared-data/routes.ts` (owner assignments, and now the saved-clan list) go through
  `requireAdminFor` plus a `stillActiveAdmin` re-check for the same reason. A route that decides
  who-may-do-this-write inline, rather than calling one of these, is the pattern to avoid — see
  `claude-kit/rules/invariants.md` on centralizing the actual authorization decision.
- **Rules live in pure modules with adjacent tests**, never inline in a component — see
  `docs/layout.md` for the list. A new rule gets a module and a `.test.ts`, not a `useMemo`.
- **Prettier is deliberately not in CI.** `.github/workflows/verify.yml` argues the case at
  length and carries the current measurement of how much of the codebase it would rewrite — read
  it there rather than trusting a number restated here. The short version: the code was laid out
  by hand within the same 100 columns Prettier targets, and running it would bury every real
  change in the diff it landed with. Do not run `npm run format` as a drive-by.
- **There are no CSS modules here.** Styling is `styles.css` plus inline `style={{}}` on a couple
  dozen elements across roughly half the components (`grep -rc 'style={{' web/src --include='*.tsx'`
  for the current count — deliberately not written here, see `claude-kit/rules/improving-the-kit.md`
  on churning counts), which is why the CSP carries `'unsafe-inline'` (`deploy/nginx-coc.conf`). Do
  not introduce a third styling mechanism.
- **A table's row-limit select and its pager are one control, not two.** They sit together in a
  `<div className="roster-footer">` below the table — see `CardsView.tsx`'s leaderboard or
  `SavedClansView.tsx`. Never put the row-limit select in the card header while the pager stays at
  the bottom; `ProgressGridView.tsx` shipped that way once and had to be moved.
- **Stay inside this repo.** Any agent working here — including one subagent spawning another —
  operates only within `coc/`, or an isolated worktree of it. Touching another repository under
  `~/repos-jcc/` (`claude-kit/` included) or anything outside this checkout needs explicit
  direction first; do not infer it from context or convenience.

## Files that bite, and how

Not a hot-file list in the rework sense — this repo is days old and has no ticket history to
measure reopens against, so a list claiming "most bugs live here" would be borrowing the authority
of evidence it does not have. These are named for a specific way each one has misled a reader, or
can.

- **`web/src/styles.css`** (the most-churned file in the repo) — **selectors recur far
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

  A later full-repo review found seven more instances of this exact shape — a base-pass
  declaration silently overridden by the same selector's own later "chrome pass" restating the
  same property (`.notice`, `.meter`, `.meter__fill`, `.icon-button`, `.section-title`,
  `.topbar__title`, `.war-score__value`/`.hero-figure__value`) — and they were fixed by deleting
  the earlier, always-losing declaration of each conflicting property, leaving one source of truth
  per property per selector. Nothing above is still a live footgun; it is recorded because the
  pattern recurred once already after `.topbar`/`.card`/`.chip` and can again — worth a second look
  whenever a rule in this file's later sections stops having a visible effect when edited.
- **`web/src/hooks.ts`** — routing and `useAsync`, so it runs during render and inside effects,
  which is what made it dangerous: **before 2026-08-06 there was no error boundary anywhere above
  it**, so a throw here was not a broken panel, it was a blank page. Both crashes found on
  2026-08-04 were in this file — `decodeURIComponent` on a truncated escape, and a loader that
  threw before returning a promise — and both are fixed at the source. `web/src/components/ErrorBoundary.tsx`
  now wraps the whole app from `web/src/main.tsx`, added specifically in response to those two
  incidents, so a throw anywhere in the tree is a caught, reported error rather than a blank page.
  This file is still worth care — a new unguarded throw here is still a worse failure than one in
  a leaf component, just no longer a *total* one.
- **`server/src/db.ts`** — migrations are append-only and an applied one can never be edited. The
  reasoning is in the file header; read it before adding a step, and never renumber.
- **`web/src/components/CardsView.tsx`** (990 lines when first added to this list, still growing —
  `wc -l` it for where it stands now rather than trusting a number here, per
  `claude-kit/rules/improving-the-kit.md` on churning counts) — the card page's controller, sharing
  three components with the player page (`BaseCardEditor`, `CardTile`, `TradeSuggestions`). A change
  here frequently lands there too, and two people editing it at once do not compose. It is the
  largest component in the app by a wide margin and past the line count (`RosterTable.tsx`'s own doc
  comment cites 660) that file was split out from `ClanView.tsx` at — a plausible next split, not yet
  done.

The first two are recorded from incidents; the last two are reasoned from the code and have not yet
cost anything. Add to this list when a file misleads you, and say what it did.

## Testing

`npm test` runs all three workspaces (`node:test`, no framework). Tests sit adjacent to their
module. Run the whole suite, not a workspace. For the current count, run it — each workspace's own
tail reports its total — rather than trusting a number here: exact test counts and coverage ratios
are deliberately not written into this file, because they drift on every commit that adds a test
and were wrong, in this exact file, more than once in a single afternoon.
See `claude-kit/rules/improving-the-kit.md` on why a churning count does not belong in prose at all.

Run it on the pinned Node. A non-interactive shell does not fire the `fnm --use-on-cd` hook and
silently gets whatever Node is on `PATH`, so a green suite there says nothing about the runtime
production uses. `zsh -i -c 'cd <repo> && npm test'` is the form that pins it.

Known gap, so it is not rediscovered as a surprise: **component test coverage is partial.** For the
current ratio, `ls web/src/components/*.tsx web/src/components/*.test.tsx` and compare — but the
ratio was never the useful fact anyway. What matters, and does not drift the way a count does: the
gap is not uniformly presentational. `Login.tsx`, `TradeSuggestions.tsx`, `ProgressGridView.tsx`,
`ForcedPasswordChange.tsx`, `UserMenu.tsx` and `ClanView.tsx` each wire up real interaction or
business logic with no test file at all (their *underlying* pure logic is tested elsewhere; the
component wiring itself is not) — treat "untested" as "the wiring around already-tested logic,"
not "nothing here can break."
`TradeTracker.tsx` and `SavedClansView.tsx` are a narrower version of the same gap: each now has a
test file, but each covers one specific piece of wiring found by a review (an error-message branch
on the first, an admin-only gate on the second) rather than the component as a whole — a real
reduction in risk, not a closed gap.

## Repo visibility

The repo went public on 2026-08-10, still owned by the personal account `jcc004`, not an org.
That ownership matters for one setting: GitHub's `allow_forking` toggle only works on org-owned
private repos — `PATCH /repos/jcc004/coc -f allow_forking=false` fails with "Allow forks setting
can only be changed on org-owned private repositories." So forking, and therefore PRs from
non-collaborators, cannot be disabled here short of transferring the repo to an org or reverting
to private. Decided to leave it open: anyone can open a PR from a fork, same as ordinary open
source, but merge rights stay collaborators-only regardless. The other lever GitHub offers,
interaction limits set to "collaborators only," was considered and rejected because it expires
after a max of 6 months and silently needs renewing rather than being a one-time setting.

## Deploying

**Committing to `main` is deploying.** The droplet runs `coc-update.timer` every five minutes,
which fast-forwards to `origin/main` and runs `deploy/update.sh`. There is no push-triggered CI
deploy; `verify.yml` only typechecks, lints, tests and builds.

`deploy/update.sh` checks outcomes rather than exit codes, restores the previous `web/dist` if a
build or health check fails, and supports `--rollback` / `--resume`. `deploy/README.md` is the
host itself: Nginx, TLS, the systemd units.

The fast-forward still happens *before* `npm ci`, so a failed install can still leave the tree
advanced while the service stays on the old build — but the next timer run no longer treats that
as "nothing to do." `deploy/update.sh` compares the checkout against `.deploy-last-good-sha`, not
just against `origin/main`, so a commit that fast-forwarded but never finished deploying is
retried automatically rather than silently accepted as current. `deploy/update-test.sh` pins this
behavior directly (a broken `npm ci`, then a working one, with an assertion that the retry never
reports "already up to date"). `--force` still exists for forcing a rebuild on demand; it is no
longer the only way out of a stuck install.

Two more traps, both from 2026-08-09, about seven hours apart:

**A rewritten `origin/main` history stops the timer cold.** A `git filter-repo` rewrite (scrubbing
the droplet's own real IP and account name out of history — `git.md`'s provenance note) meant the
droplet's already-checked-out commit was no longer an ancestor of the new `origin/main`.
`git merge --ff-only` then failed with "Not possible to fast-forward" on every five-minute tick from
13:00 to 14:47 UTC — 22 consecutive failures — while the service itself never crashed and kept
serving the last good build the whole time (nginx's access log shows zero 5xx responses across the
window: this is a stalled *deploy*, not an outage). It self-resolved only because the droplet's
local branch was reset to match origin by hand; there is no automatic recovery from this shape of
failure, and `deploy/update.sh` deliberately dies rather than force-resetting on divergence. Manual
fix: `ssh <droplet> 'cd /srv/coc && git fetch origin main && git reset --hard origin/main &&
./deploy/update.sh --force'`. `.github/workflows/monitor.yml`'s "Deployed commit is fresh" job now
catches this shape within about 30 minutes by comparing `/api/health`'s `commit` field against
GitHub's compare API — it did not exist before this incident; it shipped as part of the incident's
own recovery (`d743f5b`).

**That same freshness check then produced a false positive for 7 hours from a second, unrelated
bug.** `/api/health`'s `commit` field was read once at process startup from
`.deploy-last-good-sha` and cached for the process's lifetime — but `deploy/update.sh` writes that
file only *after* restarting the service, so a freshly-restarted process always read and cached the
*previous* deploy's commit, reporting it until its own next restart. The 15:48 deploy of `7ec731c`
hit exactly this: `/api/health` kept reporting the prior commit for 7+ hours straight, and the
monitor paged every run in that window, each time reporting a healthy, current deploy as stuck.
Fixed in `cc8ea51`: the handler now reads the file fresh on every request instead of caching it at
startup, so the field self-corrects within the same deploy cycle that changed it.

### This project overrides "production is hands-off by default"

`claude-kit/rules/working-style.md`'s standing rule is to hand over commands for the operator to
run rather than SSH into a live system directly. **For this project only**, that default is
lifted: Claude may run any command directly against the production droplet, using the account
described in `.claude/droplet-access.local.md`.

That file is gitignored — it holds the droplet's address, the account name, and its sudo posture,
none of which belongs in a repo this project shares with people who should not receive a live
server's access details. Read it before doing any operational work on the droplet. If it is
missing from this checkout, this session is not running as the operator — ask before attempting
anything against the droplet rather than assuming the exception still applies.

@.claude/droplet-access.local.md

This does not relax anything else: still take a backup before a write that could lose data, still
say plainly what a command will do before running something with real effect, and the general
prohibitions (destructive actions without a clear, reversible path back) still hold. The point of
this exception is removing the copy-paste round trip for routine operational work on a project
with exactly one operator, not removing judgment about what a command actually does before it
runs.
