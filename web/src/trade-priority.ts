import { parseAllowlisted } from './persisted-choice.ts'
import { tradeKey } from './trade-matching.ts'
import type { TradePair, TradeSuggestion } from './card-trades.ts'

/**
 * Display order for the trade suggestions table, layered over the pair order
 * `TradeSuggestions.tsx` already builds (`groupTradesByPair(sortTradesByAchievability(...))`
 * — achievable first, rarest value second, `card-trades.ts`/`trade-matching.ts`).
 *
 * `optimal` is that order, unchanged: it is the reason the site can promise a
 * headline "up to N trades could happen at once" at all, and every other mode
 * still falls back to it wherever its own primary key ties. That fallback is
 * not incidental — it is the whole point of this module. A member choosing
 * `fewestPartners` is asking "which order gets me in and out of the fewest
 * trade windows", not "stop telling me what's achievable"; the site is always
 * optimizing for real, completable trades underneath, and a priority mode only
 * changes which of those trades gets read first, never whether achievability
 * still decides the ties. `docs/cards-ui.md` documents this explicitly, the
 * same commitment `card-total-sort.ts` makes for the "Cards across the clan"
 * grid's own Sort control — that function's own doc comment is the template
 * this one follows: a small closed set of states, a stable sort layered over
 * an existing order rather than a replacement of it, and a `parse*` fallback
 * for a stored value an older or newer build no longer offers.
 */
export type TradePriority = 'optimal' | 'fewestPartners' | 'highestValue'

/** Every state the control offers, in the order it offers them. */
export const TRADE_PRIORITIES: readonly TradePriority[] = ['optimal', 'fewestPartners', 'highestValue']

const DEFAULT_PRIORITY: TradePriority = 'optimal'

/** What the select's own option reads, for each state. */
export function tradePriorityLabel(priority: TradePriority): string {
  switch (priority) {
    case 'optimal':
      return 'Optimal'
    case 'fewestPartners':
      return 'Fewest partners'
    case 'highestValue':
      return 'Highest value'
  }
}

/** How many of a pair's own trades are in the achievable set — `fewestPartners`'s key. */
function achievableCountIn(pair: TradePair, achievable: ReadonlySet<string>): number {
  return pair.trades.filter((trade) => achievable.has(tradeKey(trade))).length
}

/**
 * A pair's rank under `highestValue`: the earliest position among its own
 * trades in `flatTrades`, the un-bucketed list `suggestTrades` returns.
 *
 * `suggestTrades` sorts by rarity value descending, so a lower index there
 * means a rarer card — and because that comparator is a total order (rarity,
 * then tag, then card id, with no ties, per `card-trades.ts`), no two pairs
 * can ever land on the same rank. `highestValue` needs this instead of
 * `pairs`' own incoming order because `pairs` has *already* had achievability
 * layered over value (`sortTradesByAchievability`): reading rank from `pairs`
 * would silently keep bucketing by achievability first, which is exactly what
 * this mode exists to set aside as the *primary* key while still honoring it
 * as this module's fallback for other modes.
 */
function valueRankOf(pair: TradePair, valueRank: ReadonlyMap<string, number>): number {
  let best = Number.POSITIVE_INFINITY
  for (const trade of pair.trades) {
    const rank = valueRank.get(tradeKey(trade))
    if (rank !== undefined && rank < best) best = rank
  }
  return best
}

/** `tradeKey(trade)` → its index in `flatTrades`, for `valueRankOf`. */
function buildValueRank(flatTrades: readonly TradeSuggestion[]): Map<string, number> {
  const rank = new Map<string, number>()
  flatTrades.forEach((trade, index) => rank.set(tradeKey(trade), index))
  return rank
}

/**
 * Sorts `pairs` by a numeric key computed once per pair rather than
 * recomputed on every comparison — decorate/sort/undecorate, since
 * `Array.prototype.sort`'s comparator otherwise reruns `keyOf` O(n log n)
 * times instead of the O(n) this needs. Descending when `ascending` is
 * false, so `fewestPartners` (highest achievable count first) and
 * `highestValue` (lowest rank — i.e. rarest — first) can share one helper.
 */
function sortByKey(
  pairs: readonly TradePair[],
  keyOf: (pair: TradePair) => number,
  ascending: boolean,
): TradePair[] {
  const decorated = pairs.map((pair) => ({ pair, key: keyOf(pair) }))
  decorated.sort((a, b) => (ascending ? a.key - b.key : b.key - a.key))
  return decorated.map((entry) => entry.pair)
}

/**
 * `pairs`, reordered for the chosen priority. `optimal` returns a copy in the
 * same order it arrived in — the input is never mutated, and `optimal` is a
 * copy rather than the same reference so a caller cannot tell the two modes
 * apart by identity, the same guarantee `sortCardTotalsForDisplay` makes for
 * its own `default` state.
 *
 * `fewestPartners` ranks a pair by how many of its own options are currently
 * achievable, descending — a partner who can complete several trades at once
 * outranks one who can only complete one, so fewer distinct bases need a trade
 * window opened for the same amount of value moved. `highestValue` ranks by
 * the rarest card either pair's own trades would give up, regardless of
 * whether that trade is achievable right now.
 *
 * Both non-default modes are a stable sort over `pairs` as handed in, so a tie
 * on the mode's own key — `fewestPartners`' can genuinely tie; `highestValue`'s
 * cannot, per `valueRankOf` — keeps the pairs in `pairs`' own incoming order,
 * which is the achievable-then-rarity order this function is layered over.
 * That is the "optimal stays the invisible second ordering mechanism" promise
 * this module exists to keep, not a side effect of `Array.prototype.sort`
 * happening to be stable.
 */
export function sortTradePairsForPriority(
  pairs: readonly TradePair[],
  priority: TradePriority,
  flatTrades: readonly TradeSuggestion[],
  achievable: ReadonlySet<string>,
): TradePair[] {
  if (priority === 'optimal') return pairs.slice()

  if (priority === 'fewestPartners') {
    return sortByKey(pairs, (pair) => achievableCountIn(pair, achievable), false)
  }

  const valueRank = buildValueRank(flatTrades)
  return sortByKey(pairs, (pair) => valueRankOf(pair, valueRank), true)
}

/**
 * Reads a stored priority choice back. Anything that is not one of the three
 * known states — absent, hand-edited, or a state an older/newer build no
 * longer offers — falls back to `optimal`. See `parseAllowlisted`
 * (`persisted-choice.ts`) for the shared shape this and every other picker's
 * own parse function use.
 */
export function parseTradePriority(stored: string | null): TradePriority {
  return parseAllowlisted(stored, TRADE_PRIORITIES, DEFAULT_PRIORITY)
}
