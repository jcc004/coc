import { useEffect, useMemo, useState } from 'react'
import {
  normalizeTag,
  type BaseInventory,
  type OwnerRecord,
  type SessionUser,
  type TradeRecord,
} from '@coc/shared'
import { ApiError } from '../api.ts'
import { scrollAndFocusFirst, scrollBehaviorFor } from '../card-sections.ts'
import {
  flattenTradePairs,
  groupTradesByPair,
  sortTradesByMutuality,
  suggestTrades,
  type TradePair,
  type TradeRow,
  type TradeSuggestion,
} from '../card-trades.ts'
import { cardById, categoryOfCard } from '../cards.ts'
import { hrefFor, usePersistedChoice, useRowLimit } from '../hooks.ts'
import { useOwners } from '../owners.ts'
import { paginate, type PagedRows, type RowLimit } from '../saved-table.ts'
import {
  UNOWNED,
  UNOWNED_LABEL,
  filterPairsByOwners,
  orientRowForOwner,
  ownersInPairs,
  tradeFilterSummary,
} from '../trade-filters.ts'
import { maxAchievableTrades, sortTradesByAchievability, tradeKey } from '../trade-matching.ts'
import {
  filterPairsByMutuality,
  parseTradeMutualityFilter,
  tradeMutualityFilterLabel,
  tradeMutualityFilterSummary,
  TRADE_MUTUALITY_FILTERS,
  type TradeMutualityFilter,
} from '../trade-mutuality-filter.ts'
import {
  parseTradePriority,
  sortTradePairsForPriority,
  tradePriorityLabel,
  TRADE_PRIORITIES,
  type TradePriority,
} from '../trade-priority.ts'
import {
  findPendingSwap,
  sidesOfTrade,
  tradeProposeAccess,
  tradeRowId,
} from '../trade-tracker.ts'
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

/**
 * Scrolls to and focuses a specific trade's row on the tracker below, falling back
 * to the tracker's own section heading when the row itself isn't there to find.
 *
 * **The row won't always be rendered.** `sortTrades` puts pending trades first but
 * *oldest* first within that group, so a trade just proposed lands at the *end* of
 * the pending block — off the tracker's current page if it paginates, since the
 * tracker's own page state is internal to it and nothing outside the component can
 * reach it. And on a player page, `TradeSuggestions` and `TradeTracker` are mounted
 * together inside one disclosure (see this module's own doc comment); if that panel
 * is closed the tracker never rendered its rows at all. Either way, `cards-tracker`
 * — the card page's own tracker heading id — does not exist there either, so
 * `scrollAndFocusFirst` trying it as a fallback is a no-op rather than a mistake.
 *
 * `scrollAndFocusFirst` already answers "missing is a no-op, not a throw" for both
 * ids it tries — this runs inside a click handler on a page with no error boundary
 * above it (`hooks.ts`, per this repo's `CLAUDE.md`).
 */
function jumpToTrackedTrade(id: number): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  scrollAndFocusFirst([tradeRowId(id), 'cards-tracker'], scrollBehaviorFor(reducedMotion))
}

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
  /* Set from `proposeTrade`'s own response, the moment this exact click proposes it.
     A fallback for `pending?.id` below, not the primary source — see there for why. */
  const [sentId, setSentId] = useState<number | null>(null)

  const access = tradeProposeAccess(user, sidesOfTrade(trade, owners))
  const pending = findPendingSwap(tracked, trade)

  /*
   * `state` is a one-render bridge to cover the gap before `tracked` catches up
   * with a proposal this exact click just made — see the comment below. Nothing
   * ever moved it back once that gap closed, so once a trade left `pending` for
   * any other reason afterwards (declined, completed, undone), `pending` went
   * back to `undefined` the way `findPendingSwap` intends, but `state` stayed
   * stuck at `'sent'` from the original proposal, and the `||` below kept
   * reading it as still on the tracker forever. Reported and reproduced
   * 2026-08-08: propose, decline on the tracker, the suggestion still read "On
   * the tracker ↓". Resetting here, once `tracked` confirms this exact swap is
   * genuinely not pending, is what lets the button honestly go back to
   * `Propose` — restated by the same store data this component already trusts,
   * not a timer or a guess at how long the bridge should last.
   */
  useEffect(() => {
    if (pending === undefined && state === 'sent') {
      setState('idle')
      setSentId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (!access.allowed) {
    return (
      <span className="card-meta" title={access.message}>
        {labelOf(trade.baseA)} or {labelOf(trade.baseB)} can propose this
      </span>
    )
  }

  /* `sent` and `pending` are the same fact one render apart — the store refresh that
     follows a proposal is what turns the first into the second — so both read the
     same way and the label cannot flicker between them. */
  if (pending !== undefined || state === 'sent') {
    /* `pending?.id` first: it comes from the tracker's own store, which
       `proposeTrade` already refreshed before resolving (`server-store.ts`'s
       `mutate` awaits `load()`), so by the time either condition above is true it is
       normally there. `sentId` only covers the render in between, before that
       refreshed snapshot has propagated down as this component's `tracked` prop. */
    const rowId = pending?.id ?? sentId
    return (
      <button
        type="button"
        className="trade-tracker-link"
        onClick={rowId === null ? undefined : () => jumpToTrackedTrade(rowId)}
        disabled={rowId === null}
      >
        On the tracker ↓
      </button>
    )
  }

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
            .then((proposed) => {
              setSentId(proposed.id)
              setState('sent')
            })
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
 * The one-click Complete — propose and complete a suggestion in one step, instead
 * of a trip to the tracker below to approve what was just proposed.
 *
 * **Party-or-admin, the same rule `ProposeButton` beside it already uses.** This
 * used to be an admin's fast path alone, reasoned as needing no separate check
 * because an admin already clears both `tradeProposeAccess` and
 * `tradeResolveAccess` unconditionally. That reasoning still holds for an admin,
 * but the button is no longer admin-only: an owner of either base may use it too,
 * because a party who can propose a swap between their own base and another can
 * also resolve it once it is pending — the server already permits exactly that
 * sequence (`mayProposeTrade` then `mayResolveTrade`, both party-or-admin), so
 * this only exposes in the UI what was already allowed.
 *
 * Reuses `proposeTrade` as-is, including its already-proposed handling — a duplicate
 * 409 comes back as the existing pending row rather than an error — so the same click
 * handler works whether or not this exact swap is already on the tracker: propose (or
 * recover the existing one), then complete it.
 *
 * **Renders nothing, with no message, when refused** — not the "X or Y can propose
 * this" text `ProposeButton` shows for the identical refusal, because that message
 * is already sitting right beside this button in the same row (see
 * `SuggestionTable` below): repeating it here would put the same sentence in front
 * of the same reader twice in one glance.
 */
function CompleteNowButton({
  trade,
  user,
  owners,
}: {
  trade: TradeSuggestion
  user: Pick<SessionUser, 'id' | 'role'>
  owners: OwnerRecord[]
}) {
  const [state, setState] = useState<'idle' | 'sending'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  const access = tradeProposeAccess(user, sidesOfTrade(trade, owners))
  if (!access.allowed) return null

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

/**
 * The "Involving" / "and" owner pickers and the "Other only" checkbox — pulled
 * out of {@link TradeSuggestions} so its own `ownerChoices.length > 1 ? ... :
 * null` guard is one conditional rather than one nested inside `pairs.length > 0`'s.
 *
 * Labeled "Involving" and "and" rather than by column, because that is what they
 * do: the pair of selections is matched as a set against the pair of owners, in
 * either order. Naming them for the columns would promise something the table
 * cannot deliver, since which side an owner lands on is decided by their base's tag.
 *
 * Clear lives in {@link TradeSuggestions} itself now, not here — it resets this
 * component's own three fields plus the mutuality filter beside it, and neither
 * filter is this component's to own.
 */
function OwnerFilterControls({
  ownerChoices,
  firstOwner,
  secondOwner,
  otherOnly,
  onFirstOwner,
  onSecondOwner,
  onOtherOnly,
}: {
  ownerChoices: string[]
  firstOwner: string | null
  secondOwner: string | null
  otherOnly: boolean
  onFirstOwner: (owner: string | null) => void
  onSecondOwner: (owner: string | null) => void
  onOtherOnly: (checked: boolean) => void
}) {
  return (
    <>
      <label htmlFor="trade-owner-a">
        Involving
        <select
          id="trade-owner-a"
          value={firstOwner ?? ''}
          onChange={(event) => onFirstOwner(event.target.value === '' ? null : event.target.value)}
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
          onChange={(event) => onSecondOwner(event.target.value === '' ? null : event.target.value)}
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
          onChange={(event) => onOtherOnly(event.target.checked)}
        />
        Other only
      </label>
    </>
  )
}

/** Rows-per-page options for the suggestions. See {@link TradeSuggestions}. */
const TRADE_ROW_LIMITS: RowLimit[] = [5, 10, 20, 'all']

/** Where the chosen trade priority is remembered — one key shared by both pages this
    component renders on, since it is a preference about how the member likes to
    trade, not about which page they are on. */
const TRADE_PRIORITY_KEY = 'coc:tradePriority'

/** Where the chosen two-sided/one-sided/both filter is remembered — same reasoning
    as `TRADE_PRIORITY_KEY` above: a reading preference, not a per-page setting. */
const TRADE_MUTUALITY_FILTER_KEY = 'coc:tradeMutualityFilter'

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
 * **The page counts rows (individual options), not pairs.** This used to page by
 * pair — a limit of 5 meant 5 *pairs*, however many options each one carried —
 * on the reasoning that splitting a pair across a page boundary would leave a
 * continuation row with two empty Member cells at the top of page 2, reading as
 * missing data. That reasoning stopped being true once every row started naming
 * both bases on its own (see "Both members named on every row" below): nothing
 * renders ambiguously wherever a page boundary lands, so there is no reason left
 * to let one pair with several legal options push the row count on screen past
 * the number somebody actually picked. Reported live on prod: a limit of 5 showed
 * well more than 5 rows, because several options belonging to one pair each only
 * counted as that pair's "1". `flattenTradePairs` (`card-trades.ts`) is what turns
 * `pairs` into the flat, one-row-per-option list this pages over, so "5" means 5
 * `<tr>`s, not 5 decisions that could each expand. The limit is remembered under
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
   *
   * **The matching runs over the whole clan, before any narrowing.** A base's
   * spare is just as contested by a trade a player page never shows as by one it
   * does, so computing `maxAchievableTrades` only over `focus`'s own pairs would
   * answer a different, too-generous question — "how many could this base do if
   * nobody else on the list wanted the same spares" — instead of the real one.
   * `achievableCount` below then narrows the *result* of that clan-wide matching
   * to `focus`, which is the same "run wide, narrow after" shape `pairs` itself
   * already uses.
   */
  const flatTrades = useMemo(() => suggestTrades(bases, categoryOfCard), [bases])
  const achievable = useMemo(() => maxAchievableTrades(flatTrades, bases), [flatTrades, bases])
  const pairs = useMemo(() => {
    /* `flatTrades` itself stays pure rarity order — `sortTradePairsForPriority`'s
       `highestValue` mode ranks directly off it and needs that, see
       `suggestTrades`'s own doc comment. Mutual-preference is layered on top
       here, for `pairs`/`optimal` only, and it goes on *last* — applied after
       achievability, not before — so it is the dominant key: every two-sided
       trade sorts ahead of every one-sided one regardless of achievability,
       matching the promise `help-copy.tsx`'s `SwapRules` makes ("sorts below
       the swaps that gain both sides something new"). Achievability only
       breaks ties within a mutual/one-sided group. */
    const all = groupTradesByPair(sortTradesByMutuality(sortTradesByAchievability(flatTrades, achievable)))
    return focus === null ? all : pairsInvolving(all, focus)
  }, [flatTrades, achievable, focus])

  /*
   * The priority selector only changes which order `pairs` displays in — the
   * matching above, and what counts as "achievable", are unaffected. `optimal`
   * is `pairs` unchanged; every other mode still falls back to `pairs`' own
   * order (mutual first, achievable second, rarest value third) wherever its
   * own key ties, which is what keeps optimal trading the invisible second
   * ordering mechanism regardless of which priority is picked — see
   * `trade-priority.ts`.
   */
  const [priority, setPriority] = usePersistedChoice(TRADE_PRIORITY_KEY, parseTradePriority)
  const prioritizedPairs = useMemo(
    () => sortTradePairsForPriority(pairs, priority, flatTrades, achievable),
    [pairs, priority, flatTrades, achievable],
  )

  /*
   * Which side(s) of a pair's own trades show at all — a filter, not just a
   * reading order, so it narrows `prioritizedPairs` before anything downstream
   * sees it. `'twoSided'` is the default (`parseTradeMutualityFilter`), so a
   * one-sided trade is hidden unless a member explicitly asks for it or for
   * `'both'` — see `trade-mutuality-filter.ts` for why the default leans this
   * way. Filters *trades within* a pair, not whether to keep the pair, since
   * one pair can offer both kinds of option at once.
   */
  const [mutualityFilter, setMutualityFilter] = usePersistedChoice(
    TRADE_MUTUALITY_FILTER_KEY,
    parseTradeMutualityFilter,
  )
  const mutualityFilteredPairs = useMemo(
    () => filterPairsByMutuality(prioritizedPairs, mutualityFilter),
    [prioritizedPairs, mutualityFilter],
  )
  const mutualityNote = tradeMutualityFilterSummary(
    mutualityFilter,
    mutualityFilteredPairs.length,
    pairs.length,
  )

  /* The headline number: how many of `pairs`'s own candidates could really all
     complete together, not merely how many pairs have *an* option — see
     `trade-matching.ts` for why those two counts differ. Scoped to `pairs`
     (focus-narrowed, not owner-filtered) for the same reason the old raw pair
     count always was: the owner pickers narrow what is *displayed*, not what
     the summary line is answering. */
  const achievableCount = useMemo(
    () =>
      pairs.reduce(
        (sum, pair) => sum + pair.trades.filter((trade) => achievable.has(tradeKey(trade))).length,
        0,
      ),
    [pairs, achievable],
  )

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
    () => filterPairsByOwners(mutualityFilteredPairs, ownerOf, firstOwner, secondOwner, otherOnly),
    [mutualityFilteredPairs, ownerOf, firstOwner, secondOwner, otherOnly],
  )
  const filterNote = tradeFilterSummary(
    shown.length,
    pairs.length,
    firstOwner,
    secondOwner,
    otherOnly,
  )

  /* One row per option, not one per pair — see the `TradeSuggestions` doc comment
     above for why the limit has to page over this instead of over `shown` itself. */
  const rows = useMemo(() => flattenTradePairs(shown), [shown])

  const [limit, setLimit] = useRowLimit('coc:tradePairLimit', 5)
  const [page, setPage] = useState(1)
  const view = useMemo(() => paginate(rows, limit, page), [rows, limit, page])

  /* Re-entered counts — or a filter — can shrink the list under a page number that is
     now past the end; `paginate` clamps, and this puts the control back in step. */
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  const rowCount = view.rows.length

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
       * The owner pickers render only when there is more than one owner to choose
       * between — with a single owner in the whole list they could only ever narrow it
       * to everything or nothing (see `OwnerFilterControls`, called below). The
       * priority select beside them is not gated the same way: it is useful even to a
       * single-owner account, so it renders whenever there is a table at all, not only
       * alongside the owner pickers it happens to sit next to.
       */}
      {pairs.length > 0 ? (
        <div className="roster-filters">
          {ownerChoices.length > 1 ? (
            <OwnerFilterControls
              ownerChoices={ownerChoices}
              firstOwner={firstOwner}
              secondOwner={secondOwner}
              otherOnly={otherOnly}
              onFirstOwner={(owner) => {
                setFirstOwner(owner)
                setPage(1)
              }}
              onSecondOwner={(owner) => {
                setSecondOwner(owner)
                setPage(1)
              }}
              onOtherOnly={(checked) => {
                setOtherOnly(checked)
                setPage(1)
              }}
            />
          ) : null}

          {/* Reorders `pairs` for display — never which trades are achievable, only
              which of them show up first. See `trade-priority.ts`: every mode still
              falls back to the mutual-then-achievable-then-rarity order underneath, so
              this is a reading preference layered on top of "optimal", not a
              replacement for it. */}
          <label htmlFor="trade-priority">
            Priority
            <select
              id="trade-priority"
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as TradePriority)
                setPage(1)
              }}
            >
              {TRADE_PRIORITIES.map((option) => (
                <option key={option} value={option}>
                  {tradePriorityLabel(option)}
                </option>
              ))}
            </select>
          </label>

          {/* Which side(s) of a pair's own trades to show at all — a real filter,
              not just a reading order, so it can shrink the list on its own. See
              `trade-mutuality-filter.ts` for why `'twoSided'` is the default. */}
          <label htmlFor="trade-mutuality">
            Sides
            <select
              id="trade-mutuality"
              value={mutualityFilter}
              onChange={(event) => {
                setMutualityFilter(event.target.value as TradeMutualityFilter)
                setPage(1)
              }}
            >
              {TRADE_MUTUALITY_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {tradeMutualityFilterLabel(option)}
                </option>
              ))}
            </select>
          </label>

          {firstOwner !== null || secondOwner !== null || mutualityFilter !== 'twoSided' ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setFirstOwner(null)
                setSecondOwner(null)
                setOtherOnly(false)
                setMutualityFilter('twoSided')
                setPage(1)
              }}
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* What the mutuality filter did, then what the owner filters did — two
          independent narrowings, each explaining its own share so a shorter list
          never reads as missing data. */}
      {mutualityNote !== null ? <p className="empty-hint">{mutualityNote}</p> : null}
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
          achievableCount={achievableCount}
          rowCount={rowCount}
          focusLabel={focus === null ? null : labelOf(focus)}
          soleOwner={firstOwner}
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
  achievableCount,
  rowCount,
  focusLabel,
  soleOwner,
}: {
  view: PagedRows<TradeRow>
  labelOf: (tag: string) => string
  ownerOf: (tag: string) => string | undefined
  user: Pick<SessionUser, 'id' | 'role'>
  owners: OwnerRecord[]
  tracked: TradeRecord[]
  limit: RowLimit
  onLimit: (next: RowLimit) => void
  onPage: (next: number) => void
  /** The size of the maximum achievable set — see `trade-matching.ts` — among
      the candidates in scope for this table (focus-narrowed, not
      owner-filtered, the same scope `filterNote` already leaves untouched). */
  achievableCount: number
  rowCount: number
  /** The focused base's member name, or `null` when the table is clan-wide. */
  focusLabel: string | null
  /** The "Involving" picker's own selection — `null` unless narrowed to one
      owner. Passed straight to `orientRowForOwner` so that owner's base always
      prints on the left, whichever side `suggestTrades`'s tag ordering put it on. */
  soleOwner: string | null
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
            {view.rows.map((row) => {
              const { trade, pairStart } = row
              /* Display orientation only — `pair`/`trade` keep the tag-based order
                 `card-trades.ts` computed them in; everything below reads `left`/
                 `right` rather than `baseA`/`baseB` directly, so the "Involving"
                 picker's own owner always lands in the left column instead of
                 wherever `suggestTrades`'s tag comparison happened to put it. See
                 `orientRowForOwner` in `trade-filters.ts`. */
              const { left, right } = orientRowForOwner(row, ownerOf, soleOwner)
              return (
                <tr
                  key={`${trade.baseA}-${trade.baseB}-${trade.cardFromA}-${trade.cardFromB}`}
                  role="row"
                  /*
                   * Marks where one pair's block of options begins, so the wide
                   * table can rule a line above it. Without that, a continuation
                   * row's empty Member cells read as missing data rather than as
                   * "same two bases as above" — seen in a screenshot, where the
                   * second option rendered as a bare "Minion / Hog Rider" row
                   * with nobody's name on it. `flattenTradePairs` computes this the
                   * same way regardless of which page a pair's options land on,
                   * since the table now pages by row rather than by pair.
                   */
                  data-pair-start={pairStart ? 'true' : undefined}
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
                   * thing making the blanks legible — and it is also what makes it safe
                   * for a pair's options to be split by a page boundary now: the row on
                   * either side of the split still names both bases on its own.
                   */}
                  <td className="stack-title" role="cell">
                    <BaseLabel tag={left.tag} label={labelOf(left.tag)} owner={ownerOf(left.tag)} />
                  </td>
                  <td role="cell" data-label="Gives">
                    <TradeCard cardId={left.cardId} />
                  </td>
                  <td className="stack-title" role="cell">
                    <BaseLabel tag={right.tag} label={labelOf(right.tag)} owner={ownerOf(right.tag)} />
                  </td>
                  <td role="cell" data-label="Gives">
                    <TradeCard cardId={right.cardId} />
                  </td>
                  {/* `mutual` is false only when one side of the swap already owns
                      the card it would receive — still a legal trade (`card-trades.ts`),
                      just lower priority, which is why it sorts to the bottom of
                      its group rather than getting a whole column. Either owner (or
                      an admin) may press Propose below, so the tooltip describes the
                      trade itself rather than assuming who clicks it. */}
                  <td className="card-meta" role="cell" data-label="Category">
                    {trade.category}
                    {!trade.mutual && (
                      <span
                        className="chip chip--static"
                        title="One side already owns the card it would receive — still legal, just lower priority"
                      >
                        {' One-sided'}
                      </span>
                    )}
                  </td>
                  <td className="row-actions" role="cell" data-label="Propose">
                    <ProposeButton
                      trade={trade}
                      labelOf={labelOf}
                      user={user}
                      owners={owners}
                      tracked={tracked}
                    />{' '}
                    <CompleteNowButton trade={trade} user={user} owners={owners} />
                  </td>
                </tr>
              )
            })}
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
          id="trade-options"
          label="Options"
          options={TRADE_ROW_LIMITS}
          value={limit}
          onChange={onLimit}
        />
        <Pager view={view} noun="options" onPage={onPage} />
      </div>

      {/*
       * Counts only. The two rules this line used to carry — that a row is an option
       * rather than a commitment, and what Propose does — are in the disclosure
       * below, which is present whether or not there are rows to count.
       *
       * **"Trades" here, not "pairs".** This used to count pairs that have *any*
       * legal option, which overstated what the clan could actually get done:
       * completing one trade spends a spare, and two pairs reaching for the same
       * spare cannot both go through. `achievableCount` is the size of the
       * largest set of trades that really could all complete together — see
       * `trade-matching.ts` — so it is never larger than the number of options on
       * the table, and can be smaller than the number of pairs with an option
       * even though every one of those pairs is individually real.
       */}
      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        Up to {achievableCount} trade{achievableCount === 1 ? '' : 's'} could happen at once
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
