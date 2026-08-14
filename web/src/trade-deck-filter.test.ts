import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CardCategory } from '@coc/shared'
import { cardCategoriesInOrder } from './cards.ts'
import { groupTradesByPair, type TradeSuggestion } from './card-trades.ts'
import {
  filterPairsByDeck,
  parseTradeDeckFilter,
  tradeDeckFilterLabel,
  tradeDeckFilterSummary,
  TRADE_DECK_FILTERS,
} from './trade-deck-filter.ts'

const [firstDeck, secondDeck] = cardCategoriesInOrder()

/** Same shape as `trade-priority.test.ts`'s own `suggestion` helper, plus a deck. */
function suggestion(
  baseA: string,
  baseB: string,
  cardFromA: number,
  cardFromB: number,
  category: CardCategory,
): TradeSuggestion {
  return { baseA, baseB, cardFromA, cardFromB, category, mutual: true }
}

describe('TRADE_DECK_FILTERS', () => {
  it('offers "all" first, then every deck in manifest order', () => {
    assert.deepEqual(TRADE_DECK_FILTERS, ['all', ...cardCategoriesInOrder()])
  })
})

describe('filterPairsByDeck — a specific deck', () => {
  it('keeps only trades in the chosen deck, dropping a pair left with none', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, firstDeck!),
      suggestion('#C', '#D', 3, 4, secondDeck!),
    ])

    const filtered = filterPairsByDeck(pairs, firstDeck!)

    assert.deepEqual(
      filtered.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#B'],
    )
    assert.equal(filtered[0]?.trades[0]?.category, firstDeck)
  })

  it('keeps only the matching option of a pair offering more than one deck', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, firstDeck!),
      suggestion('#A', '#B', 3, 4, secondDeck!),
    ])

    const filtered = filterPairsByDeck(pairs, firstDeck!)

    assert.equal(filtered.length, 1)
    assert.deepEqual(
      filtered[0]?.trades.map((trade) => trade.category),
      [firstDeck],
    )
  })
})

describe('filterPairsByDeck — all', () => {
  it('returns every pair and trade unchanged, as a copy rather than the same array', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, firstDeck!),
      suggestion('#C', '#D', 3, 4, secondDeck!),
    ])

    const filtered = filterPairsByDeck(pairs, 'all')

    assert.deepEqual(
      filtered.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#A-#B', '#C-#D'],
    )
    assert.notEqual(filtered, pairs)
  })
})

describe('filterPairsByDeck — does not mutate the input', () => {
  it('leaves the original pairs and their trades arrays untouched', () => {
    const pairs = groupTradesByPair([
      suggestion('#A', '#B', 1, 2, firstDeck!),
      suggestion('#A', '#B', 3, 4, secondDeck!),
    ])
    const before = pairs[0]!.trades.length

    filterPairsByDeck(pairs, firstDeck!)

    assert.equal(pairs[0]!.trades.length, before)
  })
})

describe('parseTradeDeckFilter — an unrecognized or absent value is the safe default', () => {
  it('accepts every known state', () => {
    for (const filter of TRADE_DECK_FILTERS) {
      assert.equal(parseTradeDeckFilter(filter), filter)
    }
  })

  it('falls back to "all" for null, empty, or a deck the manifest never offered', () => {
    assert.equal(parseTradeDeckFilter(null), 'all')
    assert.equal(parseTradeDeckFilter(''), 'all')
    assert.equal(parseTradeDeckFilter('Not A Deck'), 'all')
  })
})

describe('tradeDeckFilterLabel', () => {
  it('reads "All decks" for all, and the deck name itself otherwise', () => {
    assert.equal(tradeDeckFilterLabel('all'), 'All decks')
    assert.equal(tradeDeckFilterLabel(firstDeck!), firstDeck)
  })
})

describe('tradeDeckFilterSummary', () => {
  it('says nothing for all — there is no narrowing to explain', () => {
    assert.equal(tradeDeckFilterSummary('all', 5, 5), null)
  })

  it('names the count and the chosen deck', () => {
    assert.equal(
      tradeDeckFilterSummary(firstDeck!, 3, 5),
      `Showing 3 of 5 pairs, ${firstDeck} only.`,
    )
  })

  it('uses the singular for a total of one', () => {
    assert.equal(
      tradeDeckFilterSummary(firstDeck!, 1, 1),
      `Showing 1 of 1 pair, ${firstDeck} only.`,
    )
  })

  it('reports zero survivors distinctly rather than "Showing 0 of N"', () => {
    assert.equal(tradeDeckFilterSummary(firstDeck!, 0, 5), `No ${firstDeck} trades to show.`)
  })
})
