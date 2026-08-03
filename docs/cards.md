# The card-collecting event

Each base collects cards during August. `#/cards` is the page: a grid of all 60 cards per base,
manual entry of the counts, and the trades those counts make possible.

**There is no API for any of this.** Supercell exposes nothing about the event, so every number
is typed in by hand. That single fact shapes the rest of the design — there is nothing to
refresh from, so what is stored is whatever a person last entered, and the only defence against
a wrong number is that everyone can see it and see who entered it.

## The card list is generated and committed

`web/public/coc/cards/manifest.json` is the source of truth for which sixty cards exist —
**not** the spreadsheet at the repo root, which is the author's working notes. The manifest also
carries `collected` and `confidence`; both are notes about how each *picture* was sourced and
have nothing to do with inventory, so neither is carried across.

`npm run cards:generate` (`scripts/generate-cards.mjs`) reads it and writes
`web/src/cards.generated.ts` — id, category, name, image path — the same way
`scripts/fetch-wiki-art.mjs` writes `wiki-art.generated.ts`. It validates before it writes:
contiguous ids from 1, a known category on every card, a name and an image path. A structural
problem aborts and leaves the committed module alone, because a duplicate id or a bad category
would otherwise surface as a wrong picture weeks later.

**The generated module is tracked; the art it points at is not.** `web/public/coc/` is
gitignored, so a fresh clone has the sixty cards' ids, names and categories but none of their
pictures — and the manifest is inside that directory too, so a fresh clone cannot even re-run
the generator. That is exactly why the module is committed rather than generated at build time.

A missing picture is the **normal** case, not an error. The art is a hand-placed set under
`web/public/coc/cards/` and no committed script fetches it; without it, `GameIcon` removes the
`<img>` on error and the tile is an empty, correctly sized art box over its count — the tiles carry
no name of their own, so on such a checkout the number box's accessible name and the tile's `title`
are the only things that still say which card is which.
`.card-tile__frame` reserves the height rather than shrinking to its content, so the grid
neither collapses nor reflows. Never a broken-image glyph.

The **id** is the identity and the **name** is what the user reads; an image path is neither.
That was concrete under the old wiki art, where "Baby Dragon" and "Baby Dragon (Builder)" were one
file and two tiles were the same picture. The current set draws **all sixty separately** — card 11
is `elixir_11_baby_dragon.png`, card 38 is `builder_base_38_baby_dragon_builder.png`, and no two
cards share a file. `card-crops.test.ts` pins that: it groups all sixty by image path and asserts
no path is reused, naming the offenders if one ever is. Keying on the id anyway is what makes the
grid survive a set that *does* reuse a file.

## The tiles are framed whole

Every tile shows the **whole** of its picture. `.card-tile__frame` is `aspect-ratio: 4 / 5`
because the art is 4:5 — 256×320, all sixty — so `object-fit: contain` at the matching ratio
neither trims an edge nor leaves a letterbox bar. Read back off the DOM at 390, 600 and 1280px,
light and dark: all 120 frames on the card page have an `<img>` box **exactly** equal to the frame
box, offset 0,0. At 1280px that is a 107×134 frame showing a 256×320 file, so the art downscales —
sharper than any crop of it could be.

This replaced a per-card **crop table**. The art used to be whole figures standing on a patch of
grass, and `card-crops.ts` held three numbers per card (`x`, `y`, `zoom`) that CSS used to slide a
window over the head. The new art is already framed on its subject, so cropping it would zoom into
a face that already fills the frame. The frame was 3:4 while its shape was a free choice.

**The crop machinery is kept, not deleted.** The art may be regenerated unframed, and re-cropping
should stay a table of numbers rather than a rewrite:

- `cardFraming(id)` returns `WHOLE_FRAMING` unless the id appears in `FACE_CROPS`, which is
  **empty**. Whole is the default; a face crop is the exception, and `CardTile` sets
  `data-crop="face"` plus the three custom properties only for one.
- `faceCrop(x, y, zoom)` is exported and carries the clamp that keeps a window inside its picture.
  It is tested **directly**, because an empty table would make the old per-entry assertions pass
  vacuously — a crop at zoom 2 clamps to 25–75%, at zoom 4 to 12.5–87.5%, and at zoom 1 collapses
  to dead centre.
- the per-entry guard rails (ids must name real cards, windows must stay inside the picture, zoom
  in 1–3) are still there and still run, so the table cannot be refilled wrongly unnoticed.

**Roughly half the files carry transparency** (31 of 60 have fully transparent pixels; 29 are
opaque edge to edge — measured by decoding the PNGs properly, filters reconstructed, not by reading
raw scanlines). Where a background is transparent the tile's own `--surface` shows through:
parchment in light mode, dark wood in dark. Looked at on both themes and all four deck frames, that
reads as a cut-out figure on the card and matches the game's own treatment, so **no backing colour
is painted** — one would only re-introduce a box edge the art was cut out to avoid.

## The data model, and why inventory is shared

Cards are collected **per player**, so counts are keyed by base — one set of sixty per player
tag — and migrations **v4** and **v5** add two tables. Both are shared across every account for
exactly the reason `owner_assignments` is: how many Barbarian cards a base holds is a *fact
about the base*, not a private opinion, and trade suggestions only mean anything if everybody is
reading the same numbers. Ten private copies would produce ten disagreeing sets of suggestions.

```
card_inventory     (season, player_tag, card_id) PK, count,
                   updated_at, updated_by_user_id → users(id) ON DELETE SET NULL
                   CHECK (card_id BETWEEN 1 AND 60), CHECK (count BETWEEN 0 AND 10)

card_base_updates  (season, player_tag) PK, updated_at,
                   updated_by_user_id → users(id) ON DELETE SET NULL
```

- **Rows are sparse: absent means zero.** A base holding nine cards has nine rows, not sixty. A
  count of 0 deletes the row rather than storing a zero, so "does not hold it" has exactly one
  representation.
- **Both CHECKs restate what the route already validates**, on purpose. The route can be
  bypassed by a future caller; the database cannot. There are tests that insert past the route
  and assert the schema refuses. `count` still permits 0 because 0 is legal on the wire, even
  though no row ever stores one.
- **`updated_by_user_id` is nullable, `ON DELETE SET NULL`** — the counts outlive the account
  that typed them, and **disabling an account touches no row here**, which is covered by a test.
  Attribution is joined on read, so a rename never leaves old edits credited to a stale name.
- **The edit time is always captured, in its own table.** `card_base_updates` holds one row per
  base saying when its counts were last saved and by whom, written on **every** save inside the
  same transaction as the counts. It started out derived from `MAX(updated_at)` over the count
  rows, and that was wrong: because storage is sparse, a base cleared back to zero has no count
  rows left, so the derived stamp vanished for precisely the base most likely to prompt "when
  did we last check this one?". Saving a base with *nothing* on it is a real check and is
  recorded as one. v5 backfills each base from its newest surviving count row, so an install
  already at v4 keeps the attribution it had. One row per base, not per card — a base is saved
  whole, so a per-card stamp would be sixty copies of one fact.
- **An emptied base stays listed**, reporting zero cards and its stamp, rather than disappearing.

## The season constant

Every row is scoped to a season string, and there is exactly one:
`CARD_SEASON` in `shared/src/card-types.ts`, currently `'2026-08'`.

**One line to change next August.** Without it, next year's counts would merge silently into
this year's and the suggestions would be drawn from a mix of two events. There is deliberately
**no season-switching UI** — the constant is the switch, and the routes never take a season from
the request, so a client cannot write into a season nobody is looking at.

## Routes

All authenticated; `/api/*` is deny-by-default, so they were protected before they were written,
and a test asserts each one 401s anonymously. **Reading is open to every member; writing a base
belongs to that base's owner** (and to admins) — see
[Who may assign an owner, and who may write a base](shared-data.md#who-may-assign-an-owner-and-who-may-write-a-base).

| Route | |
|---|---|
| `GET /api/cards/inventory` | every base with cards recorded, each with `updatedAt` and the display name in `updatedBy` — **everyone** |
| `GET /api/cards/inventory/:tag` | one base; a base nobody has entered answers `{ counts: [] }`, not a 404 — **everyone** |
| `PUT /api/cards/inventory/:tag` | replaces that base's whole season in one request — **the owning account, or an admin** |

A caller who does not own the base gets a **403 naming the owner**, and an unowned base is
writable by admins alone. The decision is `mayWriteBaseCounts` in
`server/src/cards/write-access.ts`, checked before the body is parsed.

The write is **one request per base, never sixty per card** — the entry screen edits a base at a
time, and sixty requests to save one screen would be sixty chances to half-apply. Every id must
be 1–60 and every count 0–10; **one bad entry rejects the whole request** with a 400 and writes
nothing, because a partially applied save would leave a base holding a mixture of what was typed
and what was there before, with nothing on screen saying which took. A repeated `cardId` is
refused too, rather than letting the last one quietly win.

**Concurrency is last-write-wins per base**, deliberately unlike the owner flow's
expected-value handshake. A card count is a number somebody read off a screen a moment ago, not
a decision another person made, so the cost of a clobber is re-typing one base — where the cost
of clobbering an owner is losing somebody's decision. What makes that acceptable is that
`updated_at` and `updated_by` are recorded and shown on every base, so a surprise is at least
explainable: you can see the count changed, when, and who changed it.

## The trade rules

`web/src/card-trades.ts`, pure and with no knowledge of React, the server, or the generated card
list — categories arrive through a resolver, which is what lets the tests run the rules against
three made-up cards instead of sixty real ones. `web/src/card-trades.test.ts` covers it.

A trade pairs base A giving card X to base B, and B giving card Y to A, where **all** of:

1. **A holds 2 or more of X, and B holds 2 or more of Y.** A base never trades away its last
   copy, so a count of exactly 1 is *not* tradeable. This is the rule people get wrong by hand.
2. **B holds zero of X, and A holds zero of Y.** You may only receive a card you do not already
   own — a second copy of something you hold once is worth nothing to you.
3. **X and Y are in the same category.** The game only swaps within a deck.
4. **A and B are different bases**, including when one tag appears twice in the input.

Rules 1 and 2 together make `X === Y` unreachable without a special case, and there is a test
that says so rather than only a comment.

**Mirrors are reported once.** A↔B and B↔A are one trade seen from two sides, so each unordered
pair is considered once and the result is always oriented with the lexicographically smaller tag
as `baseA` — which makes the output independent of the order the bases were passed in, and that
is asserted directly. Output is sorted by base then card, so it never shuffles between renders.

One pair can yield several suggestions and one spare can appear against several partners. That
is intended: these are options to choose between, not a plan.
