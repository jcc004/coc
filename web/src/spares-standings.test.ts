import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import type { StandingBase } from './card-standings.ts'
import { spareStandings } from './spares-standings.ts'

/*
 * Real card ids, unlike a toy deck: `spareStandings` goes through `countMap`, which
 * drops any id the generated list does not know, so an invented id would be
 * silently thrown away and every assertion would read zero. Ids 1 and 2 are Elixir.
 */
function base(tag: string, counts: [number, number][]): BaseInventory {
  return { tag, counts: counts.map(([cardId, count]) => ({ cardId, count })) }
}

function named(tag: string, label: string, owner: string | null = null): StandingBase {
  return { tag, label, owner, ownerUserId: null }
}

describe('spareStandings — the measure', () => {
  it('scores a card held exactly once as zero spares', () => {
    const [row] = spareStandings([named('#A', 'Anna')], [base('#A', [[1, 1]])])
    assert.equal(row?.spares, 0)
    assert.deepEqual(row?.cards, [])
  })

  it('scores a card held ten times as nine spares', () => {
    const [row] = spareStandings([named('#A', 'Anna')], [base('#A', [[1, 10]])])
    assert.equal(row?.spares, 9)
    assert.deepEqual(row?.cards, [{ cardId: 1, spares: 9 }])
  })

  it('sums spares across every card, not just the one with the most', () => {
    const [row] = spareStandings([named('#A', 'Anna')], [base('#A', [[1, 3], [2, 1], [3, 5]])])
    // card 1: 2 spares, card 2: 0 spares (its only copy), card 3: 4 spares.
    assert.equal(row?.spares, 6)
    assert.equal(row?.spareVariety, 2)
    assert.deepEqual(row?.cards, [
      { cardId: 1, spares: 2 },
      { cardId: 3, spares: 4 },
    ])
  })

  it('scores a base holding nothing at zero, without dropping it from the board', () => {
    const rows = spareStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', [[1, 5]])])
    const anna = rows.find((row) => row.label === 'Anna')
    assert.equal(anna?.spares, 0)
    assert.deepEqual(anna?.cards, [])
  })

  it('ignores counts the grid would not draw either', () => {
    // An id outside 1-60 and a non-positive count are both absences, on the same
    // terms `countMap` applies everywhere else.
    const [row] = spareStandings([named('#A', 'Anna')], [base('#A', [[1, 4], [999, 8], [2, 0]])])
    assert.equal(row?.spares, 3)
    assert.deepEqual(row?.cards, [{ cardId: 1, spares: 3 }])
  })
})

describe('spareStandings — the tiebreak', () => {
  it('separates two bases tied on total spares by variety, breadth first', () => {
    // Anna: nine spares from one card. Bert: nine spares spread across three cards.
    // Same total; Bert can answer three different trade requests, Anna only one.
    const rows = spareStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 10]]), base('#B', [[1, 4], [2, 4], [3, 4]])],
    )
    assert.equal(rows[0]?.spares, 9)
    assert.equal(rows[1]?.spares, 9)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[0]?.spareVariety, 3)
    assert.equal(rows[1]?.spareVariety, 1)
  })

  it('shares the rank on a spares tie even though variety separates the order', () => {
    const rows = spareStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 10]]), base('#B', [[1, 4], [2, 4], [3, 4]])],
    )
    // Neither out-traded the other on the measure itself, so both are rank 1.
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('falls through to member name, then tag, on a full tie', () => {
    const rows = spareStandings(
      [named('#C', 'Zack'), named('#A', 'Anna'), named('#B', 'Mia')],
      [base('#A', [[1, 2]]), base('#B', [[1, 2]]), base('#C', [[1, 2]])],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Mia', 'Zack'],
    )

    const tagRows = spareStandings(
      [named('#ZZ', 'darek'), named('#AA', 'darek')],
      [base('#AA', [[1, 2]]), base('#ZZ', [[1, 2]])],
    )
    assert.deepEqual(
      tagRows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })

  it('numbers three distinct spare totals 1, 2, 3 — no ties to skip', () => {
    const rows = spareStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass')],
      [base('#A', [[1, 10]]), base('#B', [[1, 5]]), base('#C', [[1, 2]])],
    )
    assert.deepEqual(
      rows.map((row) => [row.label, row.spares, row.rank]),
      [
        ['Anna', 9, 1],
        ['Bert', 4, 2],
        ['Cass', 1, 3],
      ],
    )
  })
})

describe('spareStandings — the fields carried from StandingBase', () => {
  it('carries tag, label, owner and ownerUserId through unchanged', () => {
    const [row] = spareStandings(
      [{ tag: '#A', label: 'Anna', owner: 'Jared', ownerUserId: 7 }],
      [base('#A', [[1, 2]])],
    )
    assert.equal(row?.tag, '#A')
    assert.equal(row?.label, 'Anna')
    assert.equal(row?.owner, 'Jared')
    assert.equal(row?.ownerUserId, 7)
  })
})
