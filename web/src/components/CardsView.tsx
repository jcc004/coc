import { useCallback, useMemo, useState } from 'react'
import { type SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { applyBaseOrder, useBaseOrder } from '../base-order.ts'
import { activeTag, ownsAnyBase, tagsInScope, type BaseScope } from '../base-scope.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { cardColumnOptions } from '../card-scale.ts'
import { searchCards } from '../card-search.ts'
import { CARD_TOP_ID } from '../card-sections.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import { cardsInGridOrder, cardTotals } from '../card-standings.ts'
import {
  CARD_TOTAL_SORTS,
  cardTotalSortLabel,
  sortCardTotalsForDisplay,
  type CardTotalSort,
} from '../card-total-sort.ts'
import {
  CARD_TOTAL_VIEWS,
  parseCardTotalView,
  type CardTotalView,
} from '../card-total-view.ts'
import { useBaseScope, useCardColumns, useMeasuredWidth, usePersistedChoice } from '../hooks.ts'
import { lastBaseKey, rememberedBaseTag } from '../last-base.ts'
import { ownerRecordFor, useOwners, useOwnersState } from '../owners.ts'
import { tradeFodder } from '../trade-fodder.ts'
import { useCardRefresh } from '../use-card-refresh.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
import { BackToTop, HeadingJumpChip, SectionJumpRow } from './CardSectionNav.tsx'
import { CardsLeaderboardSection } from './CardsLeaderboardSection.tsx'
import { CardTotals, useCardTotalSort } from './CardTotals.tsx'
import { ErrorPanel, HelpLink, Loading } from './primitives.tsx'
import { TradeSuggestions } from './TradeSuggestions.tsx'
import { TradeTracker } from './TradeTracker.tsx'

/**
 * The card-collecting event: who holds what, and who should trade with whom.
 *
 * The bases are `owner_assignments` — the set of player tags the group already
 * tracks — so there is no second list of bases to curate and drift. The owner is
 * shown beside every base because the owner is the person who would do the
 * trading; a tag on its own tells you nothing about who to message.
 *
 * All the rules live in pure modules — the trade rules in `card-trades.ts`, the
 * card shaping in `cards.ts`, the leaderboard order and the group totals in
 * `card-standings.ts`, the base filter in `base-scope.ts`, and the paging in
 * `saved-table.ts`. This file is the controls, the panels, and reporting failures
 * at the control that caused them.
 *
 * **Three pieces of it are shared with the player page**, which is the same event
 * seen from one base: the 60-tile grid and its entry form (`BaseCardEditor`), one
 * tile of either grid (`CardTile`), and the suggestions table
 * (`TradeSuggestions`) — clan-wide here, narrowed to one base there. Naming a base
 * is shared too, in `useBaseLabels`, so both pages print the same text for it.
 *
 * **The page narrows as it goes down.** The picker and the grid are the one base
 * you can act on; everything below is the whole clan and is deliberately *not*
 * filtered by the picker's Mine/All choice — see the note on each section.
 *
 * The order is: picker, plaques and grid → **trade suggestions** → collection
 * leaderboard → cards across the clan. The trades' position was asked for; the rest
 * follows from it. Trades read against the grid immediately above them — the spares
 * you have just typed in are what the suggestions are made of — and they are the
 * only panel that asks you to *do* something. The leaderboard and the clan totals
 * are both reference, and the totals are sixty more tiles, so they go last.
 *
 * The one thing the totals grid can be asked is **who** holds a card: a tile there is
 * a button, and pressing it opens the holders table under the grid. That needs no
 * route of its own — `/api/cards/inventory` already returns every base's per-card
 * counts, so it is a projection of the same `bases` array, in `card-holders.ts`.
 */

/*
 * The stylesheet's own gap values for the two breakpoints, and the width the narrow
 * one takes over at. Duplicated from styles.css because the density arithmetic needs
 * a number and CSS cannot hand one back — kept named and adjacent so the pair is
 * findable if either side moves.
 */
const WIDE_GRID_GAP = 10
const NARROW_GRID_GAP = 4
const NARROW_GRID_WIDTH = 600

/** Where the chosen display order for "Cards across the clan" is remembered. */
const TOTAL_SORT_KEY = 'coc:cardTotalSort'

/** Where the chosen view (Totals or Trade Fodder) for the same panel is remembered. */
const TOTAL_VIEW_KEY = 'coc:cardTotalView'

export function CardsView({ user }: { user: SessionUser }) {
  /*
   * The counts on this page are two people's, not one's: completing a trade moves a
   * card on both bases, and the person who pressed Complete is usually in another
   * tab. So the page re-reads both shared stores while it is open — on focus and
   * every ten seconds, never while hidden and never across a save. The rules are
   * `card-refresh.ts` and the mechanism `use-card-refresh.ts`; both endpoints are
   * local SQLite reads, which is what makes polling them affordable.
   */
  useCardRefresh()

  const state = useCardInventoryState()
  const bases = state.entries
  const ownersState = useOwnersState()
  const owners = useOwners()

  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (tag: string) => byTag.get(tag)
  }, [owners])

  const ownerUserIdOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.ownerUserId ?? null]))
    return (tag: string) => byTag.get(tag) ?? null
  }, [owners])

  /*
   * The tracked bases and the text to print for each. Which bases those are, and
   * how a shared name is disambiguated, is `useBaseLabels`' — shared with the
   * player page's trade table so the two name the same base the same way.
   *
   * `allOptions` is the list the Base select offers before the Mine/All filter, and
   * is computed over **every** tracked base rather than the filtered subset: the
   * labels have to read the same in the group-wide panels below, and a name shared by
   * two bases must still be disambiguated when the filter offers only one of them.
   */
  const { tags, options: allOptions, labelOf } = useBaseLabels(owners, bases)

  /*
   * Mine / All. Every rule is in `base-scope.ts`; the only decision here is when
   * the default may be worked out, which is once the owner list has actually
   * landed — an empty first snapshot would say this account owns nothing and open
   * on `All` for everybody. An error counts as landed: we will not learn any more,
   * and `All` is the answer that shows something.
   */
  const ownersReady = ownersState.status === 'ready' || ownersState.status === 'error'
  const scopedBases = useMemo(
    () => owners.map((entry) => ({ tag: entry.tag, ownerUserId: entry.ownerUserId ?? null })),
    [owners],
  )
  const ownsAny = useMemo(() => ownsAnyBase(scopedBases, user.id), [scopedBases, user.id])
  const [scope, setScope] = useBaseScope(user.id, ownsAny, ownersReady)

  const mineTags = useMemo(
    () => tagsInScope(scopedBases, 'mine', user.id),
    [scopedBases, user.id],
  )
  /*
   * Read-only here: this page reorders nothing, it only shows the order
   * `#/base-order` saved. `reorder()` is left unused on purpose — see the doc
   * on `useBaseOrder` for why the read side alone is what a caller like this
   * wants.
   */
  const baseOrder = useBaseOrder(mineTags, ownersReady)

  const options = useMemo(() => {
    if (scope === 'all') return allOptions
    /*
     * Mine is ordered by the saved base order, not alphabetically like `All`
     * stays — `applyBaseOrder` only reorders, so a tag `baseOrder` has not
     * caught up with yet (still loading, or reconciliation not run) simply
     * keeps `allOptions`' alphabetical position instead of vanishing.
     */
    const mine = new Set(mineTags)
    const mineOptions = allOptions.filter((option) => mine.has(option.tag))
    return applyBaseOrder(mineOptions, baseOrder.tags)
  }, [allOptions, scope, mineTags, baseOrder.tags])

  /*
   * The base the picker was left on, per account, at `coc:cardBase:<id>` — so a
   * reload comes back to the base you were entering rather than to the head of the
   * list. Every rule is in `last-base.ts`, including why a stored value that is not
   * a tag has to read as "nothing remembered" rather than throw; what is here is
   * the reading and the writing.
   *
   * Read once, when this page mounts. There is no per-account guard of the kind
   * `useBaseScope` carries, because there is nothing for it to do: `App` renders the
   * sign-in screen when there is no session, so the account cannot change under a
   * mounted `CardsView`.
   */
  const [selected, setSelected] = useState<string | null>(() =>
    rememberedBaseTag(localStorage.getItem(lastBaseKey(user.id))),
  )

  /*
   * Written at the two places the page commits to a base — the picker, and the
   * Mine/All change that carries the current base across the filter — rather than by
   * an effect on `active`. Same shape as `useBaseScope`'s `choose` and
   * `useRowLimit`'s, and the difference is not cosmetic here: `active` is a *derived*
   * value that spends the first renders of every load as "the head of whatever list
   * has arrived so far", before the names, the owners and the resolved filter are in.
   * An effect on it would overwrite the remembered tag with that transient default on
   * the way to reading it back, which is the memory deleting itself.
   */
  const chooseBase = useCallback(
    (tag: string | null) => {
      setSelected(tag)
      if (tag !== null) localStorage.setItem(lastBaseKey(user.id), tag)
    },
    [user.id],
  )

  /*
   * `activeTag` is both the default and the repair: it keeps the chosen base while
   * the filtered list still offers it and otherwise falls to the head of that list.
   * That is what moves the selection when switching to `Mine` while looking at
   * somebody else's base — the editor below follows it rather than being left
   * showing counts the picker no longer offers. `options[0]`, not `tags[0]`: the
   * list is ordered by member name, so defaulting by tag would leave the select
   * showing its second or third entry as the chosen one.
   *
   * It is also the whole handling of a *remembered* base that is no longer offered —
   * unassigned, removed, or dropped by `Mine`. A stale key falls to the head of the
   * list exactly as an emptied filter does, so it can never leave the page blank.
   */
  const active = activeTag(options, selected)

  const totals = useMemo(() => cardTotals(bases, cardsInGridOrder()), [bases])
  const absentCount = useMemo(() => totals.filter((entry) => entry.absent).length, [totals])

  /*
   * Display order for "Cards across the clan" alone — `cardTotals()` above still
   * never sorts itself, for every other reader of `totals`. This is a deliberate,
   * opt-in exception layered on top, in `sortCardTotalsForDisplay()`; see that
   * function's doc comment, and `cardTotals()`'s own, for why the two do not
   * contradict each other.
   */
  const [totalSort, setTotalSort] = useCardTotalSort(TOTAL_SORT_KEY)
  const sortedTotals = useMemo(
    () => sortCardTotalsForDisplay(totals, totalSort),
    [totals, totalSort],
  )

  /*
   * Which reading of the same sixty tiles the panel shows — the clan-wide count
   * ("Totals", unchanged) or which cards are safe to trade away ("Trade Fodder",
   * `tradeFodder()` in `trade-fodder.ts`). Independent of `totalSort` above: the
   * Sort control still ranks `sortedTotals` by `total` in either view, so choosing
   * Trade Fodder does not lose a Highest/Lowest choice already in effect, and
   * switching sort does not silently reset the view.
   */
  const [totalView, setTotalView] = usePersistedChoice(TOTAL_VIEW_KEY, parseCardTotalView)
  const fodder = useMemo(() => tradeFodder(sortedTotals, bases), [sortedTotals, bases])
  const fodderById = useMemo(
    () => (totalView === 'fodder' ? new Map(fodder.map((entry) => [entry.card.id, entry])) : null),
    [totalView, fodder],
  )
  const notFullyHeldCount = useMemo(
    () => fodder.filter((entry) => !entry.held).length,
    [fodder],
  )

  const emptyMine = scope === 'mine' && options.length === 0 && tags.length > 0

  /*
   * The grid's own width, and the density it allows.
   *
   * Measured off the header this row sits in, which shares the card's content box with
   * the grid below it — so it is the same width without needing a ref threaded into a
   * child component. The gap is read from the stylesheet's own value for this
   * breakpoint rather than duplicated as a constant.
   */
  const [rowRef, rowWidth] = useMeasuredWidth<HTMLElement>()
  const gridGap = rowWidth > 0 && rowWidth <= NARROW_GRID_WIDTH ? NARROW_GRID_GAP : WIDE_GRID_GAP
  const [columns, setColumns] = useCardColumns('coc:cardColumns', rowWidth, gridGap)
  const columnOptions = cardColumnOptions(rowWidth, gridGap)

  /* Transient on purpose: a filter that survived navigating away would leave somebody
     returning to a grid with 57 cards missing and no memory of why. */
  const [query, setQuery] = useState('')
  const found = useMemo(() => searchCards(cardsInGridOrder(), query), [query])

  return (
    <>
      <section className="card" ref={rowRef}>
        <div className="card-header">
          {/* The anchor every back-to-top arrow returns to, and the only heading here
              that gets an id without an arrow of its own — there is nothing above it.
              `tabIndex={-1}` so `jumpToSection` can move the caret here; it stays out
              of the tab order, which `-1` is exactly what means. */}
          <h2 className="section-title" style={{ margin: 0 }} id={CARD_TOP_ID} tabIndex={-1}>
            Clash of Cards
          </h2>
          <div className="card-header__tools">
            {tags.length > 0 ? (
              <>
                {/* Left of the picker, because it decides what the picker offers.
                    A select rather than a pair of buttons: it is the control beside
                    it, it shows its own state without being opened, and it already
                    has a 44px target and a 16px font on a phone. */}
                <label className="row-limit" htmlFor="cards-scope">
                  Show
                  <select
                    id="cards-scope"
                    value={scope}
                    onChange={(event) => {
                      /*
                       * Carries the base currently on screen across the filter
                       * change. Widening to `All` must not bump you off the base you
                       * were reading, and it would: until the picker has been used,
                       * nothing is *chosen* and the active base is just "the first
                       * one offered", which is a different base in the longer list.
                       * Narrowing to `Mine` carries it too, and then `activeTag`
                       * drops it — but only if it genuinely is not yours.
                       *
                       * Done here rather than by remembering whatever went active:
                       * the offered list is ordered by member *name*, and those
                       * arrive after the tags do, so anything that latched the
                       * first-offered base early would pin the tag-alphabetical one
                       * for good.
                       */
                      chooseBase(active)
                      setScope(event.target.value as BaseScope)
                    }}
                  >
                    <option value="mine">Mine</option>
                    <option value="all">All</option>
                  </select>
                </label>
                {options.length > 0 ? (
                  <label className="row-limit" htmlFor="cards-base">
                    Base
                    <select
                      id="cards-base"
                      value={active ?? ''}
                      onChange={(event) => chooseBase(event.target.value)}
                    >
                      {options.map((option) => (
                        <option key={option.tag} value={option.tag}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {/*
                 * Search and density, in the same container as Show and Base — they are
                 * all questions about what this one panel shows, and the container
                 * already wraps, so "same row if they fit" is decided by the width
                 * rather than by markup. They come after the two pickers because those
                 * choose *which base* and these choose *how to look at it*.
                 */}
                {active !== null ? (
                  <>
                    <label className="row-limit" htmlFor="cards-search">
                      Find
                      <input
                        id="cards-search"
                        type="search"
                        className="card-controls__search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Card name"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>

                    {/*
                     * Only where there is a choice. On a phone six across is the only
                     * density that fits, so `cardColumnOptions` returns one entry and
                     * this renders nothing rather than a picker that cannot change
                     * anything — which is what "only useful on larger screens" means in
                     * practice.
                     */}
                    {columnOptions.length > 1 ? (
                      <label className="row-limit" htmlFor="cards-columns">
                        Per row
                        <select
                          id="cards-columns"
                          value={String(columns)}
                          onChange={(event) => setColumns(Number(event.target.value))}
                        >
                          {columnOptions.map((option) => (
                            <option key={option} value={String(option)}>
                              {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {/*
         * Below the controls rather than among them: those choose what this panel
         * shows, these leave it entirely, and a Leaderboard button between `Base` and
         * `Find` would read as a third filter. It reads as a second line of the
         * header's tools all the same — right-aligned to the same edge — which is
         * `.card-jump`'s doing and is explained there, including why it is a sibling of
         * `.card-header` rather than a child of `.card-header__tools`.
         *
         * Drawn unconditionally, unlike the controls above, which are all inside
         * `tags.length > 0`. The three panels it points at are group-wide and are
         * rendered whatever this account owns — the row would be at its most useful
         * to somebody with no bases of their own, who has nothing to type into the
         * grid and is only here to read.
         */}
        <SectionJumpRow />

        {/* Said out loud, because a grid with 57 tiles missing looks like a fault until
            something explains it. Below the row rather than in it: it is a result, not a
            control, and it appears and disappears as you type. */}
        {found.filtering ? (
          <p className="card-controls__count">
            {found.cards.length === 0
              ? `No card matches “${query.trim()}”`
              : `Showing ${found.cards.length} of ${found.total} cards`}
          </p>
        ) : null}

        {state.status === 'error' && state.error ? <ErrorPanel error={state.error} /> : null}

        {tags.length === 0 && state.status === 'loading' ? (
          <Loading what="card counts" />
        ) : tags.length === 0 ? (
          <p className="empty-hint">
            No bases to track yet. Card counts hang off the <strong>owner assignments</strong> —
            open a clan and set an owner on a member, and that base appears here.
          </p>
        ) : null}

        {/* An empty dropdown would say nothing. Ownership is assigned by an admin,
            so that is the actual next step, and `All` is one control away. */}
        {emptyMine ? (
          <p className="empty-hint">
            None of the {tags.length} tracked base{tags.length === 1 ? '' : 's'} is yours. A base
            becomes yours when an <strong>admin assigns it to your account</strong> on the clan
            page — ask one to do that. Meanwhile, switch <strong>Show</strong> to{' '}
            <strong>All</strong> to read everybody's counts; the leaderboard and the card totals
            below cover the whole clan either way.
          </p>
        ) : null}
      </section>

      {active !== null ? (
        <section className="card">
          <BaseCardEditor
            key={active}
            tag={active}
            label={labelOf(active)}
            base={inventoryFor(bases, active)}
            /* Only the *owner* of the chosen base may type into the grid, so the
               editor is handed that base's assignment rather than being left to
               guess from the label beside it. */
            owner={baseOwnerOf(ownerRecordFor(owners, active))}
            user={user}
            columns={columns}
            query={query}
            /* The four deck plaques, under the count line in the header. Only here:
               the player page draws its own above the panel that holds this grid. */
            showDeckProgress
          />
        </section>
      ) : null}

      {/* Immediately under the grid: the spares just typed in are what the
          suggestions are made of, and this is the only panel on the page that asks
          you to do something. */}
      <section className="card">
        <h2 className="section-title section-title--jump" id="cards-suggestions" tabIndex={-1}>
          Trade suggestions <HelpLink section="trades" topic="what makes a swap legal" />
          <HeadingJumpChip label="Tracker" to="cards-tracker" />
          <BackToTop from="Trade suggestions" />
        </h2>
        <TradeSuggestions bases={bases} labelOf={labelOf} ownerOf={ownerOf} user={user} />
      </section>

      {/*
       * Directly below the suggestions, which is the order the work happens in: the
       * table above says what *could* be swapped, this says what has been agreed and
       * is waiting on somebody. Its own panel rather than a second table inside that
       * one, because a row here is a stored record with consequences — completing it
       * moves cards on two bases — and that is a different kind of thing from a row
       * of arithmetic.
       */}
      <section className="card">
        <h2 className="section-title section-title--jump" id="cards-tracker" tabIndex={-1}>
          Trade tracker{' '}
          <HelpLink section="tracker" topic="who can complete a trade, and what it does" />
          <HeadingJumpChip label="Suggestions" to="cards-suggestions" />
          <BackToTop from="Trade tracker" />
        </h2>
        <TradeTracker user={user} labelOf={labelOf} />
      </section>

      <section className="card">
        <h2 className="section-title section-title--jump" id="cards-leaderboard" tabIndex={-1}>
          Collection leaderboard <HelpLink section="leaderboard" topic="how the leaderboard scores" />
          <BackToTop from="Collection leaderboard" />
        </h2>

        <CardsLeaderboardSection
          bases={bases}
          tags={tags}
          labelOf={labelOf}
          ownerOf={ownerOf}
          ownerUserIdOf={ownerUserIdOf}
          user={user}
        />
      </section>

      {/*
       * Last, and still collapsed: it is sixty more tiles, and left open it would
       * push everything above it off a phone screen. It costs no extra art either
       * way — measured, the totals grid's sixty image URLs are byte-for-byte the
       * grid's above, so opening it adds no requests, only the drawing.
       */}
      <section className="card">
        {/* An arrow but no chip in the row above. It is the bottom of the page, so it
            is the worst place to strand somebody and the best claim on an arrow — and
            it was the fourth chip that took that row from one line to two at 390px.
            The only one of the four whose heading carries no `HelpLink`, so the arrow
            is its sole flex item after the text and `margin-left: auto` is doing all
            the work. */}
        <h2 className="section-title section-title--jump" id="cards-totals" tabIndex={-1}>
          Cards across the clan
          <BackToTop from="Cards across the clan" />
        </h2>
        <details className="group">
          <summary>
            All {totals.length} cards
            {totalSort === 'default'
              ? ', in grid order'
              : `, sorted ${cardTotalSortLabel(totalSort).toLowerCase()}`}
            <span
              className={
                (totalView === 'fodder' ? notFullyHeldCount : absentCount) > 0
                  ? 'card-panel__trades card-total__none'
                  : 'card-panel__trades card-meta'
              }
            >
              {' · '}
              {totalView === 'fodder'
                ? notFullyHeldCount > 0
                  ? `${notFullyHeldCount} not held by every base`
                  : 'every card is held by every base'
                : absentCount > 0
                  ? `${absentCount} nobody holds`
                  : 'every card is held by somebody'}
            </span>
          </summary>
          <div className="group__body">
            {/*
             * Off by default, and deliberately so: the panel's whole reason for
             * existing is scanning it tile-for-tile against the entry grid above,
             * which only holds in `Grid order`. This is a named, opt-in exception
             * to that — see the doc comments on `cardTotals()` in
             * `card-standings.ts` and `sortCardTotalsForDisplay()` in
             * `card-total-sort.ts` — not a quiet reversal of it, which is why the
             * summary line and the paragraph below both say out loud when it is
             * in effect.
             *
             * Labeled `Read as`, not `View` — the collection leaderboard above
             * already has a control literally called `View` (`leaderboard-view`),
             * and both are mounted on this same page at once, so a second `View`
             * would be two controls sharing one accessible name a screen reader,
             * and `getByLabelText`, cannot tell apart. `Read as` also says more
             * plainly what the control does: it changes how the *same* sixty
             * tiles are read, not which tiles are shown.
             *
             * It sits before `Sort`, deciding *what the tiles mean* before `Sort`
             * decides *what order they're in* — the two are independent:
             * switching this leaves whatever Sort was already chosen in place,
             * and vice versa. `Sort` itself is untouched by the addition — it
             * still ranks `sortedTotals` by `total` (`sortCardTotalsForDisplay`),
             * never by the Trade Fodder view's own `extra`, a deliberate scope
             * decision rather than a gap: giving `Sort` a second sortable value
             * per view is a real feature, just not this one.
             */}
            <label
              className="row-limit"
              htmlFor="card-total-view"
              style={{ marginBottom: 12 }}
            >
              Read as
              <select
                id="card-total-view"
                value={totalView}
                onChange={(event) => setTotalView(event.target.value as CardTotalView)}
              >
                {CARD_TOTAL_VIEWS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="row-limit"
              htmlFor="card-total-sort"
              style={{ marginBottom: 12 }}
            >
              Sort
              <select
                id="card-total-sort"
                value={totalSort}
                onChange={(event) => setTotalSort(event.target.value as CardTotalSort)}
              >
                {CARD_TOTAL_SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {cardTotalSortLabel(sort)}
                  </option>
                ))}
              </select>
            </label>
            {/* The last sentence is what tells anybody the tiles are pressable. A grid
                of sixty buttons has no other affordance at this size — there is no room
                for a caption on a 52px tile — so the panel says it once, in the line
                that is already explaining what the badges mean. Two entirely different
                paragraphs, not one reused across both `View` states: what gray-with-no-
                badge *means* inverts between them (nobody holds it, versus somebody
                still needs it), so a single paragraph patched with a ternary in the
                middle would read as a hedge instead of a plain statement of the rule
                actually in effect. */}
            {totalView === 'fodder' ? (
              <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
                The same grid as above, reading it a different way: which cards are safe to{' '}
                <strong>give away</strong> without leaving any tracked base short. A tile in{' '}
                <strong>gray with no badge</strong> means at least one reporting base does not
                hold this card yet — keep it, someone still needs it. A tile{' '}
                <strong>in color</strong> means every reporting base already has one, and its
                badge is the surplus past that — copies free to trade once everybody's own is
                accounted for, so <strong>×0</strong> is "held by everyone, nothing spare" and
                a higher number is easy fodder. <strong>Choose a card</strong> to list the
                bases holding it below, same as the Totals view.
              </p>
            ) : (
              <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
                The same grid as above, with the copies held across <strong>every</strong>{' '}
                tracked base — linked to an account or not — as the badge in each tile's
                corner.{' '}
                {totalSort === 'default' ? (
                  <>The order is the grid's, so the two can be read tile for tile.</>
                ) : (
                  <>
                    Sorted by clan-wide total ({cardTotalSortLabel(totalSort).toLowerCase()}),
                    so tiles no longer line up with the grid above — choose{' '}
                    <strong>Grid order</strong> to restore that.
                  </>
                )}{' '}
                A tile in <strong>gray with no badge</strong> is a card nobody in the clan
                holds; it cannot be got by trading, only from the game.{' '}
                <strong>Choose a card</strong> to list the bases holding it below.
              </p>
            )}
            <CardTotals
              totals={sortedTotals}
              columns={columns}
              bases={bases}
              labelOf={labelOf}
              grouped={totalSort === 'default'}
              fodderById={fodderById}
            />
          </div>
        </details>
      </section>
    </>
  )
}
