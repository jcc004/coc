import type { BaseInventory } from '@coc/shared'
import { cardDemand } from './card-holders.ts'
import type { CardTotal } from './card-standings.ts'

/**
 * One card, as the "Trade Fodder" view of the totals panel reads it: not "how many
 * does the clan hold" but "is this one safe to give away".
 *
 * A card only earns that answer once **every reporting base already has a copy** —
 * `held` — because a card even one reporting base still needs is not fodder, it is
 * something to keep passing toward that base instead. `extra` is the point past
 * that: the surplus once the one-per-base floor is subtracted back out, which is
 * the count that is actually free to trade away without leaving anyone short.
 *
 * Deliberately reuses `cardDemand()` (`card-holders.ts`) rather than re-deriving
 * "does every base hold it" from `countMap` a third time — that function is already
 * the tested, correct-by-construction answer to "how many reporting bases hold
 * none of this card", and `needing === 0` **is** "held by everyone", not a
 * restatement of it that could quietly drift from `cardDemand`'s own rule for what
 * counts as a reporting base.
 */
export interface TradeFodderEntry {
  card: CardTotal['card']
  /** Copies across every base handed in — carried through from `CardTotal.total`
   *  unchanged, so a caller does not need both arrays to get at it. */
  total: number
  /** Every reporting base holds at least one copy. Drives the tile's grayscale,
   *  the same way `held` on `CardTile` itself does. */
  held: boolean
  /**
   * Surplus copies once every reporting base already has its own one, i.e.
   * `total - reporting`. Only meaningful when `held` is true — `0` when it is not,
   * since a card nobody has finished collecting has no surplus to speak of.
   */
  extra: number
}

/**
 * `totals` (`cardTotals()`'s own output, in whatever order the caller wants drawn)
 * enriched with the Trade Fodder view's `held`/`extra` for each card.
 *
 * One `cardDemand()` call per card — 60 in the worst case — rather than a second
 * pass folded into `cardTotals()`'s own loop. `cardDemand` is already tested and
 * already the rule for "who counts as reporting"; a fold-in would save one pass
 * over `inventory` at the cost of a second implementation of that rule to keep in
 * sync with the first.
 *
 * A reporting base count of zero is **not** "held by everyone" despite `needing`
 * coming back `0` too (vacuously, over no bases) — same trap `CardHolders`' own
 * `bases.length > 0` guard exists to avoid: with nothing reported, there is no
 * data to call a "yes" on, so `held` is `false` and `extra` is `0`.
 */
export function tradeFodder(
  totals: readonly CardTotal[],
  inventory: readonly BaseInventory[],
): TradeFodderEntry[] {
  return totals.map(({ card, total }) => {
    const { reporting, needing } = cardDemand(inventory, card.id)
    const held = reporting > 0 && needing === 0
    return { card, total, held, extra: held ? total - reporting : 0 }
  })
}
