# Saved clans, shared data and ownership

## Saved clans

The landing page carries one list: saved clans — tag, a display name, level, members, points,
and war league. Clicking a row opens the clan and **War** opens its current war. The list is
**shared** — everyone signed in sees the same one — and **writing it is an admin decision**:
adding a tag, **Edit** (which renames and marks the row `custom` so **Refresh all** stops
overwriting the label), and **Remove** (which deletes after a confirm, for everybody) are all
admin-only, both in the UI and on the server. Any clan page also has a **★ Saved / ☆ Save**
toggle for the same write, gated the same way. A non-admin still reads the whole list; what they
lose is the ability to change it.

## The shared data model

Saved clans and owner assignments used to be `localStorage`, under `coc:savedClans` and
`coc:owners`. They are now rows on the server, and — the important part —
**shared across every account, not per user**.

That is the whole point of the exercise. Ten people looking at the same clan need *one*
canonical answer to "who owns this base"; per-user copies give ten answers and no way to
reconcile them, and the same person sees a different list on their phone. So there is one row
per clan tag and one per player tag for the install, and **every signed-in caller reads all of
them**. Reading is not filtered per user, and shared visibility is not what changed when
ownership became a permission — see
[Who may assign an owner, and who may write a base](#who-may-assign-an-owner-and-who-may-write-a-base).

```
saved_clans        clan_tag PK, name, custom, clan_level, members, clan_points,
                   war_league, updated_at, updated_by_user_id → users(id)
owner_assignments  player_tag PK, owner, owner_user_id → users(id) ON DELETE SET NULL,
                   updated_at, updated_by_user_id → users(id)
```

- **A base belongs to an account: `owner_user_id`** (migration **v6**). That is what makes "only
  the owner may edit this base's card counts" a question the server can answer at all — free
  text cannot be compared to a session, a user id can.
- **The `owner` text column stays beside it, and is not going away.** It is the label for a row
  that has never been matched to an account, which is most of them: these assignments predate
  accounts and name clan members who mostly have none. An unmatched name is still the only
  record of whose base it is in real life, so it is kept and shown — but it grants **nothing**.
  When a row does resolve, the stored text tracks that account's display name and the label the
  API returns comes from `users`, joined on read, so a rename cannot leave the two disagreeing.
- **`updated_by_user_id` is nullable, `ON DELETE SET NULL`.** The data outlives the account
  that entered it. Losing an attribution is acceptable; losing the assignment because somebody
  left the clan is not. **Disabling an account touches no row here at all** — disable is a
  timestamp on `users`, not a delete — and that is covered by a test.
- **Attribution is joined on read**, not copied onto the row, so renaming somebody does not
  leave old edits credited to a stale name. Every record carries `updatedAt` and `updatedBy`
  so the UI can say who last touched it.

All routes are authenticated; `/api/*` is deny-by-default, so they were protected before they
were written, and a test asserts each one 401s anonymously.

| Route | |
|---|---|
| `GET /api/saved/clans` | the shared list — **everyone** |
| `POST /api/saved/clans` | insert or refresh; an existing `custom` label survives — **admin only** |
| `PATCH /api/saved/clans/:tag` | rename, which marks the row `custom` — **admin only** |
| `DELETE /api/saved/clans/:tag` | remove, for everyone — **admin only** |
| `GET /api/owners` | every assignment, with `ownerUserId` — **everyone** |
| `PUT /api/owners/:tag` | assign one base to one account, `{ "userId": n }` — **admin only** |
| `DELETE /api/owners/:tag` | remove one — **admin only** |
| `POST /api/owners/bulk` | the conditional bulk apply, below — **admin only** |
| `POST /api/import` | the one-time browser hand-off, below; both its owner and clan halves are admin only |

### Who may assign an owner, and who may write a base

Four rules, and they are the whole authorization model:

1. **Everyone signed in reads everything.** Every base, every owner, every card count, every
   saved clan. That was the reason this data moved to the server and it has not changed.
2. **Only an admin writes the owner column** — the single set, the bulk apply, and the clear.
   Ownership decides who may edit a base's card counts, so a member who could reassign a base
   could grant themselves that write, which would make it not a permission at all. A member
   attempting one gets a 403 saying *an admin assigns ownership of a base*, not a bare denial.
3. **Only an admin writes the saved-clan list** — add, rename, and remove, including the
   shortcut on a clan's own page. The list is shared state every signed-in member sees, so a
   member who could reshape it unilaterally would be changing what everyone else sees without
   anyone entitled to that call having agreed to it — the same reasoning as rule 2, applied to a
   different shared table. This used to be open to every member; the project owner closed it
   once the same "a member can unilaterally rewrite what everyone sees" shape was recognized in
   both tables. A member attempting a write gets a 403 saying *an admin manages the saved clan
   list*.
4. **Only the owning account writes that base's card counts** —
   `PUT /api/cards/inventory/:tag`. A non-owner gets a 403 that **names the owner**
   ("`#2GCJ2QPU` belongs to Jared…"), because being told who to ask is the difference between a
   usable message and a wall.

Two decisions inside rule 4, both deliberate:

- **An admin may also write any base's counts.** An admin can reassign ownership to themselves
  in one request, so refusing them the direct write would stop nothing and would remove their
  only way to fix somebody else's mistake.
- **A base nobody's account owns is writable by admins only.** Nobody else has a claim to it.
  That covers a base with no assignment *and* a base whose assignment is an unresolved text
  label — the label is a note about a person, not a grant to a session. On this install that is
  22 of the 39 live assignments, so a member who finds a base refused should expect the fix to
  be an admin assigning it rather than anything they can do themselves.

The rule is **one pure function**, `mayWriteBaseCounts` in `server/src/cards/write-access.ts`,
with its own tests in `write-access.test.ts` — no database, no session, no HTTP. It is one
function rather than a check in each handler because spread out it would drift: one place would
forget the admin case, another would treat an unowned base as fair game, and nobody could state
the rule without reading three files. The route consults it *before* parsing the body, so a
refusal never depends on whether the payload happened to be well formed.

The owner routes and the saved-clan routes are both gated by middleware rather than by a check
inside each handler, so a route added later cannot become a hole by omission — the same
reasoning as `/api/*` being deny-by-default. `requireAdminFor(message)` in
`server/src/auth/middleware.ts` takes the message so each area can say what an admin actually
does there — `ownerWritesAreAdminOnly` and `savedClansAreAdminOnly`, both in
`server/src/shared-data/routes.ts`, are two applications of the same function.

### Migration v6, and what the backfill did

v6 adds `owner_user_id` and backfills it by matching the existing `owner` text against
`users.display_name`, **trimmed and case-insensitively** — that text was only ever meant for
human eyes, and `jared`, `Jared ` and `Jared` were the same person to whoever typed it. Notes:

- **Most rows do not resolve, and that is not a failure.** On this install the backfill linked
  **17 of 39** assignments and left **22** as text labels (`lisa_sweatt` ×9, `william` ×13 —
  neither matches an account's display name; note `lisa_sweatt` is *not* `lisa sweatt`). Nothing
  is deleted, nothing fails, and an unresolved row simply owns nothing until an admin reassigns
  it with `PUT /api/owners/:tag`.
- **The server says the split out loud at boot**, e.g.
  `→ owner assignments: 17 of 39 linked to an account, 22 still a text label (admin-writable only)`.
  It is read from the table on every boot rather than reported by the migration, so it stays true
  after an admin has reassigned a few.
- **It runs exactly once**, like every other step, because `PRAGMA user_version` is the marker.
  That matters more here than elsewhere: a backfill that ran again would read the stale text on a
  row an admin has since pointed somewhere else and silently put the old owner back. There is a
  test for precisely that.
- `LOWER` in SQLite is ASCII-only, so a display name needing Unicode case folding stays
  unresolved rather than resolving wrongly. Two accounts answering to one name resolve to the
  lowest id — arbitrary, but deterministic.
- Typing a name into the **bulk bar** goes through the same matching rule, so an admin typing a
  teammate's display name links the account rather than creating another label.

### Optimistic concurrency on the bulk owner apply

Shared data means two people can race on one row. `POST /api/owners/bulk` therefore takes, on
**every** row, the owner value the client *believed* was current — `""` meaning "I believe
nobody owns this". The server writes a row only if the stored value still matches, and returns
any mismatch as a conflict carrying the **real** current value, its timestamp and who set it.
Rows that did match are still applied: one stale row must not block the other nine.

`expectedOwner` is **required**, not defaulted. A missing one would read as `""`, which is
precisely the silent clobber the endpoint exists to prevent, so the request is refused with a
400 instead.

This maps onto the approval dialog that already existed in `ClanView`. `planOwnerChange` still
does the client-side partitioning — it is reused, not duplicated — and a row the *server*
rejects is appended to the very same list, now showing the real current value, for re-approval
against the truth. Approving is itself conditional on the value that was approved, so a row
that changes again while somebody is deciding comes back a second time rather than being
overwritten. Single-owner edits go through the same check, using whatever that tab believes.

### The one-time import of browser data

On the first sign-in after this change, whatever the browser still holds under `coc:owners`,
`coc:savedClans` (and the older `coc:saved`) is POSTed once to `/api/import`, and a
`coc:importedToServer` flag stops it happening again.

**It fills gaps only. It never overwrites a value already on the server.** With shared data and
several people importing their own copy, an overwriting import would mean whoever signed in
last silently won every disagreement. The insert is `ON CONFLICT DO NOTHING`, which also makes
the endpoint idempotent regardless of what the client does — the flag only saves a round trip,
the server is the real guard. The response counts what was applied against what was skipped,
and the UI shows that as a short, dismissible summary: quietly moving somebody's data without
saying what became of it is not on, least of all when some of it was skipped.

The `localStorage` keys are **read and never cleared**, so if the import turns out to have been
wrong the original data is still sitting there.

**The upload route itself is not admin-only, but both halves of what it carries are.** A
member's own browser data is theirs to bring across — the route stays open so nobody needs an
admin present just to hand off a `localStorage` export — but the owner rows and the saved-clan
rows inside it are gated exactly as their dedicated routes are. Either would otherwise be a way
straight around the admin gate on `/api/owners` or `/api/saved/clans`: a member refused on those
routes could get the identical write through here instead. For a non-admin both halves are
refused unexamined and reported as `owners.refused` and `clans.refused` rather than silently
dropped, so the client can say what happened to every row it sent.

### The client stores

`web/src/owners.ts` and `web/src/saved-clans.ts` keep the shape they had — `useOwners()`,
`useSavedClans()`, `setOwner`, `saveClan`, … — so the components barely changed. Both are built
on `web/src/server-store.ts`, one module-level external store over `useSyncExternalStore`, the
same mechanism as before, so the Save toggle on a clan page and the list on the landing page
still agree instantly.

What changed is that the snapshot is now a *cache of something another person can alter*, so
`status` and `error` are part of it: reads have a real loading state, and **a failed write is
made visible rather than dropped**. `mutate` records the error *and* rethrows, so the button
that was pressed can say the write did not happen — the UI never claims a change succeeded
when the request failed. Signing out empties both caches.

### Row counts and paging

The table has a **Rows** select, defaulting to 5 (5 / 10 / 20 / 50 / All). The choice persists
in `localStorage`, so it survives a reload.

A limit never silently hides rows. Whenever the list is longer than the limit, a footer says
`Showing 1–5 of 63` with **Previous** / **Next**. The page resets to 1 when the limit or the
sort changes, and is clamped if rows are removed underneath it, so the view can never land on
an empty page past the end.

The slicing is a pure function, `paginate(rows, limit, page)` in `web/src/saved-table.ts`,
returning `{ rows, page, pageCount, from, to, total }` where `'all'` (or `null`) means no
paging. The returned `page` is authoritative — that is where clamping happens, so a stale
page number in a component cannot produce a blank table.

Four lists share that machinery — `paginate()` and `parseRowLimit()` for the logic,
`RowLimitSelect` and `Pager` for the controls, `useRowLimit()` for the persistence. Their defaults
differ because the lists do:

| List | Default | Options | Stored at |
|---|---|---|---|
| Saved clans | 5 | 5 / 10 / 20 / 50 / All | `coc:savedClans:limit` |
| Clan roster | 10 | 5 / 10 / 20 / 50 | `coc:rosterLimit` |
| Trade suggestions | 5 | 5 / 10 / 20 / All | `coc:tradePairLimit` |
| Collection leaderboard | 5 | 5 / 10 / 20 / 50 | `coc:cardStandingLimit` |

The trade suggestions' select is labeled **Pairs**, not **Rows**, because that list pages by pair —
see [Row counts on the trade suggestions](cards-ui.md#row-counts-on-the-trade-suggestions).

## Owners live on the clan page

There used to be a second landing-page table of saved *bases*: a curated list of player tags
with a display name, Town Hall, trophies, clan, and an **owner**. The clan page already shows
all of that for every member, so the table was redundant and is gone. The one thing worth
keeping is the owner, because it is the only field the API cannot supply.

Owner is keyed by player tag, stored on the server and **readable by everyone** (see
[The shared data model](#the-shared-data-model)), through `web/src/owners.ts`. The clan roster
joins it in as a sortable **Owner** column, so the place you assign an owner is the place you
can already see the Town Hall, trophies and rank you are deciding from.

It is no longer a bare annotation: an owner is an **account**, and **only an admin can set one**
(see [Who may assign an owner, and who may write a base](#who-may-assign-an-owner-and-who-may-write-a-base)).
The server enforces that on every owner-writing route. **The web UI has not caught up yet**: the
Owner column and the bulk bar still type a free-text name, which the server matches to an
account by display name where it can, and a member pressing them gets a 403 rather than a
disabled control. The outstanding UI work is the Owner cell becoming a picker over accounts,
the bulk bar being hidden from non-admins, and card entry being disabled for a base you do not
own.

Removing the bases table also removed the **Save** button from player profiles. Player pages
themselves stay, and the homepage still looks players up.

### Migrating `coc:saved` → `coc:owners` → the server

`migrateLegacySaved` parses the old `coc:saved` payload and carries over every entry with a
non-empty owner, discarding the name, stats and clan along with any entry that had no owner at
all. It now feeds the one-time import rather than a second `localStorage` key. **Neither key is
deleted** — both stay put, so nothing is destroyed by a migration that turns out to be wrong.

The migration is a pure exported function, `migrateLegacySaved(rawJson)`, precisely so it can
be tested against what a browser might really be holding: malformed JSON, a non-array, a
non-object entry, a missing or unparseable `tag`, a missing or blank `owner`, duplicate tags.
`web/src/owners.test.ts` covers all of those.

### Bulk owner assignment

Tick members and a bulk bar appears; the header checkbox goes indeterminate on a partial
selection. The game caps a clan at 50 members, so this table is never paged and the header
checkbox safely means the **whole roster** — every row it ticks is on screen, which is what
made a page-scoped select-all necessary in the old bases table.

Type an owner, press **Apply to selected**, and:

- members with **no owner** are written straight away — conditionally, asserting that belief,
  so the write still fails safely if somebody else got there first;
- members that **already have a different owner** are held back for approval, listed one per
  line with the old and new value, each unticked by default — nothing is overwritten until
  you tick it and press **Apply N approved**;
- members that already match are counted as unchanged and left alone;
- members the **server** refuses, because the value changed underneath this tab, join that
  same approval list showing the real current value. See
  [Optimistic concurrency](#optimistic-concurrency-on-the-bulk-owner-apply).

Clearing an owner (empty box) takes the same approval path, since it destroys information
just as much as replacing it. The owner input is backed by a `datalist` of owners already in
use, so repeat entries are one keystroke.

Every column of both tables sorts, and blank or unknown values stay at the bottom in **both**
directions — reversing a column should not bring a wall of dashes to the top. The two
comparators that do that are exported from `web/src/saved-table.ts` so each table shares the
one behavior rather than reimplementing it.

Comparators, ordering, paging, and the approval partitioning all live in
`web/src/saved-table.ts`, apart from the components, and are covered by `npm test`.
`planOwnerChange` takes the minimal `{ tag, name, owner? }` shape, which is why a live clan
member satisfies it directly.
