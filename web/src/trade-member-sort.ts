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
 * active) exactly as it was, and any other value here is layered on top of it
 * as the new primary key.
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
 * A stable sort over `pairs` as handed in (via `sortByComputedKey`,
 * `saved-table.ts`), so two pairs whose sorted-on name is byte-for-byte
 * identical (two bases sharing a display name exactly) keep whatever order
 * `pairs` already carried — the priority order this is layered over — rather
 * than an arbitrary one. Two names differing only by case (`"Anna"` vs.
 * `"anna"`) are a narrower case: `nameCompare` (`trade-filters.ts`)
 * deliberately gives them a *deterministic* order of their own — the same
 * "don't let two case-variants swap on every render" guarantee it makes for
 * {@link ownersInPairs}/{@link basesInPairs} — rather than falling through to
 * arrival order the way a true tie does.
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
  const nameOf = (pair: TradePair) => labelOf(orientPairForOwner(pair, ownerOf, soleOwner)[side])

  return sortByComputedKey(pairs, nameOf, (a, b) => (ascending ? nameCompare(a, b) : nameCompare(b, a)))
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
