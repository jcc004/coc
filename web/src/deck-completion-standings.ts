import type { BaseInventory, CardCategory } from '@coc/shared'
import type { StandingBase } from './card-standings.ts'
import type { CategoryHolding } from './card-summary.ts'
import { cardCategoriesInOrder, cardsInCategory, categoryOfCard, countMap } from './cards.ts'
import { deckProgress } from './deck-progress.ts'

/**
 * A "full decks" ranking: how many of the four decks a base holds **outright**,
 * not how far into any one of them it has got.
 *
 * The building block is `deckProgress()` — the same function behind the app's
 * existing `7/19` plaques — because "complete" is not a new rule, it is the
 * existing one at its endpoint: a deck is complete exactly when `held === size`
 * for that deck. Recomputing that boundary here, separately from the plaques,
 * would be the second place it could disagree.
 *
 * This is deliberately *not* a per-category leaderboard (that ranks bases within
 * one deck at a time; a different piece of work owns that). This one collapses
 * the four decks into a single 0–4 count per base, for a ranking that asks "who
 * has finished the most whole decks" rather than "who leads in Elixir."
 *
 * The per-category `distinct`/`total`/`spares` tally below is a small,
 * deliberate duplicate of the loop `summarizeBase` (`card-summary.ts`) already
 * runs — not a reuse of it, because `summarizeBase` also computes trade
 * partners by calling `suggestTrades` against every other base, which is O(n)
 * work per base and therefore O(n²) across a whole board. This ranking has no
 * use for trade partners, so calling `summarizeBase` per base here would pay
 * for a search this feature never asked for.
 *
 * **A deck is `doubled` when every one of its cards is held at least twice** —
 * the same threshold `row-standings.ts` and `category-standings.ts` both score
 * on their own boards, applied here at the whole-deck level. Doubled implies
 * complete, so it is a finer tier within "completed," not an alternative to it,
 * the same relationship `category-standings.ts`'s `doubled` has to its own
 * `distinct === size`.
 */

/** The event's four decks, in the order the grid and the plaques draw them. */
const DECK_CATEGORIES = cardCategoriesInOrder()

/** How many cards each deck holds — the denominator `deckProgress` needs. */
const DECK_SIZES = new Map(DECK_CATEGORIES.map((category) => [category, cardsInCategory(category).length]))

/** Each deck's own card ids, for the `doubled` check below — every one of them
 *  needs its own count looked up, not just the size `DECK_SIZES` carries. */
const DECK_CARD_IDS = new Map(
  DECK_CATEGORIES.map((category) => [category, cardsInCategory(category).map((card) => card.id)]),
)

export interface DeckCompletionStanding extends StandingBase {
  /** How many of the four decks this base holds outright. The measure — 0 through 4. */
  completedCount: number
  /**
   * Which decks are complete, in the event's own deck order. Not just how many:
   * a UI showing this ranking needs to say *which* deck(s) a base finished, and a
   * bare count would throw that away.
   */
  completedDecks: CardCategory[]
  /** How many of the four decks are doubled — see the module doc. Always ≤ `completedCount`. */
  doubledCount: number
  /** Which decks are doubled, in the event's own deck order — a subset of {@link completedDecks}. */
  doubledDecks: CardCategory[]
  /** Distinct cards held across every deck, not just the completed ones — the tiebreak. */
  distinct: number
  /**
   * Standing, sharing a number on a genuine tie — the same rule `baseStandings`
   * uses: ties skip the numbers they consume (1, 2, 2, 4), so a rank still says
   * how many bases are ahead.
   */
  rank: number
}

/**
 * The tracked bases, most whole decks first.
 *
 * **The order is: completed-deck count descending, then doubled-deck count
 * descending, then distinct cards overall descending, then member name, then
 * tag.** Doubled sits between the two: two bases both on the same completed
 * count have not out-finished one another there, but the one that has gone on
 * to double one or more of those decks has gone further, the same way
 * `category-standings.ts` puts a deck's own `doubled` ahead of its `points`.
 *
 * Distinct cards, not points (`cardPoints` in `card-standings.ts`), is the
 * tiebreak below that. Points reward a deep stack of spares in cards a base already holds,
 * which says nothing about how close it is to finishing a *fifth* — sorry,
 * *another* — deck: a base sitting on nine spares of one card it already owns
 * scores heavily on points but has not moved a single deck closer to complete.
 * Distinct cards overall, by contrast, is exactly the quantity that has to grow
 * before any additional deck can complete, so among bases tied on whole decks
 * finished, the one closer to a set across the *rest* of its collection is the
 * one genuinely ahead. Name and then tag are not merit, same as `baseStandings`:
 * they exist only to make the order total, so two bases level on both measures
 * render in the same sequence every time rather than swapping on each re-render.
 */
export function deckCompletionStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
): DeckCompletionStanding[] {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows = bases.map((base) => {
    const held = byTag.get(base.tag)
    const counts = countMap(held)

    const byCategory = new Map<CardCategory, CategoryHolding>(
      DECK_CATEGORIES.map((category) => [category, { category, distinct: 0, total: 0, spares: 0 }]),
    )
    for (const [cardId, count] of counts) {
      const category = categoryOfCard(cardId)
      const entry = category === undefined ? undefined : byCategory.get(category)
      if (!entry) continue
      entry.distinct += 1
      entry.total += count
      entry.spares += count - 1
    }

    const progress = deckProgress(
      DECK_CATEGORIES.map((category) => byCategory.get(category)!),
      (category) => DECK_SIZES.get(category),
    )
    const completedDecks = progress.filter((deck) => deck.complete).map((deck) => deck.category)
    const doubledDecks = completedDecks.filter((category) =>
      DECK_CARD_IDS.get(category)!.every((cardId) => (counts.get(cardId) ?? 0) >= 2),
    )

    return {
      ...base,
      completedCount: completedDecks.length,
      completedDecks,
      doubledCount: doubledDecks.length,
      doubledDecks,
      distinct: [...byCategory.values()].reduce((sum, entry) => sum + entry.distinct, 0),
      rank: 0,
    }
  })

  rows.sort(
    (a, b) =>
      b.completedCount - a.completedCount ||
      b.doubledCount - a.doubledCount ||
      b.distinct - a.distinct ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    // Completed-deck count and doubled-deck count together decide a tie, same
    // rule as `baseStandings`'s points: two bases level on both have not
    // out-finished one another, whatever their names or their broader
    // collections sort like — but one ahead on doubled decks has, even at the
    // same completed count.
    if (
      !previous ||
      previous.completedCount !== row.completedCount ||
      previous.doubledCount !== row.doubledCount
    ) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}
