# coc

A Clash of Clans API explorer: look up player profiles, clan details, and clan rosters.

TypeScript throughout — [Hono](https://hono.dev) API on Node, React + Vite frontend, no
component library. The API token stays on the server; the browser only ever talks to `/api`.

## Setup

```sh
npm install
cp .env.example .env      # then paste your token into COC_API_TOKEN
npm run dev
```

`npm run dev` starts the API on <http://localhost:8787> and the UI on
<http://localhost:5173>. Vite proxies `/api` to the server, so open the Vite URL.

Get a token from <https://developer.clashofclans.com/#/account>.

### The IP binding

Supercell binds each API key to the IP addresses you name when you create it. If requests
start failing with **403 `accessDenied`**, your public IP changed — mint a new key for the
new IP and update `.env`. The server surfaces this as a hint in the error panel rather than
leaving you to guess, because it is by far the most common failure.

This is also the thing to solve before deploying anywhere: you need a static egress IP (a
small VPS, or a proxy with a fixed address), because most PaaS hosts rotate outbound IPs.

## Layout

```
shared/   types for the CoC API + tag parsing, imported by both sides
server/   Hono API, upstream client, TTL cache
web/      Vite + React UI
```

`shared` is consumed as TypeScript source through an npm workspace link — no build step,
so a type change is visible on both sides immediately.

## API

The server exposes a thin, cached layer over the upstream API. Tags may be passed with or
without the leading `#` (URL-encode it as `%23` if you include it).

| Route | Returns |
|---|---|
| `GET /api/health` | liveness + cache size |
| `GET /api/players/:tag` | full player profile |
| `GET /api/clans/:tag` | clan detail including `memberList` |
| `GET /api/clans/:tag/members` | clan roster only |
| `GET /api/clans/:tag/currentwar` | live war, both rosters (20s cache) |
| `GET /api/clans/:tag/warlog` | past wars, newest first |
| `GET /api/clans?name=…` | clan search by name (min 3 chars) |

Errors come back as `{ error: { status, reason, message, hint? } }`.

### Caching

Successful upstream responses are cached in memory for `CACHE_TTL_SECONDS` (default 60) and
identical concurrent requests are coalesced into one upstream call. Both exist to stay well
under Supercell's per-token rate limit while clicking around a roster. The cache is
per-process and disappears on restart — that is deliberate for a personal tool.

## The lookup sidebar

Lookup lives in a right-hand sidebar, sticky near the top so it stays put while the main
column scrolls. The sidebar is **15% of the viewport with a 260px floor** — a bare 15% is
only ~192px at 1280px wide, which is too narrow for the controls. Below 900px the layout
collapses to one column and the sidebar stacks *above* the content, so lookup is still the
first thing in reach on a phone. The topbar spans the full width above both columns.

There are two forms rather than one form with a mode select:

- **Find player** takes a player tag and opens `#/player/<tag>`.
- **Find clan** takes either a clan tag *or* a clan name. If the input parses as a tag it
  opens `#/clan/<tag>`; otherwise it is treated as a name and searched via
  `#/search/<name>`, which needs at least 3 characters to match the server's minimum.

Tag and name are genuinely ambiguous — `Reddit` is six alphanumeric characters, so it is a
structurally valid tag — so the clan form previews which branch will run ("Opens clan
#REDD1T" vs "Searches clan names for …") before you submit.

Both forms block submission only on **structural** invalidity. The canonical-alphabet check
is advisory: it prints a warning and performs the lookup anyway, because the API returns the
same flat 404 for a malformed tag as for an unknown one and is the only authority.

**Recent** chips sit below the two forms.

## Saved bases

The landing page carries two lists — saved bases, then saved clans below them. A base is a
tag, a display name you control, and an **owner**.
Add a tag and the app fetches the profile to validate it and prefill the in-game name;
supply your own label to override it. Clicking a row opens the player, the clan cell opens
the clan, and **War** opens that clan's war. Rows are grouped by owner, unassigned last.

**Owner is local-only** — the API has no concept of it, so a refresh never touches it. The
owner input is backed by a `datalist` of owners already in use, so repeat entries are one
keystroke. **Refresh all** re-fetches every entry to update Town Hall, trophies, and clan,
leaving both your custom name and the owner alone.

### Bulk owner assignment

Tick rows and a bulk bar appears. The header checkbox is scoped to the **rows on the current
page only** — ticking rows you cannot see and then bulk-editing them is a footgun, so its
label says how many rows that is. Selections made on another page are kept, and the bulk bar
counts them separately (`24 selected · 4 on other pages`) so nothing is edited invisibly.

Type an owner, press **Apply to selected**, and:

- rows with **no owner** are written straight away;
- rows that **already have a different owner** are held back for approval, listed one per
  line with the old and new value, each unticked by default — nothing is overwritten until
  you tick it and press **Apply N approved**;
- rows that already match are counted as unchanged and left alone.

Clearing an owner (empty box) takes the same approval path, since it destroys information
just as much as replacing it. The per-row Edit button is exempt: it is a single explicit
row you are already looking at, with the current value visible in the input.

Every column of both tables sorts, and blank or unknown values stay at the bottom in **both**
directions — reversing a column should not bring a wall of dashes to the top.

The ordering, paging, and approval-partitioning logic all live in `web/src/saved-table.ts`,
apart from the components, and are covered by `npm test`.

Storage is `localStorage` under `coc:saved`, so the list is per-browser. The store in
`web/src/saved.ts` is a module-level external store, not component state, so the Save
button on a profile and the list stay in sync. Moving it server-side later means replacing
that one module.

## Saved clans

Below the saved bases is the same idea for clans: tag, a display name you control, level,
members, points, and war league. Add a tag and the app fetches the clan to validate it and
prefill the in-game name. Clicking a row opens the clan and **War** opens its current war;
**Edit** renames (which marks the row `custom` so **Refresh all** stops overwriting the
label), and **Remove** deletes after a confirm. Any clan page also has a **★ Saved / ☆ Save**
toggle, the same as a player profile.

Storage is `localStorage` under `coc:savedClans`, through `web/src/saved-clans.ts` — the same
module-level external store shape as `saved.ts`, for the same reason.

### Row counts and paging

Each table has a **Rows** select: bases default to 20 (20 / 50 / All), clans to 5
(5 / 10 / 20 / 50 / All). Both choices persist in `localStorage`, so they survive a reload.

A limit never silently hides rows. Whenever the list is longer than the limit, a footer says
`Showing 1–20 of 63` with **Previous** / **Next**. The page resets to 1 when the limit or the
sort changes, and is clamped if rows are removed underneath it, so the view can never land on
an empty page past the end.

The slicing is a pure function, `paginate(rows, limit, page)` in `web/src/saved-table.ts`,
returning `{ rows, page, pageCount, from, to, total }` where `'all'` (or `null`) means no
paging. The returned `page` is authoritative — that is where clamping happens, so a stale
page number in a component cannot produce a blank table.

## War view

`#/war/<clanTag>` shows the current war and the war log together, fetched independently so
one failing does not blank the other. Head-to-head star score, destruction, attack usage
meters, and both rosters with per-member stars, best hit, attacks used, and best defence
against them.

## What the API exposes per player tag

Verified against the live API, not the docs. **Only two endpoints take a player tag:**

| Endpoint | Notes |
|---|---|
| `GET /players/{playerTag}` | the full profile — troops, heroes, achievements, clan summary |
| `POST /players/{playerTag}/verifytoken` | confirms a player owns the account, using the in-game API token from Settings → More Settings. Returns `{tag, token, status}` |

`/players/{tag}/wars`, `/players/{tag}/clan`, and a `/players` list do **not** exist — all
404. Everything else worth having hangs off `player.clan.tag`, which the profile gives you:

| Endpoint | Returns |
|---|---|
| `GET /clans/{clanTag}` | clan detail incl. `memberList` |
| `GET /clans/{clanTag}/members` | roster only |
| `GET /clans/{clanTag}/currentwar` | live war — `state`, `clan`, `opponent`, per-member attacks |
| `GET /clans/{clanTag}/warlog` | past wars (only when the war log is public) |
| `GET /clans/{clanTag}/currentwar/leaguegroup` | CWL group — `state`, `season`, `clans`, `rounds` |
| `GET /clanwarleagues/wars/{warTag}` | an individual CWL war, from a round's war tags |
| `GET /clans/{clanTag}/capitalraidseasons` | Capital raid weekends |

Players also appear inside `/locations/{id}/rankings/players`,
`/locations/{id}/rankings/players-builder-base`, and Legend League season rankings — but
those are keyed by location or league, not by tag, so you cannot ask "where does this
player rank" directly. You would page the leaderboard and match on tag.

### One important caveat on tags

The API returns a flat `404 notFound` for a malformed tag *and* for a tag that simply does
not exist — `#!!!!`, `#IIIIIII`, and a plausible-but-unknown tag are indistinguishable in
its response. So client-side alphabet validation cannot be trusted to gate a lookup:
`normalizeTag` enforces only structure (3–12 alphanumerics), and
`usesCanonicalAlphabet` is advisory, surfaced as a warning while the lookup proceeds.

## Notes on the data

- The API returns `admin` for the role the game calls **Elder**. `ROLE_LABELS` in
  `shared/` maps the four roles to their in-game names.
- Tags never contain the letter `O` — that character is always a zero. `normalizeTag`
  corrects it, so a tag copied off a screenshot usually works.
- `warTies` and `warLosses` are only present when the clan's war log is public;
  `warWins` is always returned.
- **A private war log returns 403 on `/currentwar` too**, not just `/warlog` — so a 403 is
  not automatically an IP-binding problem. `describeFailure` in `server/src/coc-client.ts`
  branches on the path to give the right hint; the war one also tells you how to tell the
  two cases apart.
- **War members use `townhallLevel`** (lowercase `h`), while player profiles use
  `townHallLevel`. Both spellings are correct for their own payload. Verified live.
- **Timestamps are ISO 8601 *basic* format** — `20260802T045542.000Z` — which `new Date()`
  parses as `Invalid Date`. Everything time-related must go through `parseCocTimestamp`.
- When `state` is `notInWar`, the API still returns `clan` and `opponent` objects, stubbed
  with `clanLevel: 0` and no `name`, `tag`, or `members`. Hence those fields are optional on
  `WarClan`.
- War-log `result` is `null` for Clan War League entries, and equal star counts can still be
  a win — destruction breaks the tie, so the table shows both sides' percentages.

## Game art and the Fan Content Policy

The UI wears a Clash-themed skin — parchment and stone by day, dark wood by night,
gold-bevelled panels and pressed buttons. All of that is CSS: gradients and bevels,
no image assets, so it costs nothing to load and works in both themes.

The actual game art is a different matter. Three things come from Supercell's CDN
via the API, and only these three:

| Asset | Source | Vendored? |
|---|---|---|
| League badges | `league.iconUrls` | yes — 23 files |
| Clan / player label icons | `labels[].iconUrls` | yes — 36 files |
| Clan badges | `clan.badgeUrls` | no — one per clan, unbounded |

`npm run assets:coc` downloads the two finite sets into `web/public/coc` and
regenerates `web/src/coc-assets.ts` with the ids that landed. Vendoring them means
the app is not hotlinking `api-assets.clashofclans.com`, so it survives offline and
under a strict CSP.

`web/public/coc/` is **gitignored** — the art is Supercell's, not ours to
redistribute through this repo. A fresh clone therefore has the ids but no files,
which is why `GameIcon` falls back to the CDN URL the API supplied instead of
showing a broken image. Run the script and it uses the local copies again.

Note what the API does *not* give you: troop, spell, hero and equipment artwork,
Town Hall imagery, achievement icons, resource icons, and the Clash of Clans
wordmark. Those arrays carry only `name`, `level`, `maxLevel` and `village`, which
is why the progression section uses level meters rather than unit icons. Sourcing
that art means scraped game files, so the app does without it.

Supercell's [Fan Content Policy](https://supercell.com/en/fan-content-policy/)
requires an unofficial-and-not-endorsed notice on fan work that uses their assets.
It is rendered in the page footer (`.site-footer` in `App.tsx`) rather than buried
here, because that is where the policy wants it. **Do not remove it** while the app
still shows their icons.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | API + UI with reload |
| `npm test` | unit tests for the saved-table sort, paging, and owner-overwrite logic |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm run build` | production bundle for the UI |
| `npm run assets:coc` | re-download the vendored league and label icons |
| `npm start` | API only, no watcher |

The server runs through `tsx` in both dev and production — there is no server build step.
