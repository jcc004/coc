import { MIN_TRADEABLE_COUNT, type BaseInventory } from '@coc/shared'
import { countMap } from './cards.ts'

/**
 * One card, and which of the tracked bases are sitting on a copy of it.
 *
 * The clan-totals grid says *how many* copies the clan holds of each card; this is
 * the other half of that sentence — **who**. It is the question the badge on a tile
 * raises and cannot answer: `×4` tells you a trade is theoretically possible and
 * nothing at all about whom to message.
 *
 * Its own module, and not a few lines inside `CardsView`, for the reason the rest of
 * `card-standings.ts` and `card-summary.ts` are: the order has a wrong answer a
 * screenshot would not catch. A comparator that stops at the count leaves bases that
 * hold the same number in whatever order the inventory arrived in, which is a table
 * that reshuffles itself between renders — the same trap `baseStandings` documents.
 *
 * Counting is `countMap`'s, not a second implementation. That is what makes the rows
 * add up to the badge on the tile: a card id the list does not know, or a count that
 * is not positive, is dropped here on exactly the terms the grid and `cardTotals`
 * drop it. It builds a map per base to read one entry out of it, which is more work
 * than a scan of `base.counts` would be — a base holds at most sixty rows, and this
 * runs once per selection rather than once per tile, so agreeing with the grid is
 * worth more than the arithmetic saved.
 */

export interface CardHolder {
  /** Canonical `#TAG` — the identity, as everywhere else. */
  tag: string
  /** What to print for the base, from the caller's labeller. */
  label: string
  /** Copies of this one card. At least 1: a base holding none is not a holder. */
  count: number
  /**
   * Whether this base could give one away — `count >= MIN_TRADEABLE_COUNT`.
   *
   * The distinction the whole table is for. A base never gives away its last copy
   * (the rule is `card-trades.ts`' and the server's, and this is the same constant),
   * so a lone copy is a holding you cannot ask for and two is an offer.
   */
  canSpare: boolean
}

/**
 * The bases holding `cardId`, **most copies first**.
 *
 * Then by label, then by tag, which is not merit: it makes the order *total*, so two
 * bases on the same count render in the same sequence on every re-render instead of
 * swapping places. A base no roster names is labelled with its tag and so sorts under
 * `#`, exactly as the leaderboard's comparator leaves it — the picker's "unnamed
 * last" rule belongs to `baseOptions`, which is choosing what to offer rather than
 * reporting what is held.
 *
 * Sorting by count here does not contradict the totals grid's rule that **nothing
 * sorts by count, in any mode**. That rule is about tile *position*: the grid only
 * earns its place by being scannable card-for-card against the entry grid above it,
 * and there is no such counterpart for a list of holders. What this table is asked is
 * "who could give me one", and the bases with a spare are the answer, so they go at
 * the top.
 *
 * Takes the whole inventory rather than a pre-joined subset, so "nobody holds it"
 * comes back as an empty array from the same call — a card 38 of the sixty are in.
 * `labelOf` is required rather than defaulted to the tag: naming a base is
 * `useBaseLabels`' job on both pages that do it, and a default here would be a
 * second, quieter way to name one.
 */
export function cardHolders(
  inventory: readonly BaseInventory[],
  cardId: number,
  labelOf: (tag: string) => string,
): CardHolder[] {
  const rows: CardHolder[] = []

  for (const base of inventory) {
    const count = countMap(base).get(cardId)
    if (count === undefined) continue
    rows.push({
      tag: base.tag,
      label: labelOf(base.tag),
      count,
      canSpare: count >= MIN_TRADEABLE_COUNT,
    })
  }

  rows.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.tag.localeCompare(b.tag),
  )

  return rows
}
