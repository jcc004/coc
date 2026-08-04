# coc

A Clash of Clans API explorer. Hono API on Node, React + Vite front end, `node:sqlite` for
everything persistent. Three workspaces: `shared/`, `server/`, `web/`.

The shared working rules live outside this repo and are imported here:

@~/repos-jcc/claude-kit/rules/working-style.md
@~/repos-jcc/claude-kit/rules/invariants.md
@~/repos-jcc/claude-kit/rules/git.md

Everything below is what is true of *this* codebase.

## The documentation is the documentation

`README.md` indexes `docs/`, one file per topic — setup, authentication, layout, the API, the UI,
shared data, the card event, the trade tracker, game art. It is unusually complete and it is
current. Read the topic file before asking about an area, and do not restate it here.

The code comments carry the same weight. Where a comment explains why something is the way it is,
it is usually recording an incident. Treat it as evidence, not decoration.

## Invariant instances

The general rules are in `claude-kit`. These are this repo's instances of them.

- **The season is never read from a request.** It is `CARD_SEASON`, `shared/src/card-types.ts:18`,
  applied at `server/src/cards/routes.ts:132` and `:175` and echoed in every response.
- **Session rows are verifiers.** `sessions.id` is `sha256(token)` — `hashToken`,
  `server/src/auth/store.ts:42`. The raw token exists only in the cookie.
- **`/api/*` is deny-by-default.** The public allowlist is `PUBLIC_API_PATHS`,
  `server/src/app.ts:135`. Adding to it is a security decision.
- **Migrations are append-only**, keyed on `PRAGMA user_version` — `MIGRATIONS`,
  `server/src/db.ts:521`. `v1` creates a table `v9` drops; both must stay, because a fresh
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

- **Card counts are stored sparsely.** Absent means zero; a count of 0 deletes the row. Never
  store a 0. Sixty rows per base would be sixty times the writes to say almost nothing.
- **Authorisation lives in one pure function.** `mayWriteBaseCounts`,
  `server/src/cards/write-access.ts:63`, is the only interesting auth decision in the app. Do not
  reimplement it inline in a handler.
- **Rules live in pure modules with adjacent tests**, never inline in a component — see
  `docs/layout.md` for the list. A new rule gets a module and a `.test.ts`, not a `useMemo`.
- **Prettier is deliberately not in CI.** `verify.yml` argues the case at length: the code was
  laid out by hand within the same 100 columns Prettier targets, and running it would rewrite
  ~1,100 lines and bury every real change. Do not run `npm run format` as a drive-by.
- **There are no CSS modules here.** Styling is `styles.css` plus 25 inline `style={{}}`
  occurrences across 13 components, which is why the CSP carries `'unsafe-inline'`
  (`deploy/nginx-coc.conf`). Do not introduce a third styling mechanism.

## Testing

`npm test` runs all three workspaces — 911 tests, `node:test`, no framework. Tests sit adjacent
to their module. Run the whole suite, not a workspace.

Known gap, so it is not rediscovered as a surprise: **4 of 24 components have tests**. The pure
modules are well covered; `hooks.ts` and `api.ts`'s global 401/403 routing are the two
non-presentational blanks.

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
