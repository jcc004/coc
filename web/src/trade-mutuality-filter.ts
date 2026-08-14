import { parseAllowlisted } from './persisted-choice.ts'
import type { TradePair } from './card-trades.ts'

/**
 * Which of a pair's own trades the suggestions table shows: two-sided
 * (`mutual: true`, both bases gain a new card), one-sided (`mutual: false`,
 * only one side does — see `card-trades.ts`'s `suggestTrades` doc comment for
 * the rule), or both.
 *
 * `'twoSided'` is the default. A one-sided swap is still a real, completable
 * trade — `help-copy.tsx`'s `SwapRules` says so directly — but it is the
 * lower-priority kind, and defaulting to hiding it keeps the table's first
 * impression to the trades that help both sides, with One-sided/Both there
 * for whoever wants the rest.
 */
export type TradeMutualityFilter = 'twoSided' | 'oneSided' | 'both'

/** Every state the control offers, in the order it offers them. */
export const TRADE_MUTUALITY_FILTERS: readonly TradeMutualityFilter[] = [
  'twoSided',
  'oneSided',
  'both',
]

const DEFAULT_MUTUALITY_FILTER: TradeMutualityFilter = 'twoSided'

/** What the select's own option reads, for each state. */
export function tradeMutualityFilterLabel(filter: TradeMutualityFilter): string {
  switch (filter) {
    case 'twoSided':
      return 'Two-sided'
    case 'oneSided':
      return 'One-sided'
    case 'both':
      return 'Both'
  }
}

/**
 * `pairs`, narrowed to the trades `filter` allows — a pair whose every trade
 * is filtered out drops entirely, rather than surviving as an empty block.
 *
 * Filters each pair's own `trades`, not whether to keep the pair, because
 * mutuality is a property of one trade, not of the two bases: one pair can
 * offer both a two-sided option and a one-sided one at once (`card-trades.ts`'s
 * `suggestTrades` puts no such restriction on a pair), so keeping or dropping
 * the whole pair on one trade's mutuality would silently hide the pair's other,
 * still-wanted option.
 *
 * `'both'` returns a copy rather than the same array — the same "never let a
 * caller tell the modes apart by identity" guarantee `sortTradePairsForPriority`
 * makes for its own `optimal` state.
 */
export function filterPairsByMutuality(
  pairs: readonly TradePair[],
  filter: TradeMutualityFilter,
): TradePair[] {
  if (filter === 'both') return pairs.slice()

  const wantMutual = filter === 'twoSided'
  const filtered: TradePair[] = []
  for (const pair of pairs) {
    const trades = pair.trades.filter((trade) => trade.mutual === wantMutual)
    if (trades.length > 0) filtered.push({ ...pair, trades })
  }
  return filtered
}

/**
 * What the filter did, in words, or `null` for `'both'` — there is nothing to
 * explain when nothing is hidden.
 *
 * A separate note from `trade-filters.ts`'s `tradeFilterSummary`, on the same
 * "a shorter list with no explanation reads as missing data" reasoning that
 * function's own doc comment states: this filter can shrink the list on its
 * own, independent of the owner pickers, and `'twoSided'` being the *default*
 * makes that especially worth saying out loud — a first-time viewer who never
 * touched this control still needs to know why a one-sided trade they expect
 * to see is not on the page.
 */
export function tradeMutualityFilterSummary(
  filter: TradeMutualityFilter,
  shown: number,
  total: number,
): string | null {
  if (filter === 'both') return null
  const label = filter === 'twoSided' ? 'two-sided' : 'one-sided'

  if (shown === 0) return `No ${label} trades to show.`
  return `Showing ${shown} of ${total} pair${total === 1 ? '' : 's'}, ${label} only.`
}

/**
 * Reads a stored filter choice back. Anything that is not one of the three
 * known states — absent, hand-edited, or a state an older/newer build no
 * longer offers — falls back to `'twoSided'`. See `parseAllowlisted`
 * (`persisted-choice.ts`) for the shared shape this and every other picker's
 * own parse function use.
 */
export function parseTradeMutualityFilter(stored: string | null): TradeMutualityFilter {
  return parseAllowlisted(stored, TRADE_MUTUALITY_FILTERS, DEFAULT_MUTUALITY_FILTER)
}
