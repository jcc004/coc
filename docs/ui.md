# The UI: chrome, responsive rules and the views

## Phones and tablets first

This app is read mostly on a phone, so small screens are the design rather than a fallback.
All of it is hand-written CSS in `web/src/styles.css`; the responsive rules live in one block
at the **end** of that file, because a media query adds no specificity and the Clash chrome
section above re-declares several of the same selectors.

Two breakpoints, both authored as `max-width` so they cascade into each other and cannot leave
a gap in the middle:

| Band | What changes |
| --- | --- |
| **≤ 900px** (tablet and phone) | One column, lookup stacked above the content, footer forced last. **Every wide table becomes one card per row.** Gutters drop to `20px 16px`. |
| **≤ 600px** (phone) | Gutters drop again to `14px 12px`, every `.search` form goes one control per line, form controls go to 16px, the 60-card grid tightens to a 96px column floor, the four deck plaques go 2×2, and the hero and war blocks left-align. |
| **> 900px** (desktop) | Unchanged. |

600px is the line where a two-up control row stops fitting: phones in use run 320–430px and a
portrait tablet is 768px, so it falls in the empty space between the two. 900px was already the
point at which the layout gives up its second column.

Tables stack at **900px, not 600px**, and that is a measured decision — at 768px, a tablet in
portrait, four of the then-eight tables still wanted a sideways scroll, and the users table wanted
1124px against 694px of available content width. (There are nine now: the card-holders table
below the clan-totals grid took the stacked treatment when it was added, which is the rule this
measurement exists to justify rather than an exception to it.)

**Tap targets** key off `@media (max-width: 900px), (pointer: coarse)` rather than width alone,
because a landscape tablet is 1024px wide and still driven by a thumb. Inside that block every
button, input, select and pill clears 44px. Checkboxes are the exception — `min-height` would
outrank their explicit `height` and stretch the box — so a roster checkbox is wrapped in a
`.select-hit` label, 24px on a desktop and 44px on a touch screen.

The 16px floor on phone form controls is not cosmetic: iOS Safari zooms the whole page whenever
a focused control is smaller than that.

### A new table has to take the stacked treatment

Otherwise it will scroll sideways on a phone. The recipe:

1. Put `roster--stack` on the table.
2. Give every cell a `data-label`; that is what the stacked card prints in place of the column
   head. The row's identity cell takes `class="stack-title"` and **no** label, so it reads as
   the card's heading instead — and if it holds a link, that link gets a 44px box. For the two
   sortable tables the label comes from `rosterColumnLabel()` / `clanColumnLabel()` in
   `saved-table.ts`, so a stacked label cannot drift from the column header it stands in for.
3. Add the ARIA. Changing `display` on a table strips its semantics from the accessibility tree
   in Chrome and Safari alike, so every element carries the role it would otherwise have had:
   `role="table"` / `rowgroup` / `row` / `columnheader` / `rowheader` / `cell`. The header row
   is hidden with the `.visually-hidden` recipe, never `display: none`, so a screen reader still
   reads real column headers — and its `aria-sort` — against real cells.
4. **If the table sorts, it needs a `SortControl`.** Stacked, there are no visible column heads
   to hang seven sort buttons off. Reflowing them into a strip above the cards was tried and
   read as a run of unexplained gold words, so instead `useStackedTables()` decides and the
   table renders *different DOM*: plain text in the `th`s plus one "Sort by" select and a
   direction button. Rendering both and hiding one in CSS would leave the hidden set in the
   accessibility tree as invisible duplicate tab stops. A column whose heading is an
   abbreviation (`#`, `TH`) needs a `long` label in its `TableColumn`, because the Sort menu has
   no column of numbers underneath to explain it.

A cell the row had nothing to put in is dropped (`td:empty`), so a blank line never appears.
The label is a **float**, not a flex or grid column, because a cell's value is arbitrary inline
content — a link, then text, then a pill — and any of those would be torn into separate flex
items by a flex or grid container.

The one table that does not stack is the account identity table. It is two columns at every
width, so it wears `roster--pairs`, which only lets its cells wrap — a 36-character guid does
not fit a 320px screen on one line.

## The topbar

A gold plate carrying the title, the Clan and Cards links, and the account menu. It wraps at
390px rather than scrolling sideways, so everything on it stays reachable on a phone (measured:
two rows, no horizontal overflow).

### The compass rosette

Left of the words **Clash of Clans Explorer** is a compass rosette: a ring around two four-point
stars, long and solid on the cardinals, shorter and at 45% opacity on the diagonals.

It is **inline SVG written by hand** in `web/src/App.tsx` — no dependency, no external file, no
icon font. Everything else drawn in this app is either game art from the API and the wiki or it
is CSS, and one 24-pixel glyph is not a reason to add a package. Both stars paint in
`currentColor`, so the mark takes whatever ink the plate uses (`--on-gold`, which differs between
the themes) and needs no colour of its own; `opacity` rather than a second colour is what
separates the two stars, for the same reason.

**It is inside the title's existing link, not beside it.** Two adjacent links to the same place
would be two tab stops reading as two destinations, and naming the icon "Home" would invent a
second one. So the icon takes `aria-hidden="true"` and the single link keeps the accessible name
**"Clash of Clans Explorer"** — verified from the computed accessibility tree, not from the
markup: `link` / `Clash of Clans Explorer`, with the `<svg>` itself `ignored` and `role: none`.
It navigates to the homepage, which is the saved-clans list.

### The Clan button

Labelled **Clan**, and it goes to **the last clan this account opened** — not to the saved-clans
list. Coming back to a clan is the common move, and it used to cost a trip through the list.

The tag is persisted per account under `coc:lastClan:<id>`, exactly as `coc:lastRoute:<id>`
already is, because a browser can be shared and handing one person another person's clan would be
worse than having no shortcut at all. It is written by `useLastClan` in `web/src/hooks.ts` on
every hash change, canonicalised on the way in, and only `#/clan/<tag>` counts — a war page is
*about* a clan but is not the clan.

**Before any clan has been opened it goes to the saved-clans list**, which is where you pick one.
That is the one thing it must never be: a dead control, or a link to nowhere. Its tooltip says
which of the two it is doing (`Back to #G88CYQP, the last clan you opened` /
`No clan opened yet — this opens the saved clans`). The decision is `clanTargetTag()` in
`web/src/last-route.ts`, pure and tested including the junk-in-storage case.

Like the Cards link, it is **absent where it would point at the page you are on** — on any clan
page (the last clan is the one you are looking at) and, with no clan yet, on the list itself. The
saved-clans list stays one click away on the title.

### The account menu

One silhouette button on the right, holding everything about *you*: the appearance switch, **Help**,
a link to your password page, the **admin panel** if you are an admin, and **Sign out**.

It replaced three separate topbar controls — a theme cycler labelled with the current theme, the
display name as a link, and a Sign out button. At 390px those competed with Clan and Cards for a
bar barely wide enough for the title, and "my settings" is a thing people look for behind their own
avatar rather than spread across a toolbar.

**The button's accessible name is the display name and role** — `verify (admin) — account menu` —
because a silhouette says nothing about *who* is signed in, and on a shared browser that is the one
thing worth being able to check. The panel repeats it in words, with the email, for a sighted user
who cannot hear the label.

**The admin entry is absent for a member, not disabled.** A greyed-out "Admin panel" tells somebody
their account is lacking; an absent one says the feature is not theirs. `userMenuItems()` in
`web/src/user-menu.ts` decides it, pure and tested, and **Sign out is last** so it is never between
two navigation items where it can be pressed by accident.

**Help is first, and it is on everybody's menu** — the opposite of the admin entry, because there is
no version of a help page that is not yours, and hiding it from members would hide it from exactly
the people most likely to need it. It is first because it is the only item somebody opens this panel
for while *confused* rather than while administering something. It points at the whole page, never at
a section: arriving from the menu nobody has said which part they want, and landing mid-page looks
broken. See [In-app help](#in-app-help).

**Appearance stays a cycler, not three radio items.** It is the only item pressed repeatedly, it has
to visit all three states, and as a cycler it can be pressed without the menu closing underneath it
— so the effect is visible while the control is still under the cursor. Every other item navigates
or signs out, and those close the menu. Read back in a browser: four presses gave
`◐ System → ☀ Light → ☾ Dark → ◐ System` with the panel still open, and `data-theme` following on
the root element.

`system` is **in** the cycle and is the default. Without it, anybody whose OS switches at dusk could
not get back to following it without clearing storage. An unrecognised stored value — an older
build's, or one somebody edited — lands on `system`, the one answer that is never wrong.

Hand-rolled ARIA, because there is no menu library here and one glyph is not worth a dependency:
`aria-haspopup="menu"` and `aria-expanded` on the button, `role="menu"` / `role="menuitem"` on the
panel and its items, **Escape closes it and returns focus to the button** (closing without moving
focus leaves a keyboard user at a control that no longer exists), and an outside press closes it —
bound on `pointerdown` rather than `click`, so a press that starts outside cannot land on an item
that has moved. All four verified in a browser, including `aria-controls` matching the panel's id.

The silhouette itself is inline SVG in `web/src/components/UserMenu.tsx`, a circle and a clipped
half-capsule in `currentColor`, for the same reason the rosette is.

## In-app help

`#/help` is one page of prose about the four things people ask about twice: who owns a base, the
difference between a suggested swap and an agreed trade, what the leaderboard is measuring, and that
there is one copy of the data and it is everybody's. `HelpView` in
`web/src/components/HelpView.tsx`; reachable from the account menu, and from a `?` beside each panel
it describes.

It is **not a feature tour**. Every claim on it was checked against the module that enforces the
rule rather than against the README, and the numbers in it are *computed* — `MIN_TRADEABLE_COUNT`,
the 0–10 entry cap, the sixty cards and the whole points curve come from `shared/src/card-types.ts`,
`cards.ts` and `cardPoints()`, so raising a cap cannot leave a paragraph quietly lying about it.

### Rules used to disappear when they became relevant

The app carried around thirty-five explanatory blocks (`empty-hint` / `notice__hint`), and several of
them **only rendered in an empty-state branch** — so the explanation vanished at exactly the moment
the panel filled with data somebody might be confused by. The clearest case: the sentence defining a
legal swap ("one base holding two or more of a card the other has none of, in both directions, within
one category") was the trade suggestions' *empty* message. Once there were trades to explain, the
rule was gone, and it never came back.

Three of those are now collapsed `<details class="group">` — the idiom this app already uses — sitting
under the panel they govern, present whether or not the panel has rows:

| Panel | Disclosure | Was |
|---|---|---|
| Trade suggestions | *What makes a swap legal* | the empty-state message, plus a clause on the footer count line |
| Trade tracker | *Who can complete a trade, and what completing does* | a clause on the footer count line, so absent from an empty tracker |
| Collection leaderboard | *How the points work* | nowhere; the visible intro line described the **old** measure |
| Clan roster's Owner column | *Who owns a base, and what an owner may do* | nowhere at all |

Genuine "nothing here yet" messages were left where they are — `No clans saved yet`,
`No members match those filters`, the capital-raid weekend that has no per-member breakdown because
the API omits one. Those explain an absence rather than a rule.

**The leaderboard's intro line was wrong**, which is why it is in that table. It read *"by distinct
cards out of 60. Level on that, more copies goes first"* — the measure it described stopped being the
measure when `cardPoints()` arrived, and a base holding nine copies of one card outranks a base
holding eight single cards, which is the opposite of what the sentence said. It now names points, and
the curve itself is in the disclosure and on the help page from one source.

**No copy is written twice.** Each rule is one component in `web/src/components/help-copy.tsx`,
rendered by the disclosure *and* by its help-page section. They are fragments — no headings, no
wrappers, no margins — so the caller supplies the container.

### Deep links: `#/help/<section>`, and the scroll is ours

`{ view: 'help'; section }` was added exactly as `{ view: 'admin' }` was — the union in
`web/src/hooks.ts`, `parseHash`, `hrefFor`, and a render branch in `App.tsx`. The section ids, the
href builder and the parser are a pure module, `web/src/help.ts`, with tests: a `?` that scrolls to
the wrong section is worse than no `?`, and a link naming a section that has since been renamed lands
silently at the top of the page and looks like it worked.

**The obvious spelling is unavailable.** `#/help#owners` is not two fragments; the hash is already the
router, so a second `#` is just more fragment text and the browser's own anchor scrolling can never
fire. Of the two remaining shapes — a query (`#/help?section=owners`) and a path segment
(`#/help/owners`) — the path segment is the one this app already speaks: `parseHash` splits on `/` and
hands the second segment to the view, exactly as `#/player/<tag>` does. A query would have taught
`parseHash` a second syntax for one route.

The cost is that `HelpView` scrolls itself, in one effect. That buys something the native behaviour
does not: the ids stay ordinary element ids, so the in-page contents list uses the same hrefs the `?`
marks do. The effect also **moves focus** to the heading (`tabIndex={-1}`, `preventScroll` so it does
not fight the smooth scroll) — a link that scrolls the page but leaves the caret in the topbar sends a
keyboard user back through the whole page to reach what they clicked for. An unrecognised section is
**not** an error: it falls back to the top of the page, because somebody following an old link should
get the help page rather than a 404 for a heading that was renamed.

Verified in a browser at 390px and 1280px, in both themes: all six sections render, all six deep
links land with the heading at the top of the viewport and holding focus, `#/help/nonsense` opens the
page at `scrollY` 0, and every disclosure opens and closes.

### The `?` mark

`HelpLink` in `web/src/components/primitives.tsx`, on the card grid's header, the trade suggestions,
the trade tracker, the collection leaderboard and under the roster's Owner column.

**The glyph is not the name.** `?` is a mark, so it is `aria-hidden` and the accessible name is a
`.visually-hidden` sentence naming the topic — `Help: what makes a swap legal`. Same split as the
compass rosette and the account-menu silhouette, for the same reason: six links all announced as
"question mark" tell a screen reader user nothing, six times.

It is deliberately the quietest control in the app — an 18px outlined circle in `--ink-muted`, no
fill, no gold, no new colour role. It sits beside something the reader has already found and is only
worth noticing when they are stuck. On the card grid it goes beside the *status* line rather than the
heading, because that heading is a person's name and a `?` after somebody's name reads as a question
about them.

On a touch screen the **target** grows without the drawing changing: an absolutely positioned 44px
pseudo-element centred on the glyph takes the press, since growing the box would push the line height
of every panel header it sits in around. Nothing adjacent to it is interactive, so the overhang costs
nothing.

## Looking a player or clan up

The two lookup forms sit **on the homepage, beneath the saved clans**, side by side in one row
that becomes one column on a phone. The layout is a **single column at every width**.

They used to live in a sticky 260px right-hand sidebar spanning every route. That was right when
they were the only thing on screen and wrong everywhere else: on a clan, player or card page they
were a permanent column of chrome beside the thing you had already found. The **Recent** chips came
with them, because they live *inside* the two lookup cards — each list under the box that produced
it — and because "where have I been" is the same question as "where do I go", asked on the same
page. The title navigates home from anywhere, so both are one click away from every route.

With the chat panel gone too (replaced by the Trade Tracker on the card pages) the sidebar had
nothing left to hold, and a second grid track would have been a dead gutter. Each card still stacks
its controls one per line, as it did at 260px: two narrow forms read better than two sprawling
ones, and it means the phone layout is the same shape as the desktop one rather than a second
arrangement to keep working.

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

## War view

`#/war/<clanTag>` shows the current war and the war log together, fetched independently so
one failing does not blank the other. Head-to-head star score, destruction, attack usage
meters, and both rosters with per-member stars, best hit, attacks used, and best defence
against them.

## Capital raid weekends

Below the roster, the clan page shows the last few raid weekends from
`GET /api/clans/:tag/capitalraidseasons` — date range, state, total capital loot, raids
completed, enemy districts destroyed, and the offensive and defensive reward. Each weekend
also gets a `<details>` expander with the per-member breakdown: attacks used out of the limit,
and capital resources looted, ordered by loot.

Two things about that payload are worth knowing before reading the code:

- **`members` is only present while a weekend is `ongoing`.** Every `ended` weekend omits the
  key entirely — not an empty array — verified across two clans and ten weekends each. So past
  weekends have totals but no attribution at all, and the expander says so rather than
  pretending the clan had no participants.
- **Attacks used can exceed `attackLimit`**, because the bonus attack is reported separately.
  The usable total is `attackLimit + bonusAttackLimit`, which is what the table divides by.

A clan that has never taken part gets `{"items": []}`, which the card handles with a plain
message.
