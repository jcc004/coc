import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MIN_TRADEABLE_COUNT, type BaseInventory } from '@coc/shared'
import { cardHolders } from './card-holders.ts'
import { cardTotals } from './card-standings.ts'
import { cardById } from './cards.ts'

/*
 * Real card ids, for the same reason `card-standings.test.ts` uses them: this goes
 * through `countMap`, which drops any id the generated list does not know, so an
 * invented one would be thrown away and every assertion would read "nobody holds it".
 * Ids 1 and 2 are Elixir, 20 is Dark Elixir.
 */
const BARBARIAN = 1
const ARCHER = 2

function base(tag: string, counts: [number, number][]): BaseInventory {
  return { tag, counts: counts.map(([cardId, count]) => ({ cardId, count })) }
}

/** Names bases the way the page's labeler does, and falls back to the tag as it does. */
const NAMES: Record<string, string> = { '#AAA': 'Alda', '#BBB': 'Brix', '#CCC': 'Cyd' }
const labelOf = (tag: string) => NAMES[tag] ?? tag

describe('cardHolders', () => {
  it('lists only the bases holding a copy, not every base tracked', () => {
    const rows = cardHolders(
      [base('#AAA', [[BARBARIAN, 1]]), base('#BBB', [[ARCHER, 4]]), base('#CCC', [])],
      BARBARIAN,
      labelOf,
    )

    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AAA'],
    )
  })

  it('comes back empty for a card nobody in the clan holds', () => {
    // 38 of the sixty are in this state in the live install, so it is the common case
    // rather than the edge one, and the panel has to say something about it.
    assert.deepEqual(cardHolders([base('#AAA', [[BARBARIAN, 2]])], ARCHER, labelOf), [])
  })

  it('puts the most copies first, so the bases with a spare lead the table', () => {
    const rows = cardHolders(
      [
        base('#AAA', [[BARBARIAN, 1]]),
        base('#BBB', [[BARBARIAN, 5]]),
        base('#CCC', [[BARBARIAN, 2]]),
      ],
      BARBARIAN,
      labelOf,
    )

    assert.deepEqual(
      rows.map((row) => row.count),
      [5, 2, 1],
    )
  })

  it('orders bases level on copies by name and then tag, so the order is total', () => {
    /* Handed in reverse of the order they must come out in: a comparator that stopped
       at the count would leave them exactly as the inventory arrived, which is a table
       that reshuffles itself between renders. */
    const rows = cardHolders(
      [
        base('#ZZZ', [[BARBARIAN, 3]]),
        base('#BBB', [[BARBARIAN, 3]]),
        base('#AAA', [[BARBARIAN, 3]]),
      ],
      BARBARIAN,
      labelOf,
    )

    /* `#ZZZ` first because no roster names it, so its label *is* its tag and `#` sorts
       ahead of a letter — the same thing the leaderboard's comparator does with an
       unnamed base, and the reason the tie-break is a documented order rather than
       "alphabetical". */
    assert.deepEqual(
      rows.map((row) => row.label),
      ['#ZZZ', 'Alda', 'Brix'],
    )
  })

  it('calls a base with two or more copies able to spare one, and a lone copy not', () => {
    const rows = cardHolders(
      [base('#AAA', [[BARBARIAN, MIN_TRADEABLE_COUNT]]), base('#BBB', [[BARBARIAN, 1]])],
      BARBARIAN,
      labelOf,
    )

    assert.deepEqual(
      rows.map((row) => row.canSpare),
      [true, false],
    )
  })

  it('names every base through the labeler it is given', () => {
    const rows = cardHolders([base('#AAA', [[BARBARIAN, 1]])], BARBARIAN, labelOf)

    assert.equal(rows[0]?.label, 'Alda')
  })

  it('drops what the grid drops, so the rows always add up to the tile badge', () => {
    /* The badge and this table are two readings of one number, and they only agree
       because both count through `countMap`: a zero, a negative and an id the
       generated list has never heard of are absences in both. */
    const inventory = [
      base('#AAA', [
        [BARBARIAN, 3],
        [ARCHER, 0],
      ]),
      base('#BBB', [
        [BARBARIAN, -2],
        [9999, 7],
      ]),
      base('#CCC', [[BARBARIAN, 4]]),
    ]

    const card = cardById(BARBARIAN)
    assert.ok(card)
    const [total] = cardTotals(inventory, [card])
    const rows = cardHolders(inventory, BARBARIAN, labelOf)

    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#CCC', '#AAA'],
    )
    assert.equal(
      rows.reduce((sum, row) => sum + row.count, 0),
      total?.total,
    )
  })

  it('leaves the inventory it was handed alone', () => {
    // It sorts, and sorting the caller's array in place would reorder `state.entries`
    // itself — the array the grid above and the leaderboard are both drawn from.
    const inventory = [base('#BBB', [[BARBARIAN, 1]]), base('#AAA', [[BARBARIAN, 9]])]

    cardHolders(inventory, BARBARIAN, labelOf)

    assert.deepEqual(
      inventory.map((entry) => entry.tag),
      ['#BBB', '#AAA'],
    )
  })
})
