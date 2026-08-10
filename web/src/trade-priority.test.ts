import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupTradesByPair, type TradeSuggestion } from './card-trades.ts'
import {
  parseTradePriority,
  sortTradePairsForPriority,
  tradePriorityLabel,
  TRADE_PRIORITIES,
} from './trade-priority.ts'

/** Same shape as `card-trades.test.ts`/`trade-matching.test.ts`'s own `suggestion` helper. */
function suggestion(
  baseA: string,
  baseB: string,
  cardFromA: number,
  cardFromB: number,
): TradeSuggestion {
  return { baseA, baseB, cardFromA, cardFromB, category: 'Elixir' }
}

describe('sortTradePairsForPriority — optimal leaves the incoming pair order untouched', () => {
  it('returns the same order as the input, for a copy rather than the same array', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)

    const sorted = sortTradePairsForPriority(pairs, 'optimal', flatTrades, new Set())

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
    )
    assert.notEqual(sorted, pairs)
  })

  it('does not mutate the array handed in', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    const before = pairs.map((pair) => `${pair.baseA}-${pair.baseB}`)

    sortTradePairsForPriority(pairs, 'optimal', flatTrades, new Set())

    assert.deepEqual(
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
      before,
    )
  })
})

describe('sortTradePairsForPriority — fewestPartners ranks by achievable trades per pair', () => {
  it('puts the pair with more achievable options first, regardless of arrival order', () => {
    // #A-#B has one achievable option; #A-#C has two. Handed in arrival order
    // that already puts #A-#B ahead, so this only passes if fewestPartners
    // actually reorders rather than just keeping the input's own order.
    const flatTrades = [
      suggestion('#A', '#B', 1, 2),
      suggestion('#A', '#C', 3, 4),
      suggestion('#A', '#C', 5, 6),
    ]
    const pairs = groupTradesByPair(flatTrades)
    const achievable = new Set([
      `${flatTrades[0]!.baseA}|${flatTrades[0]!.baseB}|${flatTrades[0]!.cardFromA}|${flatTrades[0]!.cardFromB}`,
      `${flatTrades[1]!.baseA}|${flatTrades[1]!.baseB}|${flatTrades[1]!.cardFromA}|${flatTrades[1]!.cardFromB}`,
      `${flatTrades[2]!.baseA}|${flatTrades[2]!.baseB}|${flatTrades[2]!.cardFromA}|${flatTrades[2]!.cardFromB}`,
    ])

    const sorted = sortTradePairsForPriority(pairs, 'fewestPartners', flatTrades, achievable)

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#C', '#A-#B'],
    )
  })

  it('breaks a tie on achievable count by keeping the incoming (optimal) order', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    // Neither trade is in the achievable set: both pairs tie at 0.
    const sorted = sortTradePairsForPriority(pairs, 'fewestPartners', flatTrades, new Set())

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
    )
  })

  it('does not mutate the array handed in', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    const before = pairs.map((pair) => `${pair.baseA}-${pair.baseB}`)

    sortTradePairsForPriority(pairs, 'fewestPartners', flatTrades, new Set())

    assert.deepEqual(
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
      before,
    )
  })
})

describe('sortTradePairsForPriority — highestValue ranks by earliest position in flatTrades', () => {
  it('ranks a pair by its best (earliest-appearing) trade, ignoring achievability entirely', () => {
    // flatTrades is handed in "value order" here (index 0 = rarest), same as
    // suggestTrades's own contract. #A-#C's best trade (index 0) outranks
    // #A-#B's best (index 1), even though nothing is achievable at all.
    const flatTrades = [suggestion('#A', '#C', 1, 2), suggestion('#A', '#B', 3, 4)]
    const pairs = groupTradesByPair([suggestion('#A', '#B', 3, 4), suggestion('#A', '#C', 1, 2)])

    const sorted = sortTradePairsForPriority(pairs, 'highestValue', flatTrades, new Set())

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#C', '#A-#B'],
    )
  })

  it('a pair with several options ranks by its single best one, not its worst', () => {
    const flatTrades = [
      suggestion('#A', '#C', 1, 2), // rarest overall
      suggestion('#A', '#B', 3, 4), // #A-#B's only option
      suggestion('#A', '#C', 5, 6), // #A-#C's weaker second option
    ]
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 3, 4),
      suggestion('#A', '#C', 5, 6),
      suggestion('#A', '#C', 1, 2),
    ])

    const sorted = sortTradePairsForPriority(pairs, 'highestValue', flatTrades, new Set())

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#C', '#A-#B'],
    )
  })

  it('does not mutate the array handed in', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    const before = pairs.map((pair) => `${pair.baseA}-${pair.baseB}`)

    sortTradePairsForPriority(pairs, 'highestValue', flatTrades, new Set())

    assert.deepEqual(
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
      before,
    )
  })
})

describe('parseTradePriority — an unrecognized or absent value is the safe default', () => {
  it('accepts each of the three known states', () => {
    for (const priority of TRADE_PRIORITIES) {
      assert.equal(parseTradePriority(priority), priority)
    }
  })

  it('falls back to optimal for null, empty, or a value the control never wrote', () => {
    assert.equal(parseTradePriority(null), 'optimal')
    assert.equal(parseTradePriority(''), 'optimal')
    assert.equal(parseTradePriority('by-name'), 'optimal')
  })
})

describe('tradePriorityLabel — one label per state, matching the select options', () => {
  it('names every state TRADE_PRIORITIES offers', () => {
    for (const priority of TRADE_PRIORITIES) {
      assert.equal(typeof tradePriorityLabel(priority), 'string')
      assert.ok(tradePriorityLabel(priority).length > 0)
    }
  })
})
