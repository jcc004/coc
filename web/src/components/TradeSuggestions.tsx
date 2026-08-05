import { useEffect, useMemo, useState } from 'react'
import {
  normalizeTag,
  type BaseInventory,
  type OwnerRecord,
  type SessionUser,
  type TradeRecord,
} from '@coc/shared'
import { ApiError } from '../api.ts'
import {
  groupTradesByPair,
  suggestTrades,
  type TradePair,
  type TradeSuggestion,
} from '../card-trades.ts'
import { cardById, categoryOfCard } from '../cards.ts'
import { hrefFor, useRowLimit } from '../hooks.ts'
import { useOwners } from '../owners.ts'
import { paginate, type PagedRows, type RowLimit } from '../saved-table.ts'
import {
  UNOWNED,
  UNOWNED_LABEL,
  filterPairsByOwners,
  ownersInPairs,
  tradeFilterSummary,
} from '../trade-filters.ts'
import { findPendingSwap, sidesOfTrade, tradeProposeAccess } from '../trade-tracker.ts'
import { completeTrade, proposeTrade, useTrades } from '../trades.ts'
import { SwapRules } from './help-copy.tsx'
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
 * Puts a suggested swap onto the Trade Tracker, in the panel below this table.
 *
 * **It records; it does not execute.** A proposal is one side saying "let's do this"
 * — the cards do not move until the *other* member (or an admin) marks it complete
 * on the tracker, which is where the confirmation and the audit stamp live. So this
 * button is safe to press, and its label says only what it does: `Propose`.
 *
 * Who may press it is `tradeProposeAccess`, the same rule the server applies: you
 * must own one of the two bases, or be an admin. Somebody who owns neither is told
 * who can instead of being given a button that would 403 — proposing a swap between
 * two other people's bases is putting words in their mouths.
 *
 * A swap already pending on the tracker says so rather than offering a second
 * proposal. Pressing it again would be harmless — the server answers 409 with the
 * existing row and `proposeTrade` treats that as success — but a control that does
 * nothing new should not look like one that does.
 */
function ProposeButton({
  trade,
  labelOf,
  user,
  owners,
  tracked,
}: {
  trade: TradeSuggestion
  /**
   * The same member-name resolver the picker and the table use — `baseOptions` in
   * `base-names.ts`, fetched by `useBaseLabels` — so a refusal names the members who
   * are on screen rather than their tags.
   */
  labelOf: (tag: string) => string
  user: Pick<SessionUser, 'id' | 'role'>
  owners: OwnerRecord[]
  /** The tracker's rows, for the already-proposed check. */
  tracked: TradeRecord[]
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  const access = tradeProposeAccess(user, sidesOfTrade(trade, owners))
  const already = findPendingSwap(tracked, trade) !== undefined

  if (!access.allowed) {
    return (
      <span className="card-meta" title={access.message}>
        {labelOf(trade.baseA)} or {labelOf(trade.baseB)} can propose this
      </span>
    )
  }

  /* `sent` and `already` are the same fact one render apart — the store refresh that
     follows a proposal is what turns the first into the second — so both read the
     same way and the label cannot flicker between them. */
  if (already || state === 'sent') return <span className="card-meta">On the tracker ↓</span>

  return (
    <>
      <button
        type="button"
        className="chip"
        disabled={state === 'sending'}
        onClick={() => {
          setState('sending')
          setProblem(null)
          proposeTrade({
            baseA: trade.baseA,
            baseB: trade.baseB,
            cardFromA: trade.cardFromA,
            cardFromB: trade.cardFromB,
            category: trade.category,
          })
            .then(() => setState('sent'))
            .catch((cause: unknown) => {
              setProblem(cause instanceof ApiError ? cause.message : 'Could not reach the server.')
              setState('idle')
            })
        }}
        title="Adds it to the trade tracker below — no cards move until it is completed"
      >
        {state === 'sending' ? 'Proposing…' : 'Propose'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

/**
 * The admin fast path: propose and complete a suggestion in one click, instead of a
 * trip to the tracker below to approve what was just proposed.
 *
 * Reuses `proposeTrade` as-is, including its already-proposed handling — a duplicate
 * 409 comes back as the existing pending row rather than an error — so the same click
 * handler works whether or not this exact swap is already on the tracker: propose (or
 * recover the existing one), then complete it. No separate authorization check is
 * needed here because an admin already clears `tradeProposeAccess` and
 * `tradeResolveAccess` unconditionally.
 *
 * Renders nothing for anybody else: this is a shortcut past the tracker's own
 * confirmation and audit trail, not a second way for a member to act on somebody
 * else's swap.
 */
function CompleteNowButton({
  trade,
  user,
}: {
  trade: TradeSuggestion
  user: Pick<SessionUser, 'id' | 'role'>
}) {
  const [state, setState] = useState<'idle' | 'sending'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  if (user.role !== 'admin') return null

  return (
    <>
      <button
        type="button"
        className="chip"
        disabled={state === 'sending'}
        onClick={() => {
          const question =
            'Complete this trade now? It records the swap and moves the cards on both ' +
            'bases immediately — nothing to approve afterwards.'
          if (!window.confirm(question)) return

          setState('sending')
          setProblem(null)
          proposeTrade({
            baseA: trade.baseA,
            baseB: trade.baseB,
            cardFromA: trade.cardFromA,
            cardFromB: trade.cardFromB,
            category: trade.category,
          })
            .then((proposed) => completeTrade(proposed.id))
            .then(() => setState('idle'))
            .catch((cause: unknown) => {
              setProblem(cause instanceof ApiError ? cause.message : 'Could not reach the server.')
              setState('idle')
            })
        }}
        title="Proposes and completes it in one step — both bases change immediately"
      >
        {state === 'sending' ? 'Completing…' : 'Complete'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

/**
 * A base, as a person: the member name over the tag and the owner.
 *
 * The name is the link, because the name is what somebody recognizes. **The tag
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
 * the limit is labeled `Pairs` and the pager counts pairs — so the numbers on
 * screen can never disagree with the rows under them. The limit is remembered under
 * one key for both pages, on purpose: it is a reading preference about this table,
 * not about a route.
 *
 * **The Category column is kept in both contexts.** It is not redundant with the
 * two cards named beside it: the swap is legal *because* they share a deck, and on a
 * player page the four deck plaques directly above make the deck the unit of
 * progress — so "which deck does this swap move" is the column that says whether a
 * given option is worth taking. It costs nothing at 390px either, where the table
 * stacks into one labeled card per swap and the deck becomes a line rather than a
 * column competing for width.
 */
export function TradeSuggestions({
  bases,
  labelOf,
  ownerOf,
  user,
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
   * Who is signed in, for the Propose button's rule. Passed down rather than read
   * from `useSession` here, the same way `BaseCardEditor` is handed it: both pages
   * already hold it and a second subscription would refetch `/api/auth/me` per
   * mount.
   */
  user: Pick<SessionUser, 'id' | 'role'>
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

  /* Both feed the Propose button in each row: who owns the two bases decides whether
     it is offered, and what is already on the tracker decides whether it says so
     instead. Subscribed once here rather than per row — sixty rows would be sixty
     subscriptions to the same two module-level stores. */
  const owners = useOwners()
  const tracked = useTrades()

  /*
   * Two owner selections, matched as a set rather than one per column — see
   * `trade-filters.ts` for why the columns cannot be filtered independently. Transient,
   * like the card search: a filter that survived navigating away would leave somebody
   * returning to a list with most of it missing and no memory of why.
   */
  const [firstOwner, setFirstOwner] = useState<string | null>(null)
  const [secondOwner, setSecondOwner] = useState<string | null>(null)
  /*
   * `suggestTrades` only rules out a base trading with itself, not an owner's two
   * bases trading with each other — that pair is a real, if narrow, result (see
   * `filterPairsByOwners` in `trade-filters.ts`). This is the general form of "only
   * show trades with other people": it works whether or not an owner is picked, so
   * it stays a checkbox rather than a value on the second select, which could only
   * ever mean "other than the first" once a first owner already narrowed the list.
   */
  const [otherOnly, setOtherOnly] = useState(false)

  /* Offered from the unfiltered pairs, so choosing one owner never empties the other
     picker of the very options you would want next. */
  const ownerChoices = useMemo(() => ownersInPairs(pairs, ownerOf), [pairs, ownerOf])
  const shown = useMemo(
    () => filterPairsByOwners(pairs, ownerOf, firstOwner, secondOwner, otherOnly),
    [pairs, ownerOf, firstOwner, secondOwner, otherOnly],
  )
  const filterNote = tradeFilterSummary(
    shown.length,
    pairs.length,
    firstOwner,
    secondOwner,
    otherOnly,
  )

  const [limit, setLimit] = useRowLimit('coc:tradePairLimit', 5)
  const [page, setPage] = useState(1)
  const view = useMemo(() => paginate(shown, limit, page), [shown, limit, page])

  /* Re-entered counts — or a filter — can shrink the list under a page number that is
     now past the end; `paginate` clamps, and this puts the control back in step. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  const rowCount = view.rows.reduce((sum, pair) => sum + pair.trades.length, 0)

  /*
   * The rules used to be the *empty* message: "no trades available yet — a swap
   * needs one base holding two or more of a card the other has none of". Which meant
   * the explanation disappeared the moment there were trades to explain, and stayed
   * gone from then on. It is a disclosure below the table now, always present and
   * always shut, so the panel reads the same whether or not it has rows — and the
   * copy itself is `SwapRules`, shared with the help page rather than restated there.
   */
  return (
    <>
      {/*
       * Two owner pickers, offered only when there is more than one owner to choose
       * between — with a single owner in the whole list they could only ever narrow it to
       * everything or nothing.
       *
       * Labeled "Involving" and "and" rather than by column, because that is what they
       * do: the pair of selections is matched as a set against the pair of owners, in
       * either order. Naming them for the columns would promise something the table
       * cannot deliver, since which side an owner lands on is decided by their base's tag.
       */}
      {pairs.length > 0 && ownerChoices.length > 1 ? (
        <div className="roster-filters">
          <label htmlFor="trade-owner-a">
            Involving
            <select
              id="trade-owner-a"
              value={firstOwner ?? ''}
              onChange={(event) => {
                setFirstOwner(event.target.value === '' ? null : event.target.value)
                setPage(1)
              }}
            >
              <option value="">Anyone</option>
              {ownerChoices.map((owner) => (
                <option key={owner} value={owner}>
                  {owner === UNOWNED ? UNOWNED_LABEL : owner}
                </option>
              ))}
            </select>
          </label>

          <label htmlFor="trade-owner-b">
            and
            <select
              id="trade-owner-b"
              value={secondOwner ?? ''}
              onChange={(event) => {
                setSecondOwner(event.target.value === '' ? null : event.target.value)
                setPage(1)
              }}
            >
              <option value="">Anyone</option>
              {ownerChoices.map((owner) => (
                <option key={owner} value={owner}>
                  {owner === UNOWNED ? UNOWNED_LABEL : owner}
                </option>
              ))}
            </select>
          </label>

          {/* Excludes an owner's own bases trading with each other — a real result
              `suggestTrades` allows, since it only rules out a base trading with
              itself, not an owner's second base. Standalone rather than a value on
              the second select, so it also narrows the plain unfiltered list. */}
          <label
            htmlFor="trade-other-only"
            className="roster-filters__check"
            title="Hides pairs where one member's own two bases would trade with each other"
          >
            <input
              id="trade-other-only"
              type="checkbox"
              checked={otherOnly}
              onChange={(event) => {
                setOtherOnly(event.target.checked)
                setPage(1)
              }}
            />
            Other only
          </label>

          {firstOwner !== null || secondOwner !== null || otherOnly ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setFirstOwner(null)
                setSecondOwner(null)
                setOtherOnly(false)
                setPage(1)
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* What the filter did. A shorter list with nothing to explain it reads as missing
          data — the same failure the blank member cells were. */}
      {filterNote !== null ? <p className="empty-hint">{filterNote}</p> : null}

      {pairs.length === 0 ? (
        <p className="empty-hint">
          {focus === null ? 'No trades available yet.' : 'No trades available for this base yet.'}{' '}
          Nobody holds a spare the other side is missing, in the same deck, both ways round.
        </p>
      ) : shown.length === 0 ? (
        /* Filtered to nothing. The note above already says which filter did it, so this
           only has to keep the table from rendering an empty body. */
        null
      ) : (
        <SuggestionTable
          view={view}
          labelOf={labelOf}
          ownerOf={ownerOf}
          user={user}
          owners={owners}
          tracked={tracked}
          limit={limit}
          onLimit={(next) => {
            setLimit(next)
            setPage(1)
          }}
          onPage={setPage}
          pairCount={pairs.length}
          rowCount={rowCount}
          focusLabel={focus === null ? null : labelOf(focus)}
        />
      )}

      <details className="group">
        <summary>What makes a swap legal</summary>
        <div className="group__body help-prose">
          <SwapRules />
        </div>
      </details>
    </>
  )
}

/**
 * The table, its pager and its count line — everything that only exists when there
 * is at least one pair.
 *
 * Split out purely so the rule disclosure above can sit outside the empty check
 * without wrapping the whole body in a ternary the length of the file. It takes what
 * it draws and decides nothing.
 */
function SuggestionTable({
  view,
  labelOf,
  ownerOf,
  user,
  owners,
  tracked,
  limit,
  onLimit,
  onPage,
  pairCount,
  rowCount,
  focusLabel,
}: {
  view: PagedRows<TradePair>
  labelOf: (tag: string) => string
  ownerOf: (tag: string) => string | undefined
  user: Pick<SessionUser, 'id' | 'role'>
  owners: OwnerRecord[]
  tracked: TradeRecord[]
  limit: RowLimit
  onLimit: (next: RowLimit) => void
  onPage: (next: number) => void
  pairCount: number
  rowCount: number
  /** The focused base's member name, or `null` when the table is clan-wide. */
  focusLabel: string | null
}) {
  return (
    <>
      <div className="table-wrap">
        {/* Stacks into one labeled card per swap on a phone; the explicit roles
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
                  {/*
                   * **Both members named on every row**, including the second and third
                   * option for the same pair.
                   *
                   * They used to be named once per pair, with blank cells beneath and a
                   * rule above each group to say "same two bases as above". That was
                   * reported as missing data twice — once from a screenshot and again
                   * from the live server, where the reporter noticed that pressing
                   * Propose recorded a trade with names the row had not shown. The
                   * button was always right: it holds the whole suggestion regardless of
                   * what is drawn. It was the row that was lying by omission.
                   *
                   * The cost is repetition on a pair with several options. That is the
                   * cheaper mistake: a repeated name is read once and ignored, an absent
                   * one sends somebody looking for a bug. `data-pair-start` still rules a
                   * line above each group, which is now grouping rather than the only
                   * thing making the blanks legible.
                   */}
                  <td className="stack-title" role="cell">
                    <BaseLabel
                      tag={pair.baseA}
                      label={labelOf(pair.baseA)}
                      owner={ownerOf(pair.baseA)}
                    />
                  </td>
                  <td role="cell" data-label="Gives">
                    <TradeCard cardId={trade.cardFromA} />
                  </td>
                  <td className="stack-title" role="cell">
                    <BaseLabel
                      tag={pair.baseB}
                      label={labelOf(pair.baseB)}
                      owner={ownerOf(pair.baseB)}
                    />
                  </td>
                  <td
                    role="cell"
                    data-label="Gives"
                  >
                    <TradeCard cardId={trade.cardFromB} />
                  </td>
                  <td className="card-meta" role="cell" data-label="Category">
                    {trade.category}
                  </td>
                  <td className="row-actions" role="cell" data-label="Propose">
                    <ProposeButton
                      trade={trade}
                      labelOf={labelOf}
                      user={user}
                      owners={owners}
                      tracked={tracked}
                    />{' '}
                    <CompleteNowButton trade={trade} user={user} />
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
          onChange={onLimit}
        />
        <Pager view={view} noun="pairs" onPage={onPage} />
      </div>

      {/*
       * Counts only. The two rules this line used to carry — that a row is an option
       * rather than a commitment, and what Propose does — are in the disclosure
       * below, which is present whether or not there are rows to count.
       */}
      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        {pairCount} pair{pairCount === 1 ? '' : 's'} could trade
        {focusLabel === null ? null : <> with {focusLabel}</>}
        {view.pageCount > 1 ? (
          <>
            , {rowCount} option{rowCount === 1 ? '' : 's'} on this page
          </>
        ) : null}
        .
      </p>
    </>
  )
}
