import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory, CardCategory } from '@coc/shared'
import { resourceKey, spareCapacity, suggestTrades, type TradeSuggestion } from './card-trades.ts'
import { maxAchievableTrades, sortTradesByAchievability, tradeKey } from './trade-matching.ts'

/* Same toy deck shape as card-trades.test.ts — enough categories to keep rule 3
   out of the way without needing the real 60-card manifest. */
const CATEGORY: Record<number, CardCategory> = { 1: 'Elixir', 2: 'Elixir', 3: 'Elixir', 4: 'Elixir' }
const categoryOf = (id: number): CardCategory | undefined => CATEGORY[id]

function base(tag: string, counts: Record<number, number>): BaseInventory {
  return {
    tag,
    counts: Object.entries(counts).map(([cardId, count]) => ({ cardId: Number(cardId), count })),
  }
}

/** A `TradeSuggestion` literal, for tests that need to control candidate order
    directly rather than derive it from `suggestTrades`'s own rarity sort. */
function suggestion(
  baseA: string,
  baseB: string,
  cardFromA: number,
  cardFromB: number,
): TradeSuggestion {
  return { baseA, baseB, cardFromA, cardFromB, category: 'Elixir' }
}

/**
 * Exhaustively checks every subset of `suggestions` and returns the size of the
 * largest one that never asks a resource for more than `spareCapacity` says it
 * has. Independent of `maxAchievableTrades`'s own implementation on purpose — a
 * test that reused the code under test to check itself would only ever confirm
 * the code agrees with itself.
 *
 * Only affordable at the small candidate counts these tests use (`2 ** n`
 * subsets), which is the whole reason `maxAchievableTrades` does not do this
 * itself — see its doc comment.
 */
function bruteForceMax(suggestions: readonly TradeSuggestion[], bases: readonly BaseInventory[]): number {
  const capacity = spareCapacity(bases)
  let best = 0

  for (let mask = 0; mask < 2 ** suggestions.length; mask += 1) {
    const used = new Map<string, number>()
    let count = 0
    let feasible = true

    for (let i = 0; i < suggestions.length; i += 1) {
      if ((mask & (1 << i)) === 0) continue
      const trade = suggestions[i]!
      const keys = [resourceKey(trade.baseA, trade.cardFromA), resourceKey(trade.baseB, trade.cardFromB)]
      for (const key of keys) {
        const next = (used.get(key) ?? 0) + 1
        if (next > (capacity.get(key) ?? 0)) feasible = false
        used.set(key, next)
      }
      if (!feasible) break
      count += 1
    }

    if (feasible) best = Math.max(best, count)
  }

  return best
}

/** Confirms a greedy result never spends more of a resource than it has —
    the one property that must hold regardless of how good the answer is. */
function assertFeasible(
  selected: ReadonlySet<string>,
  suggestions: readonly TradeSuggestion[],
  bases: readonly BaseInventory[],
): void {
  const capacity = spareCapacity(bases)
  const used = new Map<string, number>()

  for (const trade of suggestions) {
    if (!selected.has(tradeKey(trade))) continue
    for (const key of [resourceKey(trade.baseA, trade.cardFromA), resourceKey(trade.baseB, trade.cardFromB)]) {
      used.set(key, (used.get(key) ?? 0) + 1)
    }
  }

  for (const [key, count] of used) {
    assert.ok(
      count <= (capacity.get(key) ?? 0),
      `resource ${key} oversubscribed: used ${count}, capacity ${capacity.get(key) ?? 0}`,
    )
  }
}

describe('maxAchievableTrades — no conflict', () => {
  it('takes every candidate when nothing shares a resource', () => {
    // Two categories, not one — with all four cards in the same deck, every
    // base would also be a legal partner for the *other* pair (holding zero of
    // a stranger's card is automatic when nobody has poisoned it), which would
    // make this fixture accidentally test a four-way conflict instead of "no
    // conflict at all". Splitting the decks is what actually isolates the two
    // pairs from each other, the same way rule 3 isolates them in the app.
    const twoDecks: Record<number, CardCategory> = { 1: 'Elixir', 2: 'Elixir', 3: 'Dark Elixir', 4: 'Dark Elixir' }
    const bases = [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 3: 2 }), base('#DDD', { 4: 2 })]
    const trades = suggestTrades(bases, (id) => twoDecks[id])
    assert.equal(trades.length, 2, 'the two pairs, and nothing crossing between them')

    const achievable = maxAchievableTrades(trades, bases)
    assert.equal(achievable.size, trades.length)
    assertFeasible(achievable, trades, bases)
  })

  it('is empty for no candidates', () => {
    assert.equal(maxAchievableTrades([], []).size, 0)
  })
})

describe('maxAchievableTrades — one spare, several partners', () => {
  it('can only honor one of them at once', () => {
    // The exact fixture from card-trades.test.ts's "offers one spare to more than
    // one partner" case: #AAA's single spare of card 1 is a candidate with both
    // #BBB and #CCC, but #AAA only has one copy to actually give away.
    const bases = [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 2: 2 })]
    const trades = suggestTrades(bases, categoryOf)
    assert.equal(trades.length, 2, 'two candidate options, sharing #AAA:1')

    const achievable = maxAchievableTrades(trades, bases)
    assert.equal(achievable.size, 1)
    assert.equal(achievable.size, bruteForceMax(trades, bases))
    assertFeasible(achievable, trades, bases)
  })

  it('extends to as many partners as the spare count allows, keeping the last copy', () => {
    // #AAA holds three of card 1: one to keep, two to give away — so both of its
    // candidate trades can go through at once, to two different partners. #CCC's
    // extra, non-spare copy of card 2 only blocks the third candidate this
    // triangle would otherwise also produce (#BBB <-> #CCC, card 2 for card 3) —
    // see the dedicated triangle scenario below for that shape on its own.
    const bases = [base('#AAA', { 1: 3 }), base('#BBB', { 2: 2 }), base('#CCC', { 3: 2, 2: 1 })]
    const trades = suggestTrades(bases, categoryOf)
    assert.equal(trades.length, 2)

    const achievable = maxAchievableTrades(trades, bases)
    assert.equal(achievable.size, 2, 'both partners can be served from the two spare copies')
    assertFeasible(achievable, trades, bases)
  })
})

describe('maxAchievableTrades — a known worst case', () => {
  it('can land at half of the true optimum when the tightest-looking edge is misleading', () => {
    /*
     * The classic example that any *maximal* matching is only guaranteed half of
     * the true maximum, adapted to this module's own tie-break: four bases in a
     * chain, each holding exactly one spare —
     *
     *   #AAA:1 <-> #BBB:2 <-> #CCC:3 <-> #DDD:4
     *
     * #BBB's card 2 and #CCC's card 3 are each a candidate with *two* partners
     * (#AAA & #CCC for card 2; #BBB & #DDD for card 3), so the middle trade
     * (#BBB<->#CCC) and both outer trades all compete over the two middle
     * resources. The true optimum takes both outer trades — #AAA<->#BBB and
     * #CCC<->#DDD — for 2, leaving the middle one out. Listed first (highest
     * priority — see `sortTradesByAchievability`'s doc comment on how a caller
     * controls this order), the middle trade alone ties every resource it touches
     * at its starting capacity, so a most-constrained-first greedy has no way to
     * prefer the outer trades over it and picks it first — which strands both
     * outer candidates and settles for 1.
     *
     * This is constructed by hand rather than through `suggestTrades`, because
     * getting `suggestTrades`'s own rarity sort to land the middle trade first
     * would need controlling real card scarcity rather than the resource
     * contention this test is actually about.
     */
    const middleFirst = [
      suggestion('#BBB', '#CCC', 2, 3),
      suggestion('#CCC', '#DDD', 3, 4),
      suggestion('#AAA', '#BBB', 1, 2),
    ]
    const bases = [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 3: 2 }), base('#DDD', { 4: 2 })]

    assert.equal(bruteForceMax(middleFirst, bases), 2, 'the two outer trades really can both happen')

    const achievable = maxAchievableTrades(middleFirst, bases)
    assert.equal(achievable.size, 1, 'the greedy settles for the middle trade alone — exactly half of optimal')
    assert.deepEqual([...achievable], [tradeKey(middleFirst[0]!)])
    assertFeasible(achievable, middleFirst, bases)

    // The same four trades, reordered so an outer trade is tried first, do reach
    // the true optimum — this is not a bug in the four bases, only in the order
    // the middle test above deliberately fed the greedy.
    const outerFirst = [middleFirst[2]!, middleFirst[1]!, middleFirst[0]!]
    assert.equal(maxAchievableTrades(outerFirst, bases).size, 2)
  })
})

describe('maxAchievableTrades — never exceeds the true maximum', () => {
  // Two separate decks, isolating card ids 1-2 from 3-4 by rule 3 — otherwise a
  // scenario meant to test one shape (a triangle, two side-by-side conflicts)
  // would also pick up every cross-id trade the shared single-category
  // `categoryOf` above would allow between them, and stop testing that shape at
  // all. The hub scenario does not need this: it only ever uses ids 1 and 2.
  const twoDecks: Record<number, CardCategory> = { 1: 'Elixir', 2: 'Elixir', 3: 'Dark Elixir', 4: 'Dark Elixir' }
  const categoryOfTwoDecks = (id: number): CardCategory | undefined => twoDecks[id]

  const scenarios: Array<{ name: string; bases: BaseInventory[]; categoryOf: typeof categoryOf }> = [
    {
      // Every pair of the three trades, so each of the three resources is shared
      // by two of the three candidate trades — a triangle, whose true maximum is
      // 1 (any two of the three edges share a vertex).
      name: 'a triangle of three mutually-tradeable bases',
      bases: [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 3: 2 })],
      categoryOf,
    },
    {
      name: 'two disjoint conflicts side by side',
      bases: [
        base('#AAA', { 1: 2 }),
        base('#BBB', { 2: 2 }),
        base('#CCC', { 2: 2 }),
        base('#DDD', { 3: 2 }),
        base('#EEE', { 4: 2 }),
        base('#FFF', { 4: 2 }),
      ],
      categoryOf: categoryOfTwoDecks,
    },
    {
      name: 'a hub base spared by several partners at once',
      bases: [base('#AAA', { 1: 4 }), base('#BBB', { 2: 2 }), base('#CCC', { 2: 2 }), base('#DDD', { 2: 2 })],
      categoryOf,
    },
  ]

  for (const { name, bases, categoryOf: categoryOfScenario } of scenarios) {
    it(`is feasible and within the true maximum: ${name}`, () => {
      const trades = suggestTrades(bases, categoryOfScenario)
      const achievable = maxAchievableTrades(trades, bases)
      const optimum = bruteForceMax(trades, bases)

      assertFeasible(achievable, trades, bases)
      assert.ok(achievable.size <= optimum, 'never claims more than is truly achievable')
      assert.ok(
        achievable.size >= Math.ceil(optimum / 2),
        `at least half of optimal: got ${achievable.size} of ${optimum}`,
      )
    })
  }
})

describe('tradeKey', () => {
  it('is stable for the same swap and distinct for a different one', () => {
    const a = suggestion('#AAA', '#BBB', 1, 2)
    const b = suggestion('#AAA', '#BBB', 1, 2)
    const c = suggestion('#AAA', '#BBB', 1, 3)
    assert.equal(tradeKey(a), tradeKey(b))
    assert.notEqual(tradeKey(a), tradeKey(c))
  })
})

describe('sortTradesByAchievability', () => {
  it('moves achievable trades ahead of the rest, keeping each group’s order', () => {
    const t1 = suggestion('#AAA', '#BBB', 1, 2)
    const t2 = suggestion('#CCC', '#DDD', 3, 4)
    const t3 = suggestion('#EEE', '#FFF', 5, 6)
    const achievable = new Set([tradeKey(t2), tradeKey(t3)])

    const sorted = sortTradesByAchievability([t1, t2, t3], achievable)

    assert.deepEqual(sorted, [t2, t3, t1])
  })

  it('leaves the order untouched when everything or nothing is achievable', () => {
    const t1 = suggestion('#AAA', '#BBB', 1, 2)
    const t2 = suggestion('#CCC', '#DDD', 3, 4)

    assert.deepEqual(sortTradesByAchievability([t1, t2], new Set([tradeKey(t1), tradeKey(t2)])), [t1, t2])
    assert.deepEqual(sortTradesByAchievability([t1, t2], new Set()), [t1, t2])
  })
})
