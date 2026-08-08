import type { CardTotal } from './card-standings.ts'

/**
 * How scarce each card is *in this clan*, right now — not an in-game rarity tier,
 * which the card-collecting event does not have, but a purely relative measure
 * derived from how many total copies the clan holds of each of the sixty.
 *
 * **Ten tiers, evenly sized, recomputed live off current holdings.** Chosen over
 * this app's whole design conversation on 2026-08-08: quartiles were tried first
 * and felt too coarse this early in the season (with room for the distribution to
 * spread out a lot further before it ends), and a raw inverse-of-copies formula
 * was rejected because a single card sitting at 1–2 total copies would swing wildly
 * and dominate the whole ranking. Ten fixed-size tiers, recomputed from whatever
 * the clan holds *today*, is the middle ground: bounded like `cardPoints()`'s own
 * 10-down-to-1 curve for a single base's copies, but tracking the season instead of
 * being pinned to one day's snapshot — the tier boundaries themselves are expected
 * to drift as the season goes on, which is the point, not a bug to guard against.
 *
 * **Tied totals are broken by card id, deterministically — the same reasoning
 * `baseStandings()` already uses to keep two level bases in the same order every
 * render.** Several totals tie exactly (a `total` of 22 is currently shared by
 * seven different cards), so without a tiebreak the boundary between two tiers
 * would depend on `Array.sort`'s stability guarantees rather than being a
 * property of the data. Card id is arbitrary but fixed, which is what a total
 * order needs — it is not a claim that a lower id is "rarer."
 */

/** Rarest first, most common last — index 0 is `RARITY_TIER_COUNT - 1` steps of
 *  `RARITY_POINT_STEP` above the floor. Ten tiers, forty down to four in steps of
 *  four: the ceiling matches the 4-tier design this was refined from (top tier was
 *  40 there too), and the floor is `RARITY_POINT_STEP` itself so no tier is worth 0. */
export const RARITY_TIER_COUNT = 10
const RARITY_POINT_STEP = 4
const RARITY_POINT_CEILING = RARITY_TIER_COUNT * RARITY_POINT_STEP

export interface CardRarity {
  /** 1 (rarest) through {@link RARITY_TIER_COUNT} (most common). */
  tier: number
  /** `RARITY_POINT_CEILING` for tier 1, stepping down by `RARITY_POINT_STEP` per tier. */
  points: number
}

/**
 * Splits `totals` into {@link RARITY_TIER_COUNT} equal-as-possible bands by total
 * copies held, rarest first, and returns each card's tier and point value keyed
 * by card id.
 *
 * Tier size is `Math.ceil(totals.length / RARITY_TIER_COUNT)` rather than the
 * literal `6` this app's card count happens to produce today, so this keeps
 * working (just with a different-sized last tier) if the manifest ever grows
 * past sixty cards — the same reasoning `cardsInGridOrder()` derives its order
 * from the generated list rather than a hardcoded count.
 */
export function cardRarity(totals: readonly CardTotal[]): Map<number, CardRarity> {
  const ordered = [...totals].sort((a, b) => a.total - b.total || a.card.id - b.card.id)
  const tierSize = Math.ceil(ordered.length / RARITY_TIER_COUNT) || 1

  const rarity = new Map<number, CardRarity>()
  ordered.forEach((entry, index) => {
    const tier = Math.min(RARITY_TIER_COUNT, Math.floor(index / tierSize) + 1)
    const points = RARITY_POINT_CEILING - (tier - 1) * RARITY_POINT_STEP
    rarity.set(entry.card.id, { tier, points })
  })

  return rarity
}

/** `0` for a card id `cardRarity()` was never asked about — never a throw, the
 *  same "missing is the safe default" this app already applies to a stored count
 *  that is absent rather than zero. */
export function rarityPoints(rarity: ReadonlyMap<number, CardRarity>, cardId: number): number {
  return rarity.get(cardId)?.points ?? 0
}
