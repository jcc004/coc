import type { CardCategory } from '@coc/shared'
import type { GeneratedCard } from './cards.ts'

/**
 * Narrowing the grid to the cards whose name matches what was typed.
 *
 * A filter, not a highlight: the cards that do not match are removed, which is what
 * was asked for and is also the only version that helps — sixty tiles with three of
 * them outlined is still sixty tiles to scan.
 *
 * **Order is never touched.** Matches come back in grid order, which is deck order,
 * so a filtered view is the same layout with rows missing rather than a new one. No
 * relevance ranking: it would mean a card moves depending on what you typed, and the
 * whole point of the fixed grid is that a card's position is stable. This is the same
 * discipline the clan-wide totals list follows.
 */

/** What a query does to the grid. */
export interface CardSearchResult {
  /** The matching cards, in grid order. */
  cards: GeneratedCard[]
  /** Whether a query is in force at all — `false` means "showing everything". */
  filtering: boolean
  /** How many were searched, for an honest "3 of 60" line. */
  total: number
}

/**
 * Folds a name the way two people spelling the same card would differ: case, and
 * runs of anything that is not a letter or a digit.
 *
 * So `p.e.k.k.a`, `PEKKA` and `P.E.K.K.A.` all fold together, which matters because
 * the real card list contains `P.E.K.K.A` and nobody types the stops. Unicode letters
 * count — a card name is data, not an identifier.
 */
export function foldCardName(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * The cards matching `query`, in the order they were given.
 *
 * Substring rather than prefix: `drag` should find Baby Dragon and Electro Dragon, not
 * only Dragon, because half the reason to search is that you cannot remember which
 * dragon it was.
 *
 * An empty or whitespace-only query is **not** a filter — it returns everything with
 * `filtering: false`, so clearing the box restores the full grid without the caller
 * needing a second code path for it.
 */
export function searchCards(
  cards: readonly GeneratedCard[],
  query: string,
): CardSearchResult {
  const wanted = foldCardName(query)
  if (!wanted) return { cards: [...cards], filtering: false, total: cards.length }

  return {
    cards: cards.filter((card) => foldCardName(card.name).includes(wanted)),
    filtering: true,
    total: cards.length,
  }
}

/**
 * The decks still represented, in the order given.
 *
 * The grid wraps each deck in a named `role="group"`, and a group with nothing in it
 * is noise for anything reading the page aloud — so a filtered grid has to know which
 * wrappers to leave out entirely rather than render empty.
 */
export function decksPresent(
  cards: readonly GeneratedCard[],
  categories: readonly CardCategory[],
): CardCategory[] {
  const present = new Set(cards.map((card) => card.category))
  return categories.filter((category) => present.has(category))
}
