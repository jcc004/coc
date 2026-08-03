import { useEffect, useMemo, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { useBaseLabels } from '../base-labels.ts'
import { activeTag, ownsAnyBase, tagsInScope, type BaseScope } from '../base-scope.ts'
import { baseOwnerOf } from '../card-entry.ts'
import { inventoryFor, useCardInventoryState } from '../card-inventory.ts'
import {
  baseStandings,
  cardTotals,
  cardsInGridOrder,
  type BaseStanding,
  type CardTotal,
} from '../card-standings.ts'
import { deckSlug } from '../cards.ts'
import { formatFull } from '../format.ts'
import { hrefFor, useBaseScope, useRowLimit } from '../hooks.ts'
import { ownerRecordFor, useOwners, useOwnersState } from '../owners.ts'
import { paginate, type RowLimit } from '../saved-table.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'
import { CardTile } from './CardTile.tsx'
import { ErrorPanel, Loading, Meter, Pager, RowLimitSelect } from './primitives.tsx'
import { TradeSuggestions } from './TradeSuggestions.tsx'

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
 * The order is `baseStandings`', not this component's: distinct descending, then
 * copies descending, then member name and tag. Ties are the *normal* case early in
 * an event, which is why the comparator is total and lives somewhere tested.
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
                   */}
                  {row.recorded ? (
                    <span title={`${formatFull(row.points)} of ${formatFull(row.size * 55)} possible`}>
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
 * Group-wide, like the leaderboard, and including the bases whose owner is still
 * only a text label — most of them are — because their cards are as tradeable as
 * anyone's and leaving them out would undercount the group by more than half.
 */
function CardTotalsGrid({ totals }: { totals: CardTotal[] }) {
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
    <div className="card-grid">
      {decks.map((deck) => {
        const headingId = `card-total-deck-${deck.slug}`
        return (
          <div key={deck.category} className="card-deck" role="group" aria-labelledby={headingId}>
            <h4 id={headingId} className="visually-hidden">
              {deck.category}
            </h4>
            {deck.entries.map(({ card, total }) => {
              const held = heldAcrossTheClan(total)
              return (
                <CardTile
                  key={card.id}
                  card={card}
                  held={total > 0}
                  badge={total > 0 ? `×${total}` : undefined}
                  title={`${card.name} · ${card.category} · ${held}`}
                  /* The tile's own name, because nothing inside it is a control
                     that could carry one — and because it is where the zero is
                     said in words. */
                  label={`${card.name}, ${card.category} — ${held}`}
                />
              )
            })}
          </div>
        )
      })}
    </div>
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

  return (
    <>
      <section className="card">
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
              </>
            ) : null}
          </div>
        </div>

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
        <h2 className="section-title">Trade suggestions</h2>
        <TradeSuggestions bases={bases} labelOf={labelOf} ownerOf={ownerOf} />
      </section>

      <section className="card">
        <h2 className="section-title">Collection leaderboard</h2>
        <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
          Every tracked base, by <strong>distinct cards out of {totals.length}</strong>. Level on
          that, more copies goes first; level on both, alphabetically — so the order never
          reshuffles. Not affected by <strong>Show</strong>: this is the whole clan.
        </p>
        <Leaderboard rows={standings} />
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
            <p className="empty-hint" style={{ margin: '0 0 12px', fontSize: 13 }}>
              The same grid as above, with the copies held across <strong>every</strong> tracked
              base — linked to an account or not — as the badge in each tile's corner. The order is
              the grid's and never changes with the counts, so the two can be read tile for tile. A
              tile in <strong>grey with no badge</strong> is a card nobody in the clan holds; it
              cannot be got by trading, only from the game.
            </p>
            <CardTotalsGrid totals={totals} />
          </div>
        </details>
      </section>
    </>
  )
}
