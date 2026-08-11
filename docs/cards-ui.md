# The card event's screens

## The UI

`#/cards`, titled **Clash of Cards** — the event's own name in the game, and the same heading the
card panel on a player page carries, so the two pages no longer word it differently. `CARD_SEASON`
is not shown in either title; it still scopes every stored row and is still returned by every
route, it is simply not chrome.

The page **narrows as it goes down**. The picker and the grid are the one base you can act on;
the three panels under them are the whole clan and are deliberately *not* filtered by the picker:

1. the base picker, with the **Mine / All** filter to its left, and the 60-tile grid for the base
   it chooses;
2. **Trade suggestions** — who should swap what with whom, 5 options (rows) at a time;
3. **Collection leaderboard** — a **View** picker over seven boards (Overall, Rarity, Full rows,
   By category, Full decks, Spares on hand, Most active trader), each ranking every tracked base by
   its own measure, 5 rows at a time, sharing one Owner filter and pager that never renumber — see
   [Seven boards: the View picker](#seven-boards-the-view-picker);
4. **Cards across the clan** — an expandable copy of the same grid, every tile badged with the
   clan's total, and every tile a button: press one for the bases holding that card. Grid order by
   default; an opt-in sort control can rank it by total instead — see
   [A sort control, opt-in](#a-sort-control-opt-in).

**Trades sit directly under the grid** because the spares you have just typed in are what the
suggestions are made of, and because they are the only panel on the page that asks you to *do*
something. The leaderboard and the clan totals are both reference; the totals are sixty more tiles,
so they go last, still collapsed. Only the trades' position was asked for — the rest is a
consequence of it.

The bases are the **owner assignments** — the set of player
tags the group already tracks — so there is no second list of bases to curate and drift. A base
that somehow has counts but no owner assignment is still listed, so its rows are never orphaned.
The **owner is named on every trade suggestion**, because the owner is who would do the trading.
The picker itself lists in-game names and not owners: a name and an owner side by side in one
option are two people's names in one label, and the reader cannot tell which is which.

- **The base list is member names, not tags.** A tag is not who you go and talk to. The names come
  from the saved clans' rosters — one request per saved clan covers every base in it — and any base
  no visible roster names is asked for directly, one request each. A tag the API will not resolve
  keeps showing as a tag. Where two bases share a name the tag is appended (`darek (#2GCJ2QPU)`),
  and only then; the list is ordered by name, unnamed bases last. All of that is
  `baseOptions()` in `base-names.ts`, pure and tested. **Tags remain the identity** — the select's
  values, the inventory keys and the trade suggestions are all still tags, and the selected base
  shows its tag beside the timestamp.
- **The picker remembers the base**, per account, at `coc:cardBase:<userId>` — so a reload comes
  back to the base you were entering rather than to the head of the list. Keyed per account for the
  reason `coc:baseScope:<id>` is: one browser is shared. It is deliberately **not** in the route:
  `#/cards` still carries no tag, because a link to one base would be a link into somebody else's
  editing session, and remembering a choice locally is a different thing from handing out an
  address for it. A remembered base that is no longer offered — unassigned, removed, dropped by
  `Mine`, or never a tag at all, since `localStorage` is hand-editable — falls to the head of the
  list through the same `activeTag()` that repairs an emptied filter, so a stale key can never
  leave the page blank. The reading is `last-base.ts`, pure and tested; nothing is stored until
  the picker is actually used, so a first visit still opens exactly where it did.
- **The grid** is one continuous grid of all 60 in deck order — nothing drawn between one deck and
  the next, so a deck that runs out mid-row does not leave a ragged line. Each deck is still a
  **named group** in the markup: a `.card-deck` wrapper carrying `role="group"` and a
  `.visually-hidden` `<h3>` it is labeled by. The wrapper is `display: contents`, which is what
  keeps it out of the layout — the tiles stay direct grid items of the one grid, so the grouping
  costs no box, no gap and no change to the column alignment. Anything other than `contents` there
  splits the sixty tiles back into four grids and the seams reappear.
  Tiles are **picture only**: no card name. A card the base holds renders in color; one it lacks
  renders the same file under `grayscale(1)`. For a sighted reader that is **never the only cue** —
  the badge over the art prints the exact count past a spare, so a held-once-or-more card is never
  told apart from an unheld one by color alone. A screen reader, though, gets nothing at all here:
  there is no longer a number box or an accessible badge to read the count from, only the two
  steppers' bare card names — see [The count row](#the-count-row) for the honest accounting of
  what that costs and why it was accepted anyway. The name is on the tile's `title` and in the
  accessible name of both steppers, so *which card* is never lost even where *how many* is.
  The cost is real and worth knowing: the card art is gitignored, so on a checkout with no art a
  tile is an empty frame over a count.
- **The count badge** sits in a wide bar straddling the art's lower edge and appears **only past
  one copy**: `×1` on fifty tiles would be noise, where a spare is the fact worth spotting. The
  clan-totals grid makes the opposite call and badges every count — see
  [Cards across the clan](#cards-across-the-clan). Sized and placed off the real game's own
  card-collection screen; see [The count row](#the-count-row) for the measurements.
- **The tile border carries the deck**, in the event's own frame colors —
  `--deck-elixir`, `--deck-dark-elixir`, `--deck-builder-base`, `--deck-super-troop`, declared
  in all three theme scopes and lightened for dark mode, where the deep purple would otherwise
  vanish. Categorical color on a border only, never on text. With the drawn headings and the names
  gone it is the only *visible* cue to deck, which is a real narrowing — the fallback for a sighted
  reader is that the cards stay in deck order so each color arrives as one unbroken run, and that
  each run is a named group with a hidden heading. For a screen reader there is no fallback left on
  the entry grid: the badge that once spelled the deck out in words is decoration now, so `title`
  (which assistive tech mostly ignores) is what remains — see
  [The count row](#the-count-row). It also settles the one case where two cards share a picture,
  since the home and Builder Base Baby Dragons sit in different decks; with the names gone, that
  pair is otherwise indistinguishable to a sighted reader. The nominal values are recorded in
  `CARD_CATEGORY_BORDER` in `shared/src/card-types.ts`; what the page paints is the CSS token,
  because a color that must work on parchment *and* dark wood is a theme decision.
- **Entry** is a **count row under each frame** — just `−` and `+`, capped 0–10 — kept in a local
  draft so pressing sixty rows of buttons is one write, not sixty. There is no way to type a count
  directly at any width: the cap is low enough that a run of taps is never more than ten presses,
  which is what lets the steppers be the only control rather than a convenience beside a typed one.
  The draft re-seeds when the base changes or when somebody else's save lands — but never while
  there are unsaved edits, because silently replacing what someone is doing is worse than showing a
  stale number they are about to overwrite. See [The count row](#the-count-row) for the three
  things that row has to get right.
- **The four deck plaques** sit in the base header's **upper right, directly beneath the
  `13/60 cards · 22 copies · 9 spares` line** they break down. See
  [Deck progress plaques](#deck-progress-plaques) — the same four are on every player page.
- **Last updated and who** is shown above the grid for the selected base.
- **A failed write is reported at the card it was typed on** — `Not saved` under the frame and a
  `--critical` outline on that one tile — and again in a notice above the grid saying why, with the
  typed counts left exactly as they are so nothing has to be re-entered. There is no Save button
  left to report it at: sixty fields that save themselves have no button to go quiet in, which is
  why the failure has to be visible at the tile.
- **Trade suggestions** are the panel directly under the grid, driven entirely by the pure module
  and grouped by the pair of bases involved. Its two identity columns are headed **Member** and
  print the **member name** as the link — a tag is not who you go and talk to — with the **tag and
  the owner** on a second line beneath it. The tag is not dropped anywhere: it is the identity the
  counts, the routes and the trades are all keyed on, and it is omitted only where it *is* the
  name, i.e. for a base no visible roster names. The names come from the same `baseOptions()` the
  picker uses, so there is one resolver, not two. Stacked on a phone, a pair's later options label
  themselves `darek gives` / `Zack gives` rather than repeating the tags.
  The table itself is `TradeSuggestions` in `web/src/components/TradeSuggestions.tsx`, **shared with
  a player page**, which renders the same component with a `focusTag` so it shows only that base's
  pairs — see [the trades under a player's grid](#the-trades-themselves-under-the-grid). Here it
  is deliberately unfiltered and group-wide: a trade has two sides and half of them are somebody
  else's bases by definition.

### The count row

There is no row any more. Tap the tile to add a copy; tap a small circle over its own
upper-right corner to remove one:

```
  ┌─────────────────┐
  │              (−)│ ← only drawn past a held copy — tap it to remove one
  │   card artwork  │
  │       ×3        │
  └─────────────────┘
   tap anywhere else to add one
```

**There is still no way to type a count, at any tile width — a number box and, later, a
tap-to-edit badge were both tried and both dropped, and neither is what this is.** Sixty
cards is sixty numbers, and that reasoning is still real, but both of the earlier designs
put a *typed, arbitrary* number within reach — a box you could type `37` into, or a badge
doubling as a text field with its own hidden edit state. Neither exists here: the cap is
still 10, a tap still moves the count by exactly one, and `cardCountStep()` in
`card-entry.ts` still decides both whether a tap is offered and where it lands, unchanged
from the two-button row this replaced. What changed is only the *hit area* a single-step
tap has to land on — the whole tile instead of a small dedicated `+`, a corner circle
instead of a small dedicated `−` — not the kind of value a tap can produce. Nothing on the
tile is a target for typing, so nothing has to reserve space, hide itself at a width, or
manage a second focus state — the badge over the art is pure decoration, exactly as it is
on the totals grid, and the tile-wide tap and the corner circle are the whole of the cell.

**Two controls, in a new shape, and what each is called.** Sixty tiles times two is still
120 things a screen reader can land on, and the tiles print no name of their own, so every
word of "which card is this" is in one of the two controls' own accessible names — a
whole-tile `<button>` and a small corner `<button>` now, instead of two same-sized ones in
a row, but the same two sentences either way. Read back through the accessible-name
computation in `web/src/components/BaseCardEditor.test.tsx`:

```
button      One fewer Barbarian
button      One more Barbarian
```

Naming carries less than the box-and-badge design once did, and that is recorded rather
than smoothed over. There is no third control left to spell out the deck or the range in
words — the badge that would have carried them is `aria-hidden`. A screen reader hears
the card's name and nothing else about it: not the deck, not the range, not the current
count. The deck still reaches a sighted reader through the frame's border color and the
tile's `title` (a pointer tooltip assistive tech mostly ignores); the count still reaches
a sighted reader through the badge past a spare and the grayscale below that. Naming all
three in full was the alternative tried first, in an earlier design, and was worse for a
different reason — one deck read out `Elixir` nineteen times over — but that tradeoff no
longer applies now that there is no third control to name at all.

**No `<button>` nests inside another.** `CardTile` itself is still not a button — see its
own doc comment in `web/src/components/CardTile.tsx` — so the tile-wide tap is a `<button>`
that *wraps* it, the same resolving pattern the clan-totals grid already uses to make its
own tiles pressable (`CardsView.tsx`'s `CardTotalPick`). The corner circle is a *sibling*
of that wrapping button, not a child of it and not a child of `CardTile`, which is what
keeps this legal markup instead of a button nested inside a button.

**`position: absolute` on its own did not win the tap, in a real browser.** The circle
also needs an explicit `z-index: 1` — the wrapper around both buttons has to be a
container (`container-type: inline-size`, so the circle's own size has something to
measure against — see "Touch targets" below) and that makes it a stacking context in its
own right, inside which a bare `z-index: auto` did not reliably beat the tile-wide
button's own nested `position: relative` descendants. Measured before the `z-index`
existed: `document.elementFromPoint()` at the circle's own center returned the art layer
underneath it, so every tap silently added a copy instead of removing one — checked by
driving a real browser and reading back what actually received the click, not assumed
from the stacking rules on paper. That is exactly the shape of mistake a
`pointer-events` slip or a missing `z-index` can produce here: nothing in an automated,
non-rendering test would have caught it.

**Leaving the *cell* is still the save.** A tap on the tile-wide `+` can move focus onto
the corner `−` (and a tap on `−` back onto `+`), so a save-on-blur would still turn five
taps into five PUTs of the base's whole season, each moving the `updated_at` the
attribution line reads out. The wrapper around both controls is one element with one
`onBlur`; `focusout` bubbles, and `relatedTarget` says whether focus went to the cell's
other control or out of it. The skip is still the fourth reason in `blurDecision` —
`sameCell`, ahead of `unchanged`, `notWritable` and `busy` — and a test taps `+` five
times and asserts **one** write of `count: 5`.

**The bounds are handled differently at each end, because the two controls are no longer
the same shape.** The tile-wide `+` is still `disabled` at the cap, exactly as the old
row's `+` was — `cardCountStep()` returning `null` is both the disabled state and the
tap's destination, so the two cannot disagree, and the bound is legible without it either
way (the badge past a spare, the grayscale below that). The corner `−` has no `disabled`
state to fall into at all: below a held copy it is not drawn, full stop, rather than drawn
and inert — there is no count for it to be a doomed tap on. The one cost this shape still
carries: a control that disappears (the `−` circle, on the tap that empties a tile) can no
more hold focus than a `disabled` one could, so the tap that removes it hands focus to the
tile-wide `+` first — the same "hand focus to the sibling before it goes away" instinct
`StepButton`'s old row used, now needed in one direction instead of two, since the
tile-wide `+` is never itself removed from the DOM, only disabled.

**A read-only base disables the tile-wide `+` and draws no `−` circle at all.** The `+`
carries the refusal as a `, read-only` suffix on its accessible name, exactly as the old
row's `+` did, and the sentence is still said in full only once, in the notice above the
grid — never duplicated per tile. The `−` circle is not merely disabled on a read-only
base; it does not render, since there is nothing to offer a decrement that would 403 and
no small hit area to widen for a control that can never legally fire. One real, recorded
cost: the old row's `title={readOnlyReason}` put the *full* refusal sentence on a mouse
tooltip at every one of the sixty tiles. That tooltip has no home to move to on a tile-wide
button wrapping the whole picture — `CardTile`'s own `title` (the card's name and deck)
sits on the innermost element under it, so a browser resolving "whose `title` wins" finds
that one first and never reaches the wrapping button's. What is lost is the second,
redundant place a mouse user used to find the refusal by hovering one tile; the notice
above the grid still says it once, same as before.

**The badge is decoration on both grids that draw it, drawn only past a spare, and is
otherwise untouched by any of this.** `×1` on fifty tiles would be noise where a spare is
the fact worth spotting, so `count > 1` is the whole condition — the same one the totals
grid uses, and the one this grid's very first version used before a number box and later a
tap-to-edit badge both tried, and both dropped, taking on the job of showing 0 and 1 as
well. A card held once, or not at all, is grayscale-versus-not and nothing else — the same
encoding the totals grid already carries for every card on it, not a new gap introduced
here.

**The tile's own padding between the art and its border is deliberately thin, and the
badge and the corner circle are both allowed to sit over that border rather than being
kept clear of it.** Reported back directly: the earlier padding read as noticeably more
air than the real game leaves around its own card art, where the count badge already
straddles the frame's edge outright. `.card-tile`'s padding dropped from 6px to 2px
(3px to 1px on the phone breakpoint) for this reason. The entry grid used to reserve
extra room under the frame — `.card-tile--entry` — specifically to keep the badge's own
overhang from reaching the border there, which was the opposite call from what the
totals grid already made for the same badge; that reservation is gone now; both grids
draw the badge exactly the same way.

**Touch targets, at the density this grid can reach.** The corner circle's own visible
size and its actual tap target are two different boxes on purpose: at twelve columns on a
phone a tile's own content is well under the ~44px floor most touch-target guidance uses,
so a target sized to that floor would reach past the tile's own center and into its
neighbor's. The target is capped below that floor instead — `clamp()`, in a container-query
unit tied to the tile's own width, the same technique the badge's font-size already uses —
and the visible dot inside it is smaller still. Measured against the compiled stylesheet at
the app's own reference tile sizes, in both themes: see `BaseCardEditor.tsx`'s
`CardEntryTile` doc comment and the CSS comments on `.card-entry-tile__minus` for the exact
numbers this was checked against.

**Sized and positioned off the real game's own card-collection screen, not an
app-invented corner-chip convention.** Measured from a reference screenshot — the "×2"
badge on the game's own Furnace card, against the card's own art — the badge is a wide
bar roughly **half the art's width and about a seventh of its height**, centered
horizontally and straddling the art's *bottom edge* rather than tucked into a corner:

| | badge width | badge height |
|---|---|---|
| measured (reference) | ≈ 50.6% of art width | ≈ 14.0% of art height |
| implemented | `width: 50%` | `height: 14%` |

Both are percentages of `.card-tile__frame`'s own box, so the badge scales with the tile
at every density and viewport the same way the art itself does — measured against the
compiled stylesheet, the ratio holds exactly at every tile size from 79.7px of content
up (`.card-tile__frame`'s `overflow: hidden` clips nothing at those sizes, since the
badge never exceeds the frame). Below that, two floors take over: `min-width: 24px` and
`min-height: 16px`, because a pill scaled to a literal 50%×14% of a 44.7px-wide phone
tile's art would be a few pixels tall, too short to hold even the smallest legible type.
`font-size` is `max(11px, 12cqi)` for the same reason on the text itself — `cqi` (the
tile's own container-query inline size, the same unit family the stepper threshold below
already uses) lets the digits grow with the tile, and the `11px` floor is this app's
original fixed badge size, so the smallest tiles never render text smaller than the
badge already shipped with.

**It stops at the frame's own bottom edge rather than spilling past it — the one place
this adapts rather than copies the reference exactly.** The real game's card has nothing
below its art to collide with; this app's tile has two always-visible stepper buttons
directly under the frame, and a badge sized to hang past the art the way the reference's
does would cover part of them. `.card-tile__frame`'s existing `overflow: hidden` is what
enforces the stop — measured, at every tile size the badge's bottom edge sits flush with
the frame's, never past it and never overlapping the stepper row.

**The shape is a subtle, `inverted` trapezoid, not a plain rounded rectangle** — read off
the reference's own pixels rather than assumed from "game badges are pills". A horizontal
scan of the badge's black outline at several heights measures the top edge (nearest the
art) at ≈92px and the bottom edge at ≈88.5px across a ≈90px-wide badge: a real taper,
wider at the top, but only about 2% inward per side from top to bottom — not the
dramatic wedge "isosceles trapezoid" suggests taken on its own. `clip-path: polygon(...)`
on `.card-tile__badge` reproduces that ratio, with each of the four corners chamfered
rather than right-angled: a straight-edge polygon cannot round a corner the way
`border-radius` does, and a chamfer reads closer to the reference's rounding at this size
than a sharp corner would. (The totals grid's badge is unaffected — same class, same
shape — since the reference's card is what both grids' badges are modeled on now, not
only the entry grid's.)

**The text is white with a black outline, not `--on-gold`, this app's usual accessible
ink for the gold gradient.** A horizontal scan straight through the reference's "×2"
glyphs reads, in order: gold badge fill, a near-black stroke, near-white glyph fill,
near-black stroke again, gold fill in the gap between the two strokes of the "×", then
the "2". `-webkit-text-stroke` draws that outline; `paint-order: stroke fill` keeps it
from painting over the fill and thinning it. This is not a step away from the
`--on-gold`-everywhere-else habit so much as a different route to the same goal: a thick
dark outline around light text is the standard game-UI answer to needing text legible
against a background that varies — the same problem `--on-gold`'s measured 4.5:1 solves
for a single, known gold gradient. `aria-hidden` exempts the badge from needing an
accessible *name* either way, not from needing to be readable by the sighted eye that
lands on it. Font weight is 800, a step above this app's usual 700 for bold UI text —
also read off the reference, where the digits sit visibly heavier than that.

Measured in Chrome against the real stylesheet, both themes, at the app's own reference
tile sizes: **no clipping, no overflow, no overlap with the stepper row, at any of
them** — 33px and 44.7px of content (the floors engage; badge reads legibly at a fixed
24×16 and 11px type), 79.7px, 104px, 175.3px and 250px (the proportional 50%/14% values
and the measured taper both apply cleanly, and the floors have no effect).

### Row counts on the trade suggestions

An **Options** select at the **bottom** of the section, defaulting to **5** (5 / 10 / 20 / All),
with the pager beside it. The choice persists at `coc:tradePairLimit` (the key kept its old name;
see the note below), the same way every other row limit in the app does, and the same `paginate()`
/ `parseRowLimit()` / `RowLimitSelect` / `Pager` machinery does the work — see [Row counts and
paging](shared-data.md#row-counts-and-paging).

**The limit counts rows (individual swap options), not pairs.** It used to count pairs instead — a
limit of 5 meant 5 *pairs*, however many options each one carried — on the reasoning that splitting
a pair across a page boundary would leave a continuation row with two empty Member cells at the top
of page 2, reading as missing data. That reasoning stopped holding once every row started naming
both bases on its own regardless of position (see "Both members named on every row" above), and the
gap between the two readings turned out to matter in practice: **reported live, a limit of 5 showed
well more than 5 rows**, because a clan's suggestion list is grouped by pair (`groupTradesByPair`)
and a pair with several legal options — two bases that can each legally swap more than one card —
contributes every one of those options to whichever page its pair lands on. One real example from
that report: the clan's first pair alone (two bases that could swap either of two card pairs) had 2
options, so "5 pairs" on the first page actually rendered 6 `<tr>`s — the pager said `5` and the
count line under it said `6 options on this page`, which is exactly the discrepancy that was
reported. `flattenTradePairs` (`web/src/card-trades.ts`) now turns the grouped pairs into a flat,
one-row-per-option list before paging, so the limit and the pager both operate on that flat list —
"5" now means at most 5 `<tr>`s, full stop, and a pair's options can land on either side of a page
boundary without anything reading as missing.

The `Options` label and the pager's `options` noun match the word the count line beneath the table
already used for a single row (`N options on this page`) before this change, so nothing new was
introduced — the control and the pager now agree with wording that was already there. The
`localStorage` key is unchanged (`coc:tradePairLimit`): a stored `5` was already accurate under the
old pairs-based reading in the common case where every pair on a page had exactly one option, and
staying on the same key means nobody's saved preference silently reset to the default the next time
they opened the page.

### How many trades could really happen

The panel used to say `N pairs could trade`, counting every base-pair with *at least one* legal
option. That overstated things: completing a trade spends a spare, and two pairs reaching for the
same spare cannot both go through — a base offering its one extra Barbarian to three different
partners is one trade, not three, however many rows list it as an option.

The line now reads `Up to N trades could happen at once`, where `N` is the size of the largest set
of candidate trades that could all complete together without any base running out of a card it
promised twice. That is a resource-constrained matching problem — `maxAchievableTrades` in
`web/src/trade-matching.ts` — solved by a **greedy approximation, not an exact solver**: the exact
algorithm for this shape of problem is a blossom-style search, the general-graph relative of
ordinary matching, because a base's spare of one card can be contested by trades with several
different partners rather than being confined to two sides of one relationship the way a bipartite
problem would be. Implementing and proving a blossom solver correct is disproportionate machinery
for a hint line here, so the module runs a dynamic most-constrained-first greedy instead, and its
own tests check that greedy against brute force on small cases — including one built specifically
to demonstrate the known worst case (half of the true maximum) — so the gap is measured, not
assumed away.

**Pairs and options are ordered by achievability first, rarity second.** A pair with an option that
is part of the achievable set sorts ahead of one whose every option would cost a conflicting trade
elsewhere, and within one pair's own block of options, the achievable ones come before the ones
that are not — `sortTradesByAchievability`, layered over `suggestTrades`'s own order the same way
`sortCardTotalsForDisplay` layers over `cardTotals()` (see [A sort control,
opt-in](#a-sort-control-opt-in)). The previous ordering was rarity alone — the single rarest card
either side would give away, descending — and that is still the tiebreak within each group, so a
scarce, time-sensitive trade still surfaces near the top of whichever group it lands in.

### The site is always optimizing for achievable trades — a priority mode only changes the order

A `Priority` select sits in the filter row above the table, beside the owner pickers and Clear (or
alone, on a single-owner account, where the owner pickers never render at all). It offers three
states, `web/src/trade-priority.ts`:

- **Optimal** — the default, and exactly the achievable-then-rarity order described above,
  unchanged.
- **Fewest partners** — ranks a pair by how many of its own options are currently achievable,
  descending. A partner who can complete several trades at once outranks one who can only complete
  one, so working down the table in this order opens the fewest distinct trade windows for the same
  amount of value moved — the problem this mode exists for: a member with several achievable trades
  scattered across many different partners otherwise has to jump back and forth between the same few
  bases as the table's default order interleaves them by rarity.
- **Highest value** — ranks a pair by the rarest card either of its own trades would give up,
  *regardless of whether that trade is achievable right now*. For someone who would rather go after
  a specific rare card even if it cannot complete this instant.

**No mode ever stops the table from being about achievable trades.** This is worth stating
explicitly, because it is easy to misread "Fewest partners" or "Highest value" as opting out of the
achievability matching described above — they do not. `sortTradePairsForPriority` only reorders the
pairs `sortTradesByAchievability` already produced; it never changes which trades are in the
achievable set, never changes the `Up to N trades could happen at once` count, and — because
`Array.prototype.sort` is stable — every mode falls back to that same achievable-then-rarity order
wherever its own key ties. **Optimal, achievable trading is the invisible second ordering mechanism
under every priority mode, not a fourth option you can turn off.** The same layering discipline
`sortTradesByAchievability` itself uses over `suggestTrades`, and `sortCardTotalsForDisplay` uses
over `cardTotals()` (see [A sort control, opt-in](#a-sort-control-opt-in)) — a reordering step that
sits *after* an already-correct order and never weakens what that order guarantees.

The choice is remembered per browser at `coc:tradePriority`, the same `localStorage` mechanism as
every other display preference on this page, and shared by both places `TradeSuggestions` renders
(the card page and a player page) — one preference about how a member likes to trade, not a
per-page setting.

## The collection leaderboard

Every tracked base, ranked by how far it has got, directly under the trade suggestions — because
"who should trade with whom" and "who is furthest ahead" are the same question asked two ways, and
the base near the top with spares is the one worth messaging. Member name, tag, owner, points, cards,
copies and **last updated**; the `17/60` is printed and a `.meter` bar on the sequential blue ramp is
a second telling of it, never the only one.

That is the **Overall** board — the one that existed before a **View** picker sat above the table
offering six more. Everything below through [Last updated, and the Owner
filter](#last-updated-and-the-owner-filter) describes Overall specifically; the other six boards,
what each one measures, and the picker itself are in [Seven boards: the View
picker](#seven-boards-the-view-picker) below. The Rows select, the Owner filter and the pager are
shared machinery every board reuses unchanged — described once here rather than seven times.

**A Rows select at the bottom of the table**, defaulting to **5** (5 / 10 / 20 / **50**), persisted
at `coc:cardStandingLimit`. No `All`: 50 already covers every tracked base with room to spare, so
it would be a second name for the option next to it. Same helpers as every other paged table.

**The measure is points**, awarded per card by how many copies a base holds — `cardPoints()` in
`card-standings.ts`:

| Copy | 1st | 2nd | 3rd | … | 10th | 11th and beyond |
|---|---|---|---|---|---|---|
| Worth | 10 | 9 | 8 | … | 1 | 1 each |

So a card held once is 10 points, twice 19, three times 27, ten times 55. Summed over the sixty,
a complete set at the cap is **3,300**. The curve means the first copy of a card you lack is worth
ten times the eleventh copy of one you have, so breadth outweighs hoarding — while spares still
count, because spares are what make a trade possible at all.

The beyond-ten arm is **deliberately unreachable today**: `MAX_CARD_COUNT` caps entry at ten, so
nothing can score it through the interface. It is implemented so that raising the cap cannot
silently change what a base scores, and a test pins it.

The order, in `baseStandings()`:

> **points descending, then distinct descending, then member name, then tag.**

Distinct breaks a points tie because reaching the same score across more of the sixty is the
better position — and points ties are real, not hypothetical: 54 is reachable both as one card
held nine times and as two cards held three times each. The name and tag are not merit at all.
They are there to make the order **total**, so two level bases render in the same sequence every
time rather than swapping places between renders; a test runs the same bases in reversed input
order and asserts an identical result.

The **rank number** is shared on a genuine tie and then skips (1, 2, 2, 4). Tied means level on
**points**: two bases separated by nothing but their names, or by which cards made up the same
score, have not out-scored one another and must not print as 4th and 5th.

The row prints the score *and* `17/60`. Either alone misleads — a bare score does not say how far
through the sixty a base is, and the fraction no longer explains why one row outranks another.

**Paging never renumbers.** The rank comes from `baseStandings()`, computed once over the whole
board, so page 2 opens at rank 6 and reads 6 — numbering the visible rows instead would restart at
1 and turn the one column that means something into a row counter. Read back off the DOM: page 2 of
the default 5-row view shows ranks `6, 7` under `Showing 6–7 of 7 bases`.

A base **nobody has ever saved** stays on the board, last, and says `Nothing recorded yet` rather
than printing `0/60` — the same distinction the grid's attribution line draws. Sixty zeroes
presented as data would be a claim nobody made.

### Last updated, and the Owner filter

The last column is **when this base's counts were last saved**, as a relative age — `5 days ago` —
with the exact moment on the cell's `title`. Relative is what a column is scanned down; the exact
timestamp is what you check once you have found the row, so it is one hover away rather than gone.
The same pair the footer's build stamp and the attribution line above the grid already use, and the
same `parseStamp` guards all three. The stamp comes from `card_base_updates` (migration v5), which
is why a base **cleared back to zero still carries one**: the counts are sparse, so a stamp derived
from them would vanish for exactly the base most likely to prompt "when did we last check this?".

**`Never` is a state, not a formatter falling over.** A base nobody has ever entered counts for has
no stamp at all — and v5's backfill is explicit that a base emptied before that migration has
nothing to recover — so the column decides `Never` from the absence and prints it in the muted
`.role-pill` the Owner column uses for `no owner set`. It is the most useful value in the column,
which is the opposite of something to render as `Invalid Date` or leave blank. A stamp that is not a
date at all keeps its raw text, exactly as the attribution line does with the same value: the base
*was* saved, so `Never` would be the worse of the two lies.

An **Owner select above the table** narrows which rows are drawn. Its options are the owners
**actually on the board** — so every option keeps at least one row — with `Everyone` as the default,
so the board still opens on the whole clan. A base whose owner is an unlinked legacy label is
listed under that label like anybody else, and only a base with *no assignment at all* falls under
`No owner set`; that is the same line `mayWriteBaseCounts()` draws between `ownerNotLinked` and
`unowned`, and neither the column nor the filter grants anybody a permission. The select is not
drawn at all when it would offer one owner, for the reason the density control is not: an option
that cannot change what is on screen is a control that answers a press by doing nothing.

**The filter never renumbers, either.** `filterStandingsByOwner()` takes the board `baseStandings()`
has already ranked and only removes rows, so an owner's four bases read 3, 7, 12 and 19 — their
places among every tracked base — rather than 1 to 4. Ranking the survivors would be a leaderboard
of one, which is the thing this board must not become. Pinned by a test in `card-standings.test.ts`
and again off the DOM in `CardsView.test.tsx`. Narrowing the board can leave the page number past
the end; that is the clamp `paginate()` already reports and the leaderboard already follows for a
base that lost its owner assignment, extended rather than duplicated for this second cause.

The choice is **transient**, unlike the row limit: a filter that survived a reload would open the
page on a board with most of the clan missing and no memory of having asked for that. And if the
chosen owner leaves the board — a reassignment landing on the thirty-second background re-read —
the select falls back to `Everyone` rather than showing a value it has no option for over an empty
table, which is `activeTag()`'s reasoning applied to a filter.

**Why this exists at all**, since it overturns what this page used to say: the board is still
group-wide by default and the **Mine/All picker still does not touch it**. But "which of my bases
has nobody entered counts for lately" is a maintenance question, not a ranking one, and the only
place that fact was shown was the attribution line for the *selected* base — one at a time, behind a
`<select>`, with the reader left to remember what each said. The column plus this filter is that
same fact for every base at once.

### Seven boards: the View picker

A **View** select at the top of the leaderboard table (`CardsView.tsx`, styled like `RowLimitSelect`
and the totals panel's own `#card-total-sort`) switches between seven rankings, in this fixed order:
**Overall**, **Rarity**, **Full rows**, **By category**, **Full decks**, **Spares on hand**,
**Most active trader** — the whole-collection boards first, then the ones scoped to a narrower
slice (a single deck, a spare threshold, trading activity). The choice is remembered per browser at
`coc:cardLeaderboardView`, the same mechanism as `coc:cardStandingLimit` and `coc:cardTotalSort`.

Every ranking is a pure module beside `card-standings.ts`, computed from the same `bases`/`inventory`
already on the page (plus, for the trader board, the Trade Tracker's own `trades`) — nothing is
re-fetched when the picker changes. Each returns rows carrying a **shared-and-skipped `rank`**, the
same convention `BaseStanding.rank` uses: tied on the board's own measure, ties share a number and
the next rank skips ahead. `categoryStandings()` did not carry a `rank` when it was first written,
on the grounds that array position was enough; it does now, added for this picker on the same
reasoning every sibling module already had — see `category-standings.ts`.

**The table is per-view, not one universal shape.** `LeaderboardTable` draws Rank, Member and Owner
identically for all seven — the same accessible-naming, `roster--stack` phone behavior and
`stack-title`/`data-label` markup `card-standings.ts`'s original table used — and each board supplies
its own columns beyond that:

| Board | Columns beyond Rank / Member / Owner | Measure |
|---|---|---|
| Overall | Points, Cards (`n/60` + meter), Copies, Last updated | Points — see above |
| Rarity | Rarity score, Cards (`n/60` + meter) | Sum of `rarityPoints()` over distinct cards held, weighted by clan-wide scarcity right now |
| Full rows | Full rows (`n/10` + ten fill marks), Longest streak, Score | `fullRowCount × 10 + longestStreak × 5` over the real game's six-wide rows |
| By category | Cards (`n`/deck size + meter), Points | Distinct cards held **within the chosen deck**, computed separately per deck; points only break a tie |
| Full decks | Decks complete (`n/4`), Which decks (chips), Distinct cards | How many of the four decks are held outright |
| Spares on hand | Spares, Spare variety | Tradeable spares (copies beyond the one kept) summed across all 60 |
| Most active trader | Completed trades, Distinct partners | Completed trades a base was party to, from the Trade Tracker |

**By category has a second picker.** A **Deck** select appears only while "By category" is active,
in the same filter row Owner already occupies (`Leaderboard`'s `filters` slot) — Elixir, Dark Elixir,
Builder Base, Super Troop, defaulting to the first and remembered separately at
`coc:cardLeaderboardCategory`, so switching away and back does not lose which deck was open. Unlike
the other six, "By category" is really four independently-ranked boards; `categoryStandings()`
returns all four at once, keyed by category, and the picker selects which key's rows to show.

**Unlike every other board here, "By category" ranks by distinct cards first and points only as a
tiebreak — the reverse of Overall's order.** Confined to one ~19-card deck, points can disagree
outright with "how close is this base to finishing the deck", not just tie at the margins: a base
sitting on several spares of a few cards can out-point a base one card short of a clean deck, while
being the base further from finished. `category-standings.ts` has the full reasoning and the
reported case that prompted it (2026-08-11): an 18-of-19 base outranking a 19-of-19 one on points
alone.

**The Rows select, Owner filter and pager are the same instance across every view**, not reset when
the picker changes — `Leaderboard` is one generic component parameterized by the active board's row
type and column list, so "how many rows" and "which owner" stay put while "which board" changes
underneath them. Only the Deck sub-picker is per-board, since it has no meaning outside "By
category." Every board's table gets its own `aria-label` (`Rarity leaderboard`, `Elixir leaderboard`
for the currently-chosen deck, and so on) — Overall keeps the original `Collection leaderboard` name
unchanged, so nothing that already looked it up by that name broke when the picker shipped.

**The explanatory paragraph above the table, and the "How this board scores" disclosure below it,
are both conditional on the active view.** Overall's paragraph and its `ScoringRules` disclosure are
verbatim what they were before the picker; the other six each get their own short paragraph and their
own rule component in `help-copy.tsx` (`RarityScoringRules`, `CategoryScoringRules`,
`RowScoringRules`, `DeckCompletionScoringRules`, `SpareScoringRules`, `TraderScoringRules`) — reused,
unchanged, on the help page's `leaderboard` section, so the app never states a board's rule twice.

## Getting about the page

The page is long — with a base selected, the entry grid alone measures **1194px at 390px wide**,
which is 1.4 phone screens before the first panel anybody scrolled down for. So there is a row of
jump chips under the controls, and an up arrow in the corner of each section it can land on.

```
CLASH OF CARDS   Show [Mine v]  Base [Alda v]  Find [        ]
                 ( Suggestions ) ( Tracker ) ( Leaderboard ) ( Totals )
```

**It reads as a second line of the header's tools, right-aligned to the same edge** — but it is a
*sibling* of `.card-header`, not a fourth child of `.card-header__tools`. Breaking a line inside the
tools would mean `flex-basis: 100%` on a child of a shrink-to-fit flex item, which moves `Show`,
`Base` and `Find`; and at 1280px it would cap the row at the tools' 414px rather than letting it use
the card's full width. The alignment falls out of the header being `justify-content: space-between`
— the tools are flush to the card's content edge, and so is a full-width row's `flex-end`. Measured,
the last chip's right edge and the tools' right edge are the same number: **1239px at 1280px, 363px
at 390px**.

At 390px the header itself wraps — `.card-header { flex-wrap: wrap }` in the `600px` block — and the
tools take the whole second line, so "right-aligned under the tools" and "the width of the card"
are the same edge there. The chips still sit on **one 44px line**; right-aligning changes where they
sit on the line, not how many lines they need.

**Four chips in page order, and the fourth is hidden where it will not fit.** Suggestions, tracker
and leaderboard are the order those sections are rendered in, so the row reads as a map of what is
below rather than as a ranking; `Totals` comes last. An earlier revision led with `Leaderboard` on
the grounds that it is what people open the page for — tried, then reversed, because a row whose
order disagrees with the page teaches nothing about where anything is. The order and the one-word
labels are pinned by a test, since both are decisions that would otherwise read as accidents.

**`Totals` disappears below 480px, and 480 is measured rather than picked.** Sweeping the real
markup in Chrome at 2px steps from 320 to 1000: four chips need **372.8px** of line; the card offers
the viewport less 52px of shell and card padding at that end; the row is two lines from 320px up to
**426px** and one line from **428px** upward — identically with a coarse pointer, so the constraint
is width and nothing else. The rule sits at 480 rather than 428 because 372.8px is *this* platform's
font metrics and chip widths travel with them; 480 leaves 429px of content against 372.8 needed,
about 15% of slack, where 428 would leave none.

Neither existing breakpoint was right. `600px` never wraps, but would drop the chip across 428–600px
where four demonstrably fit (one line at 500 and at 600) — every small window and portrait tablet
losing a chip for nothing. `900px, (pointer: coarse)` is wider again, and its coarse arm would hide
`Totals` on a large touchscreen with room for ten of them, which answers a question about input with
a rule about width.

**The chip is always rendered; the hiding is `display: none` in CSS.** Not `visibility`, not
`opacity` — the chip has to leave the accessibility tree rather than stay focusable while invisible.
That also means **jsdom does not exercise it**: the component tests see four buttons at every width
and assert the DOM and the ordering, while the browser measurement owns whether the row is one line.
Faking a viewport in jsdom would be a test asserting a layout it cannot see.

**One trap, and it cost a wrong "done".** Written as a bare `.card-jump__wide { display: none }` the
rule did nothing: `.chip` is declared again ~2,500 lines further down inside
`@media (max-width: 900px), (pointer: coarse)`, setting `display: inline-flex` for the touch target.
Equal specificity, later rule wins — so at 390px the media query matched, the rule was in the sheet,
and the computed display came back `flex` with all four chips still showing. Nothing about the CSS
looked wrong; only measuring caught it. It is now `.card-jump .card-jump__wide`, which outranks
`.chip` on specificity rather than on position and cannot be undone by a fifth `.chip` block landing
below it.

**The totals section keeps its back-to-top arrow at every width.** On a phone it is the one section
with a way back and no way down, which is the right way round for the bottom of the page.

**Known: below 354px even three chips wrap** to two rows and 96px — measured two lines from 320px to
352px. That is narrower than any current phone in portrait (390px here, 375px for the smaller
iPhones) but it is reachable by zooming, and it is the one width band where the row is not a single
line. Left as it is rather than papered over: fixing it means either a second hidden chip or shorter
words, and both are decisions rather than adjustments.

**The chips are buttons, not `href="#cards-leaderboard"`.** The hash is spent on the router.
`parseHash` splits it on `/` and matches the first segment, so a bare fragment is an unknown route
that resolves to `home` — which unmounts the card page to render the home page. Worse quietly:
`routeToRemember` keeps any non-blank hash, so the fragment is persisted as the last route and
restores to home on the *next* sign-in. Both were run against the real modules rather than reasoned
about. `help.ts` hit the same wall and answered it with a path segment (`#/help/<section>`);
`#/cards/<section>` is available here too and was not taken, because the ask is in-page scrolling
rather than shareable addresses, and it would mean widening `parseHash` — a file with no error
boundary above it — for a convenience nobody asked for.

**Every jump moves the caret, not just the view.** The target headings carry `tabIndex={-1}` for no
other reason, and the jump calls `focus({ preventScroll: true })` after the scroll — the same
pairing, for the same reason, as the help page's deep links. Scrolling alone would leave a keyboard
user's focus at the top of the page for a chip and at the bottom for an arrow, with the thing they
pressed now a whole document away.

**A chip scrolls its heading; an arrow scrolls the window to 0.** The two branches of
`jumpToSection` differ because `cards-top` is a heading *inside the first card*, about 120px down
the document — `.shell`'s 24px of padding, the banner and its 20px margin, then the card's border
and 20px of padding. `scrollIntoView` on it did exactly what it says and stopped with the banner
off-screen and the card looking beheaded, which is what "the arrow doesn't go quite high enough"
turned out to mean. The heading stays the *focus* target, which is the only reason it is an anchored
section at all; scrolling the window **instead of** focusing would be the trap the paragraph above
describes, and scrolling the window *and* focusing is not. The distinction is invisible in jsdom and
in a screenshot, so a test asserts a literal `top: 0` and no element scroll at all on that press.

**Smooth by default, instant for anybody who asked for less motion.** `scrollBehaviorFor()` in
`card-sections.ts` is a boolean in and a `ScrollBehavior` out, so the rule is a line a test holds
rather than a ternary in JSX; the query is read at press time, since it is one decision per click
with nothing to keep in sync. Note that the help page's own scroll is still unconditionally smooth —
a known gap, left alone deliberately rather than fixed in passing.

**The arrows are named for what they leave**, as `Back to top, from Trade tracker`, because four
controls all reading "Back to top" are four indistinguishable rows in a screen reader's list. The
glyph is `aria-hidden` with the words in a `.visually-hidden` span — the `HelpLink` pattern, not an
`aria-label`, which over a text node can leave `↑` in the accessibility tree. The name comes from
`card-sections.ts` in sentence case and never from the heading beside it: those are
`text-transform: uppercase`, and Chrome computes the accessible name *after* the transform, which is
how the leaderboard table once ended up called `COLLECTION LEADERBOARD`.

The arrow makes its heading a flex row so `margin-left: auto` can push it into the corner. Measured
before and after against the real markup: the heading grows from 28.9px to 54px at 390px and to
45.5px at 1280px — the arrow is a 44px touch target on a phone — and the inline `?` beside the three
headings that have one shifts right by **1.5px**, which is the literal space becoming a 6px flex
gap. No horizontal overflow at either width.

## Cards across the clan

The **last** panel, and an expandable one: the same 60-tile grid as above, every tile carrying the
copies held across **every** tracked base as a small badge in its lower-right corner — exactly where
the per-base count badge sits. Collapsed by default, and its summary line carries the headline —
`All 60 cards, in grid order · 38 nobody holds` by default, or `All 60 cards, sorted highest to
lowest · …` once the sort control below is used (see
[A sort control, opt-in](#a-sort-control-opt-in)).

**Every tile is a button, and pressing one lists the bases holding that card** in a table under the
grid — see [Who holds a card](#who-holds-a-card). The badge says a trade is arithmetically possible;
the table says whom to message, which is the only reason to be reading this panel.

**It is the grid, not a list.** It was a two-column list of `.meter-row`s; a grid is what makes it
readable against the tiles above, because "the same picture in the same place" needs no
translation. That is not a claim about two similar components: `CardTile` in
`web/src/components/CardTile.tsx` **is** the tile, and `BaseCardEditor`'s entry grid and this one
are its two callers — same art, same framing, same deck-colored frame, same grayscale.
Re-measured in Chrome against the real stylesheet, at the six columns the grid is fixed to: both
render **191.3px tiles over a 175.3×219.2 (4:5) frame at 1280px**, 87.7px tiles at 600px and 52.7px
at 390px, tile for tile the same width in both grids at every one of them. (An earlier note here
said seven columns of 123px at 1280px and three columns at 390px. That was true of the `auto-fill`
grid it was written against; the column count has since been fixed at six, with the density control
on the card page — 6/8/10/12 — the only thing that changes it, and it changes both grids together.)
What the two callers vary is only the badge, what sits under the frame (the entry grid's count row,
or nothing) and where the accessible name comes from.

**`CardTile` itself is still not a control.** The press is a `<button class="card-total__pick">` that
this panel wraps each tile in, not a click handler inside the tile — so the entry grid, whose tiles
hold their own `−` and `+` under the frame (a button inside a button is not markup a browser keeps),
is untouched, and the pressable version gets keyboard
activation, focus, the focus ring and a real pressed state from the element rather than from
attributes. `.card-deck` is `display: contents`, so the button takes the tile's place as the grid
item; it is `display: block; width: 100%` with the browser's button chrome removed, and the tile
inside still draws the border, background and padding. A button is inline-block by default, which
would shrink-wrap and leave the tile narrower than its column — that pair of declarations is what
keeps the swap invisible, and it is the thing to check in a browser if the columns ever look wrong.

**By default, the order is fixed by design and never changes with the counts.** It comes from
`cardsInGridOrder()`, which is literally the grid's own two calls — `cardCategoriesInOrder()` then
`cardsInCategory()` — rather than a second ordering that agrees with it today and drifts the next
time the manifest is regenerated. The whole reason the panel earns its place is that it can be
scanned tile-for-tile against the grid above it, so **`cardTotals()` itself never sorts by count, in
any mode** — that is still an unconditional property of the function. That is asserted directly: a
test puts all the copies on the *last* card and none on the first and checks the output order still
matches the input's. And read back off the DOM at the default sort: the two grids' 60 tiles, compared
by name in document order, match card for card at 390, 600 and 1280px.

### A sort control, opt-in

The panel also carries a small `Sort` select, styled like the row-count controls elsewhere on this
page (`.row-limit`) rather than the multi-column `SortControl` the stacked tables use — there is only
one sortable value here (the clan-wide total), so a three-option dropdown is the whole control:
**Grid order** (the default above, unchanged), **Highest to lowest**, and **Lowest to highest**, both
of the latter by `total` from `cardTotals()`.

This is a **deliberate, acknowledged reversal** of the "nothing sorts by count" reasoning two
paragraphs up — asked for on this specific panel, not a quiet drift away from it. The reversal is
scoped tightly on purpose:

- `cardTotals()` in `card-standings.ts` is untouched and still never sorts, for every caller. The
  reordering happens afterward, over a copy of its output, in `sortCardTotalsForDisplay()` —
  `web/src/card-total-sort.ts`, pure and tested on its own — so the invariant the entry-grid
  comparison depends on is not weakened, only opted out of by one panel when asked to be.
- Ties keep their grid position in either ranked mode (`Array.prototype.sort` is stable), so two
  cards level on total do not reshuffle between renders.
- **Grid order is still the default on first load**, and the panel says so out loud whenever it is
  not: the summary line and the explanatory paragraph both name the active sort, so a reader who
  left it ranked from a previous visit is told the tiles no longer line up with the grid above,
  rather than left to notice the mismatch on their own.
- The choice is remembered per browser at `coc:cardTotalSort` — the same `localStorage` mechanism as
  the row-count and column-density controls elsewhere on this page (`coc:cardStandingLimit`,
  `coc:cardColumns`), not the server: nobody else's view of the shared data should change because one
  reader wanted the grid ranked.

**The badge appears on every count, including 1** — the opposite of the entry grid, where `×1` on
fifty tiles is noise. Here the totals *are* the point, and a card exactly one person in the clan
holds is one of the more interesting things on the page.

**Every tracked base is counted, linked to an account or not.** Most assignments in this install
are still free-text labels; their cards are as tradeable as anyone's, and excluding them would
undercount the group by more than half rather than describe a smaller one.

**A card nobody holds is grayscale with no badge, and the words carry it.** That visual state is a
color cue plus a *missing* cue, which is not enough on its own, so every tile has an explicit
accessible name — the tile is a `role="img"` with an `aria-label`, since nothing *inside* it is a
control that could carry one:

```
Barbarian, Elixir — none held across the clan
Archer, Elixir — 3 held across the clan
```

The same sentence is on each tile's `title`, and the summary line above counts them. That label is
also **what names the surrounding button**, by name-from-content, so the control has one name rather
than a second one competing with the picture's — read back through the accessible-name computation
in the component tests, which find each tile as `button` / `Archer, Elixir — 3 held across the
clan`, and the pressed state rides on `aria-pressed` beside it. The tile **does not move**: card 1
is the first tile in grid order and nobody holds it, and it stays first.

Each deck is a `role="group"` labeled by a `.visually-hidden` heading exactly as the entry grid's
`.card-deck` is, with its own `card-total-deck-*` ids — both grids are mounted on this page at once,
so the ids cannot be shared. **Only in Grid order.** The sort control below can reorder these tiles
by clan-wide count instead (see "A sort control, opt-in"), and once that happens the four decks are
no longer contiguous — grouping by deck stops making sense, and stops happening: a sorted view is a
flat sixty-tile list, no `role="group"`, no heading. This is not just a display choice; grouping by
*consecutive* deck while the order can be non-deck-contiguous was the exact bug this app shipped and
fixed on 2026-08-08 — several sibling groups ended up sharing one `key={deck.category}`, and React's
handling of a duplicate key among siblings is what produced tiles appearing to pile up under a
previous sort instead of replacing it.

It stays **collapsed** because sixty more tiles left open would push everything above them off a
phone. It costs no extra art either way: measured, its sixty image URLs are byte-for-byte the entry
grid's, so opening it adds no requests, only the drawing.

### Who still needs a card

Pressing a tile opens a section **under the grid**, headed by the card's name and its art. The
first thing in it, before "who holds it", is a list: the reporting bases that do **not** hold the
pressed card, by name.

```
[art] Barbarian   Elixir · 6 held across the clan
3 bases still need it:

Member
Cyd   #CCC
Dana  #DDD
Evan  #EEE
```

**Leads, rather than following "who holds it" — moved here directly, after shipping it the other
way round.** It rendered *under* the holders table at first, and was reported back within the day
as reading like it was missing rather than merely second: pressing a tile is usually about finding
somebody to trade *toward* — who still needs this — before it's about finding somebody to trade
*from*, so the list answering the more common question now comes first. Requested in the first
place, directly, on the app's own [Propose a change](#/change-requests) page, by a clan member who
wanted to see which bases still needed a card rather than only how many. `cardDemand()`'s `needing`
count has been on the page since the panel shipped, in the third clause of the summary line the
holders table below carries; this is the names behind that number, which nothing on the page could
previously show — the bases it counts are precisely the ones with no row in the holders table, so
no amount of scanning that table finds them.

**Its own function, `basesNeeding()` in `web/src/card-holders.ts`, sibling to `cardHolders()` and
`cardDemand()` in the same module.** It is not a filter over `cardHolders()`'s output, because there
is nothing to filter *out of*: counts are sparse, a count of 0 deletes the row, so a base holding
none of a card has no row anywhere to begin with. It scans the same way `cardDemand()` does —
`!countMap(base).has(cardId)`, never `count === 0`, which would find nothing and report that nobody
needs anything.

**Sourced from `bases`, the same reporting-only array `cardHolders()` and `cardDemand()` read, not
the full tracked roster.** `useBaseLabels()` unions the owner assignments in elsewhere on this page,
and a base nobody has ever entered has not told us it lacks the card — listing it as needing one
would invent a demand out of missing data, the same reasoning `cardDemand()`'s own `reporting` clause
documents below. The list is guarded on `bases.length > 0` for the same reason: with no reporting
bases at all there is nothing to claim either way, so neither the list nor its empty-state sentence
renders.

**Independent of whether anyone holds the card at all.** A card 38 of the sixty are in — nobody holds
it — is exactly the case where "which bases still need one" is every reporting base, and arguably the
most useful reading on the panel; the list does not nest inside the holders table's branch below and
renders the same way whether that table or its own "nobody holds it" sentence is showing underneath.
That is also why it leads: the holders-table section can be entirely a "nobody holds it" sentence
with no table at all, while this list still has real rows to show in exactly that case.

**One column, not three.** `CardHolder` carries `count` and `canSpare`; a base that holds none of the
card has neither, so `CardNeeder` carries only `tag` and `label`, and the table this list renders as
has a single `Member` header rather than `Copies` and `Spare` columns that would always read blank.
Same row markup as the holders table below otherwise — `roster roster--stack`, `stack-title`, the
name linked to the player's page with the tag underneath — so a base reads identically in both
tables.

**Ordered by label then tag**, the same total order `cardHolders()` uses for its own tie break, but
with nothing to sort by first: every row here is "zero copies" by construction, so there is no count
to lead with the way the holders table's "most copies first" does.

**Everybody already holding it gets a sentence, not an empty table** — `Every reporting base already
holds it.` — the same empty-table-looks-broken reasoning the holders table's own "nobody holds it"
state uses, mirrored rather than reused verbatim: unlike that sentence, this one needs no second
clause explaining *why*, since "everybody already has it" needs no justification the way "trading
cannot conjure a copy" does.

**The holders table's summary line keeps its wording unchanged.** `holdersLine()`'s "N of M
reporting bases need it" clause was deliberately left as a pure summary rather than rewritten to
point at this list ("… — see above"): a screen reader reaching this panel's heading meets the list
on the way through regardless of which way the pointer would read, and the count-with-denominator
framing the line's own doc comment protects is left exactly as it was.

### Who holds a card

Under the "still needs it" list above, a second section, headed by the same card name and art:

```
2 bases hold it · 1 with a spare to trade · 3 of 5 reporting bases need it

Member          Copies   Spare
Brix  #BBB           5   Can spare one
Alda  #AAA           1   Its only copy
```

**Under the grid, not above it — and under the "still needs it" list, not above that either.** The
tiles are what the panel *is*, and a table inserted above them would push sixty tiles down the page
on every press, moving the tile you had just pressed out from under the pointer; see the previous
section for why "still needs it" gets the position closer to the tiles.

**No new endpoint, and no request.** `GET /api/cards/inventory` already returns every tracked base
with its per-card counts, and the page already holds it as `state.entries`, so this is a projection
of the same array the grid, the leaderboard and the trade suggestions are all drawn from. The
projection is `cardHolders()` in `web/src/card-holders.ts`, pure and tested: which bases hold a
given card, how many each, and whether that is enough to give one away. It counts through
`countMap` rather than re-reading `base.counts`, which is what makes the rows add up to the badge on
the tile — a zero, a negative or an id the generated list has never heard of is an absence in both,
and there is a test that pins the sum against `cardTotals()`.

**Rows are ordered most copies first**, then by member name, then by tag. That is not the grid's
rule being broken: "nothing sorts by count" is about tile *position*, because the grid earns its
place by being scannable card-for-card against the entry grid above it, and a list of holders has no
such counterpart. The question this table answers is "who could give me one", so the bases that can
are the ones at the top. Name and tag after that make the order **total**, so bases level on copies do not
swap places between renders — the same reasoning as the leaderboard's comparator, and a base no
roster names sorts under its `#` exactly as it does there.

**The `Spare` column is the point of the count.** A base never gives away its last copy
(`MIN_TRADEABLE_COUNT`, the same constant the trade suggestions and the server apply), so one copy is
a holding you cannot ask for and two is an offer — spelled out per row as `Can spare one` /
`Its only copy` rather than left as a comparison to make once per row. The line above the table counts
both: `2 bases hold it · 1 with a spare to trade · 3 of 5 reporting bases need it`, so "several bases
hold it and none of them can help you" does not need a scan of the column to notice.

**The third statistic is the one the table cannot be scanned for**, because the bases it counts are
precisely the ones with no row in it — they are the rows in the "still needs it" list above instead.
The first two answer "can I get one"; this is "who am I competing with", and on a card three of five
bases still want it means something different from three of thirty. It is `cardDemand()` in
`web/src/card-holders.ts`, beside `cardHolders()` and tested in the same file.

Two definitions are doing work in that clause, and both have a wrong answer that looks right:

- **"Reporting" is every base in `state.entries`**, which is every base anyone has *saved* this
  season. Membership of that array is the definition — the server returns a base if it has count
  rows **or** a stamp, so a base saved and then cleared back to zero is reporting and arrives with
  an empty `counts`. That is the same distinction `BaseStanding.recorded` draws for the
  leaderboard's `Never` column. It is deliberately **not** the *tracked* bases: `useBaseLabels()`
  unions the owner assignments in, and a base nobody has ever entered has not told us it lacks the
  card, so counting it as needing one would invent a demand out of missing data. A test pins that
  by putting an owner-assigned base with no inventory row in the fixture and checking the
  denominator does not move.
- **"Needs it" is an absent row, never a stored zero.** Counts are sparse and a count of 0 deletes
  the row, so a base that reported and holds none of this card has no row for it anywhere. An
  implementation looking for `count === 0` finds nothing and reports that nobody needs anything —
  which is why the count goes through `countMap` like everything else on this panel, and why the
  test for it uses a base whose only rows are for *other* cards plus one cleared to nothing.

The three numbers add up — the bases holding it plus the ones needing it are every reporting base —
and that is asserted rather than guaranteed, because `cardDemand()` scans instead of subtracting the
holder count. Subtraction would make the sum an identity that could never catch the two drifting
apart.

The zero stays numeric here (`0 of 2 reporting bases need it`) where the spares clause turns into
words (`none with a spare to trade`). The denominator is most of what the clause is for, and the
spares clause has no denominator to lose.

**A card nobody holds shows none of this line.** The whole line is replaced by the sentence below,
so the statistic is absent for the 38 of sixty in that state — the cards it would arguably say the
most about. That is a known gap and a deliberate one for now: the "still needs it" list's own
empty-state paragraph, above this section, is its own separate decision, and folding a fraction into
this line is a change to that sentence rather than to this one. That list above is unaffected either
way — it has real rows to show regardless of whether the holders table below has any of its own.

**The member is a link to that player's page**, with the tag as secondary text under the name, and
the name is `labelOf` from `useBaseLabels()` — the same resolver the picker, the leaderboard and the
trade tables use, so one base reads the same in all four.

**A card nobody holds is still pressable, and says so.** 38 of the sixty are in that state in this
install, and that was the decision worth making deliberately: the rule here is that a control is
never dead and never navigates nowhere, and `Nobody in the clan holds it. Trading cannot produce a
copy of a card nobody has — this one has to come from the game.` is an answer, arguably the most
useful one on the panel, since it is the one the badge cannot show. The rejected alternative was
tiles that respond only where a badge happens to be: that makes two thirds of the grid silently
inert with nothing to explain a press that did nothing, and hands a keyboard user a set of tab stops
that changes with the counts. There is no empty table either — headers over no rows read as broken,
so the sentence replaces it and the card's heading stays.

**Pressing the selected tile again closes the whole section**, "still needs it" list included, and
`aria-pressed` goes back to `false`. It is the control that opened it, so it is the one somebody
reaches for to put it away; without that the table could only ever be swapped for another card's.
`aria-pressed` rather than `aria-expanded` because there is *one* section and the sixty tiles take
turns owning it — sixty independent disclosures is not what this is — and only the pressed tile
carries `aria-controls`, since on the other fifty-nine there is no `#card-holders` to point at. The
selection is **never color alone**: the ring on the tile is `--accent` as a `box-shadow` *outside*
the tile (recoloring the border would cost the deck color, which is the only visible cue to which
deck a card is in), the state is on `aria-pressed`, and the card is named in words with its art
directly below.

The selection **survives the panel being collapsed and reopened**, deliberately: coming back to
find your card still chosen costs nobody anything, and clearing it would be a second way to close
a table the tile's own toggle already closes.

It **stacks like every other table** — `roster--stack`, `data-label` on each cell, `stack-title` on
the member, and the explicit `role="table"` / `rowgroup` / `row` / `columnheader` / `cell` that
survive `display` changing. Nothing in it sorts, so it needs no `SortControl`. It carries **no
pager**, unlike the two tables above the whole section: those are unbounded in pairs and bases, this
is at most one row per tracked base and in practice a handful, and truncating "who holds this" to
five rows would hide the base somebody opened it to find. Same for the "still needs it" list above
it.

## Mine / All on the base picker

A `Show` select to the **left** of the `Base` picker, filtering what the picker offers. A select
rather than a pair of buttons: it is the same control as the one beside it, it shows its own state
without being opened, and the phone rules already give it a 44px target and a 16px font. Its
accessible name, read off the computed accessibility tree, is `Show`.

**`Mine` means `ownerUserId`, never the owner label.** It is the same field the write rule
(`cardEntryAccess`) uses, so "mine" on the picker and "mine" on the grid cannot come apart — and
a free-text owner name that happens to match yours is a note about a person, not a base you may
write.

Four things it has to get right, all of them in `base-scope.ts` with tests:

- **the selection cannot point outside the list.** `activeTag()` keeps the chosen base while the
  filtered list still offers it and otherwise falls to the head of that list — so switching to
  `Mine` while reading somebody else's base moves the editor to your own first base rather than
  leaving counts on screen that the picker no longer offers. It is deliberately the *same* rule as
  the initial default, so there is one definition of "a valid selection" rather than a default and
  a repair that could disagree. Widening back to `All` carries the base you were reading with it.
- **`Mine` is the default only when the account actually owns a base**, otherwise `All`. Most
  accounts here own nothing, and defaulting blindly would open them on an empty dropdown over an
  empty editor. The check waits for the owner list to land first: an empty first snapshot would
  say everybody owns nothing.
- **an empty `Mine` says so in words**, naming the actual next step — a base becomes yours when an
  **admin assigns it to your account** — and pointing at `All`. The `Base` select is not rendered
  at all in that state rather than rendered empty. A stored `Mine` is honored even by an account
  that owns nothing, which is what keeps that message reachable: they asked for it.
- **the choice is persisted per account**, at `coc:baseScope:<userId>`, for the reason
  `coc:lastClan:<id>` is: one browser is shared, and one person's `Mine` is the other person's
  empty list. Verified in a browser — with `coc:baseScope:1` holding `all`, a second account
  signing in on the same profile still defaults to `Mine` and does not touch the first key.

**The leaderboard and the card totals ignore this filter entirely.** They are about the whole
clan's progress, and a *ranking* narrowed to one person's bases would stop meaning anything. The
leaderboard's own [Owner filter](#last-updated-and-the-owner-filter) is a separate control and a
different question — which rows to draw, for "whose bases have gone stale" — and it leaves the rank
each base holds on the whole board untouched.

## Deck progress plaques

How far a base has got in each of the four decks, drawn the way the event itself draws it across
the top of its own panel: one rounded plaque per deck, in that deck's color with a full-strength
rim, the deck named across the top in bold, and beneath it a bar — dark track, fill growing from
the left, **the fraction printed on the bar** — `Elixir Cards 7/19`.

**Where they are.** Two placements, both showing the same four numbers:

- **a player page**, full width, immediately under the panel's `Clash of Cards` title and
  **above** the `<details>` that holds the grid — so they are readable whether the grid is open or
  shut, which is the whole point of them. Deliberately *not* inside the `<summary>`: a summary's
  accessible name is its own contents, so four progressbars in there would rename the disclosure
  control from `Card grid · Trades available with 1 base` to a paragraph of numbers every time it
  was announced, and four block plaques would have to lay out around the marker glyph a summary
  draws. The summary keeps the **trade indicator**, which is now the only thing it says that the
  plaques do not;
- **the card page**, in the base header's upper right, directly beneath the
  `13/60 cards · 22 copies · 9 spares` line they break down. There they read off the live **draft**
  rather than the stored record, so they never disagree with that count while somebody is typing.

**Four across, 2×2 at ≤600px** — four in a row at 390px would be 75px each, narrower than the
words on them. The header placement reserves `34rem` beside the base name and lets the *name* take
its own line rather than squeezing the plaques, which is what keeps four across down to 601px with
no third breakpoint. Measured 320–1280px: names on one line at every width, no horizontal
overflow anywhere.

**The bar fill is the sequential blue ramp, not the game's gold.** The game fills these bars gold;
gold in this app is chrome — panel edges, buttons, the two display numerals — and has never encoded
a value. A gold bar whose length meant something would be the first, and it would spend the one
signal the palette has for "this is furniture, not data". The deck's own color was the other
candidate and is out for the mirror-image reason: `--deck-*` is *categorical*, it already says
which deck on the plaque wrapped around the bar, and reusing it for the bar would leave four bars
whose colors differ for a reason that has nothing to do with their lengths. So the plaque keeps
the deck color, the bar keeps `--accent` on `--track` like every other meter here, and **the
fraction is printed either way** — progress is never carried by a length or a hue alone. That last
part is the non-negotiable one; the choice between the three colors is a judgment call and this
is where it is recorded, alongside the same note in `DeckPlaques.tsx`.

The plaque is a *tint* of the deck color rather than a solid fill like the game's, because the
four tokens run from bright magenta to deep purple and no single text color clears 4.5:1 on all
four; tinting keeps the name and the fraction in `--ink`. The fraction sits over bare track on an
empty deck and over full-strength `--accent` on a complete one, so it carries a `--surface` ring
in `text-shadow` — the panel color `--ink` is already designed to be read on, in both themes.
The game outlines its numerals for the same reason.

**No resource icon** at the right end, unlike the game. The event's elixir, dark-elixir,
builder-gold and potion icons are not among the vendored art — `web/public/coc/` has card art,
league badges, labels and wiki unit art and nothing else — and an equipment gem standing in for a
resource would be a picture saying something untrue. The space goes to the fraction.

**A base with nothing recorded gets no plaques at all**, on either page: four `0/19` bars for a
base nobody has entered would be a claim nobody made. A base entered once and then **cleared back
to zero** does show four empty bars, because that is a base somebody checked. Same distinction the
card page's attribution line draws, and it comes from the same place — `summarizeBase().recorded`.

Each plaque's bar is a real `role="progressbar"` with `aria-valuemin` / `max` / `now` set and an
`aria-valuetext` of `7 of 19` (not `7/19`, which is read out as "seven slash nineteen"). Its
accessible name, read back off Chrome's computed accessibility tree, is
**`Elixir cards: 7 of 19 collected`** — deck, count and total, so nothing depends on seeing the
bar.

The shape is `deckProgress()` in `web/src/deck-progress.ts`, pure and tested: it pairs each deck's
`distinct` from `summarizeBase()` with its size from `cardsInCategory()`, clamps the bar, and
builds the two strings. It **recounts nothing** — that was the point of extracting it, since the
denominators had already been assembled once in the player panel and a second copy on the card
page would have been the third place a `7/19` could be built and the first place it could disagree.

## The same grid on a player page

A player page **is** a base, so it carries the card panel too — directly under the profile header
that holds the name and trophies, above the stat tiles. The panel's four deck plaques are always
on screen; the sixty tiles **and this base's trade suggestions** are a `<details>` below them,
**collapsed** by default, because sixty tiles unfurled there would bury the rest of the page. Shut,
the panel is the plaques plus one line:

```
EVENT CARDS · 2026-08
[Elixir Cards 7/19] [Dark Elixir Cards 2/13] [Builder Base Cards 2/11] [Super Troop Cards 2/17]
▸ Card grid · Trades available with 1 base
```

- **how far each deck has got**, as the plaques above;
- **whether a swap is waiting**, in words, with the status green as a second carrier and never
  the only one — `No trades available` reads the same with no color vision at all.

A base nobody has entered shows **no plaques** and reads
**`Nothing recorded yet — open to enter counts`**, not sixty zeroes dressed as data. That is the
same distinction the card page's attribution line draws, and it is why the panel keys off whether
a base has a record at all rather than off its totals: a base saved and then cleared back to zero
keeps its stamp and reads as recorded-and-empty.

**Opened it is the card page's grid, with no base selector** — the base is the player whose page
it is. Same tiles, same grayscale, same deck-colored frames, same `×n` badges, same
[count rows](#the-count-row), same one-request save, same 4 named deck groups. That is not a claim
about two similar components: `BaseCardEditor` in `web/src/components/BaseCardEditor.tsx` **is** the
grid, and `CardsView` and the player page are its two callers, and one tile of it is `CardTile`,
shared in turn with the clan-totals grid. Measured at 1280px, six columns of 191.3px tiles, a 10px
gap and a 175.3×219.2 frame per tile; 87.7px tiles at 600px and 52.7px at 390px. The one thing that
can differ is the *column count*, and only because the card page has a density control and this page
does not: the player page renders `DEFAULT_CARD_COLUMNS`, which is the six both are built around.
Duplicating sixty tiles and their draft-and-save logic was the thing to avoid — the grayscale, the
badges and the clamping would have drifted apart the first time either copy was touched. Choosing
the base is deliberately not the shared component's job; each page keeps its own idea of which base
it is about.

The **one** thing the two callers differ on is the deck plaques, which `BaseCardEditor` draws only
when asked (`showDeckProgress`, on for the card page and off here). A player page already has them
above the panel, where they can be read without opening it, so drawing them in the grid's header
too would print the same four bars twice on one screen.

**The trade hint needs the other bases**, because a trade is a pair. It comes from the same
module-level `card-inventory.ts` store the card page uses, so the player page costs **one**
`GET /api/cards/inventory` for every base — never one per base and never one per card — and it is
already warm if you arrived from the card page.

The counting and the predicate are one pure, tested function, `summarizeBase()` in
`web/src/card-summary.ts`. It does not re-implement the trade rules: it **calls `suggestTrades`**,
one pair at a time (the whole-list call is quadratic and computes every pair the panel will never
mention), so the hint cannot drift from the list on the card page. Its tests cover no cards, cards
in one deck only, a base holding spares with no counterpart, and a base with a genuine swap
available.

### The trades themselves, under the grid

The summary line has always said `Trades available with N bases`. Now the panel **shows them**:
the suggestions table sits inside the same `<details>`, directly below the grid, under a
`Trade suggestions` sub-heading. Same disclosure, so it opens and closes with the tiles — verified
by clicking the summary and reading `checkVisibility()` off the table, the heading and the grid at
390, 600 and 1280px in both themes: all three hidden shut, all three shown open, no second control
to find.

**Filtered to this base.** The table takes an optional `focusTag` and keeps only the pairs that base
is a side of. A clan-wide list under a heading counting *this* base's partners would contradict its
own summary line; filtered, the two are the same number. On a base with two partners and one option
each, the summary reads `Trades available with 2 bases` over a table of 2 pair blocks and 2 option
rows, one `Propose` per row, and the pager stays hidden below five rows.

Seeded with six partners, three of whom can each make two separate swaps rather than one — run
directly through `suggestTrades` / `groupTradesByPair` / `flattenTradePairs` / `paginate`, the same
functions the component calls: 6 pairs, 9 options in total, and the row-based limit of 5 (see [Row
counts on the trade suggestions](#row-counts-on-the-trade-suggestions)) puts the boundary **inside**
the third pair's block — its first option is the fifth row on page 1, its second is the first row on
page 2. The pager reads `Showing 1–5 of 9 options` on page 1 and `Showing 6–9 of 9 options` on page
2, and the page-2 continuation row still names both bases on its own (see "Both members named on
every row" in `TradeSuggestions.tsx`), which is exactly what makes splitting a pair across a page
boundary safe. Below five options in total, the pager hides itself, so a base with a couple of
partners shows no control at all.

**It is the card page's table, extracted — not a copy.** `TradeSuggestions` in
`web/src/components/TradeSuggestions.tsx` is now the third thing the two pages share, after
`CardTile` and `BaseCardEditor`, and it took `TradeCard`, `ProposeButton` and `BaseLabel` with it.
Naming a base moved too, into `useBaseLabels()` in `web/src/base-labels.ts`, so both pages print the
same text for the same tag right down to the `(#TAG)` suffix a shared name gets. The rules run over
**every** base and the narrowing happens afterwards — one call, in one order, so the two pages
cannot drift into disagreeing about what a trade is or which one comes first.

Paging is the card page's, unchanged: **rows (individual options), not pairs**, five by default,
remembered under one `coc:tradePairLimit` for both pages, because it is a reading preference about
this table and not about a route. **Propose** works here for the same reason — it posts to
`/api/cards/trades` and the tracker directly below reads the same module-level store — so a swap
proposed from a player page appears on the card page's tracker and the other way round. See
[The Trade Tracker](trade-tracker.md#the-trade-tracker).

The table carries `aria-label="Trade suggestions"` and **never** `aria-labelledby` the heading above
it. Both headings that sit over it are `.section-title`, which is `text-transform: uppercase`, and
Chrome computes an accessible name from the *transformed* text — pointing at one would name the table
`TRADE SUGGESTIONS`. Read back off the accessibility tree: `table: "Trade suggestions"`. The visible
heading is the same words, so label-in-name still holds.

**The Category column is kept**, deliberately. It is not redundant with the two cards beside it: the
swap is legal *because* they share a deck, and on a player page the four deck plaques directly above
make the deck the unit of progress — so "which deck does this swap move" is the column that says
whether an option is worth taking. It costs nothing at 390px either, where the table stacks into one
labeled card per swap and the deck becomes a line rather than a column competing for width.

## Staying current without a reload

Both card pages **re-read the shared counts and the trade list in the background**, so a swap
somebody else completes appears on your screen without a reload. Completing a trade moves a card on
two bases and the two people it moves them for are hardly ever in the same tab — the one who pressed
**Complete** is already served by that request's own refresh (see
[what the counts do afterwards](trade-tracker.md#what-the-counts-do-afterwards)); this is everybody
else.

**Three triggers, and no websocket.** The page reads when it opens, whenever the tab is brought back
to the front (`focus` *and* `visibilitychange` — neither covers the other, and a tab coming forward
usually fires both), and every **30 seconds** while it is on screen. `use-card-refresh.ts` is the
hook, mounted by `CardsView` and by `PlayerCardPanel` and by nothing else; `card-refresh.ts` is the
decision, pure and tested.

**Why polling is allowed here and nowhere else.** Every clan and player route in this app spends the
Supercell token, which is rate limited and is the thing the whole cache and TTL design exists to
protect. `GET /api/cards/inventory` and `GET /api/cards/trades` spend none of it: both are local
SQLite reads with no upstream call behind them, so a tick is two selects. Nothing that reaches
upstream may copy this.

Four things it refuses to do, each of which is a way to make a cheap idea an expensive one:

- **a hidden tab does not poll.** `document.visibilityState` outranks everything else, including a
  read that is long overdue. Eight forgotten tabs overnight is what this is about. The interval
  keeps ticking and does nothing, which is a comparison; tearing it down and rebuilding it on every
  visibility change would be a second piece of state saying what the browser already says;
- **the interval dies with the page.** It is created in the mount effect and cleared in its
  teardown, so nothing is left running for the life of the session;
- **it never reads across a save.** While a base's counts are being written, the answer would be the
  inventory from *before* the write — stale before it landed. `savingBaseCounts()` in
  `card-inventory.ts` is that flag, and there is nothing to wait for anyway: the write reloads the
  store itself when it lands;
- **a focus on the heels of a poll is one request, not two.** A focus may read far sooner than a poll
  may — making somebody who has just come back wait out the remaining seconds would be the staleness
  this exists to fix — but not within a couple of seconds of a read that has just started.

**Typing is never overwritten**, and that protection was already in place rather than added here:
`BaseCardEditor` re-seeds its draft only when the draft still matches what the server was last known
to hold, so a refresh landing mid-entry moves the attribution line and the panels around the grid
and leaves the typed numbers exactly where they are. See [Entry](#the-ui).
