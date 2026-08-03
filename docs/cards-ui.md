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
2. **Trade suggestions** — who should swap what with whom, 5 pairs at a time;
3. **Collection leaderboard** — every tracked base, furthest along first, 5 rows at a time;
4. **Cards across the clan** — an expandable copy of the same grid, every tile badged with the
   clan's total, and every tile a button: press one for the bases holding that card.

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
- **The grid** is one continuous grid of all 60 in deck order — nothing drawn between one deck and
  the next, so a deck that runs out mid-row does not leave a ragged line. Each deck is still a
  **named group** in the markup: a `.card-deck` wrapper carrying `role="group"` and a
  `.visually-hidden` `<h3>` it is labelled by. The wrapper is `display: contents`, which is what
  keeps it out of the layout — the tiles stay direct grid items of the one grid, so the grouping
  costs no box, no gap and no change to the column alignment. Anything other than `contents` there
  splits the sixty tiles back into four grids and the seams reappear.
  Tiles are **picture only**: no card name. A card the base holds renders in colour; one it lacks
  renders the same file under `grayscale(1)`. That is **never the only cue** — the number box under
  the art reads 0 for a card the base lacks and n for one it holds, at every breakpoint, so
  held-vs-not survives with no colour vision at all. The name is on the tile's `title` and in the
  accessible name of every control in the cell, so nothing that reads the page aloud has lost it.
  The cost is real and worth knowing: the card art is gitignored, so on a checkout with no art a
  tile is an empty frame over a count.
- **The count badge** sits in the art's lower right and appears **only past one copy**: `×1` on
  fifty tiles would be noise, where a spare is the fact worth spotting. The clan-totals grid makes
  the opposite call and badges every count — see [Cards across the clan](#cards-across-the-clan).
- **The tile border carries the deck**, in the event's own frame colours —
  `--deck-elixir`, `--deck-dark-elixir`, `--deck-builder-base`, `--deck-super-troop`, declared
  in all three theme scopes and lightened for dark mode, where the deep purple would otherwise
  vanish. Categorical colour on a border only, never on text. With the drawn headings and the names
  gone it is the only *visible* cue to deck, which is a real narrowing — the fallbacks are that
  the cards stay in deck order so each colour arrives as one unbroken run, that each run is a
  named group with a hidden heading, and that every tile's `title` and its box's accessible name
  spell the deck out in words. **Colour is never the only carrier**, which is the rule this page
  would otherwise have been the first to break. It also settles the one case
  where two cards share a picture, since the home and Builder Base Baby Dragons sit in different
  decks; with the names gone, that pair is otherwise indistinguishable. The nominal
  values are recorded in `CARD_CATEGORY_BORDER` in `shared/src/card-types.ts`; what the page
  paints is the CSS token, because a colour that must work on parchment *and* dark wood is a
  theme decision.
- **Entry** is a **count row under each frame** — `−`, a capped 0–10 number box, `+` — kept in a
  local draft so typing sixty boxes is one write, not sixty. The draft re-seeds when the base
  changes or when somebody else's save lands — but never while there are unsaved edits, because
  silently replacing what someone is typing is worse than showing a stale number they are about to
  overwrite. See [The count row](#the-count-row) for the three things that row has to get right.
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

Under each frame, never over the art:

```
┌─────────────────┐
│   card artwork  │
└─────────────────┘
  −     [ 3 ]    +
```

**The box stays typeable, and that is the point of the layout.** Sixty cards is sixty numbers, and
somebody entering them types `7` rather than pressing `+` seven times; the buttons are the
adjustment afterwards, which is the thing a thumb is bad at doing through a keyboard. So they went
*beside* the box and not instead of it. Overlaying them on the artwork was rejected for a separate
reason: the art is the only thing on a tile that identifies the card, so a tap target on top of it
would be covering the identity to reach the control.

**Three controls, and what each is called.** Sixty tiles times three is 180 things a screen reader
can land on, and the tiles print no names, so every word of "which card is this" is in an accessible
name. Read back through the accessible-name computation in
`web/src/components/BaseCardEditor.test.tsx`:

```
button      One fewer Barbarian
spinbutton  Barbarian, Elixir — copies held, 0 to 10
button      One more Barbarian
```

The card's name three times, because somebody landing on a `+` has to know which card it belongs to;
the deck and the range **once**, on the control the cell is actually about. Naming all three in full
was tried and is worse — one deck would read out `Elixir` nineteen times over and `0 to 10`
fifty-seven times. So was wrapping the row in a `role="group"` named for the card and leaving the
buttons as bare `One more`: a group is announced when focus *enters* it, and `+` is the third
control in, so the one place the card most needs naming is exactly where the group has stopped
saying it. The tile itself is still given **no** `label` — the controls inside it are the named
things, and naming the container would be a fourth announcement per card.

**Leaving the *cell* is the save, not leaving the box.** A press on `+` moves focus off the number
box, so a save-on-blur would turn five presses into five PUTs of the base's whole season, each
moving the `updated_at` the attribution line reads out. The row is one element with one `onBlur`;
`focusout` bubbles, and `relatedTarget` says whether focus went to another control in the same cell
or out of it. The skip is a fourth reason in `blurDecision` — `sameCell`, ahead of `unchanged`,
`notWritable` and `busy` — rather than a second, quieter rule inside the component, and a test
presses `+` five times and asserts **one** write of `count: 5`.

**Both ends are `disabled` at the bounds, not clamping.** `−` is unavailable at 0 and `+` at 10 —
`cardCountStep()` in `card-entry.ts` returns `null`, which is both the disabled state and the
press's destination, so the two cannot disagree. A `+` still offered at ten would be a control that
answers a press by doing nothing, which is the dead end this page refuses to hand out sixty times;
the bound is legible without it, since the number is right there and the box's name gives the range.
The one cost is handled deliberately: a `disabled` element cannot hold focus, so the press that
takes a button away hands focus to the box beside it rather than letting the browser drop it on
`<body>` — which would lose the user's place *and* count as leaving the cell, firing a save
mid-sequence.

**A read-only base disables all three**, and the reason still reaches the reader: in full in the
notice above the grid, in full in the box's own accessible name and `title`, and as a plain
`, read-only` suffix on each button's name. It is deliberately not repeated in full three times —
the sentence is about the *base*, so it is the same sentence on all sixty tiles, and tripling it
would cost far more than it tells anyone.

**The buttons are drawn only where they fit, and the box is never the one that gives way.** The
constraint is horizontal, and it is the tightest thing on the page. What has to fit is
`24 + 2 + box + 2 + 24`: two 24px buttons (WCAG 2.5.8's floor, not a number with slack in it), two
2px gaps, and the box's 1px borders — **54px of chrome, plus whatever `10` needs**. The grid is
`minmax(0, 1fr)`, so it cannot widen to help.

That last term is not a constant, which is why the threshold is
**`@container card-tile (min-width: calc(54px + 1.25em))`** — 72.8px at this app's 15px body type —
rather than a round number:

- `10` is set in `tabular-nums`, so it is **wider than a proportional measurement of the same
  string** (18.4px against 15.9px at 15px type). Measuring the text rather than the glyphs is what
  two earlier guesses at this threshold, 78px and then 72px, both got wrong. Measured, the box needs
  18px of usable width at 15px type, 20px at 16px and 24px at 20px: about 1.25em throughout.
- writing it in `em` means the row responds to type size on its own. If the app's text ever grows,
  the steppers **stop being drawn** rather than start clipping a count — a number cut in half is a
  wrong number, whereas a button that is not offered is a convenience that is not offered, and the
  box beside it still does the whole job.

A *container* query and not a media query, because the tile's width is a product of the viewport, the
gutters, the panel padding **and** the density control's 6/8/10/12, so a width breakpoint would be
answering a different question. Below the threshold the steppers are `display: none`, which also
keeps them out of the tab order and the accessibility tree, so a phone reads sixty controls and not
a hundred and eighty. Where they are drawn, a touch-sized screen takes them to 24×44 — taller,
because height is the axis that is free here.

**One exception the `em` cannot see**, and it is written next to the rule it corrects: below 601px
the responsive section forces 16px on `input` specifically — iOS zooms the page whenever a focused
control is under 16px — and that rule names the input, not the tile the `em` resolves against. So a
second, stricter `@container card-tile (width < 75px)` inside the same media query hides the row
there. Measured: at 16px type a 19px box clips `10` and a 20px box does not. In practice it decides
only a ~15px band of viewport width around 570px, because below 601px the density control offers
nothing but six columns.

Measured in Chrome against the real stylesheet — 31 widths from 320 to 1280px at six columns, both
themes, plus every width the density control offers 8, 10 and 12 at, plus a coarse pointer, 125%
zoom, and three browser default font sizes. Clipping is read off the box's `scrollWidth` against its
`clientWidth` on a tile holding `10`, the widest value, not off the arithmetic:

| | tile content | steppers | box |
|---|---|---|---|
| 320px, 6 cols | 33px | no | 33×44 |
| **390px, 6 cols** | **44.7px** | **no** | 44.7×44 |
| 570px, 6 cols | 74.7px | no (the 16px exception) | 56×44 |
| **600px, 6 cols** | **79.7px** | **yes, 24×44** | 27.7×44 |
| 844px, 6 cols (landscape) | 104px | yes, 24×44 | 52×44 |
| **1280px, 6 cols** | **175.3px** | **yes, 24×24** | 56×30.5 |
| 1280px, 8 cols | 125px | yes, 24×24 | 56×30.5 |
| 1280px, 10 cols | 94.8px | yes, 24×24 | 42.8×30.5 |
| **1280px, 12 cols** | **74.7px** | **yes, 24×24** | **22.7×30.5** |

**No horizontal overflow at any width, in either theme; no row overflowing its tile; no clipped
`10` anywhere the steppers are drawn**; the deck frame colours untouched.

The **densest view is the tightest case in the app** and the reason the gaps are 2px and the box has
no inline padding: twelve across at 1280px is 74.7px of tile against a 72.8px threshold, 1.9px of
margin, and at the 3px gaps and 4px of box padding this started with it missed by 3.3px and lost its
steppers. It follows that twelve-across needs a **CSS viewport of about 1250px** to keep them —
below that the tile drops under the threshold and the row falls back to the box. At **125% zoom**
that is 1250 × 1.25 ≈ 1560 physical pixels: verified, a 1600px window at 125% keeps the full row at
twelve across with no clipping, and a 1280px window at 125% (1024 CSS px) drops the steppers
cleanly rather than clipping. A larger **browser default font size** changes nothing at all, because
`body` sets `font-size: 15px` in pixels — that is a pre-existing property of the whole app, not of
this row. A forced **root** font size does reach it, and behaves as designed: at 20px the twelve-column
view hides its steppers instead of clipping the count.

The honest cost, recorded because it is the part somebody will want to argue with: **at the default
six columns on a phone there are no stepper buttons at all.** 390px yields 44.7px of tile, three
controls in which would be about 14px each — under every target-size floor this app applies and
narrower than the digits inside them. Turning the phone sideways is enough (≈844px landscape gives
104px of tile and the full row), as is a tablet. Fitting them at 390px needs a decision this change
did not have: fewer columns on a phone, which would break the fixed six-across the grid is built
around.

### Row counts on the trade suggestions

A **Pairs** select at the **bottom** of the section, defaulting to **5** (5 / 10 / 20 / All), with
the pager beside it. The choice persists at `coc:tradePairLimit`, the same way every other row
limit in the app does, and the same `paginate()` / `parseRowLimit()` / `RowLimitSelect` / `Pager`
machinery does the work — see [Row counts and paging](shared-data.md#row-counts-and-paging).

**The limit counts pairs, not rows, and both controls say so.** The two readings genuinely differ
here: fifteen pairs can be nineteen rows, because a pair with several options is one block with the
member named once and its options listed beneath. Paging by row would put a row with two empty
Member cells at the top of page 2 — which reads as missing data rather than as "the same two bases
as above", the exact failure the wide table's `data-pair-start` rule exists to prevent — and would
also make "5" mean something other than five decisions to make. So the control is labelled `Pairs`,
the pager reads `Showing 1–5 of 15 pairs`, and the note underneath adds `7 options on this page`
whenever there is more than one page. Verified in a browser: at the default, `Showing 1–5 of 15
pairs` over 5 pair-blocks and 7 rows; `Next` gives `Showing 6–10 of 15 pairs` over 5 and 5; `All`
gives 15 blocks and 19 rows with no pager at all.

## The collection leaderboard

Every tracked base, ranked by how far it has got, directly under the trade suggestions — because
"who should trade with whom" and "who is furthest ahead" are the same question asked two ways, and
the base near the top with spares is the one worth messaging. Member name, tag, owner, points, cards
and copies; the `17/60` is printed and a `.meter` bar on the sequential blue ramp is a second
telling of it, never the only one.

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

It is **group-wide and not filtered by Mine/All**. A leaderboard of one base answers nothing.

## Cards across the clan

The **last** panel, and an expandable one: the same 60-tile grid as above, every tile carrying the
copies held across **every** tracked base as a small badge in its lower-right corner — exactly where
the per-base count badge sits. Collapsed by default, and its summary line carries the headline —
`All 60 cards, in grid order · 38 nobody holds`.

**Every tile is a button, and pressing one lists the bases holding that card** in a table under the
grid — see [Who holds a card](#who-holds-a-card). The badge says a trade is arithmetically possible;
the table says whom to message, which is the only reason to be reading this panel.

**It is the grid, not a list.** It was a two-column list of `.meter-row`s; a grid is what makes it
readable against the tiles above, because "the same picture in the same place" needs no
translation. That is not a claim about two similar components: `CardTile` in
`web/src/components/CardTile.tsx` **is** the tile, and `BaseCardEditor`'s entry grid and this one
are its two callers — same art, same framing, same deck-coloured frame, same greyscale.
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
hold a number box people type into and a `−` and `+` of their own (a button inside a button is not
markup a browser keeps), is untouched, and the pressable version gets keyboard
activation, focus, the focus ring and a real pressed state from the element rather than from
attributes. `.card-deck` is `display: contents`, so the button takes the tile's place as the grid
item; it is `display: block; width: 100%` with the browser's button chrome removed, and the tile
inside still draws the border, background and padding. A button is inline-block by default, which
would shrink-wrap and leave the tile narrower than its column — that pair of declarations is what
keeps the swap invisible, and it is the thing to check in a browser if the columns ever look wrong.

**The order is fixed by design and never changes with the counts.** It comes from
`cardsInGridOrder()`, which is literally the grid's own two calls — `cardCategoriesInOrder()` then
`cardsInCategory()` — rather than a second ordering that agrees with it today and drifts the next
time the manifest is regenerated. The whole reason the panel earns its place is that it can be
scanned tile-for-tile against the grid above it, so **nothing here sorts by count, in any mode**.
That is asserted directly: a test puts all the copies on the *last* card and none on the first and
checks the output order still matches the input's. And read back off the DOM: the two grids' 60
tiles, compared by name in document order, match card for card at 390, 600 and 1280px.

**The badge appears on every count, including 1** — the opposite of the entry grid, where `×1` on
fifty tiles is noise. Here the totals *are* the point, and a card exactly one person in the clan
holds is one of the more interesting things on the page.

**Every tracked base is counted, linked to an account or not.** Most assignments in this install
are still free-text labels; their cards are as tradeable as anyone's, and excluding them would
undercount the group by more than half rather than describe a smaller one.

**A card nobody holds is greyscale with no badge, and the words carry it.** That visual state is a
colour cue plus a *missing* cue, which is not enough on its own, so every tile has an explicit
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

Each deck is a `role="group"` labelled by a `.visually-hidden` heading exactly as the entry grid's
`.card-deck` is, with its own `card-total-deck-*` ids — both grids are mounted on this page at once,
so the ids cannot be shared.

It stays **collapsed** because sixty more tiles left open would push everything above them off a
phone. It costs no extra art either way: measured, its sixty image URLs are byte-for-byte the entry
grid's, so opening it adds no requests, only the drawing.

### Who holds a card

Pressing a tile opens a table **under the grid**, headed by the card's name and its art:

```
[art] Barbarian   Elixir · 6 held across the clan
2 bases hold it · 1 with a spare to trade

Member          Copies   Spare
Brix  #BBB           5   Can spare one
Alda  #AAA           1   Its only copy
```

**Under the grid, not above it.** The tiles are what the panel *is*, and a table inserted above them
would push sixty tiles down the page on every press — moving the tile you had just pressed out from
under the pointer.

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
both: `2 bases hold it · 1 with a spare to trade`, so "several bases hold it and none of them can
help you" does not need a scan of the column to notice.

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

**Pressing the selected tile again closes the table**, and `aria-pressed` goes back to `false`. It is
the control that opened it, so it is the one somebody reaches for to put it away; without that the
table could only ever be swapped for another card's. `aria-pressed` rather than `aria-expanded`
because there is *one* table and the sixty tiles take turns owning it — sixty independent
disclosures is not what this is — and only the pressed tile carries `aria-controls`, since on the
other fifty-nine there is no `#card-holders` to point at. The selection is **never colour alone**:
the ring on the tile is `--accent` as a `box-shadow` *outside* the tile (recolouring the border
would cost the deck colour, which is the only visible cue to which deck a card is in), the state is
on `aria-pressed`, and the card is named in words with its art directly below.

The selection **survives the panel being collapsed and reopened**, deliberately: coming back to
find your card still chosen costs nobody anything, and clearing it would be a second way to close
a table the tile's own toggle already closes.

It **stacks like every other table** — `roster--stack`, `data-label` on each cell, `stack-title` on
the member, and the explicit `role="table"` / `rowgroup` / `row` / `columnheader` / `cell` that
survive `display` changing. Nothing in it sorts, so it needs no `SortControl`. It carries **no
pager**, unlike the two tables above it: those are unbounded in pairs and bases, this is at most one
row per tracked base and in practice a handful, and truncating "who holds this" to five rows would
hide the base somebody opened it to find.

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
  at all in that state rather than rendered empty. A stored `Mine` is honoured even by an account
  that owns nothing, which is what keeps that message reachable: they asked for it.
- **the choice is persisted per account**, at `coc:baseScope:<userId>`, for the reason
  `coc:lastClan:<id>` is: one browser is shared, and one person's `Mine` is the other person's
  empty list. Verified in a browser — with `coc:baseScope:1` holding `all`, a second account
  signing in on the same profile still defaults to `Mine` and does not touch the first key.

**The leaderboard and the card totals ignore this filter entirely.** They are about the whole
clan's progress; narrowed to one person's bases they would stop meaning anything.

## Deck progress plaques

How far a base has got in each of the four decks, drawn the way the event itself draws it across
the top of its own panel: one rounded plaque per deck, in that deck's colour with a full-strength
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
signal the palette has for "this is furniture, not data". The deck's own colour was the other
candidate and is out for the mirror-image reason: `--deck-*` is *categorical*, it already says
which deck on the plaque wrapped around the bar, and reusing it for the bar would leave four bars
whose colours differ for a reason that has nothing to do with their lengths. So the plaque keeps
the deck colour, the bar keeps `--accent` on `--track` like every other meter here, and **the
fraction is printed either way** — progress is never carried by a length or a hue alone. That last
part is the non-negotiable one; the choice between the three colours is a judgement call and this
is where it is recorded, alongside the same note in `DeckPlaques.tsx`.

The plaque is a *tint* of the deck colour rather than a solid fill like the game's, because the
four tokens run from bright magenta to deep purple and no single text colour clears 4.5:1 on all
four; tinting keeps the name and the fraction in `--ink`. The fraction sits over bare track on an
empty deck and over full-strength `--accent` on a complete one, so it carries a `--surface` ring
in `text-shadow` — the panel colour `--ink` is already designed to be read on, in both themes.
The game outlines its numerals for the same reason.

**No resource icon** at the right end, unlike the game. The event's elixir, dark-elixir,
builder-gold and potion icons are not among the vendored art — `web/public/coc/` has card art,
league badges, labels and wiki unit art and nothing else — and an equipment gem standing in for a
resource would be a picture saying something untrue. The space goes to the fraction.

**A base with nothing recorded gets no plaques at all**, on either page: four `0/19` bars for a
base nobody has entered would be a claim nobody made. A base entered once and then **cleared back
to zero** does show four empty bars, because that is a base somebody checked. Same distinction the
card page's attribution line draws, and it comes from the same place — `summariseBase().recorded`.

Each plaque's bar is a real `role="progressbar"` with `aria-valuemin` / `max` / `now` set and an
`aria-valuetext` of `7 of 19` (not `7/19`, which is read out as "seven slash nineteen"). Its
accessible name, read back off Chrome's computed accessibility tree, is
**`Elixir cards: 7 of 19 collected`** — deck, count and total, so nothing depends on seeing the
bar.

The shape is `deckProgress()` in `web/src/deck-progress.ts`, pure and tested: it pairs each deck's
`distinct` from `summariseBase()` with its size from `cardsInCategory()`, clamps the bar, and
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
  the only one — `No trades available` reads the same with no colour vision at all.

A base nobody has entered shows **no plaques** and reads
**`Nothing recorded yet — open to enter counts`**, not sixty zeroes dressed as data. That is the
same distinction the card page's attribution line draws, and it is why the panel keys off whether
a base has a record at all rather than off its totals: a base saved and then cleared back to zero
keeps its stamp and reads as recorded-and-empty.

**Opened it is the card page's grid, with no base selector** — the base is the player whose page
it is. Same tiles, same greyscale, same deck-coloured frames, same `×n` badges, same
[count rows](#the-count-row), same one-request save, same 4 named deck groups. That is not a claim
about two similar components: `BaseCardEditor` in `web/src/components/BaseCardEditor.tsx` **is** the
grid, and `CardsView` and the player page are its two callers, and one tile of it is `CardTile`,
shared in turn with the clan-totals grid. Measured at 1280px, six columns of 191.3px tiles, a 10px
gap and a 175.3×219.2 frame per tile; 87.7px tiles at 600px and 52.7px at 390px. The one thing that
can differ is the *column count*, and only because the card page has a density control and this page
does not: the player page renders `DEFAULT_CARD_COLUMNS`, which is the six both are built around.
Duplicating sixty tiles and their draft-and-save logic was the thing to avoid — the greyscale, the
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

The counting and the predicate are one pure, tested function, `summariseBase()` in
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
own summary line; filtered, the two are the same number. Read back off the DOM on a seeded base
with two partners: summary `Trades available with 2 bases`, table `2` pair blocks over `10` option
rows, one `Propose` per row. Seeded up to six partners: summary `Trades available with
6 bases`, `6` pairs, and the pager appears — `Showing 1–5 of 6 pairs`, `Page 1 of 2`, 19 options on
page 1 and 3 on page 2. Below five it hides itself, so a base with a couple of partners shows no
control at all.

**It is the card page's table, extracted — not a copy.** `TradeSuggestions` in
`web/src/components/TradeSuggestions.tsx` is now the third thing the two pages share, after
`CardTile` and `BaseCardEditor`, and it took `TradeCard`, `ProposeButton` and `BaseLabel` with it.
Naming a base moved too, into `useBaseLabels()` in `web/src/base-labels.ts`, so both pages print the
same text for the same tag right down to the `(#TAG)` suffix a shared name gets. The rules run over
**every** base and the narrowing happens afterwards — one call, in one order, so the two pages
cannot drift into disagreeing about what a trade is or which one comes first.

Paging is the card page's, unchanged: **pairs, not rows**, five by default, remembered under one
`coc:tradePairLimit` for both pages, because it is a reading preference about this table and not
about a route. **Propose** works here for the same reason — it posts to
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
labelled card per swap and the deck becomes a line rather than a column competing for width.
