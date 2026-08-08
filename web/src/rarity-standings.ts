import type { BaseInventory } from '@coc/shared'
import { cardRarity, rarityPoints } from './card-rarity.ts'
import { cardsInGridOrder, cardTotals, type StandingBase } from './card-standings.ts'
import { countMap } from './cards.ts'

/**
 * A second leaderboard axis, sitting beside `baseStandings()` rather than inside it.
 *
 * `baseStandings()` rewards **depth**: `cardPoints()` pays most for a card's first
 * copy but still credits every spare, so a base that has quietly stacked a dozen
 * copies of one common card can out-rank one holding a wide, shallow spread. This
 * board rewards **breadth of scarcity** instead — a base scores once per distinct
 * card it holds at least one copy of, weighted by how scarce that card is *across
 * the whole clan right now* (`cardRarity()`, `card-rarity.ts`), and copy count past
 * the first is invisible to it. The two boards can, and are meant to, disagree.
 *
 * That scarcity is clan-wide and not per-base is why this module cannot just take
 * one base's counts the way `cardPoints()` takes one number: it needs `cardTotals()`
 * over the *entire* `inventory` handed in, the same "every tracked base, including
 * the ones with only a text-label owner" set `cardTotals()` already documents,
 * before it can say anything about any single base's score.
 */

/** One card, and what holding a single copy of it is worth on this board. */
export interface RarityStanding extends StandingBase {
  /**
   * Sum of `rarityPoints()` over every distinct card this base holds at least one
   * copy of. A tenth copy of a card already held adds nothing here — that is what
   * `cardPoints()` / `baseStandings()` already reward, and this board exists to
   * measure the other thing.
   */
  rarityScore: number
  /**
   * Distinct cards held, of *any* rarity — the same field `BaseStanding.distinct`
   * counts, not narrowed to "distinct scarce cards." See the tiebreak comment on
   * {@link rarityStandings} for why the wider count is what breaks a tie here too.
   */
  distinct: number
  /**
   * Standing, sharing a number on a genuine tie — same rule as `BaseStanding.rank`:
   * two bases level on `rarityScore` have not out-scored one another, whatever the
   * rest of the sort key says, so they share a rank and the next rank skips ahead.
   */
  rank: number
}

/**
 * The tracked bases, ranked by rarity score, best first.
 *
 * **The order is: rarity score descending, then distinct cards held overall
 * descending, then member name, then tag.** This deliberately mirrors
 * `baseStandings()`'s own chain (`card-standings.ts`, around line 129) term for
 * term, including *why* each term is there: rarity score is the measure; distinct
 * breaks a tie because reaching the same score across more of the sixty is the
 * better position; name and tag carry no merit at all and exist only to make the
 * order total, so two bases dead level on both scores render in the same sequence
 * every time rather than swapping on each re-render.
 *
 * **The tiebreak counts distinct cards held overall, not distinct *scarce* cards
 * held**, and that is a deliberate choice, not an oversight. On the ten-tier scale
 * `cardRarity()` currently defines, every held card lands in *some* tier and every
 * tier still pays a positive `rarityPoints()` value — the floor is
 * `RARITY_POINT_STEP` itself, per `card-rarity.ts`'s own doc comment — so "distinct
 * held overall" and "distinct held that contributed points" cannot actually diverge
 * today. Overall is still what this reads, for two reasons: it is the exact field
 * `baseStandings()` already uses for the same purpose, so the two boards agree on
 * what "breadth" means when read side by side, and it stays correct even if a
 * future rarity scale ever introduced a zero-point tier, where a narrower count
 * would quietly start meaning something different from what this comment says it
 * means.
 *
 * **Rarity is computed once, from `inventory` alone, and never accepted as a
 * parameter.** This mirrors the split `baseStandings()` already draws between
 * itself and `cardPoints()`: `cardPoints()` is pure over a single number and gets
 * called inline once per base's copy count, because nothing about it depends on
 * any other base. `cardRarity()` cannot be split the same way — a card's scarcity
 * is a fact about the whole clan, not about the base being scored, so it has to be
 * derived from every tracked base's counts before any one base's score means
 * anything. Deriving it here, from the same `inventory` this function already
 * takes, keeps the caller from having to pre-compute `cardTotals()` and
 * `cardRarity()` itself and get the *same* inventory into both calls by hand — the
 * same "the caller does not have to pre-join" reasoning `baseStandings()` gives for
 * taking the whole inventory rather than one base's counts.
 *
 * Takes the whole inventory rather than one base's counts for that reason and also
 * `baseStandings()`'s own: a base with no entry in it is a real base with nothing
 * recorded, and it scores zero rather than being dropped off the board.
 */
export function rarityStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
): RarityStanding[] {
  const rarity = cardRarity(cardTotals(inventory, cardsInGridOrder()))
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows = bases.map((base) => {
    const held = byTag.get(base.tag)
    const counts = countMap(held)
    let rarityScore = 0
    for (const cardId of counts.keys()) {
      rarityScore += rarityPoints(rarity, cardId)
    }
    return {
      ...base,
      rarityScore,
      distinct: counts.size,
      rank: 0,
    }
  })

  rows.sort(
    (a, b) =>
      b.rarityScore - a.rarityScore ||
      b.distinct - a.distinct ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    /* Rarity score alone decides a tie, exactly as points alone decide one on
       `baseStandings()` — see the comment there for why. */
    if (!previous || previous.rarityScore !== row.rarityScore) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}
