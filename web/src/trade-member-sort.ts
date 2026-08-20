import { parseAllowlisted } from './persisted-choice.ts'
import { sortByComputedKey } from './saved-table.ts'
import { nameCompare, orientPairForOwner } from './trade-filters.ts'
import type { TradePair } from './card-trades.ts'

/**
 * Reading order for the trade suggestions table, by member name — a second,
 * independent axis over `pairs` from `trade-priority.ts`'s own `TradePriority`,
 * not a replacement for it. `sortTradePairsByMember` is applied *after*
 * `sortTradePairsForPriority`, so `'none'` here leaves the priority's own order
 * (achievable, then mutual, then rarity, then whichever priority mode is
 * active) exactly as it was, and any other value here replaces it entirely
 * with a two-key alphabetical sort — the primary column named by the mode,
 * the *other* column always ascending as the Excel-style secondary key. A
 * member sort is a request to read the table purely by name, so it does not
 * fall back to Priority's order on a tie the way an earlier version of this
 * function did — see the "sorts purely by name" note on `sortTradePairsByMember`
 * below for why a request specifically for name order should not have
 * achievability or rarity silently deciding the rest of it.
 *
 * **Both member columns, sorted by what's actually printed under them, not by
 * `pair.baseA`/`pair.baseB` directly.** Those two are stable — `suggestTrades`
 * always orients the lexicographically smaller tag as `baseA` — but *which
 * column that lands in on screen* is not: `orientRowForOwner`
 * (`trade-filters.ts`) swaps a pair's display left/right whenever a single
 * "Involving" owner is in focus, so that owner's own base always reads on the
 * left regardless of which one `suggestTrades` called `baseA`. "First member"
 * has to mean "whatever's in the first column right now", the same thing a
 * click on `RosterTable`'s own "Member" column head means — so this sorts by
 * `orientPairForOwner`'s own left/right, the pair-level version of the same
 * swap `orientRowForOwner` applies per row, rather than by the pair's raw,
 * un-oriented tags.
 */
export type TradeMemberSort = 'none' | 'firstAsc' | 'firstDesc' | 'secondAsc' | 'secondDesc'

/** Every state the control offers, in the order it offers them. */
export const TRADE_MEMBER_SORTS: readonly TradeMemberSort[] = [
  'none',
  'firstAsc',
  'firstDesc',
  'secondAsc',
  'secondDesc',
]

const DEFAULT_MEMBER_SORT: TradeMemberSort = 'none'

/** What the select's own option reads, for each state. */
export function tradeMemberSortLabel(sort: TradeMemberSort): string {
  switch (sort) {
    case 'none':
      return 'Default order'
    case 'firstAsc':
      return 'First member (A–Z)'
    case 'firstDesc':
      return 'First member (Z–A)'
    case 'secondAsc':
      return 'Second member (A–Z)'
    case 'secondDesc':
      return 'Second member (Z–A)'
  }
}

/**
 * `pairs`, reordered by member name when `sort` asks for it. `'none'` returns
 * a copy of `pairs` in the order it arrived in, unchanged — the same
 * "copy, not the same reference" guarantee `sortTradePairsForPriority`'s own
 * `optimal` makes, so a caller can never tell the two "leave it alone" modes
 * apart by identity.
 *
 * `ownerOf`/`soleOwner` are the same pair {@link orientRowForOwner} takes, and
 * for the same reason: whichever base is about to print in the first or
 * second column depends on them whenever a single "Involving" owner is
 * focused, and this has to sort by that same column, not by the pair's own
 * canonical `baseA`/`baseB`.
 *
 * **A member sort is a two-key Excel-style sort, not a single key with a
 * fallback.** The mode names its primary column and direction — `firstAsc`
 * sorts the first column A–Z, `secondDesc` sorts the second column Z–A — and
 * the *other* column is always the secondary key, always ascending,
 * regardless of the primary's own direction: a member asking to read the
 * table by name wants a name order all the way down, not achievability or
 * rarity silently deciding what a tied primary name falls back to. (An
 * earlier version of this function used `pairs`' own incoming order — the
 * achievable/mutual/rarity/priority order this is layered over — as the
 * tiebreak instead; that made "sort by name" only a partial reorder whenever
 * two pairs shared a first-column name, which is exactly the case a member
 * asking for alphabetical order cares about most.)
 *
 * Two pairs whose *both* columns are byte-for-byte identical are the only
 * true tie left, and keep whatever order `pairs` already carried, via
 * `sortByComputedKey`'s stable sort (`saved-table.ts`). Two names differing
 * only by case (`"Anna"` vs. `"anna"`) are a narrower case handled by
 * `nameCompare` itself (`trade-filters.ts`), which deliberately gives them a
 * *deterministic* order of their own — the same "don't let two case-variants
 * swap on every render" guarantee it makes for
 * {@link ownersInPairs}/{@link basesInPairs} — so a tie on the secondary key
 * is resolved the same way a tie on the primary key would be.
 */
export function sortTradePairsByMember(
  pairs: readonly TradePair[],
  sort: TradeMemberSort,
  labelOf: (tag: string) => string,
  ownerOf: (tag: string) => string | undefined,
  soleOwner: string | null,
): TradePair[] {
  if (sort === 'none') return pairs.slice()

  const ascending = sort === 'firstAsc' || sort === 'secondAsc'
  const side = sort === 'firstAsc' || sort === 'firstDesc' ? 'left' : 'right'
  const otherSide = side === 'left' ? 'right' : 'left'
  const keyOf = (pair: TradePair) => {
    const oriented = orientPairForOwner(pair, ownerOf, soleOwner)
    return { primary: labelOf(oriented[side]), secondary: labelOf(oriented[otherSide]) }
  }

  return sortByComputedKey(pairs, keyOf, (a, b) => {
    const primaryCmp = ascending ? nameCompare(a.primary, b.primary) : nameCompare(b.primary, a.primary)
    return primaryCmp !== 0 ? primaryCmp : nameCompare(a.secondary, b.secondary)
  })
}

/**
 * Reads a stored member-sort choice back. Anything that is not one of the
 * five known states — absent, hand-edited, or a state an older/newer build no
 * longer offers — falls back to `'none'`. See `parseAllowlisted`
 * (`persisted-choice.ts`) for the shared shape this and every other picker's
 * own parse function use.
 */
export function parseTradeMemberSort(stored: string | null): TradeMemberSort {
  return parseAllowlisted(stored, TRADE_MEMBER_SORTS, DEFAULT_MEMBER_SORT)
}
