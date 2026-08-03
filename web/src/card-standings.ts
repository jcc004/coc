import type { BaseInventory } from '@coc/shared'
import { ALL_CARDS, cardCategoriesInOrder, cardsInCategory, countMap } from './cards.ts'
import type { GeneratedCard } from './cards.ts'

/**
 * The two group-wide readings of the card event: how far each base has got, and
 * how many copies of each card the whole group is sitting on.
 *
 * Both are here rather than in `CardsView` because both have a rule with a wrong
 * answer that a screenshot would not catch:
 *
 * - a leaderboard needs a **total** order. Early in an event almost everybody
 *   holds a handful, so ties on "distinct cards" are the common case, not the
 *   edge one — and a comparator that stops at the first key leaves the tied rows
 *   in whatever order the array happened to arrive in, which is a list that
 *   reshuffles itself between renders;
 * - the totals list must stay in the **grid's** order whatever the counts are. It
 *   only earns its place by scanning card-for-card against the sixty tiles above
 *   it, and a list that sorted itself by count would be a different list that
 *   happened to hold the same numbers.
 *
 * Counting is not re-implemented: `countMap` from `cards.ts` is what the grid
 * itself expands a base's sparse counts with, so a card id the list does not know,
 * or a count that is not a positive number, is dropped here on exactly the terms
 * it is dropped there.
 */

/* ---------- the leaderboard ---------- */

/** A tracked base, named, as the page already knows how to name one. */
export interface StandingBase {
  /** Canonical `#TAG` — still the identity, as everywhere else. */
  tag: string
  /** The member name, or the tag when no roster we can see names it. */
  label: string
  /** Who would do the trading, or `null` when nobody is assigned. */
  owner: string | null
}

export interface BaseStanding extends StandingBase {
  /** Distinct cards held — the measure the ranking is on. */
  distinct: number
  /** Copies, spares included. The first tiebreak. */
  total: number
  /** The deck size the fraction is out of, so the row prints `17/60`. */
  size: number
  /**
   * Whether anybody has ever saved this base — the same distinction the grid's
   * attribution line draws. A base with no record is "nothing recorded yet", not a
   * base that has been checked and holds nothing.
   */
  recorded: boolean
  /**
   * Standing, sharing a number on a genuine tie.
   *
   * Tied on **distinct and total**, not on the whole sort key: the member name is
   * only in the comparator to stop the list flickering, so two bases separated by
   * nothing but their names have not out-collected one another and must not be
   * printed as 4th and 5th. Ties skip the numbers they consume (1, 2, 2, 4), so a
   * rank still says how many bases are ahead.
   */
  rank: number
}

/**
 * The tracked bases, best first.
 *
 * **The order is: distinct descending, then total copies descending, then member
 * name, then tag.** Distinct is the measure — the event rewards collecting the
 * sixty, not hoarding — and copies break the tie because a base with more spares
 * is further along the same road. The name and then the tag are not merit at all;
 * they are there to make the order *total*, so two bases that are level render in
 * the same sequence every time rather than swapping places on each re-render.
 *
 * Takes the whole inventory rather than one base's counts, so the caller does not
 * have to pre-join: a base with no entry in it is a real base with nothing
 * recorded, and it ranks last rather than being dropped off the board.
 */
export function baseStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
  size: number = ALL_CARDS.length,
): BaseStanding[] {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows = bases.map((base) => {
    const held = byTag.get(base.tag)
    const counts = countMap(held)
    let total = 0
    for (const count of counts.values()) total += count
    return {
      ...base,
      distinct: counts.size,
      total,
      size,
      /* A base saved and then cleared back to zero keeps its stamp, so it reads as
         checked-and-empty rather than as never entered. */
      recorded: held !== undefined && (counts.size > 0 || held.updatedAt !== undefined),
      rank: 0,
    }
  })

  rows.sort(
    (a, b) =>
      b.distinct - a.distinct ||
      b.total - a.total ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    if (!previous || previous.distinct !== row.distinct || previous.total !== row.total) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}

/* ---------- what the whole group holds, card by card ---------- */

export interface CardTotal {
  card: GeneratedCard
  /** Copies across every base handed in. */
  total: number
  /**
   * Nobody in the group holds one. The fact worth spotting: a card no base has a
   * copy of cannot be got by trading, however the counts move around.
   */
  absent: boolean
}

/**
 * The sixty cards in the order the grid draws them.
 *
 * Deliberately the *same two calls* the grid makes — `cardCategoriesInOrder()`
 * then `cardsInCategory()` — rather than a second ordering that agrees with it
 * today. The totals list is only worth having because it lines up card-for-card
 * with the tiles above it, and a parallel order is exactly the kind of thing that
 * drifts silently when the manifest is regenerated.
 */
export function cardsInGridOrder(): readonly GeneratedCard[] {
  return cardCategoriesInOrder().flatMap((category) => cardsInCategory(category))
}

/**
 * Every card, in `cards` order, with the copies the group holds between them.
 *
 * **Nothing is sorted here, in any mode.** The output is one entry per input card,
 * in the input's order, which is the property the tests pin down — the counts
 * decide what each row *says* and never where it sits.
 *
 * `inventory` should be every tracked base, including the ones whose owner is
 * still only a text label: they are bases somebody is collecting on, their cards
 * are as tradeable as anyone's, and leaving them out would undercount the group
 * rather than describe a smaller one.
 */
export function cardTotals(
  inventory: readonly BaseInventory[],
  cards: readonly GeneratedCard[] = cardsInGridOrder(),
): CardTotal[] {
  const totals = new Map<number, number>()
  for (const base of inventory) {
    for (const [cardId, count] of countMap(base)) {
      totals.set(cardId, (totals.get(cardId) ?? 0) + count)
    }
  }

  return cards.map((card) => {
    const total = totals.get(card.id) ?? 0
    return { card, total, absent: total === 0 }
  })
}
