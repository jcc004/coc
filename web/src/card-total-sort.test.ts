import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { cardsInGridOrder, cardTotals } from './card-standings.ts'
import {
  CARD_TOTAL_SORTS,
  cardTotalSortLabel,
  parseCardTotalSort,
  sortCardTotalsForDisplay,
} from './card-total-sort.ts'

/*
 * Real card ids, same reason `card-standings.test.ts` uses them: both `cardTotals`
 * and the counting under it go through `countMap`, which drops an id the generated
 * list has never heard of. Ids 1 and 2 are Elixir, 20 is Dark Elixir.
 */
function base(tag: string, counts: [number, number][]): BaseInventory {
  return { tag, counts: counts.map(([cardId, count]) => ({ cardId, count })) }
}

describe('sortCardTotalsForDisplay — default leaves cardTotals() untouched', () => {
  it('returns the same order as the input, for a copy rather than the same array', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals([base('#A', [[cards[cards.length - 1]!.id, 9]])], cards)

    const sorted = sortCardTotalsForDisplay(totals, 'default')

    assert.deepEqual(
      sorted.map((entry) => entry.card.id),
      totals.map((entry) => entry.card.id),
    )
    assert.notEqual(sorted, totals)
  })

  it('does not mutate the array handed in', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals([base('#A', [[cards[0]!.id, 3]])], cards)
    const before = totals.map((entry) => entry.card.id)

    sortCardTotalsForDisplay(totals, 'default')

    assert.deepEqual(
      totals.map((entry) => entry.card.id),
      before,
    )
  })
})

describe('sortCardTotalsForDisplay — highest and lowest rank by total', () => {
  it('orders highest total first', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals(
      [base('#A', [[cards[0]!.id, 1], [cards[1]!.id, 9], [cards[2]!.id, 5]])],
      cards,
    )

    const sorted = sortCardTotalsForDisplay(totals, 'highest')

    assert.deepEqual(
      sorted.slice(0, 3).map((entry) => entry.total),
      [9, 5, 1],
    )
  })

  it('orders lowest total first', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals(
      [base('#A', [[cards[0]!.id, 1], [cards[1]!.id, 9], [cards[2]!.id, 5]])],
      cards,
    )

    const sorted = sortCardTotalsForDisplay(totals, 'lowest')

    // Every card not entered above sits on 0, so the ordered totals start with a
    // run of zeros before the three that were actually given counts.
    assert.deepEqual(sorted.slice(0, 3).map((entry) => entry.total), [0, 0, 0])
    assert.deepEqual(
      sorted.slice(-3).map((entry) => entry.total),
      [1, 5, 9],
    )
  })

  it('does not mutate the array handed in, for either direction', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals([base('#A', [[cards[0]!.id, 3]])], cards)
    const before = totals.map((entry) => entry.card.id)

    sortCardTotalsForDisplay(totals, 'highest')
    sortCardTotalsForDisplay(totals, 'lowest')

    assert.deepEqual(
      totals.map((entry) => entry.card.id),
      before,
    )
  })

  it('breaks a tie by keeping the tied rows in grid order, both directions', () => {
    // Nothing entered at all: every card ties on 0, so a stable sort must leave
    // the whole list exactly as `cardTotals()` produced it either way.
    const cards = cardsInGridOrder()
    const totals = cardTotals([], cards)

    const highest = sortCardTotalsForDisplay(totals, 'highest')
    const lowest = sortCardTotalsForDisplay(totals, 'lowest')

    assert.deepEqual(
      highest.map((entry) => entry.card.id),
      cards.map((card) => card.id),
    )
    assert.deepEqual(
      lowest.map((entry) => entry.card.id),
      cards.map((card) => card.id),
    )
  })
})

describe('parseCardTotalSort — an unrecognized or absent value is the safe default', () => {
  it('accepts each of the three known states', () => {
    for (const sort of CARD_TOTAL_SORTS) {
      assert.equal(parseCardTotalSort(sort), sort)
    }
  })

  it('falls back to default for null, empty, or a value the control never wrote', () => {
    assert.equal(parseCardTotalSort(null), 'default')
    assert.equal(parseCardTotalSort(''), 'default')
    assert.equal(parseCardTotalSort('by-name'), 'default')
  })
})

describe('cardTotalSortLabel — one label per state, matching the select options', () => {
  it('names every state CARD_TOTAL_SORTS offers', () => {
    for (const sort of CARD_TOTAL_SORTS) {
      assert.equal(typeof cardTotalSortLabel(sort), 'string')
      assert.ok(cardTotalSortLabel(sort).length > 0)
    }
  })
})
