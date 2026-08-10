import type { CardTotal } from './card-standings.ts'
import { parseAllowlisted } from './persisted-choice.ts'

/**
 * Display order for the "Cards across the clan" panel. `default` is
 * `cardTotals()`'s own order — the grid's — unchanged; `highest` and `lowest`
 * rank the same rows by `total` instead.
 *
 * This is a **deliberate, opt-in reversal** of the invariant documented on
 * `cardTotals()` in `card-standings.ts`: that function itself still never sorts,
 * for every caller, including this one. Sorting happens here, afterward, over
 * its output — never inside it — so the entry-grid comparison the default view
 * exists for is untouched unless somebody explicitly asks to break it.
 */
export type CardTotalSort = 'default' | 'highest' | 'lowest'

/** Every state the control offers, in the order it offers them. */
export const CARD_TOTAL_SORTS: readonly CardTotalSort[] = ['default', 'highest', 'lowest']

const DEFAULT_SORT: CardTotalSort = 'default'

/** What the select's own option reads, for each state. */
export function cardTotalSortLabel(sort: CardTotalSort): string {
  switch (sort) {
    case 'default':
      return 'Grid order'
    case 'highest':
      return 'Highest to lowest'
    case 'lowest':
      return 'Lowest to highest'
  }
}

/**
 * Reorders `cardTotals()`'s output for display. `default` returns a copy in the
 * same order it arrived in — the input is never mutated, and `default` is a copy
 * rather than the same reference so a caller cannot tell the two modes apart by
 * identity.
 *
 * `highest`/`lowest` sort by `total` alone. Ties keep the rows in the order they
 * arrived — `Array.prototype.sort` is a stable sort, so two cards level on total
 * fall back to grid order rather than reshuffling between renders, the same
 * reasoning `baseStandings`' comparator uses for a tied leaderboard.
 */
export function sortCardTotalsForDisplay(
  totals: readonly CardTotal[],
  sort: CardTotalSort,
): CardTotal[] {
  if (sort === 'default') return totals.slice()
  const sign = sort === 'highest' ? -1 : 1
  return totals.slice().sort((a, b) => sign * (a.total - b.total))
}

/**
 * Reads a stored sort choice back. Anything that is not one of the three known
 * states — absent, hand-edited, or a state an older/newer build no longer offers
 * — falls back to `default`. See `parseAllowlisted` (`persisted-choice.ts`) for
 * the shared shape this and every other picker's own parse function use.
 */
export function parseCardTotalSort(stored: string | null): CardTotalSort {
  return parseAllowlisted(stored, CARD_TOTAL_SORTS, DEFAULT_SORT)
}
