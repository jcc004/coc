import { useEffect, useMemo, useState } from 'react'
import { normalizeTag, type BaseInventory } from '@coc/shared'
import {
  groupTradesByPair,
  suggestTrades,
  tradeProposalMessage,
  type TradePair,
  type TradeSuggestion,
} from '../card-trades.ts'
import { cardById, categoryOfCard } from '../cards.ts'
import { requestChatDraft } from '../chat-draft.ts'
import { hrefFor, useRowLimit } from '../hooks.ts'
import { paginate, type RowLimit } from '../saved-table.ts'
import { GameIcon, Pager, RowLimitSelect } from './primitives.tsx'

/**
 * The trade suggestions table, for the card page and for one player's page.
 *
 * It is its own file for the same reason `CardTile` and `BaseCardEditor` are:
 * **two pages draw it.** The card page shows every swap in the clan, under the grid
 * it is computed from; a player page shows the subset involving that one base,
 * inside the same disclosure as its grid, because that page's summary line already
 * promises "Trades available with N bases" and never showed them. One copy, so the
 * two cannot disagree about the rules, the wording, or the paging.
 *
 * Everything a caller varies is one prop, {@link TradeSuggestions.focusTag}. There
 * is no second component and no second layout: the narrow context gets the same
 * table, filtered.
 */

/** One side of a suggested swap: the card, named, with its picture if we have it. */
function TradeCard({ cardId }: { cardId: number }) {
  const card = cardById(cardId)
  if (!card) return <>Card {cardId}</>
  return (
    <span className="trade-card">
      <GameIcon src={card.image} className="trade-card__img" />
      {card.name}
    </span>
  )
}

/**
 * Loads a proposal into the chat composer in the sidebar.
 *
 * It fills the box; it does **not** post. A suggestion is a draft by definition —
 * the owners may want to change the wording, or say when — and a button that
 * silently posted to the group channel would be a nasty surprise. The label says
 * "Propose", the composer's own Send button is what sends, and the confirmation
 * below is about the composer, never about a message having gone out.
 *
 * It works identically on a player page: `requestChatDraft` writes to a
 * module-level store and the chat panel is in the sidebar on every route, so
 * nothing here depends on which page the button was pressed from.
 */
function ProposeButton({
  trade,
  labelOf,
}: {
  trade: TradeSuggestion
  /**
   * The same member-name resolver the picker and the table use — `baseOptions` in
   * `base-names.ts`, fetched by `useBaseLabels` — so the message says the names that
   * are on screen. The owner is deliberately *not* passed: the requested sentence
   * names members, and what that costs is written out on `tradeProposalMessage`.
   */
  labelOf: (tag: string) => string
}) {
  const [offered, setOffered] = useState(false)

  return (
    <button
      type="button"
      className="chip"
      onClick={() => {
        requestChatDraft(
          tradeProposalMessage(trade, {
            cardName: (id) => cardById(id)?.name,
            member: labelOf,
          }),
        )
        setOffered(true)
      }}
      title="Put this proposal in the chat box — you still press Send"
    >
      {offered ? 'In chat box ↗' : 'Propose in chat'}
    </button>
  )
}

/**
 * A base, as a person: the member name over the tag and the owner.
 *
 * The name is the link, because the name is what somebody recognises. **The tag
 * stays on screen** underneath — it is the identity the counts, the trades and the
 * routes are all keyed on, and a name alone is not enough to go and find a player
 * in the game. It is dropped only when it *is* the label, i.e. when no roster we
 * can see names the base, which is the same rule the grid's header uses.
 */
function BaseLabel({
  tag,
  label,
  owner,
}: {
  tag: string
  label: string
  owner: string | undefined
}) {
  return (
    <>
      <a href={hrefFor({ view: 'player', tag })}>{label}</a>
      <br />
      <span className="card-meta">
        {label === tag ? null : <>{tag} · </>}
        {owner ?? 'no owner set'}
      </span>
    </>
  )
}

/** Rows-per-page options for the suggestions. See {@link TradeSuggestions}. */
const TRADE_PAIR_LIMITS: RowLimit[] = [5, 10, 20, 'all']

/** `null` for input that cannot be a tag, and so can never name a stored base. */
function canonicalOrNull(tag: string): string | null {
  try {
    return normalizeTag(tag)
  } catch {
    return null
  }
}

/** The pairs one base is on either side of, in the order they arrived. */
function pairsInvolving(pairs: TradePair[], tag: string): TradePair[] {
  return pairs.filter((pair) => pair.baseA === tag || pair.baseB === tag)
}

/**
 * Every swap the current counts allow, grouped by the pair of bases involved.
 *
 * The rules are entirely in `suggestTrades`; this only renders them, and names both
 * the **member** and the **owner**, because "#2GCJ2QPU should talk to #AAABBB" is
 * not actionable until you know that means Jared should talk to Sam.
 *
 * **The page counts pairs, not rows.** The two readings are genuinely different
 * here — twelve pairs can be thirty rows — and this is the one that keeps the
 * presentation honest: a pair is named once with its options listed beneath it, so
 * splitting a pair across a page boundary would put a row with two empty Member
 * cells at the top of page 2, which reads as missing data rather than as "same two
 * bases as above" (the failure the `data-pair-start` note below is about). Paging
 * by pair also makes "5" mean five *decisions to make*, which is what somebody
 * working down this list is actually counting. Both controls therefore say pairs —
 * the limit is labelled `Pairs` and the pager counts pairs — so the numbers on
 * screen can never disagree with the rows under them. The limit is remembered under
 * one key for both pages, on purpose: it is a reading preference about this table,
 * not about a route.
 *
 * **The Category column is kept in both contexts.** It is not redundant with the
 * two cards named beside it: the swap is legal *because* they share a deck, and on a
 * player page the four deck plaques directly above make the deck the unit of
 * progress — so "which deck does this swap move" is the column that says whether a
 * given option is worth taking. It costs nothing at 390px either, where the table
 * stacks into one labelled card per swap and the deck becomes a line rather than a
 * column competing for width.
 */
export function TradeSuggestions({
  bases,
  labelOf,
  ownerOf,
  focusTag,
}: {
  /**
   * The whole shared inventory, on both pages. A trade has two sides and half of
   * them are somebody else's bases by definition, so this is never the filtered
   * picker list — narrowing happens through `focusTag`, after the rules have run.
   */
  bases: BaseInventory[]
  labelOf: (tag: string) => string
  ownerOf: (tag: string) => string | undefined
  /**
   * One base to narrow to: only the pairs it is a side of. For a player page, where
   * the panel is about that base and its summary line counts that base's partners —
   * a clan-wide list under a heading saying "with N bases" would contradict itself.
   *
   * Omitted, the table is the whole clan's, which is what the card page wants.
   */
  focusTag?: string
}) {
  const focus = focusTag === undefined ? null : canonicalOrNull(focusTag)

  /*
   * One code path for both pages: the rules run over every base, then the result is
   * narrowed. Filtering after the fact rather than asking `suggestTrades` about only
   * this base's pairs costs some work the focused view will not show — it is
   * quadratic in the number of bases — but it is the same call, in the same order,
   * that the card page makes, so the two pages cannot drift into disagreeing about
   * what a trade is or which one comes first. The counts are per-clan and the work
   * is a memo over sixty ids; the card page has always done exactly this.
   */
  const pairs = useMemo(() => {
    const all = groupTradesByPair(suggestTrades(bases, categoryOfCard))
    return focus === null ? all : pairsInvolving(all, focus)
  }, [bases, focus])

  const [limit, setLimit] = useRowLimit('coc:tradePairLimit', 5)
  const [page, setPage] = useState(1)
  const view = useMemo(() => paginate(pairs, limit, page), [pairs, limit, page])

  /* Re-entered counts can shrink the list under a page number that is now past the
     end; `paginate` clamps, and this puts the control back in step with it. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  if (pairs.length === 0) {
    return (
      <p className="empty-hint">
        {focus === null ? 'No trades available yet.' : 'No trades available for this base yet.'} A
        swap needs one base holding <strong>two or more</strong> of a card the other has{' '}
        <strong>none</strong> of, in <strong>both</strong> directions, within one category.
      </p>
    )
  }

  const rowCount = view.rows.reduce((sum, pair) => sum + pair.trades.length, 0)

  return (
    <>
      <div className="table-wrap">
        {/* Stacks into one labelled card per swap on a phone; the explicit roles
            keep it a table for assistive tech once `display` changes. Nothing
            sorts, so the header row is hidden there rather than kept — see the
            note in styles.css.

            Named with `aria-label`, never `aria-labelledby` the heading above it:
            both headings that sit over this table are `.section-title`, which is
            `text-transform: uppercase`, and Chrome computes an accessible name from
            the *transformed* text — pointing at one would name the table
            "TRADE SUGGESTIONS". The visible heading is the same words, so
            label-in-name still holds. Same reasoning as the leaderboard's. */}
        <table className="roster roster--stack" role="table" aria-label="Trade suggestions">
          <thead role="rowgroup">
            <tr role="row">
              {/* "Member", not "Base": the cell now reads as a person, which is who
                  you go and talk to. The tag is still under it. */}
              <th role="columnheader">Member</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Member</th>
              <th role="columnheader">Gives</th>
              <th role="columnheader">Category</th>
              <th role="columnheader" />
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.rows.flatMap((pair) =>
              pair.trades.map((trade, index) => (
                <tr
                  key={`${trade.baseA}-${trade.baseB}-${trade.cardFromA}-${trade.cardFromB}`}
                  role="row"
                  /*
                   * Marks where one pair's block of options begins, so the wide
                   * table can rule a line above it. Without that, a continuation
                   * row's empty Member cells read as missing data rather than as
                   * "same two bases as above" — seen in a screenshot, where the
                   * second option rendered as a bare "Minion / Hog Rider" row
                   * with nobody's name on it.
                   */
                  data-pair-start={index === 0 ? 'true' : undefined}
                >
                  {/* The pair is named once per group; the rows under it are its
                      options. A cell for a later row is genuinely empty, which is
                      how the stacked layout knows to drop the line rather than
                      print a blank one. */}
                  <td className="stack-title" role="cell">
                    {index === 0 ? (
                      <BaseLabel
                        tag={pair.baseA}
                        label={labelOf(pair.baseA)}
                        owner={ownerOf(pair.baseA)}
                      />
                    ) : null}
                  </td>
                  {/*
                   * Stacked, a row is its own card, so a later option in a pair has
                   * no base named above it and two bare "Gives" lines would not say
                   * whose. Those rows name the member in the label instead; the
                   * first does not need to, because the member is the line above it.
                   */}
                  <td
                    role="cell"
                    data-label={index === 0 ? 'Gives' : `${labelOf(pair.baseA)} gives`}
                  >
                    <TradeCard cardId={trade.cardFromA} />
                  </td>
                  <td className="stack-title" role="cell">
                    {index === 0 ? (
                      <BaseLabel
                        tag={pair.baseB}
                        label={labelOf(pair.baseB)}
                        owner={ownerOf(pair.baseB)}
                      />
                    ) : null}
                  </td>
                  <td
                    role="cell"
                    data-label={index === 0 ? 'Gives' : `${labelOf(pair.baseB)} gives`}
                  >
                    <TradeCard cardId={trade.cardFromB} />
                  </td>
                  <td className="card-meta" role="cell" data-label="Category">
                    {trade.category}
                  </td>
                  <td className="row-actions" role="cell">
                    <ProposeButton trade={trade} labelOf={labelOf} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {/* Under the table, like the roster's: the limit and the pager answer the
          same question ("what am I looking at, and how do I see the rest"), and it
          is what you reach for once you have scrolled to the bottom. The pager
          hides itself at one page, so a base with a couple of partners shows no
          control at all. */}
      <div className="roster-footer">
        <RowLimitSelect
          id="trade-pairs"
          label="Pairs"
          options={TRADE_PAIR_LIMITS}
          value={limit}
          onChange={(next) => {
            setLimit(next)
            setPage(1)
          }}
        />
        <Pager view={view} noun="pairs" onPage={setPage} />
      </div>

      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        {pairs.length} pair{pairs.length === 1 ? '' : 's'} could trade
        {focus === null ? null : <> with {labelOf(focus)}</>}
        {view.pageCount > 1 ? (
          <>
            , {rowCount} option{rowCount === 1 ? '' : 's'} on this page
          </>
        ) : null}
        . Each row is one option, not a commitment — one spare can appear against several partners,
        so pick one per card and re-enter the counts afterwards.{' '}
        <strong>Propose in chat</strong> writes the swap into the chat box in the sidebar for you to
        edit; nothing is posted until you press Send.
      </p>
    </>
  )
}
