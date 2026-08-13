import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { cardsInGridOrder, cardTotals } from './card-standings.ts'
import { tradeFodder } from './trade-fodder.ts'

/*
 * Real card ids, same reason every other module built on `countMap` uses them:
 * `cardTotals()` and `cardDemand()` both go through it, and it drops any id the
 * generated card list has never heard of. Ids 1 and 2 are Elixir cards.
 *
 * `cardTotals()` is called with no explicit card list, so it defaults to
 * `cardsInGridOrder()` — the full sixty — and each test picks the one row it
 * cares about out of that, the same way `card-holders.test.ts` does via
 * `cardById`, rather than fabricating a partial `GeneratedCard` this project's
 * own "no unchecked casts" rule would otherwise be bent for.
 */
const BARBARIAN = 1
const ARCHER = 2

function base(tag: string, counts: [number, number][]): BaseInventory {
  return { tag, counts: counts.map(([cardId, count]) => ({ cardId, count })) }
}

function fodderFor(id: number, inventory: readonly BaseInventory[]) {
  const totals = cardTotals(inventory)
  return tradeFodder(totals, inventory).find((row) => row.card.id === id)!
}

describe('tradeFodder — held requires every reporting base, not just any base', () => {
  it('marks a card held with its surplus once every reporting base has at least one', () => {
    const inventory = [
      base('#AAA', [[BARBARIAN, 3]]),
      base('#BBB', [[BARBARIAN, 1]]),
      base('#CCC', [[BARBARIAN, 2]]),
    ]

    const entry = fodderFor(BARBARIAN, inventory)

    assert.equal(entry.total, 6)
    assert.equal(entry.held, true)
    // 6 copies across 3 reporting bases, one guaranteed each: 3 spare.
    assert.equal(entry.extra, 3)
  })

  it('is held with zero extra when every base has exactly one and no more', () => {
    const inventory = [base('#AAA', [[BARBARIAN, 1]]), base('#BBB', [[BARBARIAN, 1]])]

    const entry = fodderFor(BARBARIAN, inventory)

    assert.equal(entry.held, true)
    assert.equal(entry.extra, 0)
  })

  it('is not held when even one reporting base has zero, however many copies elsewhere', () => {
    const inventory = [
      base('#AAA', [[BARBARIAN, 9]]),
      base('#BBB', [[BARBARIAN, 9]]),
      base('#CCC', []),
    ]

    const entry = fodderFor(BARBARIAN, inventory)

    assert.equal(entry.total, 18)
    assert.equal(entry.held, false)
    assert.equal(entry.extra, 0)
  })

  it('is not held for a card absent from every base', () => {
    const inventory = [base('#AAA', [[ARCHER, 4]]), base('#BBB', [[ARCHER, 1]])]

    const entry = fodderFor(BARBARIAN, inventory)

    assert.equal(entry.total, 0)
    assert.equal(entry.held, false)
    assert.equal(entry.extra, 0)
  })

  it('treats zero reporting bases as not held, despite needing being vacuously zero', () => {
    const entry = fodderFor(BARBARIAN, [])

    assert.equal(entry.held, false)
    assert.equal(entry.extra, 0)
  })
})

describe('tradeFodder — shape and order', () => {
  it('returns one entry per input card, in the input order, carrying `total` through unchanged', () => {
    const cards = cardsInGridOrder()
    const inventory = [base('#AAA', [[cards[0]!.id, 5]])]
    const totals = cardTotals(inventory, cards)

    const fodder = tradeFodder(totals, inventory)

    assert.deepEqual(
      fodder.map((row) => row.card.id),
      totals.map((row) => row.card.id),
    )
    assert.deepEqual(
      fodder.map((row) => row.total),
      totals.map((row) => row.total),
    )
  })

  it('does not mutate the totals array handed in', () => {
    const cards = cardsInGridOrder()
    const inventory = [base('#AAA', [[cards[0]!.id, 5]])]
    const totals = cardTotals(inventory, cards)
    const before = totals.map((row) => ({ ...row }))

    tradeFodder(totals, inventory)

    assert.deepEqual(totals, before)
  })
})
