import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { MAX_CARD_COUNT, type BaseInventory, type SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { activeTag, ownsAnyBase, tagsInScope, type BaseScope } from '../base-scope.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { cardHolders, type CardHolder } from '../card-holders.ts'
import { cardColumnOptions } from '../card-scale.ts'
import { searchCards } from '../card-search.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import {
  baseStandings,
  cardPoints,
  cardTotals,
  cardsInGridOrder,
  type BaseStanding,
  type CardTotal,
} from '../card-standings.ts'
import { deckSlug } from '../cards.ts'
import { formatFull } from '../format.ts'
import {
  hrefFor,
  useBaseScope,
  useCardColumns,
  useMeasuredWidth,
  useRowLimit,
} from '../hooks.ts'
import { ownerRecordFor, useOwners, useOwnersState } from '../owners.ts'
import { paginate, type RowLimit } from '../saved-table.ts'
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
 * How far every tracked base has got, best first.
 *
 * **Group-wide, never filtered by the picker.** It is about the whole clan's
 * progress; narrowed to one person's bases it would be a leaderboard of one and
 * would answer nothing. It sits directly under the trade suggestions because "who
 * should trade with whom" and "who is furthest ahead" are the same question asked
 * two ways — the base near the top with spares is the one worth messaging.
 *
 * The order is `baseStandings`', not this component's: **points** descending, then
 * distinct descending, then member name and tag. Ties are the *normal* case early in
 * an event, which is why the comparator is total and lives somewhere tested. (This
 * note used to say "distinct descending, then copies descending", which was the
 * measure before `cardPoints` — the same staleness the intro line under the heading
 * below was carrying.)
 *
 * **Paging never touches the rank.** The number in the first column is
 * `baseStanding.rank` — computed once over the whole board, shared on a genuine tie
 * and skipping the numbers a tie consumes — so rank 6 reads 6 wherever it is
 * printed. Numbering the visible rows instead would restart at 1 on page 2 and turn
 * the one column that means something into a row counter.
 */
function Leaderboard({ rows }: { rows: BaseStanding[] }) {
  const [limit, setLimit] = useRowLimit('coc:cardStandingLimit', 5)
  const [page, setPage] = useState(1)
  const view = useMemo(() => paginate(rows, limit, page), [rows, limit, page])

  /* A base losing its owner assignment shortens the board, which can leave the
     page number past the end; `paginate` clamps and this follows it. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  if (rows.length === 0) return null

  return (
    <>
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
 * `CardTile`, so the art, the crop, the deck frame and the greyscale cannot drift
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
 * **A card nobody holds is greyscale with no badge** — which is a colour cue and a
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
                 * become clickable — its tiles already hold a number box, and a
                 * press target around it would compete with typing in it. And a
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
 */
function holdersLine(holders: readonly CardHolder[]): string {
  const bases = holders.length === 1 ? '1 base holds it' : `${holders.length} bases hold it`
  const sparing = holders.filter((holder) => holder.canSpare).length
  return `${bases} · ${sparing === 0 ? 'none with a spare to trade' : `${sparing} with a spare to trade`}`
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
  /** Every tracked base, as `state.entries` — group-wide, like the grid above it. */
  bases: readonly BaseInventory[]
  labelOf: (tag: string) => string
}) {
  const { card } = entry
  const holders = useMemo(() => cardHolders(bases, card.id, labelOf), [bases, card.id, labelOf])

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
          <p className="card-holders__note">{holdersLine(holders)}</p>
          <div className="table-wrap">
            {/*
             * Stacks into one labelled card per base on a phone, like every other table
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

/**
 * The totals grid and, once a tile is pressed, the table of who holds that card.
 *
 * The selection lives here rather than in `CardsView` because the grid and the table
 * are one thing — the table is the grid's answer — and nothing else on the page reads
 * it. It survives the disclosure being collapsed and reopened on purpose: coming back
 * to the panel you were reading and finding your card still chosen is the behaviour
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
  const state = useCardInventoryState()
  const bases = state.entries
  const ownersState = useOwnersState()
  const owners = useOwners()

  const ownerOf = useMemo(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return (tag: string) => byTag.get(tag)
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

  const options = useMemo(() => {
    if (scope === 'all') return allOptions
    const mine = new Set(tagsInScope(scopedBases, 'mine', user.id))
    return allOptions.filter((option) => mine.has(option.tag))
  }, [allOptions, scope, scopedBases, user.id])

  const [selected, setSelected] = useState<string | null>(null)
  /*
   * `activeTag` is both the default and the repair: it keeps the chosen base while
   * the filtered list still offers it and otherwise falls to the head of that list.
   * That is what moves the selection when switching to `Mine` while looking at
   * somebody else's base — the editor below follows it rather than being left
   * showing counts the picker no longer offers. `options[0]`, not `tags[0]`: the
   * list is ordered by member name, so defaulting by tag would leave the select
   * showing its second or third entry as the chosen one.
   */
  const active = activeTag(options, selected)

  /* Group-wide, both of them, whatever the filter says — narrowed to one person's
     bases they would stop meaning anything. `tags` and `bases`, never `options`. */
  const standings = useMemo(
    () =>
      baseStandings(
        tags.map((tag) => ({ tag, label: labelOf(tag), owner: ownerOf(tag) ?? null })),
        bases,
      ),
    [tags, labelOf, ownerOf, bases],
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
          <h2 className="section-title" style={{ margin: 0 }}>
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
                      setSelected(active)
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
                      onChange={(event) => setSelected(event.target.value)}
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
        <h2 className="section-title">
          Trade suggestions <HelpLink section="trades" topic="what makes a swap legal" />
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
        <h2 className="section-title">
          Trade tracker{' '}
          <HelpLink section="tracker" topic="who can complete a trade, and what it does" />
        </h2>
        <TradeTracker user={user} labelOf={labelOf} />
      </section>

      <section className="card">
        <h2 className="section-title">
          Collection leaderboard <HelpLink section="leaderboard" topic="how the leaderboard scores" />
        </h2>
        {/*
         * This line said "by distinct cards out of 60. Level on that, more copies goes
         * first", which stopped being true when the measure became points in 1b917a1.
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
          is the whole clan.
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
        <h2 className="section-title">Cards across the clan</h2>
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
              tile in <strong>grey with no badge</strong> is a card nobody in the clan holds; it
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
