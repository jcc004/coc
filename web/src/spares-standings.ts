import type { BaseInventory } from '@coc/shared'
import { countMap } from './cards.ts'
import type { StandingBase } from './card-standings.ts'

/**
 * "Spares on hand": a ranking by tradeable depth rather than by progress.
 *
 * `baseStandings` (`card-standings.ts`) answers "who is furthest along" — points
 * reward the first copy of a card ten times over the eleventh, so breadth beats
 * hoarding. This answers a different question: "who's actually worth asking for a
 * trade right now" — a base that has hoovered up nine copies of one card and traded
 * none of them away scores well on points and is exactly who you want to message,
 * while a base that has already traded down to singles of everything might lead the
 * points board and have nothing spare to give.
 *
 * The per-card rule is not reinvented here. `card-holders.ts`'s `cardHolders()`
 * already labels one base's own holding of one card `Can spare one` against
 * `Its only copy`, on the same `count - 1 > 0` reasoning `MIN_TRADEABLE_COUNT`
 * (`@coc/shared`) encodes: a base never gives away its last copy, so a card held
 * once has zero tradeable spares and a card held `n` times has `n - 1`. This module
 * is that same rule, summed across all sixty cards instead of read off one.
 */

/** One card's contribution to a base's spare total. */
export interface CardSpare {
  cardId: number
  /** Copies beyond the one kept — `count - 1`. Always at least 1; a card held once
   *  or not at all contributes nothing and has no entry. */
  spares: number
}

export interface SpareStanding extends StandingBase {
  /** Total tradeable spares across all sixty cards — the measure this ranking is on. */
  spares: number
  /**
   * How many *distinct* cards contribute a spare, i.e. how many the base holds at
   * least two of. The tiebreak — see {@link spareStandings}'s doc for why this and
   * not `card-standings.ts`'s `distinct` (every card held, singles included).
   */
  spareVariety: number
  /**
   * Which cards contribute a spare, and how much each does, ascending by card id.
   * Falls out of the same pass that sums `spares`, so it costs nothing extra to
   * keep — a caller building a "browse this base's spares" view does not have to
   * re-derive it from the raw inventory. Empty for a base with no spares at all.
   */
  cards: CardSpare[]
  /** Standing, sharing a number on a genuine tie — see {@link spareStandings}. */
  rank: number
}

/**
 * The tracked bases, ranked by tradeable spares rather than by progress.
 *
 * **The order is: spares descending, then spare-variety descending, then member
 * name, then tag.**
 *
 * Spares is the measure. Spare-variety — the count of distinct cards a base holds
 * at least two of — is the tiebreak, and it is a deliberate choice among three
 * candidates:
 *
 * - **Spare-variety** (chosen): two bases tied on total spares are not equally
 *   useful to trade with. A base sitting on nine copies of one card can only ever
 *   answer a request for that one card; a base with three spares each on three
 *   different cards can answer three different requests. Breadth of what is
 *   *offerable* is what this ranking exists to surface, so it is what breaks the
 *   tie.
 * - **Total copies held** (rejected): for any base, `total = distinctHeld +
 *   spares` — every held card contributes its one kept copy to `distinctHeld` and
 *   the rest to `spares`. So among bases already tied on `spares`, ordering by
 *   `total` is *exactly* ordering by `distinctHeld`, just computed the long way
 *   round.
 * - **Distinct cards held** (`card-standings.ts`'s `distinct`, rejected for the
 *   same reason as `total` above, once the identity is seen): it credits a card
 *   held exactly once, which is precisely the holding this ranking's whole point
 *   is to look past — a single copy is not offerable to anyone.
 *
 * Name then tag follow, exactly as `baseStandings` — not merit, just what makes
 * the order total so two level bases render in the same sequence every time.
 *
 * Takes the whole inventory rather than a pre-joined subset, matching
 * `baseStandings`: a base with no entry is a real, tracked base with nothing
 * recorded, and it ranks last (zero spares) rather than being dropped.
 *
 * No `size`/fraction field, unlike `BaseStanding`: `points`/`distinct` are read as
 * "N out of the 60 the event ships", which is a meaningful fraction. Total spares
 * has no such ceiling to be read against — a base could in principle hold up to 9
 * spares per card across 60 cards, but that number is not a target the way "all 60
 * collected" is, so printing it as a fraction would imply a finish line that is not
 * there.
 */
export function spareStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
): SpareStanding[] {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows = bases.map((base) => {
    const held = byTag.get(base.tag)
    const counts = countMap(held)

    let spares = 0
    let spareVariety = 0
    const cards: CardSpare[] = []
    for (const [cardId, count] of counts) {
      const spare = Math.max(count - 1, 0)
      if (spare <= 0) continue
      spares += spare
      spareVariety += 1
      cards.push({ cardId, spares: spare })
    }
    cards.sort((a, b) => a.cardId - b.cardId)

    return { ...base, spares, spareVariety, cards, rank: 0 }
  })

  rows.sort(
    (a, b) =>
      b.spares - a.spares ||
      b.spareVariety - a.spareVariety ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    /* Spares alone decide a tie. Two bases with the same total have not out-traded
       one another, whatever their names or variety sort like. */
    if (!previous || previous.spares !== row.spares) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}
