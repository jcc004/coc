import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { cardsInGridOrder, type StandingBase } from './card-standings.ts'
import { fullRowsFor, rowScoreFor, rowStandings, ROW_SIZE } from './row-standings.ts'

/*
 * Real card ids, for the same reason `card-standings.test.ts` uses them: every
 * count here goes through `countMap`, which drops anything the generated card
 * list does not know, so an invented id would silently score zero and every
 * assertion below would be checking nothing.
 *
 * `GRID` is the exact sixty the app draws, in the exact order `fullRowsFor`
 * groups into rows of six — so `ROWS[n]` is the six card ids that make up row
 * `n`, the same grouping `row-standings.ts` computes internally. Reading the ids
 * off the real manifest, rather than assuming ids 1–6 are row 0, keeps this test
 * correct even if the manifest's category order changes.
 */
const GRID = cardsInGridOrder()
const ROWS: number[][] = []
for (let start = 0; start < GRID.length; start += ROW_SIZE) {
  ROWS.push(GRID.slice(start, start + ROW_SIZE).map((card) => card.id))
}

function base(tag: string, counts: [number, number][], updatedAt?: string): BaseInventory {
  return {
    tag,
    counts: counts.map(([cardId, count]) => ({ cardId, count })),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function named(tag: string, label: string): StandingBase {
  return { tag, label, owner: null, ownerUserId: null }
}

/** One copy of every card in the given row indices, as `base()`'s counts shape. */
function countsForRows(rowIndices: readonly number[]): [number, number][] {
  return rowIndices.flatMap((index) => ROWS[index]!.map((cardId): [number, number] => [cardId, 1]))
}

describe('fullRowsFor — which rows a base has completed', () => {
  it('marks no row full for a base holding nothing', () => {
    const fullRows = fullRowsFor(undefined)
    assert.equal(fullRows.length, 10)
    assert.ok(fullRows.every((full) => full === false))
  })

  it('marks a row full only once every one of its six cards is held', () => {
    const [first, second, , , , third] = ROWS[0]!
    const fullRows = fullRowsFor(
      base('#A', [
        [first!, 1],
        [second!, 1],
        [third!, 1],
      ]),
    )
    // Three of six held: not full yet.
    assert.equal(fullRows[0], false)
  })

  it('needs only one copy, not more, to count a card as held', () => {
    const fullRows = fullRowsFor(base('#A', countsForRows([0])))
    assert.equal(fullRows[0], true)
  })

  it('reports ten entries, in grid row order, for a base holding every card', () => {
    const all: [number, number][] = GRID.map((card) => [card.id, 1])
    const fullRows = fullRowsFor(base('#A', all))
    assert.equal(fullRows.length, 10)
    assert.ok(fullRows.every((full) => full === true))
  })

  it('ignores counts the grid would not draw either, same as countMap elsewhere', () => {
    // A non-positive count does not complete a row, same rule `countMap` applies
    // to the grid and to `baseStandings`.
    const [first, second, third, fourth, fifth, sixth] = ROWS[0]!
    const fullRows = fullRowsFor(
      base('#A', [
        [first!, 1],
        [second!, 1],
        [third!, 1],
        [fourth!, 1],
        [fifth!, 1],
        [sixth!, 0],
      ]),
    )
    assert.equal(fullRows[0], false)
  })
})

describe('rowScoreFor — the score, from a boolean-per-row reading', () => {
  it('scores nothing for no full rows', () => {
    assert.deepEqual(rowScoreFor(new Array(10).fill(false)), {
      fullRowCount: 0,
      longestStreak: 0,
      score: 0,
    })
  })

  it('scores one full row as 15: ten for the row, five for a streak of one', () => {
    const fullRows = new Array(10).fill(false)
    fullRows[0] = true
    assert.deepEqual(rowScoreFor(fullRows), { fullRowCount: 1, longestStreak: 1, score: 15 })
  })

  it('scores two separate full rows as two streaks of one, not one streak of two', () => {
    // Rows 0 and 2 full, row 1 empty between them: not adjacent, so the streak
    // that matters is the longer of two runs of one, not their sum.
    const fullRows = new Array(10).fill(false)
    fullRows[0] = true
    fullRows[2] = true
    assert.deepEqual(rowScoreFor(fullRows), { fullRowCount: 2, longestStreak: 1, score: 25 })
  })

  it('scores two adjacent full rows as one streak of two', () => {
    const fullRows = new Array(10).fill(false)
    fullRows[0] = true
    fullRows[1] = true
    assert.deepEqual(rowScoreFor(fullRows), { fullRowCount: 2, longestStreak: 2, score: 30 })
  })

  it('finds the longest of several runs, not the first or the last', () => {
    // Streaks of 1, 3 and 2: the middle one is what decides longestStreak.
    const fullRows = [true, false, true, true, true, false, true, true, false, false]
    assert.deepEqual(rowScoreFor(fullRows), { fullRowCount: 6, longestStreak: 3, score: 75 })
  })

  it('scores all ten rows full as the maximum: 100 + 50 = 150', () => {
    assert.deepEqual(rowScoreFor(new Array(10).fill(true)), {
      fullRowCount: 10,
      longestStreak: 10,
      score: 150,
    })
  })
})

describe('rowStandings — the leaderboard built on those scores', () => {
  it('scores a base with zero cards at zero, and ranks it last rather than dropping it', () => {
    const rows = rowStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', countsForRows([0]))])
    const anna = rows.find((row) => row.label === 'Anna')!
    assert.equal(anna.score, 0)
    assert.equal(anna.fullRowCount, 0)
    assert.equal(anna.longestStreak, 0)
    assert.ok(anna.fullRows.every((full) => full === false))
  })

  it('scores one full row as 15, with the streak of one it is built from', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0]))])
    assert.equal(row?.score, 15)
    assert.equal(row?.fullRowCount, 1)
    assert.equal(row?.longestStreak, 1)
    assert.equal(row?.fullRows[0], true)
    assert.ok(row?.fullRows.slice(1).every((full) => full === false))
  })

  it('scores two separate full rows as 20 + 5, not 20 + 10', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0, 2]))])
    assert.equal(row?.fullRowCount, 2)
    assert.equal(row?.longestStreak, 1)
    assert.equal(row?.score, 25)
  })

  it('scores two adjacent full rows as 20 + 10, one streak of two', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0, 1]))])
    assert.equal(row?.fullRowCount, 2)
    assert.equal(row?.longestStreak, 2)
    assert.equal(row?.score, 30)
  })

  it('gives a base holding all sixty cards the maximum: 10 full rows, one streak of 10, score 150', () => {
    const all: [number, number][] = GRID.map((card) => [card.id, 1])
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', all)])
    assert.equal(row?.fullRowCount, 10)
    assert.equal(row?.longestStreak, 10)
    assert.equal(row?.score, 150)
    assert.ok(row?.fullRows.every((full) => full === true))
  })

  it('ranks the higher score first', () => {
    const rows = rowStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', countsForRows([0, 1])), base('#B', countsForRows([0]))],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Bert'],
    )
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 2)
  })

  /*
   * The tie the fullRowCount tiebreak exists for: three full rows in one
   * unbroken run (30 + 15 = 45) versus four full rows scattered as four
   * separate streaks of one (40 + 5 = 45). Same score, reached two different
   * ways — the base that completed more rows outright ranks first.
   */
  it('breaks a score tie by full-row count, ahead of name', () => {
    const rows = rowStandings(
      [named('#Z', 'Zack'), named('#A', 'Anna')],
      [
        base('#Z', countsForRows([0, 1, 2])), // one streak of 3: 30 + 15 = 45
        base('#A', countsForRows([0, 2, 4, 6])), // four streaks of 1: 40 + 5 = 45
      ],
    )
    assert.equal(rows[0]?.score, 45)
    assert.equal(rows[1]?.score, 45)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Zack'],
    )
    assert.equal(rows[0]?.fullRowCount, 4)
    assert.equal(rows[1]?.fullRowCount, 3)
  })

  it('breaks a full tie (score and full-row count) by member name, then shares the rank', () => {
    const rows = rowStandings(
      [named('#C', 'Zack'), named('#A', 'Anna')],
      [base('#C', countsForRows([0])), base('#A', countsForRows([1]))],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Zack'],
    )
    // Same score, same full-row count: neither out-completed the other.
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('falls through to the tag when two bases share a name as well as a score', () => {
    const rows = rowStandings(
      [named('#ZZ', 'darek'), named('#AA', 'darek')],
      [base('#AA', countsForRows([0])), base('#ZZ', countsForRows([1]))],
    )
    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })

  it('keeps a base with no inventory entry on the board, scored at zero, last', () => {
    const rows = rowStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', countsForRows([0]))])
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[1]?.score, 0)
  })
})
