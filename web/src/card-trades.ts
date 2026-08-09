import { MIN_TRADEABLE_COUNT, type BaseInventory, type CardCategory } from '@coc/shared'
import { cardRarity, rarityPoints } from './card-rarity.ts'
import { cardTotals } from './card-standings.ts'

/**
 * Which two bases should swap which two cards.
 *
 * This is the only part of the card feature with real rules in it, so it is a
 * pure module with its own tests and no knowledge of React, the server, or the
 * generated card list. Categories arrive through a resolver rather than an
 * import, which is what lets the *matching* rules below be tested against
 * three made-up cards instead of sixty real ones. Ordering is a separate
 * concern from matching, though: `suggestTrades` ranks its output by rarity,
 * and rarity is scarcity *within the real 60-card manifest* — `cardTotals`'s
 * default card list — so a test asserting anything about order needs holdings
 * built from real card ids, even though the four matching rules above never
 * do.
 *
 * A trade is a **swap**, not a gift: both sides give one card and receive one.
 * The four rules, and why each is there:
 *
 * 1. **The giver must hold 2 or more.** A base never trades away its last copy —
 *    that would be losing a card, not swapping one. A count of exactly 1 is
 *    therefore not tradeable, which is the rule people get wrong by hand.
 * 2. **The receiver must hold zero.** There is no point receiving a card you
 *    already have; the event rewards distinct cards, so a second copy of
 *    something you hold once is worth nothing to you.
 * 3. **Same category.** The game only swaps within a deck, so an Elixir card
 *    cannot be traded for a Dark Elixir one however well the counts line up.
 * 4. **Different bases.** A base cannot trade with itself, including when the
 *    same tag appears twice in the input.
 *
 * Rule 1 and rule 2 together make `X === Y` impossible without a special case:
 * A would need 2 or more of X while B has none of it, *and* B would need 2 or
 * more of the same X. There is a test for that rather than a comment alone.
 */

/** One swap: A gives `cardFromA`, B gives `cardFromB`, both in `category`. */
export interface TradeSuggestion {
  /** The lexicographically smaller of the two tags. See `suggestTrades`. */
  baseA: string
  baseB: string
  /** A holds 2+ of this and B holds none. Travels A → B. */
  cardFromA: number
  /** B holds 2+ of this and A holds none. Travels B → A. */
  cardFromB: number
  category: CardCategory
}

/** Resolves a card id to its deck. `undefined` for an id the caller does not know. */
export type CategoryResolver = (cardId: number) => CardCategory | undefined

interface Holdings {
  tag: string
  /** Only positive counts; an absent id means the base holds none. */
  counts: Map<number, number>
}

/**
 * Sparse wire counts → a lookup, dropping anything that cannot mean a holding.
 *
 * A non-positive count is treated as absent so that a 0 which somehow survived
 * the route reads as "does not own", not as a distinct third state. A repeated
 * id keeps the **largest** value rather than the last: with no way to tell which
 * the user meant, the reading that risks suggesting a trade the base cannot
 * honor is the wrong one — but the larger count is also the one that matches
 * "how many are actually on the screen they copied", and a suggestion is only a
 * suggestion.
 */
function toHoldings(base: BaseInventory): Holdings {
  const counts = new Map<number, number>()
  for (const entry of base.counts) {
    if (!Number.isInteger(entry.cardId)) continue
    if (!Number.isFinite(entry.count) || entry.count <= 0) continue
    counts.set(entry.cardId, Math.max(counts.get(entry.cardId) ?? 0, entry.count))
  }
  return { tag: base.tag, counts }
}

/** The cards a base can give away: everything it holds two or more of. */
function spares(holdings: Holdings): number[] {
  return [...holdings.counts.entries()]
    .filter(([, count]) => count >= MIN_TRADEABLE_COUNT)
    .map(([cardId]) => cardId)
    .sort((a, b) => a - b)
}

/**
 * Identifies one base's stock of one card, as the unit `trade-matching.ts`
 * spends capacity against — `${tag}:${cardId}`, colon rather than the space
 * `groupTradesByPair`'s pair key uses, since a tag can itself contain neither.
 */
export function resourceKey(tag: string, cardId: number): string {
  return `${tag}:${cardId}`
}

/**
 * How many **more** times each base could give away each card it holds spare
 * of, right now — `count - 1`, keeping the last copy exactly as rule 1 above
 * requires. Exported for `trade-matching.ts`, which needs the real spare
 * counts behind a suggestion (a base holding five of a card can give it away
 * up to four times, to four different partners, not just once) rather than
 * only *whether* one exists, which is all `spares()` above answers.
 *
 * Reuses `toHoldings` so a malformed row (non-integer id, non-positive or
 * duplicated count) is read exactly the same way `suggestTrades` already
 * reads it — two readings of the same wire data must never disagree about
 * what a base holds.
 */
export function spareCapacity(bases: readonly BaseInventory[]): Map<string, number> {
  const capacity = new Map<string, number>()
  for (const base of bases) {
    const holdings = toHoldings(base)
    for (const cardId of spares(holdings)) {
      capacity.set(resourceKey(base.tag, cardId), (holdings.counts.get(cardId) ?? 0) - 1)
    }
  }
  return capacity
}

/**
 * Every swap available across `bases`, deduplicated and in a stable order.
 *
 * **Mirrors are reported once.** A↔B and B↔A are the same trade seen from two
 * sides, so each unordered pair of bases is considered exactly once and the
 * result is always oriented with the lexicographically smaller tag as `baseA`.
 * That makes the output independent of the order the bases were passed in,
 * which is the property the tests pin down.
 *
 * One pair can yield several suggestions, and one spare card can appear in
 * suggestions with several partners. That is intended: these are options to
 * choose between, not a plan. Committing to one does not invalidate the others
 * until the counts are re-entered, at which point the list is recomputed.
 *
 * **Ordered by trade value first, alphabetically second.** The single rarest
 * card either side would give away is what makes a trade worth doing, so that
 * — `max(rarityPoints(cardFromA), rarityPoints(cardFromB))`, descending — is
 * the primary sort key. The previous alphabetical-by-tag ordering is kept as
 * the tiebreak, both because two trades can genuinely tie on value and because
 * a comparator that only sometimes orders its inputs is not a total order —
 * `Array.sort` would then be free to leave equal-value trades in whatever
 * order it likes, which is exactly the flakiness the old tiebreak already
 * existed to avoid.
 */
export function suggestTrades(
  bases: BaseInventory[],
  categoryOf: CategoryResolver,
): TradeSuggestion[] {
  const all = bases.map(toHoldings)
  const suggestions: TradeSuggestion[] = []

  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const left = all[i]
      const right = all[j]
      if (!left || !right) continue
      // Rule 4. Two entries for one tag are one base, however they got here.
      if (left.tag === right.tag) continue

      // Orientation by tag, not by position, so the output does not depend on
      // the order the caller happened to hand the bases over in.
      const [a, b] = left.tag < right.tag ? [left, right] : [right, left]

      for (const cardFromA of spares(a)) {
        // Rule 2, for the card A is giving.
        if ((b.counts.get(cardFromA) ?? 0) > 0) continue
        const category = categoryOf(cardFromA)
        if (category === undefined) continue

        for (const cardFromB of spares(b)) {
          // Rule 2 again, mirrored.
          if ((a.counts.get(cardFromB) ?? 0) > 0) continue
          // Rule 3.
          if (categoryOf(cardFromB) !== category) continue

          suggestions.push({ baseA: a.tag, baseB: b.tag, cardFromA, cardFromB, category })
        }
      }
    }
  }

  // Computed once per call rather than inside the comparator below: `cardTotals`
  // walks every base and `cardRarity` sorts all 60 cards into tiers, and
  // `Array.sort`'s comparator runs O(n log n) times for n suggestions — redoing
  // either from inside it would repeat that work on every comparison instead of
  // once.
  const rarity = cardRarity(cardTotals(bases))
  const value = (s: TradeSuggestion): number =>
    Math.max(rarityPoints(rarity, s.cardFromA), rarityPoints(rarity, s.cardFromB))

  return suggestions.sort(
    (x, y) =>
      value(y) - value(x) ||
      x.baseA.localeCompare(y.baseA) ||
      x.baseB.localeCompare(y.baseB) ||
      x.cardFromA - y.cardFromA ||
      x.cardFromB - y.cardFromB,
  )
}

/**
 * The same suggestions, collected under the pair of bases they involve.
 *
 * The flat list is the tested thing; this is presentation, because "these two
 * should talk, and here are the four ways" is what someone actually acts on,
 * rather than four rows repeating the same two tags.
 *
 * **This function has no sort of its own — pairs and each pair's own trades
 * come out in first-occurrence order of whatever list they were handed.** A
 * `Map`'s insertion order is first-occurrence order, so grouping never
 * reorders anything; it only decides how to bucket what is already ordered.
 *
 * Fed `suggestTrades`'s own output directly, that makes pairs come out
 * ordered by their best trade's *value*: in a list already sorted descending
 * by value, the first entry seen for any given pair can only be that pair's
 * highest-value entry, so first-occurrence order and best-value order agree.
 * `TradeSuggestions.tsx` instead feeds this a list `sortTradesByAchievability`
 * (`trade-matching.ts`) has already re-ordered — achievable trades first,
 * value second — so there a pair's position instead reflects whether *any* of
 * its options survived the matching, not the raw rarity of its best card. Both
 * callers get a real, total order out of this function; which one they get
 * depends entirely on what they pass in, which is deliberate: this function
 * stays a plain grouping, not a second place a sort could drift from the
 * first.
 */
export interface TradePair {
  baseA: string
  baseB: string
  trades: TradeSuggestion[]
}

export function groupTradesByPair(suggestions: TradeSuggestion[]): TradePair[] {
  const pairs = new Map<string, TradePair>()

  for (const suggestion of suggestions) {
    const key = `${suggestion.baseA} ${suggestion.baseB}`
    let pair = pairs.get(key)
    if (!pair) {
      pair = { baseA: suggestion.baseA, baseB: suggestion.baseB, trades: [] }
      pairs.set(key, pair)
    }
    pair.trades.push(suggestion)
  }

  return [...pairs.values()]
}
