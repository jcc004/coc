# Weekly progress tracking and base order

Replaces a spreadsheet kept by hand: one row per base per week, Town Hall through walls,
scored against how far that account can actually go rather than the API's flat, TH-agnostic
maximums. A second, unrelated feature — per-account base ordering — rides along in this doc
because it shares no code with progress tracking but shipped in the same pair of commits and
is small enough not to need its own page.

## Data model

Three tables, added by migration v11 (`server/src/db.ts`):

- **`base_progress`** — one row per `(player_tag, week_start)`. `week_start` is always a
  Tuesday (`currentWeekStart`, duplicated deliberately in both
  `server/src/progress/routes.ts` and `server/src/progress/capture-snapshot.ts` — see below
  for why). Two callers write into it and must never step on each other's half:

  | Written by | Columns |
  |---|---|
  | The scheduled auto-capture job | `th_level`, `heroes_json`, `equipment_json`, `pets_json`, `troops_json`, `spells_json` |
  | A person, through the manual-save route | `walls_json`, `buildings_left`, `notes` |

  `auto_note` belongs to neither — it is computed server-side from the diff against the prior
  week (`"TH 17->18; Barbarian King 106->107"`) and overwritten on every save, the same way the
  card event's season constant is never accepted from a caller. `ProgressStore.upsertSnapshot`
  is the one function that merges an incoming auto or manual payload into whatever the week
  already holds, field by field, so a scheduled capture can never clobber a note somebody typed
  in by hand and vice versa. The unit columns hold a whole JSON array per week rather than one
  row per unit — unlike `card_inventory`'s sparse one-row-per-card shape, a base's hero and
  troop roster is populated most weeks, and nothing queries across units within a week, only
  across a base's own weeks, so normalizing it would only multiply writes.

  `captured_by` names *how* a row was captured — `'auto'`, `'import'` (the one-off historical
  backfill), or `'manual'` — and `captured_by_user_id` (migration v13) names *who*, for a
  `'manual'` row, as a real `INTEGER REFERENCES users(id)` joined to `display_name` at read
  time, the same pattern every other attribution column in this schema follows. `captured_by`
  started life in v11 as a bare string doing double duty for both — `'auto'` or a user id typed
  as text — which meant a manual save's account could never resolve to a display name without a
  second query; v13 split the two apart. On the wire, `ProgressSnapshot.capturedBy` is
  `'auto' | 'import' | { userId, displayName }`.

- **`max_level_reference`** — `(category, name, th_level) → max_level`. The reason this table
  has to exist at all: the Clash of Clans API returns a unit's *absolute* game-max level, never
  the cap at a given Town Hall — a TH18, a TH12 and a TH11 account all report Barbarian King
  `maxLevel: 110`, the number a fresh TH7 account would see the instant the hero unlocks.
  "Percent maxed for my current TH," the thing a player actually tracks, needs a table nothing
  in the official API provides.

- **`wall_reference`** — `th_level → (max_wall_level, total_wall_count)`, the same problem for
  walls.

`max_level_reference` and `wall_reference` are populated two ways: `hero`, `troop`, `spell` and
walls by a weekly wiki-scrape (below); `pet` and `equipment` by hand, through
`PUT /api/admin/progress/reference/:category`, admin-only. The scrape cannot cover pets and
equipment — see `server/src/progress/wiki-tables.ts`'s header for the specific reason each was
left out — so those two categories are corrected the same way an admin corrects anything else
this app cannot source automatically.

Migration v12 adds a fourth, unrelated table: **`base_order`** —
`user_id → tag_order`, one row per account, `ON DELETE CASCADE`. The first server-persisted
per-user preference in this app; everything else a signed-in account can set (color scheme,
last-viewed base, row limits) is `localStorage`-only. This one was asked to follow the account
across devices instead.

## The two scheduled jobs

Both run as one-shot scripts under systemd timers on the droplet — see
[`deploy/README.md`](../deploy/README.md#weekly-progress-tracking-jobs) for the units
themselves. Locally they're run directly: `tsx server/src/progress/refresh-reference.ts` /
`capture-snapshot.ts`, with `.env` loaded.

**`refresh-reference.ts`, Tuesdays 16:00 UTC.** Scrapes `clashofclans.fandom.com` — the
MediaWiki API only (`action=parse&prop=wikitext`; a plain page fetch gets HTTP 402, a
pay-or-consent wall), a descriptive `User-Agent`, and serial requests paced to avoid hammering
the wiki. Four pages, so a cold run is four requests a bit over a second apart. Covers `hero`,
`troop`, `spell` (Town Hall 1–18, from the Laboratory Upgrade Chart and the Hero Hall page's
level-caps table) and walls in full; `pet` and `equipment` are not attempted — `wiki-tables.ts`
explains why each was rejected rather than parsed on a guess. The job is additive: it upserts
what it found and touches nothing for categories it didn't attempt, so hand-entered pet/equipment
data is never overwritten by a run that didn't cover them.

**`capture-snapshot.ts`, Tuesdays 17:00 UTC — one hour later, and the order is load-bearing.**
Pulls this week's Town Hall, heroes, equipment, pets, troops and spells from the live API for
every base worth tracking, and classifies a unit as a pet by looking its name up in
`max_level_reference` — a table the 16:00 job just refreshed. Running reference first means that
lookup is current before the snapshot job reads it, rather than a week stale. Only home-village
fields are captured; Builder Base units have no place on a page that is explicitly main-base
progress.

**Scope, and the bootstrap gap that follows from it.** "Every base worth tracking" is every live
member of every saved clan, unioned with every base anyone has claimed via `owner_assignments`
(`collectTrackedTags`) — not scoped to ownership the way card counts are, because Town Hall and
hero levels come straight off the API with no ownership question involved, and excluding an
unclaimed member would only hide a base nobody happens to be watching yet. The cost: a member
shows up on the progress board only once this job has run for them at least once — the same
bootstrap gap the board itself had before anyone ran it by hand.

Both jobs are guarded with an `isMainModule` check at the bottom of their file, so importing
either — for a test, or anything else — never opens a database connection or calls a live
network endpoint as a side effect of `import`.

## Routes

All of these sit behind the app's standard deny-by-default `/api/*` gate — no route below
re-checks authentication itself, matching every other route file in this app.

| Route | Auth | Returns / accepts |
|---|---|---|
| `GET /api/progress` | any signed-in user | latest week for every tracked base (owned bases ∪ every tag the job has ever captured) |
| `GET /api/progress/:tag` | any signed-in user | one base's full week-by-week history |
| `GET /api/progress/reference` | any signed-in user | the full `max_level_reference` and `wall_reference` tables |
| `PUT /api/progress/:tag/manual` | the base's owner (`mayWriteBaseCounts` — the same rule `cards/routes.ts` uses, not a second copy of it) | `{ walls?, buildingsLeft?, notes? }`, merged into the current week |
| `PUT /api/admin/progress/reference/:category` | admin | a JSON array of `{ name, thLevel, maxLevel }` rows for `pet` or `equipment` only |
| `GET /api/base-order` | any signed-in user, own account only | `{ tags: string[] }`, the caller's saved order |
| `PUT /api/base-order` | any signed-in user, own account only | a bare JSON array of tags — not wrapped in `{ tags }`, since there is only ever one thing being replaced |

`GET /api/progress/reference` is mounted **before** `GET /api/progress/:tag` — Hono matches
routes in registration order when a static and a dynamic segment overlap, so `reference` would
otherwise be swallowed as a (nonsense but not rejected) player tag.

Reads are open to every signed-in member on both `/api/progress/*` and `/api/base-order` — the
same "one shared view" stance the card event takes on inventory — but writes differ: base
progress writes follow ownership exactly like card counts; base order has no ownership concept
at all, since an account's own display order is never something another user could legitimately
write. There is no `:userId` on either base-order route and no way to name one in the body —
unlike everywhere else ownership is checked in this app, the caller's own session is the only
identity either base-order handler ever consults.

`PUT /api/base-order` deliberately accepts a **partial** list: a caller reordering the two bases
they actually care about does not have to also name every other base they own. A tag the caller
already owns but leaves out of the body is not rejected or auto-filled — the server has no
opinion on where an unlisted tag belongs; that's a client-side concern, handled by
`reconcileOrder` (`web/src/base-order.ts`) appending anything owned-but-unsaved to the end on
read.

## The UI

**The progress grid** (`#/progress`, `ProgressGridView.tsx`) is spreadsheet-shaped on purpose:
one column per individual stat — six heroes, twelve pets, TH, walls, buildings left, notes — not
an aggregated percent. A predecessor view showed "Heroes 82%, Walls 61%," which is a fair
overview but not what someone scanning "who still needs Grand Warden level 90" can read a
percent for. At twenty-odd columns the table is wider than most screens; `.table-wrap` scrolls it
horizontally, the same control the trade table already uses, rather than trying to compress it.
Below the stacking breakpoint each row becomes a card, and a hero or pet a base hasn't unlocked
yet renders as an empty cell that collapses out of the stacked layout entirely, so an early-TH
base's card is short rather than a wall of dashes. Like the board it replaced, it is **not**
owner-gated for reading — every clan member the job has ever captured a row for is a row here,
the same stance the card event's inventory tables take — and it defaults to showing every row
rather than paging, since the page is meant to be scanned like the sheet it replaces.

**Entering the hand-typed fields** happens on a base's own player page
(`PlayerProgressPanel.tsx`), not on the grid — a collapsed `<details>` section so a base nobody
has captured yet costs one line rather than an empty form in front of every stat. Ownership is
checked with the same `cardEntryAccess`/`baseOwnerOf` helpers the card grid uses, mirroring
`mayWriteBaseCounts` client-side rather than reimplementing the decision; a stale-permission
403 (an admin reassigned the base while the tab was open) surfaces the server's own message
naming the real owner, rather than a generic failure.

**Percent-to-max** is computed entirely client-side and never from the API's own `maxLevel`
field (`progress-percent.ts`) — every function there takes the wiki-scraped
`MaxLevelReferenceRow` and ignores what the API reports, for the reason the data model section
above explains. A unit the reference table has nothing to say about (not yet scraped for that
category, or not yet unlocked at this TH) reports `maxForTh: null` and `percent: null`, never a
guessed 0 or 100 — `null` is the only value that doesn't misrepresent data that simply isn't
there yet.

**Base order** (`#/base-order`, `BaseOrderView.tsx`) is the only page that writes to
`base_order`; two others only read it (`CardsView`'s Mine picker and `ProgressGridView`'s "just
me" Owner filter, both via `applyBaseOrder`/`useBaseOrder` in `web/src/base-order.ts`).
Reordering is native HTML5 drag-and-drop rather than a library — the first interaction in this
app to need it — paired with explicit **Move up / Move down** buttons on every row, because a
mouse drag has no keyboard or screen-reader equivalent at all; without the buttons the page would
have a control only some visitors could use. Every reorder saves immediately rather than behind
a Save button: the server already accepts a partial list, so there's no correctness reason to
batch, and a page that has to be told to keep what it's already showing you is one more step to
forget.

## What's out of scope here

The audit trail (`auth_events`, migration v10) and the account-management routes it backs are a
separate feature with no relation to progress tracking or base order beyond sharing a migration
neighborhood; see [Authentication](authentication.md#the-migration-and-the-escape-hatch) for its
entry in the migration list.
