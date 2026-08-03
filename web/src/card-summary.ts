import { CARD_CATEGORIES, normalizeTag, type BaseInventory, type CardCategory } from '@coc/shared'
import { suggestTrades, type CategoryResolver } from './card-trades.ts'

/**
 * One base's card holdings, reduced to what a collapsed panel can say in a line.
 *
 * The player page shows this above its stat tiles, so the two questions it has to
 * answer without being opened are "how much of each deck does this base hold" and
 * "is there a swap waiting". Both have rules, so both live here rather than in the
 * component: the per-deck totals have to agree with what the grid draws, and the
 * trade predicate has to agree with the suggestion list on the card page — which
 * it does by *being* it. `suggestTrades` is called rather than re-implemented, so
 * a change to the four trade rules cannot leave this hint saying something else.
 *
 * Pure, and categories arrive through the same resolver `suggestTrades` takes, so
 * the tests exercise it against a handful of made-up cards instead of sixty real
 * ones.
 */

/** What one deck contributes. `distinct` is cards held, `total` counts copies. */
export interface CategoryHolding {
  category: CardCategory
  distinct: number
  total: number
  /** Copies past the first — the ones this base could give away. */
  spares: number
}

export interface BaseCardSummary {
  /**
   * Whether anybody has ever entered this base.
   *
   * The distinction the card page already draws (see `Attribution`): a base with
   * no record is "nothing recorded yet", not a base holding zero of everything.
   * Sixty zeroes presented as data would be a claim nobody made.
   */
  recorded: boolean
  /** Every deck asked for, in the order asked for, including the empty ones. */
  byCategory: CategoryHolding[]
  distinct: number
  total: number
  spares: number
  /** The other bases this one could swap with right now, ascending by tag. */
  tradePartners: string[]
  hasTrades: boolean
}

/** `null` for input that cannot be a tag, and so can never name a stored base. */
function canonicalOrNull(tag: string): string | null {
  try {
    return normalizeTag(tag)
  } catch {
    return null
  }
}

/**
 * Sparse wire counts → id-keyed holdings, on the same terms as `card-trades.ts`:
 * a non-positive or fractional count is an absence, and a repeated id keeps the
 * larger value. Cards the resolver does not recognise are dropped, since they
 * belong to no deck and could not be shown in one.
 */
function holdings(base: BaseInventory, categoryOf: CategoryResolver): Map<number, number> {
  const counts = new Map<number, number>()
  for (const entry of base.counts) {
    if (categoryOf(entry.cardId) === undefined) continue
    if (!Number.isInteger(entry.count) || entry.count <= 0) continue
    counts.set(entry.cardId, Math.max(counts.get(entry.cardId) ?? 0, entry.count))
  }
  return counts
}

/**
 * `tag`'s holdings per deck, and whether any other base in `bases` could trade
 * with it.
 *
 * The partner search asks `suggestTrades` about **one pair at a time** rather
 * than handing it the whole list and filtering: the whole-list call is quadratic
 * in the number of bases and computes every pair the page will never mention.
 * The rules are identical either way — a pair's suggestions do not depend on who
 * else is in the list.
 */
export function summariseBase(
  tag: string,
  bases: BaseInventory[],
  categoryOf: CategoryResolver,
  categories: readonly CardCategory[] = CARD_CATEGORIES,
): BaseCardSummary {
  const canonical = canonicalOrNull(tag)
  const self = canonical === null ? undefined : bases.find((base) => base.tag === canonical)

  const counts = self ? holdings(self, categoryOf) : new Map<number, number>()

  const byCategory = categories.map((category) => ({
    category,
    distinct: 0,
    total: 0,
    spares: 0,
  }))
  const bucket = new Map(byCategory.map((entry) => [entry.category, entry]))

  for (const [cardId, count] of counts) {
    const category = categoryOf(cardId)
    // Only the decks the caller asked about; a card in any other is genuinely
    // held but has nowhere on screen to be counted.
    const entry = category === undefined ? undefined : bucket.get(category)
    if (!entry) continue
    entry.distinct += 1
    entry.total += count
    entry.spares += count - 1
  }

  const tradePartners: string[] = []
  if (self) {
    for (const other of bases) {
      if (other.tag === self.tag) continue
      if (suggestTrades([self, other], categoryOf).length > 0) tradePartners.push(other.tag)
    }
    tradePartners.sort((a, b) => a.localeCompare(b))
  }

  return {
    /* A base cleared back to zero keeps its stamp, and is a base somebody has
       checked — so it reads as recorded-and-empty, not as never entered. */
    recorded: self !== undefined && (counts.size > 0 || self.updatedAt !== undefined),
    byCategory,
    distinct: byCategory.reduce((sum, entry) => sum + entry.distinct, 0),
    total: byCategory.reduce((sum, entry) => sum + entry.total, 0),
    spares: byCategory.reduce((sum, entry) => sum + entry.spares, 0),
    tradePartners,
    hasTrades: tradePartners.length > 0,
  }
}
