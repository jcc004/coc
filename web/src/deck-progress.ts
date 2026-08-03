import type { CardCategory } from '@coc/shared'
import type { CategoryHolding } from './card-summary.ts'
import { cardCategoriesInOrder, cardsInCategory, deckSlug } from './cards.ts'

/**
 * One deck's collection progress, shaped for the plaques the event itself draws.
 *
 * Two pages show the same four plaques — a player's own page and the card page —
 * so the join between "what this base holds" (`summariseBase`) and "how big the
 * deck is" (`cardsInCategory`) lives here rather than in either component. It was
 * already duplicated as a local `deckSizes()` in the player panel; a second copy
 * on the card page would be the third place a `7/19` could be assembled and the
 * first place it could disagree.
 *
 * Nothing is recounted here. The numerator arrives as `CategoryHolding.distinct`,
 * already computed by `summariseBase` against the same rules the grid draws with,
 * and the denominator arrives through `sizeOf` — injected, like the category
 * resolver `summariseBase` takes, so the tests can use a three-card toy deck
 * instead of the event's sixty.
 */

export interface DeckProgress {
  category: CardCategory
  /** `data-deck` attribute value, so CSS picks the deck's colour off it. */
  slug: string
  /** Distinct cards held — the numerator. */
  held: number
  /** How many cards the deck holds — the denominator. */
  size: number
  /**
   * `7/19`, printed on the bar. **Always** rendered: the bar's length and colour
   * are a second telling of this, never the only one.
   */
  fraction: string
  /**
   * The same value spoken rather than printed, for `aria-valuetext`. `7/19` is read
   * out as "seven slash nineteen"; the bar's value is worth saying properly.
   */
  spoken: string
  /** The bar's width, 0–100, clamped so a bad denominator cannot overflow it. */
  percent: number
  /** Deck, count and total in words — the plaque's accessible name. */
  label: string
}

/** How many cards each deck holds, for the `7/19` denominators. */
export function deckSizes(): Map<CardCategory, number> {
  return new Map(
    cardCategoriesInOrder().map((category) => [category, cardsInCategory(category).length]),
  )
}

/**
 * A deck's holdings as a plaque.
 *
 * A deck the size lookup does not know is treated as size 0 rather than dropped:
 * the four plaques are a fixed set, and one silently missing would read as a deck
 * that does not exist. Its bar is empty and its fraction says `0/0`, which is the
 * honest answer to "how far through a deck with no cards in it".
 */
export function deckProgress(
  holdings: readonly CategoryHolding[],
  /** `undefined` for a deck it does not know — see the note above. */
  sizeOf: (category: CardCategory) => number | undefined,
): DeckProgress[] {
  return holdings.map((holding) => {
    const size = Math.max(0, sizeOf(holding.category) ?? 0)
    const held = Math.max(0, holding.distinct)
    /* Clamped, and rounded to a tenth: the bar is a picture of the fraction beside
       it, and a width of 36.84210526315789% is no truer than 36.8%. */
    const ratio = size > 0 ? Math.min(1, held / size) : 0
    return {
      category: holding.category,
      slug: deckSlug(holding.category),
      held,
      size,
      fraction: `${held}/${size}`,
      spoken: `${held} of ${size}`,
      percent: Math.round(ratio * 1000) / 10,
      label: `${holding.category} cards: ${held} of ${size} collected`,
    }
  })
}
