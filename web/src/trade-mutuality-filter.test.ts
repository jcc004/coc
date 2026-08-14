import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupTradesByPair, type TradeSuggestion } from './card-trades.ts'
import {
  filterPairsByMutuality,
  parseTradeMutualityFilter,
  tradeMutualityFilterLabel,
  tradeMutualityFilterSummary,
  TRADE_MUTUALITY_FILTERS,
} from './trade-mutuality-filter.ts'

/** Same shape as `trade-priority.test.ts`'s own `suggestion` helper. */
function suggestion(
  baseA: string,
  baseB: string,
  cardFromA: number,
  cardFromB: number,
  mutual: boolean,
): TradeSuggestion {
  return { baseA, baseB, cardFromA, cardFromB, category: 'Elixir', mutual }
}

describe('filterPairsByMutuality — twoSided', () => {
  it('keeps only mutual trades, dropping a pair left with none', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, true),
      suggestion('#C', '#D', 3, 4, false),
    ])

    const filtered = filterPairsByMutuality(pairs, 'twoSided')

    assert.deepEqual(
      filtered.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#B'],
    )
    assert.equal(filtered[0]?.trades.length, 1)
    assert.equal(filtered[0]?.trades[0]?.mutual, true)
  })

  it('keeps only the mutual option of a pair offering both', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, true),
      suggestion('#A', '#B', 3, 4, false),
    ])

    const filtered = filterPairsByMutuality(pairs, 'twoSided')

    assert.equal(filtered.length, 1)
    assert.deepEqual(
      filtered[0]?.trades.map((trade) => trade.mutual),
      [true],
    )
  })
})

describe('filterPairsByMutuality — oneSided', () => {
  it('keeps only one-sided trades, dropping a pair left with none', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, true),
      suggestion('#C', '#D', 3, 4, false),
    ])

    const filtered = filterPairsByMutuality(pairs, 'oneSided')

    assert.deepEqual(
      filtered.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#C-#D'],
    )
    assert.equal(filtered[0]?.trades[0]?.mutual, false)
  })
})

describe('filterPairsByMutuality — both', () => {
  it('returns every pair and trade unchanged, as a copy rather than the same array', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, true),
      suggestion('#C', '#D', 3, 4, false),
    ])

    const filtered = filterPairsByMutuality(pairs, 'both')

    assert.deepEqual(
      filtered.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#B', '#C-#D'],
    )
    assert.notEqual(filtered, pairs)
  })
})

describe('filterPairsByMutuality — does not mutate the input', () => {
  it('leaves the original pairs and their trades arrays untouched', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, true),
      suggestion('#A', '#B', 3, 4, false),
    ])
    const before = pairs[0]!.trades.length

    filterPairsByMutuality(pairs, 'twoSided')

    assert.equal(pairs[0]!.trades.length, before)
  })
})

describe('parseTradeMutualityFilter — an unrecognized or absent value is the safe default', () => {
  it('accepts each of the three known states', () => {
    for (const filter of TRADE_MUTUALITY_FILTERS) {
      assert.equal(parseTradeMutualityFilter(filter), filter)
    }
  })

  it('falls back to twoSided for null, empty, or a value the control never wrote', () => {
    assert.equal(parseTradeMutualityFilter(null), 'twoSided')
    assert.equal(parseTradeMutualityFilter(''), 'twoSided')
    assert.equal(parseTradeMutualityFilter('mutual'), 'twoSided')
  })
})

describe('tradeMutualityFilterLabel — one label per state, matching the select options', () => {
  it('names every state TRADE_MUTUALITY_FILTERS offers', () => {
    for (const filter of TRADE_MUTUALITY_FILTERS) {
      assert.equal(typeof tradeMutualityFilterLabel(filter), 'string')
      assert.ok(tradeMutualityFilterLabel(filter).length > 0)
    }
  })
})

describe('tradeMutualityFilterSummary', () => {
  it('says nothing for both — there is no narrowing to explain', () => {
    assert.equal(tradeMutualityFilterSummary('both', 5, 5), null)
  })

  it('names the count and which side is hidden, for twoSided', () => {
    assert.equal(
      tradeMutualityFilterSummary('twoSided', 3, 5),
      'Showing 3 of 5 pairs, two-sided only.',
    )
  })

  it('names the count and which side is hidden, for oneSided', () => {
    assert.equal(
      tradeMutualityFilterSummary('oneSided', 1, 5),
      'Showing 1 of 5 pairs, one-sided only.',
    )
  })

  it('uses the singular for a total of one', () => {
    assert.equal(
      tradeMutualityFilterSummary('twoSided', 1, 1),
      'Showing 1 of 1 pair, two-sided only.',
    )
  })

  it('reports zero survivors distinctly rather than "Showing 0 of N"', () => {
    assert.equal(tradeMutualityFilterSummary('oneSided', 0, 5), 'No one-sided trades to show.')
  })
})
