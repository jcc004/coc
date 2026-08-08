import { CARD_CATEGORIES, type BaseInventory, type CardCategory } from '@coc/shared'
import { cardPoints, type StandingBase } from './card-standings.ts'
import { cardsInCategory, countMap } from './cards.ts'

/**
 * The same points-based leaderboard `card-standings.ts`'s `baseStandings()` builds,
 * computed **separately for each of the four decks** rather than once across all
 * sixty cards — so a base's Elixir hoard cannot carry it up the Dark Elixir board.
 *
 * Everything about the *measure* is inherited rather than reimplemented: the same
 * `cardPoints` curve (`card-standings.ts:55`) scores a card, and the same `countMap`
 * (`cards.ts:89`) turns a base's sparse counts into id → count, dropping an unknown
 * id or a non-positive count on the same terms the grid and the whole-event board
 * already drop them on. Only the *scope* changes: a card counts here only when its
 * id is one `cardsInCategory` puts in the deck being ranked.
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
   * Standing **within this deck**, sharing a number on a genuine tie — same rule as
   * {@link BaseStanding.rank}. Tied on this deck's `points` alone, not on the whole
   * sort key; see {@link categoryStandings} for what a tie means here.
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
 * Each deck's list is independently sorted by **that deck's own points, descending;
 * then that deck's own distinct count, descending; then member name; then tag** —
 * the exact tiebreak chain `baseStandings` documents at `card-standings.ts:129-136`,
 * with "points"/"distinct" reread as "points in this deck"/"distinct in this deck".
 * The name and tag legs exist for the same reason they do there: to make the order
 * total, so two bases tied within one deck render in the same sequence every time
 * rather than swapping on each re-render.
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
        b.points - a.points ||
        b.distinct - a.distinct ||
        a.label.localeCompare(b.label) ||
        a.tag.localeCompare(b.tag),
    )

    let rank = 0
    rows.forEach((row, index) => {
      const previous = rows[index - 1]
      /* This deck's points alone decide a tie, same rule as `baseStandings`: two bases
         level on points in this deck have not out-scored one another here, whatever
         their distinct counts or names sort like. */
      if (!previous || previous.points !== row.points) {
        rank = index + 1
      }
      row.rank = rank
    })

    result[category] = rows
  }

  return result
}
