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
| `PUT /api/progress/:tag/manual` | the base's owner (`mayWriteBaseCounts` — the same rule `cards/routes.ts` uses, not a second copy of it) | `{ walls?, buildingsLeft?, notes?, weekStart? }`, merged into the current week, or into `weekStart` if given |
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

**`PUT /api/progress/:tag/manual`'s `weekStart` corrects an already-captured week instead of the
current one.** Walls are hand-typed, and this app's own history is entry mistakes getting made
and needing a way back (see "Card counts are stored sparsely" and this section's own account of
where the data comes from) — until this, the only way to fix an old week's walls was asking
someone to edit the database directly. Omitted, the route behaves exactly as before: the caller's
current week, from the server's own clock, never the request. Given, `resolveTargetWeek`
(`server/src/progress/routes.ts`) validates it against `ProgressStore.getWeek` — a week this tag
has no `base_progress` row for is rejected with a 400 rather than silently creating one, since a
correction can only edit history that already exists. The wall-cap check also scores against
**that week's own** Town Hall (`existing.thLevel`, the row `resolveTargetWeek` found), not the
base's latest known one — a base that has since upgraded must not have an old week's walls
validated against a cap it did not hold at the time. Authorization is unchanged: the same
`mayWriteBaseCounts` decision, no special-casing for a past week.

Every corrected week gets a short trail appended to its `notes` — `withCorrectionNote` appends
`"Walls corrected on <date>."` (joined with whatever was already there by an em dash, the same
joiner `combineNotes` uses for display) rather than replacing it — the same honest-record stance
this schema already takes with `auto_note`'s diff and `captured_by`'s attribution: a stored row is
the record of what actually happened, and a retroactive edit changing that record deserves the
same trail every other correction here gets. `auto_note` itself is untouched by a walls-only
correction — it is computed from `thLevel`/`heroes` (`computeAutoNote`), neither of which a wall
correction ever writes.

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

**Comparing bases over time** is a second section on the grid page, below the table
(`ProgressTrendsSection.tsx`) — its own component, rendered after the grid's `</section>` rather
than inside it, so the grid's own code path is untouched. Pick a stat (Town Hall, a hero
individually, walls or a category as percent-to-cap) and see every in-scope base's own line for
it, over its own captured weeks — the comparison the flat grid can't show, since a column sorted
by today's value says nothing about who is catching up. It reuses the grid's own Owner filter
(`activeOwnerFilter`/`filterStandingsByOwner`, `card-standings.ts`) to keep the plotted line count
sane, and additionally caps the plotted set at `MAX_TREND_BASES` (12) — an unfiltered "Everyone"
selection on a fifty-base clan would otherwise fire fifty parallel `GET /api/progress/:tag`
requests and plot a chart nobody could read. There is no batch route for this: that endpoint
already answers one base's full history, and `useMultiProgressHistory` (`progress.ts`) firing one
fetch per base in the filtered set is exactly what a section that already defaults to a narrowed
view needs. **Which bases survive that cap, and the order they're plotted in, follows this
account's own saved base order** (`selectTrendBases`, `progress-trends.ts`) — the same
`applyBaseOrder`/`useBaseOrder` read `ProgressGridView`'s own "just me" Owner filter and
`CardsView`'s Mine picker already make, applied here to the owner-filtered set *before* the cap
rather than after, so a member tracking more bases than `MAX_TREND_BASES` sees their own bases, in
their own preferred order, ahead of everyone else's rather than an arbitrary cutoff.

**Entering the hand-typed fields** happens on a base's own player page
(`PlayerProgressPanel.tsx`), not on the grid — a collapsed `<details>` section so a base nobody
has captured yet costs one line rather than an empty form in front of every stat. Ownership is
checked with the same `cardEntryAccess`/`baseOwnerOf` helpers the card grid uses, mirroring
`mayWriteBaseCounts` client-side rather than reimplementing the decision; a stale-permission
403 (an admin reassigned the base while the tab was open) surfaces the server's own message
naming the real owner, rather than a generic failure.

**The disclosure's shape, top to bottom: this week's entry form, this week's full detail, the
historical charts, older weeks' notes, then a collapsed past-week correction form.** The panel has
been through two rounds. The first printed every captured week as its own block — every hero,
pet, troop, spell and equipment level spelled out again with icons, newest week first — readable
for a handful of weeks and an unreadable wall of text for months of them, with no trend at all.
The second replaced *all* of that with charts (`progress-history.ts` turning history into chart
series, `components/charts.tsx`'s hand-rolled inline-SVG `LineChart`/`TroopHeatmap` drawing them —
this app has never added a charting dependency, and this feature didn't start). Live review then
asked for the detailed block back, but only for the single newest week: a chart shows the trend,
but "is this hero maxed right now" is what a reader actually opens the panel to check day to day,
and a raw-level line doesn't answer that as directly as an icon and a fraction. So
`CurrentWeekDetail` — heroes, pets, troops, spells, **equipment** and walls, each unit with its
icon and a level/fraction, exactly the pre-chart block — now renders for the newest captured week
only, followed by the charts for the trend across every week, followed by the older weeks'
buildings-left/notes (`WeekSummaryRow`, unchanged, now mapped over every week but the newest).

**Because the detailed block is back, the charts no longer mark a "maxed" point.** An earlier
round threaded a reference table into the heroes chart so a maxed hero's marker switched to the
app's "done" color; `CurrentWeekDetail` above already says "maxed" the same way it always used to
(icon, fraction, `.progress-unit--maxed`), so the chart carrying that signal too was a second copy
of the same fact with no second reported need for it. **Point markers are gone from the charts
entirely, not just the maxed ones** — a later live review found the dots (already shrunk once,
from a 4px to a 3px radius) still crowded a chart carrying a full season of weekly points across
several series, and the maxed ring made it worse. `LineChart` now draws pure lines with no
per-point mark at all; the value at a point is still reachable through the hover/keyboard
crosshair and tooltip, and through the "Show as table" fallback underneath every chart — removing
the dot lost nothing the tooltip and table didn't already carry.

The chart categories render **heroes, pets, walls, spells, troops** — troops last, since its
aggregate-line-plus-heatmap pairing is the biggest block and reads naturally as the final section.
Heroes, pets and spells each get one raw-level line per unit (not percent-to-cap — the TH-relative
cap a percentage would divide by can itself move over the same span the chart covers, the same
reasoning the "Percent-to-max" section below gives for `null` over a guessed number, applied here
to a whole axis rather than one figure); walls get one line per level the base has ever held,
colored by a **sequential, multi-hue** ramp keyed by level (`wallLevelColor`, `chart-colors.ts`,
backed by the `--wall-ramp-1`..`--wall-ramp-5` tokens in `styles.css`) so a level still reads as
"between" its neighbors while staying distinguishable at the fifteen-plus levels a high-TH base
can hold at once — a single-hue ramp read as indistinguishable shades of blue past five or six, a
live-review finding. The dataviz skill's default sequential encoding is one hue, but it names an
explicit exception for exactly this case ("analogous neighbors … always with a scale legend"),
which the wall chart's own legend already satisfies. Heroes/pets/spells/troops are **categorical**
instead — no inherent order between two unit names — so each unit takes a fixed slot from
`--series-1`..`--series-8` (`styles.css`), cycling hue and then dash pattern past eight so a
12-pet or 18-spell chart still keeps every line pairwise distinct. Troops are 58-strong, too many
for one chart, so they get two views instead: an aggregate percent-of-troops-maxed line
(`percentToMax`'s own `.percent`, reused rather than recomputed) and a troop x week heatmap
underneath, shaded by its own single-hue sequential ramp (`percentHeatColor` — deliberately not
the wall chart's multi-hue one, since a heatmap cell carries its percent as text and never needs
color alone to separate it from its neighbor). Troops, spells and equipment barely have history
yet — the historical backfill's source, an old spreadsheet, only ever tracked heroes and pets —
so both troop views are commonly one to a handful of points right now; that is the real, current
shape of the data and both degrade to it without breaking, filling in on their own as
`capture-snapshot.ts` runs weekly. **Equipment has no chart at all** — out of scope for the chart
views specifically (it's back in `CurrentWeekDetail` above), dropped from the historical trend
entirely rather than given a sixth, unfinished treatment. Every chart's x-axis is **categorical by
captured week, not a continuous time scale**: points are spaced evenly by which weeks were
actually captured, not by calendar distance, so a missed week doesn't visually compress or
stretch the trend around it.

**A percent-bounded chart's y-axis auto-fits to what's actually plotted, clamped to `[0, 100]`,
rather than always spanning the full range.** The troops-percent chart here, and the trends
comparison section's percent-to-cap stats (below), used to pass `LineChart` a fixed `[0, 100]`
domain — every chart, however clustered its real data, spanned the full percent range top to
bottom. Live review on the trends section found real clan data clustering entirely in the 60–100%
band, wasting the bottom 60% of every chart and compressing all the real variation into a thin top
strip. `LineChart`'s `yBounds` prop (`components/charts.tsx`) replaced the fixed `yDomain`: the
axis still auto-fits to the padded range of whatever is visible, the same as the unbounded
(non-percent) charts already did, but a percent chart's fit is clamped so it can never cross 0% or
100% — clustered data now actually zooms in, and the tick labels (still the real values, never
hidden) say plainly that the axis isn't 0-anchored, so the zoomed-in range can't be misread as more
variation than it is.

**Town Hall, buildings left and notes are not chart material** (one number that barely moves, and
free text, respectively). Town Hall instead gets **"Overall progress"** — a short list of "TH
N → N+1 — date" events (`buildThUpgrades`, walking consecutive captured weeks for level
increases), plus the current level, sitting above and **outside** the `<details>` disclosure so
it stays visible even collapsed — the same "visible even collapsed" precedent the trade tracker's
pending count already sets on the card/player pages. The date is honestly the week the change was
*captured*, not necessarily the real-world day the upgrade finished, since capture is weekly.
Buildings-left/notes for older weeks stay a compact per-week list below the charts, inside the
disclosure — the current week's buildings-left/notes are part of `CurrentWeekDetail` instead, so
they are not shown twice.

**Correcting a past week's walls** is a collapsed nested `<details>` at the very bottom of the
panel — `PastWeekWallForm`/`PastWeekWallEditor` in `PlayerProgressPanel.tsx` — the same
"administrative control stays collapsed" precedent `TradeSuggestions`' "What makes a swap legal"
disclosure sets inside `PlayerCardPanel`'s own `<details>`. A `<select>` of every week
`useProgressHistory` already has client-side (no second fetch) picks the target week; choosing one
mounts a wall-only editor seeded from that week's own `walls`, reusing the same row-editor UI and
`wallsToRows`/`rowsToWalls`/`wallCapFor` logic `ManualCaptureForm` uses for the current week — both
now share it via `wall-rows.ts` (the row state and mutators, `useWallRows`) and `WallsField` (the
row-editor UI), rather than a second parallel implementation. Only writable to a base's owner (or
an admin) — the same `access.writable` gate `ManualCaptureForm` uses, not a looser or separate
check. See the Routes section above for what the request actually does server-side.

**Percent-to-max** is computed entirely client-side and never from the API's own `maxLevel`
field (`progress-percent.ts`) — every function there takes the wiki-scraped
`MaxLevelReferenceRow` and ignores what the API reports, for the reason the data model section
above explains. A unit the reference table has nothing to say about (not yet scraped for that
category, or not yet unlocked at this TH) reports `maxForTh: null` and `percent: null`, never a
guessed 0 or 100 — `null` is the only value that doesn't misrepresent data that simply isn't
there yet.

**Base order** (`#/base-order`, `BaseOrderView.tsx`) is the only page that writes to
`base_order`; three others only read it (`CardsView`'s Mine picker, `ProgressGridView`'s "just
me" Owner filter, and `ProgressTrendsSection`'s base selection/order — the last via
`selectTrendBases` in `progress-trends.ts`, the other two directly — all via
`applyBaseOrder`/`useBaseOrder` in `web/src/base-order.ts`).
Reordering is native HTML5 drag-and-drop rather than a library — the first interaction in this
app to need it — paired with explicit **Move up / Move down** buttons on every row (bracketed by
**send-to-top / send-to-bottom**, `⇈`/`⇊`, for jumping a base to either end without repeated
clicks), because a mouse drag has no keyboard or screen-reader equivalent at all; without the
buttons the page would have a control only some visitors could use. An **Alphabetize** button
above the list sorts every base by its display label, case-insensitively — never by the tag
itself, which is an opaque `#XXXXXXX` id nobody reads by. `moveTag` (`web/src/base-order.ts`)
backs the single-step and jump moves alike, called with `toIndex = 0` or `toIndex = tags.length`
for the jumps; `alphabetizeTags` in the same module backs the sort. Every reorder saves
immediately rather than behind a Save button: the server already accepts a partial list, so
there's no correctness reason to batch, and a page that has to be told to keep what it's already
showing you is one more step to forget.

## What's out of scope here

The audit trail (`auth_events`, migration v10) and the account-management routes it backs are a
separate feature with no relation to progress tracking or base order beyond sharing a migration
neighborhood; see [Authentication](authentication.md#the-migration-and-the-escape-hatch) for its
entry in the migration list.
