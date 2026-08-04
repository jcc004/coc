# Layout

```
shared/   types for the CoC API, the auth payloads and the shared data, + tag
          parsing, email normalization and CARD_SEASON
server/   Hono API, upstream client, TTL cache, auth (src/auth/), the shared
          saved clans and owners (src/shared-data/), the card inventory
          (src/cards/), migrations (src/db.ts)
web/      Vite + React UI
```

Inside `server/src/auth/`: `passwords.ts` (scrypt), `store.ts` (the only code that touches
`users` and `sessions`), `middleware.ts` (cookie → context, plus the exported `requireAuth` /
`requireAdmin` / `requirePasswordUpToDate`), `rate-limit.ts`, `bootstrap.ts` (first admin and the
email escape hatch), `temp-password.ts` (the unambiguous alphabet and the rejection sampling),
and `routes.ts`. `server/src/shared-data/` is the same split for the shared rows: `store.ts` is the
only code touching `saved_clans` and `owner_assignments`, `routes.ts` mounts them. Migrations
live in `server/src/db.ts`.

`server/src/cards/` is the same split again: `store.ts` is the only code touching
`card_inventory`, `routes.ts` mounts `/api/cards/*`, and `cards.test.ts` drives both through the
whole app.

`createApp({ coc, cache, auth, sharedData, cards, trades })` stays dependency-injected, which is
what lets the test suite drive the whole app over an in-memory database and a stub upstream.

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
`card-standings.ts` (the leaderboard's order, and the group's total of each card in the grid's
fixed order), `card-holders.ts` (which bases hold one card and which can spare a copy — the table
the clan-totals grid opens when you choose a tile), `roster-state.ts` (the clan roster's
selection, filters, sort, paging and bulk-apply, as one reducer with named transitions rather
than thirteen `useState`s), `base-scope.ts` (the card page's Mine/All filter — what "mine" means,
which way to default, and where the selection goes when the filter drops it), `last-route.ts`
(what to restore, and which clan the topbar's Clan button opens), `card-refresh.ts` (whether the
card pages' background re-read is due: the interval, the tab's visibility, a save in flight and
the gap that stops a focus event repeating a poll — the interval and the listeners themselves are
`use-card-refresh.ts`, which is the hook the two card pages mount).
Components that are shown in more than one place are shared rather than copied — `BaseCardEditor`
is the one 60-tile card grid, rendered by both the card page and a player page; `CardTile` is the
one card tile, rendered by that grid and by the card page's clan-totals grid; `TradeSuggestions` is
the one trade table, clan-wide on the card page and filtered to one base on a player page; and
`DeckPlaques` is the one set of deck bars, rendered by both pages as well. `useBaseLabels()` in
`base-labels.ts` is the one place a base tag becomes a name, for all of them.
