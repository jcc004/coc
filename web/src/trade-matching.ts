import type { BaseInventory } from '@coc/shared'
import { resourceKey, spareCapacity, type TradeSuggestion } from './card-trades.ts'

/**
 * How many of the candidate trades `suggestTrades` finds could actually all be
 * completed together, and which ones to put in front of a reader first.
 *
 * `suggestTrades` deliberately reports **every** legal swap, including several
 * that reach for the same spare — "one pair can yield several suggestions,
 * and one spare card can appear in suggestions with several partners... these
 * are options to choose between, not a plan" (`card-trades.ts`). That is the
 * right thing for a menu, but it means a raw count of pairs, or of trades,
 * overstates what a clan could actually get done: completing one trade
 * spends a spare, and every other candidate that was counting on giving away
 * that exact spare stops being legal the moment it does.
 *
 * ## The model
 *
 * This is a resource-constrained matching problem. Each base's spare stock of
 * one card is a resource with a fixed capacity — `count - 1`, keeping the
 * last copy, exactly `spareCapacity` in `card-trades.ts` — and each candidate
 * trade is an edge that spends one unit of **two** resources at once, one
 * from each side (`baseA`'s `cardFromA`, `baseB`'s `cardFromB`). The largest
 * set of trades that could all complete together is the maximum set of edges
 * that never overspends a resource: a **b-matching over a general graph**,
 * not a bipartite one. A resource belongs to a base, and a base can appear on
 * either side of any number of trades with different partners, so the
 * conflict graph routinely has odd cycles — A's spare wanted by B, B's spare
 * wanted by C, C's spare wanted by A — which is exactly the structure that
 * rules out reducing this to a flow problem the way *bipartite* matching can
 * be: max-flow is only exact for b-matching when the graph has no odd cycles,
 * and nothing here guarantees that.
 *
 * ## Why this is a greedy approximation, not the exact solver
 *
 * The exact algorithm for general-graph b-matching is a blossom-style
 * augmenting-path search — the same family as Edmonds' matching algorithm,
 * extended for per-vertex capacity. Implementing and proving one correct is a
 * substantial amount of machinery for a hint line on a card-trading page, not
 * a scheduler with real stakes riding on the last percent of optimality.
 *
 * What is here instead is a **dynamic most-constrained-first greedy**:
 * repeatedly complete whichever remaining candidate currently has the
 * tightest bottleneck — the smaller of its two resources' remaining
 * capacity, recomputed after every pick — breaking ties toward the
 * higher-rarity trade by keeping `suggestTrades`'s own order as the
 * fallback rather than recomputing value here. Any *maximal* matching this
 * kind of greedy produces (nothing left that could be added without
 * exceeding a capacity) is known to guarantee at least half of the true
 * maximum in the plain, uncapacitated matching problem, and the same
 * augmenting-path argument carries over to the capacitated version. This
 * module does not lean on that bound alone, though:
 * `trade-matching.test.ts` checks the greedy against a brute-force solver on
 * every small case it can afford to enumerate exhaustively, so the claim is
 * measured rather than assumed — including one deliberately adversarial case
 * kept specifically because the greedy comes up short on it, so the gap is
 * on record rather than papered over.
 *
 * At the scale this page actually runs at — the docs' own worked examples
 * are "32 pairs" and "15 pairs" for a whole clan — the candidate list is
 * small enough that a greedy pass costs nothing worth noticing, and in
 * practice most resources are contended by only one or two candidates at
 * all, which is exactly the regime where a most-constrained-first greedy
 * tends to land on the true optimum rather than merely approximate it.
 *
 * ## What is deliberately *not* modeled as a resource
 *
 * A trade suggestion only exists because the receiver currently holds zero
 * of the card it would get (rule 2, `card-trades.ts`). It is tempting to
 * treat "the receiver still holds zero" as a second capacity — at most one
 * of several candidates that would all hand base A its first copy of card Y
 * could really go first — but `server/src/cards/trades-store.ts` settles
 * that this is not how completion actually works: **"What is deliberately
 * not re-checked \[at completion\] is whether the receiver still lacks the
 * card"**, and later, explicitly, **"The receiver already holding the card
 * is not a refusal... the receiver's count simply goes to two, which makes
 * that card tradeable onward."** So two suggestions that both give base A
 * the same card really can both complete, in either order — the real system
 * only enforces a ceiling there (`MAX_CARD_COUNT`, ten), never a floor. That
 * ceiling is not modeled either: every candidate's receiver starts at zero
 * by construction, so it would take ten distinct suggestions all handing
 * the *same* base the *same* card at once before it could ever bind — not a
 * case worth the extra resource map for a hint line.
 */

/**
 * Identifies one candidate trade by its content rather than object identity,
 * so a caller can test membership in the `Set` {@link maxAchievableTrades}
 * returns without holding onto the exact array it was computed from.
 */
export function tradeKey(trade: Pick<TradeSuggestion, 'baseA' | 'baseB' | 'cardFromA' | 'cardFromB'>): string {
  return `${trade.baseA}|${trade.baseB}|${trade.cardFromA}|${trade.cardFromB}`
}

/**
 * The largest set of `suggestions` a dynamic most-constrained-first greedy
 * can find that could all be completed together, as the `tradeKey` of each
 * one selected. See this module's doc comment for the algorithm and why it
 * is a greedy approximation rather than an exact solver.
 *
 * `bases` supplies the real counts behind the candidates — `suggestions`
 * alone only says *which* cards two bases would swap, not how many spares
 * either one is actually sitting on, and a base holding several spares of one
 * card can genuinely complete several trades that all give it away, to
 * different partners, as long as each one still leaves a copy behind.
 */
export function maxAchievableTrades(
  suggestions: readonly TradeSuggestion[],
  bases: readonly BaseInventory[],
): ReadonlySet<string> {
  const remaining = spareCapacity(bases)
  const pool = suggestions.map((trade, index) => ({ trade, index }))
  const selected = new Set<string>()

  while (pool.length > 0) {
    let bestPos = -1
    let bestScore = Infinity

    // `pool` only ever loses elements (via the `splice` below) and is never
    // reordered, so a left-to-right scan visits candidates in their original
    // `suggestions` order — already sorted by trade value, then alphabetically
    // — which is what makes "keep the first candidate found at the lowest
    // score" the right tiebreak without a second comparison here.
    for (let i = 0; i < pool.length; i += 1) {
      const { trade } = pool[i]!
      const capA = remaining.get(resourceKey(trade.baseA, trade.cardFromA)) ?? 0
      const capB = remaining.get(resourceKey(trade.baseB, trade.cardFromB)) ?? 0
      if (capA <= 0 || capB <= 0) continue // both sides' spares are already spent

      const score = Math.min(capA, capB)
      if (score < bestScore) {
        bestScore = score
        bestPos = i
      }
    }

    if (bestPos === -1) break // nothing left is still feasible

    const { trade } = pool[bestPos]!
    selected.add(tradeKey(trade))
    const keyA = resourceKey(trade.baseA, trade.cardFromA)
    const keyB = resourceKey(trade.baseB, trade.cardFromB)
    remaining.set(keyA, (remaining.get(keyA) ?? 0) - 1)
    remaining.set(keyB, (remaining.get(keyB) ?? 0) - 1)
    pool.splice(bestPos, 1)
  }

  return selected
}

/**
 * `suggestions`, reordered so every trade in `achievable` sorts ahead of
 * every trade that is not, and otherwise unchanged.
 *
 * `Array.prototype.sort` is stable, so within each of those two groups the
 * trades keep whatever order they arrived in — `suggestTrades`'s own
 * value-then-alphabetical order, if that is what was passed in. That is the
 * point: this function adds exactly one comparison on top of an order it
 * does not otherwise touch, the same layering `sortCardTotalsForDisplay`
 * (`card-total-sort.ts`) uses to reorder `cardTotals()`'s output without
 * weakening what that function itself guarantees.
 *
 * Feeding this into `groupTradesByPair` puts a pair ahead of another pair
 * whenever it has an achievable option and the other pair does not, and
 * within one pair's own block of options, puts the ones that do not cost a
 * conflicting trade elsewhere above the ones that do.
 */
export function sortTradesByAchievability(
  suggestions: readonly TradeSuggestion[],
  achievable: ReadonlySet<string>,
): TradeSuggestion[] {
  return [...suggestions].sort((x, y) => {
    const rankOf = (trade: TradeSuggestion): 0 | 1 => (achievable.has(tradeKey(trade)) ? 0 : 1)
    return rankOf(x) - rankOf(y)
  })
}
