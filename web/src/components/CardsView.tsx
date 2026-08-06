import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { MAX_CARD_COUNT, type BaseInventory, type SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { applyBaseOrder, useBaseOrder } from '../base-order.ts'
import { activeTag, ownsAnyBase, tagsInScope, type BaseScope } from '../base-scope.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { cardDemand, cardHolders, type CardDemand, type CardHolder } from '../card-holders.ts'
import { cardColumnOptions } from '../card-scale.ts'
import { searchCards } from '../card-search.ts'
import {
  CARD_JUMP_TARGETS,
  CARD_TOP_ID,
  scrollBehaviorFor,
  type CardSectionId,
} from '../card-sections.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import {
  activeOwnerFilter,
  ALL_OWNERS,
  baseStandings,
  cardPoints,
  cardTotals,
  cardsInGridOrder,
  filterStandingsByOwner,
  lastUpdatedCell,
  standingOwnerOptions,
  type BaseStanding,
  type CardTotal,
} from '../card-standings.ts'
import { deckSlug } from '../cards.ts'
import { formatDateTime, formatFull, formatRelative } from '../format.ts'
import {
  hrefFor,
  useBaseScope,
  useCardColumns,
  useMeasuredWidth,
  useRowLimit,
} from '../hooks.ts'
import { lastBaseKey, rememberedBaseTag } from '../last-base.ts'
import { ownerRecordFor, useOwners, useOwnersState } from '../owners.ts'
import { paginate, type RowLimit } from '../saved-table.ts'
import { useCardRefresh } from '../use-card-refresh.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
import { CardTile } from './CardTile.tsx'
import { ScoringRules } from './help-copy.tsx'
import {
  ErrorPanel,
  GameIcon,
  HelpLink,
  Loading,
  Meter,
  Pager,
  RowLimitSelect,
} from './primitives.tsx'
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


/**
 * Rows-per-page options for the leaderboard.
 *
 * No `All`, unlike the trade suggestions: 50 already covers every tracked base in
 * this install with room to spare, so `All` would be a second name for the option
 * next to it — and an unbounded board is the thing the limit exists to prevent.
 */
const STANDING_LIMITS: RowLimit[] = [5, 10, 20, 50]

/**
 * The staleness column's heading, written once.
 *
 * The table stacks on a phone and each cell prints its own heading from `data-label`,
 * so the words exist twice in the markup; naming them here is what stops the column
 * head and the stacked label drifting apart, exactly as `rosterColumnLabel` does for
 * the clan roster.
 */
const LAST_UPDATED_LABEL = 'Last updated'

/**
 * When this base's counts were last saved.
 *
 * The words and the "Never" state are `lastUpdatedCell`'s, tested there; what is here
 * is which of the two it draws. A base nobody has ever entered gets `.role-pill`, the
 * same muted treatment the Owner column gives "no owner set" — an absence, stated,
 * rather than a dash somebody has to interpret. A base with a stamp gets the relative
 * age with the exact moment on its `title`, as the attribution line above the grid and
 * the build stamp in the footer both do.
 */
function LastUpdated({ updatedAt }: { updatedAt: string | null }) {
  const cell = lastUpdatedCell(updatedAt, formatRelative, formatDateTime)

  return (
    <td role="cell" data-label={LAST_UPDATED_LABEL}>
      {cell.never ? (
        <span className="role-pill">{cell.text}</span>
      ) : (
        <span className="card-meta" title={cell.exact ?? undefined}>
          {cell.text}
        </span>
      )}
    </td>
  )
}

/**
 * How far every tracked base has got, best first.
 *
 * **Group-wide by default, and never filtered by the picker.** The Mine/All select at
 * the top of the page chooses which base you can *type into*; it has no business
 * narrowing a board about the whole clan's progress, and it still does not touch it.
 * The board sits directly under the trade suggestions because "who should trade with
 * whom" and "who is furthest ahead" are the same question asked two ways — the base
 * near the top with spares is the one worth messaging.
 *
 * **Its own Owner filter is a separate control, and it exists for a question the
 * picker cannot answer.** This comment used to argue that the board must never be
 * narrowed to one person, on the grounds that a leaderboard of one answers nothing.
 * That is still true of *ranking* — which is why the ranking is untouched, below — but
 * it was the wrong conclusion about *reading*. An owner with several bases has a
 * maintenance question, "which of mine has nobody entered counts for lately", and the
 * only place that fact was shown was the attribution line above the grid, one base at
 * a time behind a `<select>`. Answering it meant clicking through the picker and
 * remembering what each one said. The Last updated column plus this filter is that
 * same fact for every base at once. The board still opens on **Everyone**, so nobody
 * who came for the clan's progress has to put the filter back.
 *
 * The order is `baseStandings`', not this component's: **points** descending, then
 * distinct descending, then member name and tag. Ties are the *normal* case early in
 * an event, which is why the comparator is total and lives somewhere tested. (This
 * note used to say "distinct descending, then copies descending", which was the
 * measure before `cardPoints` — the same staleness the intro line under the heading
 * below was carrying.)
 *
 * **Neither paging nor the owner filter touches the rank.** The number in the first
 * column is `baseStanding.rank` — computed once over the whole board, shared on a
 * genuine tie and skipping the numbers a tie consumes — so rank 6 reads 6 wherever it
 * is printed. Numbering the visible rows instead would restart at 1 on page 2, and
 * ranking the filtered rows would renumber somebody's four bases to 1–4 and read as if
 * they were the clan; either turns the one column that means something into a row
 * counter. `filterStandingsByOwner` therefore only ever removes rows from a board
 * `baseStandings` has already numbered.
 */
function Leaderboard({ rows }: { rows: BaseStanding[] }) {
  const [limit, setLimit] = useRowLimit('coc:cardStandingLimit', 5)
  const [page, setPage] = useState(1)
  /* Transient, like the card search and unlike the row limit: a filter that survived a
     reload would leave somebody opening the page to a board with most of the clan
     missing and no memory of having asked for that. */
  const [owner, setOwner] = useState(ALL_OWNERS)

  const ownerOptions = useMemo(() => standingOwnerOptions(rows), [rows])
  /* Derived rather than repaired by an effect, for the reason `activeTag` is: the
     board is re-read in the background, so the chosen owner can leave it. */
  const chosenOwner = activeOwnerFilter(ownerOptions, owner)
  const filtered = useMemo(() => filterStandingsByOwner(rows, chosenOwner), [rows, chosenOwner])
  const view = useMemo(() => paginate(filtered, limit, page), [filtered, limit, page])

  /* Two ways the board gets shorter under a page number that was fine a moment ago: a
     base losing its owner assignment, and the Owner filter narrowing it. Both leave
     the page past the end, `paginate` clamps for both, and this follows it — one
     repair rather than one per cause. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  if (rows.length === 0) return null

  return (
    <>
      {/*
       * Above the table, in the roster's own filter row, because it decides what the
       * table holds — and drawn only where it has something to choose between. One
       * owner and no unowned bases is two options that select the same board, which is
       * the control that answers a press by doing nothing that this page refuses to
       * hand out.
       */}
      {ownerOptions.length > 2 ? (
        <div className="roster-filters">
          <label htmlFor="leaderboard-owner">
            Owner
            <select
              id="leaderboard-owner"
              value={chosenOwner}
              onChange={(event) => setOwner(event.target.value)}
            >
              {ownerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <div className="table-wrap">
        {/*
         * Named with `aria-label` rather than pointed at the section's own `<h2>`.
         * `.section-title` is `text-transform: uppercase`, and Chrome computes an
         * accessible name from the *transformed* text — read back off the computed
         * tree, `aria-labelledby` gave this table the name "COLLECTION LEADERBOARD".
         * The visible heading is the same words, so label-in-name still holds.
         */}
        <table className="roster roster--stack" role="table" aria-label="Collection leaderboard">
          <thead role="rowgroup">
            <tr role="row">
              <th className="num" role="columnheader">
                Rank
              </th>
              <th role="columnheader">Member</th>
              <th role="columnheader">Owner</th>
              {/* First of the numbers because it is what the ranking is on. */}
              <th className="num" role="columnheader">
                Points
              </th>
              <th className="num" role="columnheader">
                Cards
              </th>
              <th className="num" role="columnheader">
                Copies
              </th>
              {/* Last, after the three numbers: it is about the record rather than
                  about the collection, and it is the one column somebody scans down
                  rather than compares across. */}
              <th role="columnheader">{LAST_UPDATED_LABEL}</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.rows.map((row) => (
              <tr key={row.tag} role="row">
                <td className="num" role="cell" data-label="Rank">
                  {row.rank}
                </td>
                <td className="stack-title" role="cell">
                  <a href={hrefFor({ view: 'player', tag: row.tag })}>{row.label}</a>
                  {/* The tag, again as secondary text rather than as the heading. */}
                  {row.label === row.tag ? null : (
                    <>
                      <br />
                      <span className="card-meta">{row.tag}</span>
                    </>
                  )}
                </td>
                <td role="cell" data-label="Owner">
                  {row.owner ?? <span className="role-pill">no owner set</span>}
                </td>
                <td className="num" role="cell" data-label="Points">
                  {/*
                   * Kept beside `17/60` rather than replacing it: a bare score does
                   * not say how far through the sixty a base is, and the fraction
                   * alone no longer explains why one row outranks another.
                   *
                   * The best possible score comes from the curve rather than a
                   * literal 55, so raising `MAX_CARD_COUNT` cannot leave this
                   * tooltip quoting a ceiling that no longer exists.
                   */}
                  {row.recorded ? (
                    <span
                      title={`${formatFull(row.points)} of ${formatFull(
                        row.size * cardPoints(MAX_CARD_COUNT),
                      )} possible`}
                    >
                      {formatFull(row.points)}
                    </span>
                  ) : (
                    <span className="card-meta">—</span>
                  )}
                </td>
                <td className="num" role="cell" data-label="Cards">
                  {/*
                   * A base nobody has ever saved is not a base holding zero of
                   * everything — the same distinction the grid's attribution line
                   * draws — so it says so in words instead of printing `0/60`.
                   */}
                  {row.recorded ? (
                    <div className="donation-cell">
                      <span>
                        {row.distinct}/{row.size}
                      </span>
                      <Meter
                        value={row.distinct}
                        max={row.size}
                        label={`${row.label} holds ${row.distinct} of ${row.size} cards`}
                      />
                    </div>
                  ) : (
                    <span className="card-meta">Nothing recorded yet</span>
                  )}
                </td>
                <td className="num" role="cell" data-label="Copies">
                  {row.recorded ? row.total : '—'}
                </td>
                <LastUpdated updatedAt={row.updatedAt} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* At the bottom, beside the pager, exactly as the clan roster's is. */}
      <div className="roster-footer">
        <RowLimitSelect
          id="leaderboard-rows"
          options={STANDING_LIMITS}
          value={limit}
          onChange={(next) => {
            setLimit(next)
            setPage(1)
          }}
        />
        <Pager view={view} noun="bases" onPage={setPage} />
      </div>
    </>
  )
}

/** How a clan total reads in words. The one place that sentence is written. */
function heldAcrossTheClan(total: number): string {
  return total > 0 ? `${total} held across the clan` : 'none held across the clan'
}

/**
 * Every card, and how many copies the whole group holds between them — as the
 * **same tile grid** the base above is entered in.
 *
 * A grid rather than the list of `.meter-row`s this was: the two are meant to be
 * read against each other, and the only way to do that reliably is for them to
 * look the same and sit in the same order, tile for tile. It is literally the same
 * `CardTile`, so the art, the crop, the deck frame and the grayscale cannot drift
 * from the grid's; what differs is the badge and where the name comes from.
 *
 * **The order is the grid's, fixed, and never the counts'.** It comes from
 * `cardsInGridOrder()` — the same `cardCategoriesInOrder()` then
 * `cardsInCategory()` the tiles above are drawn from — so this can be scanned
 * card-for-card against them. Sorting it by count would make it a different grid
 * that happened to hold the same numbers, and the one thing it is for would be gone.
 *
 * **The badge appears on every count, including 1.** The opposite of the entry
 * grid, where `×1` on fifty tiles is noise: here the totals *are* the point, and a
 * card exactly one person in the clan holds is one of the more interesting things
 * on the page.
 *
 * **A card nobody holds is grayscale with no badge** — which is a color cue and a
 * missing cue, so it cannot be the whole story. The words are in the tile's own
 * accessible name (`Barbarian, Elixir — none held across the clan`) and in its
 * `title`, and the disclosure line above counts them. The tile stays exactly where
 * it is: nothing sorts, in any mode.
 *
 * **Every tile is a button**, and pressing one lists the bases holding that card
 * below the grid — see `CardHolders`. Including the 38 of sixty nobody holds, which
 * was the decision worth making rather than assuming. The rule this page keeps is
 * that a control is never dead and never navigates nowhere, and "nobody in the clan
 * holds it, so it cannot be traded for" is an answer — arguably the most useful one
 * on the panel, since it is the one the badge cannot show. The alternative, tiles
 * that respond only where a badge happens to be, was rejected: it makes two thirds of
 * the grid silently inert, leaves nothing to explain why a press did nothing, and
 * would have a keyboard user tabbing through a set of stops that changes with the
 * counts.
 *
 * Group-wide, like the leaderboard, and including the bases whose owner is still
 * only a text label — most of them are — because their cards are as tradeable as
 * anyone's and leaving them out would undercount the group by more than half.
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

/**
 * The id of the holders block below the grid, so the pressed tile can point at the
 * thing it opened. Only the pressed one carries `aria-controls`: on the other
 * fifty-nine there is nothing with this id to point at, and an `aria-controls`
 * naming an element that does not exist is worse than none.
 */
const HOLDERS_ID = 'card-holders'

function CardTotalsGrid({
  totals,
  columns,
  picked,
  onPick,
}: {
  totals: CardTotal[]
  columns: number
  /** The card whose holders are shown below, or `null` for none. */
  picked: number | null
  onPick: (cardId: number | null) => void
}) {
  /* Grouped by deck exactly as the grid is: `display: contents`, so the tiles stay
     direct children of the one grid, named by a hidden heading. Walking `totals` in
     the order it arrives is what guarantees the two grids agree — grouping cannot
     reorder. The heading ids are its own: `BaseCardEditor` is mounted on this page
     too and carries `card-deck-*`. */
  const decks: { category: string; slug: string; entries: CardTotal[] }[] = []
  for (const entry of totals) {
    const last = decks[decks.length - 1]
    if (last?.category === entry.card.category) last.entries.push(entry)
    else
      decks.push({
        category: entry.card.category,
        slug: deckSlug(entry.card.category),
        entries: [entry],
      })
  }

  return (
    <div className="card-grid" style={{ '--card-columns': columns } as CSSProperties}>
      {decks.map((deck) => {
        const headingId = `card-total-deck-${deck.slug}`
        return (
          <div key={deck.category} className="card-deck" role="group" aria-labelledby={headingId}>
            <h4 id={headingId} className="visually-hidden">
              {deck.category}
            </h4>
            {deck.entries.map(({ card, total }) => {
              const held = heldAcrossTheClan(total)
              const isPicked = picked === card.id
              return (
                /*
                 * The tile in a real `<button>`, rather than click handling inside
                 * `CardTile`.
                 *
                 * Two reasons. The entry grid is the other caller and must not
                 * become clickable — its tiles hold a number box and, wherever the
                 * tile is wide enough for them, two stepper buttons, so a press
                 * target around all that would both compete with typing and nest a
                 * button inside a button, which is invalid HTML. And a
                 * `<button>` is keyboard-operable, focusable, Enter/Space-activated
                 * and focus-ringed by the stylesheet's one `:focus-visible` rule
                 * without any of that being written here; a `div` with `onClick`
                 * would be four attributes and a key handler pretending to be one.
                 *
                 * `aria-pressed`, not `aria-expanded`: there is one table below the
                 * grid and the sixty tiles take turns owning it, so this is which
                 * tile is selected rather than sixty independent disclosures. It
                 * also means the selected state is not carried by the ring alone.
                 * The button's accessible name is the tile's own `aria-label` by
                 * name-from-content, so nothing is duplicated and the count — or the
                 * "none held" — is still what a screen reader reads out.
                 */
                <button
                  key={card.id}
                  type="button"
                  className="card-total__pick"
                  aria-pressed={isPicked}
                  aria-controls={isPicked ? HOLDERS_ID : undefined}
                  /* Pressing the selected tile again closes the table. It is the
                     control that opened it, so it is the one somebody reaches for to
                     put it away, and without that the table could only ever be
                     swapped for another card's. */
                  onClick={() => onPick(isPicked ? null : card.id)}
                >
                  <CardTile
                    card={card}
                    held={total > 0}
                    badge={total > 0 ? `×${total}` : undefined}
                    title={`${card.name} · ${card.category} · ${held}`}
                    /* The tile's own name, because nothing inside it is a control
                       that could carry one — and because it is where the zero is
                       said in words. */
                    label={`${card.name}, ${card.category} — ${held}`}
                  />
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The line under the picked card's name. The one place that sentence is written.
 *
 * It counts the spares as well as the rows because that is the actionable half and the
 * Spare column below only yields it to a scan: four bases each sitting on their only
 * copy is four bases you cannot ask, which is worth knowing before reading the table.
 *
 * The third clause is the one the table cannot be scanned for *at all*, because the
 * bases it counts are precisely the ones with no row in it: how many of the bases that
 * have reported still want this card. It is the "who am I competing with" half of the
 * same question the other two answer, and `cardDemand` has the rules — in particular
 * that a base nobody has ever entered is in neither the numerator nor the denominator,
 * since it has not told us it lacks the card.
 *
 * `of ${reporting}` rather than a bare count: three needing it out of four bases and
 * three out of thirty are different situations. That is also why the zero stays
 * numeric here where the spares clause turns into words — `0 of 2 reporting bases need
 * it` keeps the denominator, and the denominator is most of what the clause is for.
 */
function holdersLine(holders: readonly CardHolder[], demand: CardDemand): string {
  const bases = holders.length === 1 ? '1 base holds it' : `${holders.length} bases hold it`
  const sparing = holders.filter((holder) => holder.canSpare).length
  const spares = sparing === 0 ? 'none with a spare to trade' : `${sparing} with a spare to trade`
  /* "1 of 3 reporting bases needs it" — the subject is the one base, not the three, so
     the verb agrees with the numerator and the noun with the denominator. */
  const { needing, reporting } = demand
  const plural = reporting === 1 ? '' : 's'
  const verb = needing === 1 ? 'needs' : 'need'
  const wanting = `${needing} of ${reporting} reporting base${plural} ${verb} it`

  return `${bases} · ${spares} · ${wanting}`
}

/**
 * Who holds the card whose tile was just pressed — the other half of the badge's
 * sentence. `×4` says a trade is arithmetically possible and nothing whatever about
 * whom to message, which is the only reason to be reading this panel.
 *
 * Everything it needs was already on the page: `/api/cards/inventory` returns every
 * tracked base with its per-card counts, so this is a projection of the same `bases`
 * array the grid above and the leaderboard are drawn from, and no request is made.
 * Which bases and in what order is `cardHolders`', tested there; this is the drawing.
 *
 * **It names the card, with its art.** Sixty tiles is a lot of grid, and on a phone
 * the tile that was pressed is usually scrolled off the top by the time the table is
 * on screen — a table headed only "Member / Copies" would be a table about nothing.
 * It is also the sighted reader's carrier for *which* tile is selected, so the ring
 * on the tile is not doing that job alone.
 *
 * **A card nobody holds gets a sentence, not an empty table.** Header rows over no
 * rows is a table that looks broken; the fact is that no amount of trading can
 * produce a copy, which is worth stating in the words the panel's intro uses.
 *
 * **No pager, unlike the two tables above.** It is bounded by the tracked bases and
 * is one card's whole answer — truncating "who holds this" to the first five would
 * hide the base somebody opened it to find. The row limit those tables carry exists
 * because their length is unbounded in the count of *pairs* and *bases*; this one is
 * at most one row per base and in practice a handful.
 */
function CardHolders({
  entry,
  bases,
  labelOf,
}: {
  entry: CardTotal
  /**
   * Every base that has reported, as `state.entries` — group-wide, like the grid above
   * it. Not every base *tracked*: the owner assignments carry bases nobody has entered
   * yet, and those are not in here. Both numbers on the line below depend on that.
   */
  bases: readonly BaseInventory[]
  labelOf: (tag: string) => string
}) {
  const { card } = entry
  const holders = useMemo(() => cardHolders(bases, card.id, labelOf), [bases, card.id, labelOf])
  const demand = useMemo(() => cardDemand(bases, card.id), [bases, card.id])

  return (
    <div className="card-holders" id={HOLDERS_ID}>
      {/* `h3` under the panel's `h2`, so the table is an outline entry somebody can
          jump to rather than a slab of markup after sixty tiles. */}
      <h3 className="card-holders__title">
        <span className="trade-card">
          <GameIcon src={card.image} className="trade-card__img" />
          {card.name}
        </span>
        <span className="card-meta">
          {card.category} · {heldAcrossTheClan(entry.total)}
        </span>
      </h3>

      {holders.length === 0 ? (
        <p className="empty-hint" style={{ margin: 0 }}>
          <strong>Nobody in the clan holds it.</strong> Trading cannot produce a copy of a card
          nobody has — this one has to come from the game.
        </p>
      ) : (
        <>
          <p className="card-holders__note">{holdersLine(holders, demand)}</p>
          <div className="table-wrap">
            {/*
             * Stacks into one labeled card per base on a phone, like every other table
             * here, with the explicit roles that keep it a table for assistive tech once
             * `display` changes. Named with `aria-label` rather than `aria-labelledby`
             * the `h3` above it — not for the uppercase reason the other two carry, but
             * because that heading holds an `<img>` and two spans, and the name has to
             * be the card in words.
             */}
            <table
              className="roster roster--stack"
              role="table"
              aria-label={`Bases holding ${card.name}`}
            >
              <thead role="rowgroup">
                <tr role="row">
                  {/* "Member", as the leaderboard and the trade table say it: the row is
                      a person to talk to, and the tag is secondary text under the name. */}
                  <th role="columnheader">Member</th>
                  <th className="num" role="columnheader">
                    Copies
                  </th>
                  <th role="columnheader">Spare</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {holders.map((holder) => (
                  <tr key={holder.tag} role="row">
                    <td className="stack-title" role="cell">
                      <a href={hrefFor({ view: 'player', tag: holder.tag })}>{holder.label}</a>
                      {holder.label === holder.tag ? null : (
                        <>
                          <br />
                          <span className="card-meta">{holder.tag}</span>
                        </>
                      )}
                    </td>
                    <td className="num" role="cell" data-label="Copies">
                      {holder.count}
                    </td>
                    <td role="cell" data-label="Spare">
                      {/*
                       * The count on its own does not say what it means. A base never
                       * gives away its last copy — `MIN_TRADEABLE_COUNT`, the same rule
                       * the trade suggestions and the server apply — so 1 is a holding
                       * you cannot ask for and 2 is an offer, and that is worth a
                       * column of words rather than leaving everybody to do the
                       * comparison per row.
                       */}
                      {holder.canSpare ? (
                        'Can spare one'
                      ) : (
                        <span className="role-pill">Its only copy</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------- jumping about the page ---------- */

/**
 * Scrolls one of the page's sections into view and puts the caret on it.
 *
 * **The focus move is not optional.** Scrolling alone leaves a keyboard user's caret
 * wherever it was — at the top of the page for a jump chip, at the bottom for a
 * back-to-top arrow — so the thing they pressed is now somewhere they have to tab the
 * whole document to reach. That is the trap `HelpView` records; the headings carry
 * `tabIndex={-1}` for no other reason than to let this succeed.
 *
 * `preventScroll`, because the browser's own focus scroll would race the one above and
 * land somewhere else. Same pairing, same reason, as `HelpView`.
 *
 * A missing element is a return, not a throw. It cannot happen while `card-sections.ts`
 * and the headings agree — which is what its tests are for — but this runs inside a
 * click handler on a page with no error boundary above it, and "the arrow did nothing"
 * is a far better failure than a blank page.
 */
function jumpToSection(id: CardSectionId): void {
  const target = document.getElementById(id)
  if (target === null) return

  /* Read at press time rather than subscribed to: it is one decision per click, so
     there is no state to keep in step and no listener to unsubscribe. */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior = scrollBehaviorFor(still)

  /*
   * The top of the page is the *window's* top, not the top heading's.
   *
   * `cards-top` sits about 120px into the document — `.shell`'s 24px of padding, the
   * banner and its 20px margin, then the card's border and 20px of padding — so
   * `scrollIntoView` on it stops with the banner scrolled off and the card apparently
   * beheaded. Which is exactly what it was asked to do: it aligns the element, and the
   * element is not the top. Every other target wants the element, and gets it.
   *
   * Focus still moves to the heading, and that is the whole reason `cards-top` is an
   * anchored section at all — see `card-sections.ts`. Scrolling instead of focusing is
   * the trap; scrolling *and* focusing is not.
   */
  if (id === CARD_TOP_ID) window.scrollTo({ top: 0, behavior })
  else target.scrollIntoView({ block: 'start', behavior })

  target.focus({ preventScroll: true })
}

/**
 * The jump row, under the controls.
 *
 * Buttons rather than `href="#cards-leaderboard"`: the hash is the router, and a bare
 * fragment parses as an unknown route, unmounts this page to render home, *and* gets
 * remembered as the last route. The whole argument is in `card-sections.ts`.
 *
 * `.recents` and `.chip` rather than a new class, because that pair is already the
 * app's row-of-small-controls and `.chip` is already worn by buttons as well as links
 * (the saved-clans row, the trade tracker). A row this small does not earn a third
 * styling mechanism, and the chip's 44px touch target on a phone comes free with it.
 */
function SectionJumpRow() {
  return (
    <nav className="recents card-jump" aria-label="Jump to a section">
      {CARD_JUMP_TARGETS.map((target) => (
        <button
          key={target.id}
          type="button"
          /* Always rendered; `.card-jump__wide` is what takes the fourth one out of the
             row — and out of the accessibility tree with it — below the width where
             four would wrap. Rendering conditionally instead would mean this component
             tracking the viewport, which is a `matchMedia` subscription and a re-render
             to do what one line of CSS already does. */
          className={target.hideWhereCramped ? 'chip card-jump__wide' : 'chip'}
          onClick={() => jumpToSection(target.id)}
        >
          {target.label}
        </button>
      ))}
    </nav>
  )
}

/**
 * The up arrow in the corner of a section heading.
 *
 * Named the way `HelpLink` is — the glyph `aria-hidden`, the words in a
 * `.visually-hidden` span, and the same string on `title` — rather than by an
 * `aria-label` on the button. An `aria-label` over a text node leaves the glyph in the
 * accessibility tree on some combinations, and `↑` is not a word.
 *
 * The name says what it is leaving, not just where it goes: four of these on one page
 * all reading "Back to top" is four identical controls in a screen reader's list, and
 * the section is the only thing that tells them apart. It comes from
 * `card-sections.ts` in sentence case and never from the heading beside it — those are
 * `text-transform: uppercase`, and Chrome computes the accessible name after the
 * transform, which is how the leaderboard table ended up named `COLLECTION
 * LEADERBOARD`.
 */
function BackToTop({ from }: { from: string }) {
  const name = `Back to top, from ${from}`
  return (
    <button
      type="button"
      className="icon-button section-title__top"
      onClick={() => jumpToSection(CARD_TOP_ID)}
      title={name}
    >
      <span aria-hidden="true">↑</span>
      <span className="visually-hidden">{name}</span>
    </button>
  )
}

/**
 * The totals grid and, once a tile is pressed, the table of who holds that card.
 *
 * The selection lives here rather than in `CardsView` because the grid and the table
 * are one thing — the table is the grid's answer — and nothing else on the page reads
 * it. It survives the disclosure being collapsed and reopened on purpose: coming back
 * to the panel you were reading and finding your card still chosen is the behavior
 * that costs nobody anything, and clearing it would be a second way to close the
 * table that the tile's own toggle already covers.
 */
function CardTotals({
  totals,
  columns,
  bases,
  labelOf,
}: {
  totals: CardTotal[]
  columns: number
  bases: readonly BaseInventory[]
  labelOf: (tag: string) => string
}) {
  const [picked, setPicked] = useState<number | null>(null)
  const entry = useMemo(() => totals.find((row) => row.card.id === picked), [totals, picked])

  return (
    <>
      <CardTotalsGrid totals={totals} columns={columns} picked={picked} onPick={setPicked} />
      {/* Below the grid, not above it: the tiles are what the panel is, and a table
          that pushed sixty tiles down the page every time one was pressed would move
          the tile you had just pressed out from under the pointer. */}
      {entry === undefined ? null : (
        <CardHolders entry={entry} bases={bases} labelOf={labelOf} />
      )}
    </>
  )
}

export function CardsView({ user }: { user: SessionUser }) {
  /*
   * The counts on this page are two people's, not one's: completing a trade moves a
   * card on both bases, and the person who pressed Complete is usually in another
   * tab. So the page re-reads both shared stores while it is open — on focus and
   * every thirty seconds, never while hidden and never across a save. The rules are
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

  /* Group-wide, both of them, whatever the filter says — narrowed to one person's
     bases they would stop meaning anything. `tags` and `bases`, never `options`. */
  const standings = useMemo(
    () =>
      baseStandings(
        tags.map((tag) => ({
          tag,
          label: labelOf(tag),
          owner: ownerOf(tag) ?? null,
          ownerUserId: ownerUserIdOf(tag),
        })),
        bases,
      ),
    [tags, labelOf, ownerOf, ownerUserIdOf, bases],
  )
  const totals = useMemo(() => cardTotals(bases, cardsInGridOrder()), [bases])
  const absentCount = useMemo(() => totals.filter((entry) => entry.absent).length, [totals])

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
          <BackToTop from="Trade tracker" />
        </h2>
        <TradeTracker user={user} labelOf={labelOf} />
      </section>

      <section className="card">
        <h2 className="section-title section-title--jump" id="cards-leaderboard" tabIndex={-1}>
          Collection leaderboard <HelpLink section="leaderboard" topic="how the leaderboard scores" />
          <BackToTop from="Collection leaderboard" />
        </h2>
        {/*
         * This line said "by distinct cards out of 60. Level on that, more copies goes
         * first", which stopped being true when the measure became points in 42a5df9.
         * Distinct cards is now only the *tie-break*; points is the measure.
         *
         * The direction the old sentence implied was right, though, and it is worth
         * recording which way round it goes, because it is easy to state backwards:
         * breadth wins, decisively. Six cards held once scores 60, which already beats
         * the 55 that ten copies of a single card scores — and ten is the cap, so no
         * one card can ever contribute more. Eight singles (80) beat nine copies of one
         * (54) comfortably.
         *
         * The curve itself is in the disclosure below, where it can be read without
         * turning this intro into a paragraph, and on the help page — one source.
         */}
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>points</strong>: {cardPoints(1)} for the first copy of a
          card and less for every copy after it, so breadth outranks hoarding. Level on points, more
          distinct cards of {totals.length} goes first. Not affected by <strong>Show</strong>: this
          is the whole clan. <strong>Owner</strong> narrows which rows are drawn — the rank stays
          each base's place on the whole board, so it never renumbers.
        </p>
        <Leaderboard rows={standings} />
        <details className="group">
          <summary>How the points work</summary>
          <div className="group__body help-prose">
            <ScoringRules />
          </div>
        </details>
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
            All {totals.length} cards, in grid order
            <span
              className={
                absentCount > 0 ? 'card-panel__trades card-total__none' : 'card-panel__trades card-meta'
              }
            >
              {' · '}
              {absentCount > 0
                ? `${absentCount} nobody holds`
                : 'every card is held by somebody'}
            </span>
          </summary>
          <div className="group__body">
            {/* The last sentence is what tells anybody the tiles are pressable. A grid
                of sixty buttons has no other affordance at this size — there is no room
                for a caption on a 52px tile — so the panel says it once, in the line
                that is already explaining what the badges mean. */}
            <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
              The same grid as above, with the copies held across <strong>every</strong> tracked
              base — linked to an account or not — as the badge in each tile's corner. The order is
              the grid's and never changes with the counts, so the two can be read tile for tile. A
              tile in <strong>gray with no badge</strong> is a card nobody in the clan holds; it
              cannot be got by trading, only from the game. <strong>Choose a card</strong> to list
              the bases holding it below.
            </p>
            <CardTotals totals={totals} columns={columns} bases={bases} labelOf={labelOf} />
          </div>
        </details>
      </section>
    </>
  )
}
