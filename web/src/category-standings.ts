import { CARD_CATEGORIES, type BaseInventory, type CardCategory } from '@coc/shared'
import { cardPoints, type StandingBase } from './card-standings.ts'
import { cardsInCategory, countMap } from './cards.ts'

/**
 * A per-deck leaderboard, computed **separately for each of the four decks** rather
 * than once across all sixty cards — so a base's Elixir hoard cannot carry it up the
 * Dark Elixir board.
 *
 * The per-card *measure* is inherited from `card-standings.ts`'s `baseStandings()`
 * rather than reimplemented: the same `cardPoints` curve (`card-standings.ts:55`)
 * scores a card, and the same `countMap` (`cards.ts:89`) turns a base's sparse counts
 * into id → count, dropping an unknown id or a non-positive count on the same terms
 * the grid and the whole-event board already drop them on. Only the *scope* changes:
 * a card counts here only when its id is one `cardsInCategory` puts in the deck being
 * ranked.
 *
 * **The *ranking* is not inherited, and deliberately diverges from `baseStandings`.**
 * `baseStandings` ranks by points first because, across all sixty cards, breadth
 * genuinely should outweigh hoarding — that is what the whole `cardPoints` curve is
 * for. Confined to one nineteen-or-so-card deck, points stop being the more useful
 * question: this board exists to answer "how close is this base to finishing this
 * deck", and points can disagree with that answer outright, not just at the margins —
 * a base sitting on nine copies of one card can out-point a base one card short of a
 * clean deck, while being the base further from finished. So here `distinct` — cards
 * of this deck actually held — is the primary key and `points` only breaks a genuine
 * tie on it. Reported live on prod, 2026-08-11: on the Elixir board, a base with 18
 * of 19 cards (207 points, several stacked copies) ranked above a base with all 19
 * (199 points, one copy each) — completeness lost to a hoard the board was never
 * meant to reward over it.
 */

/** One base's standing within a single deck. */
export interface CategoryStanding extends StandingBase {
  /** Sum of `cardPoints(count)` over this base's cards in this deck only. */
  points: number
  /** Distinct cards of this deck the base holds — the numerator of the `7/19`. */
  distinct: number
  /** This deck's size — the denominator of the `7/19`. Constant across every row of one deck's list, carried per-row so a row is self-contained for a caller that maps over one deck's array without also threading the category through. */
  size: number
  /**
   * Standing **within this deck**, sharing a number on a genuine tie — same
   * shared-and-skipped convention as {@link BaseStanding.rank}. Tied on this deck's
   * `distinct` alone, not on the whole sort key, since `distinct` is this board's
   * primary measure — see {@link categoryStandings} for why.
   */
  rank: number
}

/**
 * All four decks' standings, keyed by category.
 *
 * **Returns all four at once rather than one category per call.** A "by category"
 * view exists to show the four boards together, and computing them one call at a
 * time would either mean the caller re-invokes this once per deck — repeating the
 * `byTag` join and, worse, `countMap`'s per-base scan over `inventory.counts` four
 * times per base instead of once — or the caller does its own caching of a
 * per-category function, which is the same problem `baseStandings` already solved
 * once for the all-decks board. Computing every deck's counts from one pass over
 * each base's holdings, then bucketing by category, does the expensive part once.
 *
 * Each deck's list is independently sorted by **that deck's own distinct count,
 * descending; then that deck's own points, descending; then member name; then
 * tag** — `distinct` leads here, unlike `baseStandings`' points-first order, for the
 * reason given above: completeness within one deck is the question this board
 * answers, and points only decide between two bases that hold the same number of
 * this deck's cards. The name and tag legs exist for the same reason they do in
 * `baseStandings`: to make the order total, so two bases tied within one deck render
 * in the same sequence every time rather than swapping on each re-render.
 *
 * **Each deck carries its own `rank`, shared-and-skipped on a genuine tie within that
 * deck** — the same convention `baseStandings`'s own rank uses (`card-standings.ts:118-127`).
 * This was deliberately *not* reproduced here when the function was first written, on
 * the grounds that array position was enough and a caller could derive numbered rows
 * itself. That reasoning held only as long as nobody actually needed the numbers: the
 * "By category" leaderboard view does, for the same reason every other ranking in this
 * app numbers its rows rather than trusting array position — position alone cannot
 * express a shared rank on a tie, and computing that in the UI layer would be the one
 * ranking on the page whose tie-handling lived outside a tested pure module. So this is
 * no longer a guess at an unstated requirement; it is the same field every sibling
 * standings module already carries, added for the same reason.
 *
 * Takes the same `(bases, inventory)` shape `baseStandings` does, for the same
 * reason: a base with no entry in `inventory` is a real, tracked base with nothing
 * recorded in any deck, and it belongs on all four boards — last on each, scoring
 * zero — rather than being dropped off the ones it has not started.
 */
export function categoryStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
): Record<CardCategory, CategoryStanding[]> {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  /* One `countMap` scan per base, not one per (base, deck) pair. */
  const countsByTag = new Map(bases.map((base) => [base.tag, countMap(byTag.get(base.tag))]))

  const idsByCategory = new Map<CardCategory, ReadonlySet<number>>(
    CARD_CATEGORIES.map((category) => [
      category,
      new Set(cardsInCategory(category).map((card) => card.id)),
    ]),
  )

  const result = {} as Record<CardCategory, CategoryStanding[]>

  for (const category of CARD_CATEGORIES) {
    const ids = idsByCategory.get(category)!

    const rows = bases.map((base) => {
      const counts = countsByTag.get(base.tag)!
      let points = 0
      let distinct = 0
      for (const [cardId, count] of counts) {
        if (!ids.has(cardId)) continue
        points += cardPoints(count)
        distinct += 1
      }
      return { ...base, points, distinct, size: ids.size, rank: 0 }
    })

    rows.sort(
      (a, b) =>
        b.distinct - a.distinct ||
        b.points - a.points ||
        a.label.localeCompare(b.label) ||
        a.tag.localeCompare(b.tag),
    )

    let rank = 0
    rows.forEach((row, index) => {
      const previous = rows[index - 1]
      /* This deck's distinct count alone decides a tie: two bases holding the same
         number of this deck's cards have not out-completed one another here, whatever
         their points or names sort like. */
      if (!previous || previous.distinct !== row.distinct) {
        rank = index + 1
      }
      row.rank = rank
    })

    result[category] = rows
  }

  return result
}
