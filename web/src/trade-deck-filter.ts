import type { CardCategory } from '@coc/shared'
import { cardCategoriesInOrder } from './cards.ts'
import { parseAllowlisted } from './persisted-choice.ts'
import type { TradePair } from './card-trades.ts'

/**
 * Which deck the suggestions table is narrowed to, or `'all'` for every deck.
 *
 * A trade only ever moves a card within one deck (`suggestTrades`'s rule 3,
 * `card-trades.ts`), so every option in a pair's `trades` already carries its
 * own `category` — this filter reads that field directly rather than deriving
 * anything new. `'all'` is the default: unlike `Sides`, where the lower-priority
 * kind is worth hiding until asked for, no deck is more worth seeing than
 * another, so the unfiltered view is the right first look.
 */
export type TradeDeckFilter = 'all' | CardCategory

/**
 * Every state the control offers, in the order it offers them — `'all'` first,
 * then the four decks in `cardCategoriesInOrder()`'s own order (the manifest's
 * order, the same one the card grid and the leaderboard's own `Deck` picker
 * already draw the decks in — see `cards.ts`).
 */
export const TRADE_DECK_FILTERS: readonly TradeDeckFilter[] = ['all', ...cardCategoriesInOrder()]

const DEFAULT_DECK_FILTER: TradeDeckFilter = 'all'

/** What the select's own option reads, for each state. */
export function tradeDeckFilterLabel(filter: TradeDeckFilter): string {
  return filter === 'all' ? 'All decks' : filter
}

/**
 * `pairs`, narrowed to the trades in `filter`'s deck — a pair whose every
 * trade is in a different deck drops entirely, rather than surviving as an
 * empty block. `'all'` returns a copy rather than the same array, the same
 * "never let a caller tell the modes apart by identity" guarantee
 * `filterPairsByMutuality` (`trade-mutuality-filter.ts`) makes for its own
 * `'both'` state.
 *
 * Filters each pair's own `trades`, not whether to keep the pair, for the same
 * reason `filterPairsByMutuality` does: one pair can offer options in more
 * than one deck at once (two bases can each hold spares in several decks the
 * other needs), so keeping or dropping the whole pair on one trade's deck
 * would silently hide the pair's other, still-wanted options.
 */
export function filterPairsByDeck(
  pairs: readonly TradePair[],
  filter: TradeDeckFilter,
): TradePair[] {
  if (filter === 'all') return pairs.slice()

  const filtered: TradePair[] = []
  for (const pair of pairs) {
    const trades = pair.trades.filter((trade) => trade.category === filter)
    if (trades.length > 0) filtered.push({ ...pair, trades })
  }
  return filtered
}

/**
 * What the filter did, in words, or `null` for `'all'` — there is nothing to
 * explain when nothing is hidden. Same shape as `tradeMutualityFilterSummary`
 * (`trade-mutuality-filter.ts`): a separate note from the owner filters' own
 * `tradeFilterSummary`, since this can shrink the list on its own.
 */
export function tradeDeckFilterSummary(
  filter: TradeDeckFilter,
  shown: number,
  total: number,
): string | null {
  if (filter === 'all') return null

  if (shown === 0) return `No ${filter} trades to show.`
  return `Showing ${shown} of ${total} pair${total === 1 ? '' : 's'}, ${filter} only.`
}

/**
 * Reads a stored filter choice back. Anything that is not `'all'` or one of
 * the decks the manifest currently ships — absent, hand-edited, or a deck a
 * past manifest offered and this one no longer does — falls back to `'all'`.
 * See `parseAllowlisted` (`persisted-choice.ts`) for the shared shape this
 * and every other picker's own parse function use.
 */
export function parseTradeDeckFilter(stored: string | null): TradeDeckFilter {
  return parseAllowlisted(stored, TRADE_DECK_FILTERS, DEFAULT_DECK_FILTER)
}
