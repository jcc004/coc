# Layout

```
shared/   types for the CoC API, the auth payloads and the shared data, + tag
          parsing, email normalization and CARD_SEASON
server/   Hono API, upstream client + its retry/backoff (src/coc-client.ts),
          a TTL cache and a separate per-account rate limit on the CoC-API
          proxy routes (src/coc-rate-limit.ts), auth (src/auth/), the shared
          saved clans and owners (src/shared-data/), the card inventory
          (src/cards/), weekly progress tracking (src/progress/), per-account
          base order (src/base-order/), member-submitted requests an admin
          resolves (src/change-requests/), migrations (src/db.ts)
web/      Vite + React UI
```

Inside `server/src/auth/`: `passwords.ts` (scrypt), `store.ts` (the only code that touches
`users` and `sessions`), `middleware.ts` (cookie → context, plus the exported `requireAuth` /
`requireAdmin` / `requirePasswordUpToDate`), `rate-limit.ts`, `bootstrap.ts` (first admin and the
email escape hatch), `temp-password.ts` (the unambiguous alphabet and the rejection sampling),
and `routes.ts`. `server/src/shared-data/` is the same split for the shared rows: `store.ts` is the
only code touching `saved_clans` and `owner_assignments`, `routes.ts` mounts them. Migrations
live in `server/src/db.ts`.

`server/src/cards/` is the same split again: `store.ts` holds the hand-entered counts,
`routes.ts` mounts `/api/cards/*`, and `cards.test.ts` drives both through the whole app.
`trades-store.ts` also writes `card_inventory` directly — completing a trade moves a card between
two bases in the same transaction as the trade's own status change, which `store.ts`'s own
`saveBase` (its own `BEGIN`/`COMMIT`) cannot compose into — so this is the one table two stores in
this workspace both touch, each independently applying the same sparse-storage rule (a count of 0
deletes the row).

`server/src/progress/` holds weekly base-progress tracking: `store.ts` is the only code
touching `base_progress` / `max_level_reference` / `wall_reference`, `routes.ts` mounts
`/api/progress/*`, `capture-snapshot.ts` and `refresh-reference.ts` are the two standalone
scripts a systemd timer runs weekly (not part of the request path — see
[Weekly progress tracking and base order](progress-tracking.md)), and `wiki-tables.ts` is the
pure parser the reference job depends on. `server/src/base-order/` is the smallest instance of
the same split: `store.ts` touches `base_order` alone, `routes.ts` mounts `/api/base-order`.

`server/src/change-requests/` is "Propose a change" — the one feature with no owner column and no
base, so `sharedData` never reaches it. `access.ts` holds the five `may*ChangeRequest` decisions
(submit, amend, cancel, hide, resolve), pure and independently tested, the same discipline
`cards/write-access.ts` established; `store.ts` touches `change_requests` and
`change_request_amendments` (and, for the read side, `change_request_views`); `routes.ts` mounts
both `/api/change-requests/*` and the admin resolution routes. See
[Propose a change](proposed-changes.md).

`createApp`'s dependencies are listed as `AppDeps` in `server/src/app.ts` — every store, the two
rate limiters (login and per-account CoC-API), and the deploy/cookie/proxy-trust settings — kept
dependency-injected there rather than restated here, which is what lets the test suite drive the
whole app over an in-memory database and a stub upstream.

`shared` is consumed as TypeScript source through an npm workspace link — no build step,
so a type change is visible on both sides immediately.

Three modules in `web/src/` are machine-written and must not be hand-edited: `coc-assets.ts`
(which league and label ids are vendored), `wiki-art.generated.ts` (which unit names have wiki
art) and `cards.generated.ts` (the sixty event cards). Each has a hand-written half where the
tests point — `wiki-art.ts` for the second, `cards.ts` for the third.

Anything with rules in it is a pure module in `web/src/` with its own tests, never inline in a
component: `saved-table.ts` (sorting, paging), `base-names.ts` (how a base is written),
`card-trades.ts` (the four swap rules), `card-summary.ts` (per-deck counts and "is a trade
waiting"), `deck-progress.ts` (those counts as the four progress plaques),
`card-standings.ts` (the leaderboard's order, its Owner filter and its how-stale column — the
filter runs *after* the ranking, so a narrowed board keeps each base's place on the whole one —
and the group's total of each card in the grid's fixed order), `card-holders.ts` (which bases hold one card, which can spare a copy, and how many of the bases
that have reported at all still need it — the table the clan-totals grid opens when you choose a
tile, and the line above it), `card-sections.ts` (the card page's own anchors: which sections have
an id, which four the jump row offers and in what order, and whether a jump slides or lands —
plus why the chips are buttons rather than `#fragment` links), `roster-state.ts` (the clan roster's
selection, filters, sort, paging and bulk-apply, as one reducer with named transitions rather
than thirteen `useState`s), `base-scope.ts` (the card page's Mine/All filter — what "mine" means,
which way to default, and where the selection goes when the filter drops it), `last-route.ts`
(what to restore, and which clan the topbar's Clan button opens), `card-refresh.ts` (whether the
card pages' background re-read is due: the interval, the tab's visibility, a save in flight and
the gap that stops a focus event repeating a poll — the interval and the listeners themselves are
`use-card-refresh.ts`, which is the hook the two card pages mount), `changelog.ts` (what
`#/whats-new` lists: the `git log` record format, the committer-date choice, the three-workspace
filter and the newest-first order). `changelog.ts` is the one pure module `vite.config.ts` also
imports, so the build that writes the list and the browser that reads it back share one format
and one set of tests. `change-request-rules.ts` is the same split for "Propose a change": who may
amend, cancel or hide a request on the requester's own list, and a request's display status —
mirroring `server/src/change-requests/access.ts`, the same relationship `trade-tracker.ts` has to
the server's own trade-access rules.

The progress-tracking feature follows the same rule: `progress-grid.ts` (the board's row shape
and sort), `progress-percent.ts` (percent-to-max against the wiki-scraped reference, never the
API's own `maxLevel`), `progress-diff.ts` (the week-over-week `autoNote` text), and `base-order.ts`
(reconciling a saved order against what's currently owned, and the one array-move operation a
drag-and-drop reorder needs) — see
[Weekly progress tracking and base order](progress-tracking.md).
Components that are shown in more than one place are shared rather than copied — `BaseCardEditor`
is the one 60-tile card grid, rendered by both the card page and a player page; `CardTile` is the
one card tile, rendered by that grid and by the card page's clan-totals grid; `TradeSuggestions` is
the one trade table, clan-wide on the card page and filtered to one base on a player page; and
`DeckPlaques` is the one set of deck bars, rendered by both pages as well. `useBaseLabels()` in
`base-labels.ts` is the one place a base tag becomes a name, for all of them.
