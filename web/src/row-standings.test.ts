import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { cardsInGridOrder, type StandingBase } from './card-standings.ts'
import { rowLevelsFor, rowScoreFor, rowStandings, ROW_SIZE, type RowLevel } from './row-standings.ts'

/*
 * Real card ids, for the same reason `card-standings.test.ts` uses them: every
 * count here goes through `countMap`, which drops anything the generated card
 * list does not know, so an invented id would silently score zero and every
 * assertion below would be checking nothing.
 *
 * `GRID` is the exact sixty the app draws, in the exact order `rowLevelsFor`
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

/** Two copies of every card in the given row indices — doubles them. */
function doubledCountsForRows(rowIndices: readonly number[]): [number, number][] {
  return rowIndices.flatMap((index) => ROWS[index]!.map((cardId): [number, number] => [cardId, 2]))
}

/** `levels`, one entry per row 0..9, with every unlisted row left `'empty'`. */
function levels(overrides: Record<number, RowLevel>): RowLevel[] {
  return Array.from({ length: 10 }, (_, index) => overrides[index] ?? 'empty')
}

describe('rowLevelsFor — how full each row is', () => {
  it('marks every row empty for a base holding nothing', () => {
    const rowLevels = rowLevelsFor(undefined)
    assert.equal(rowLevels.length, 10)
    assert.ok(rowLevels.every((level) => level === 'empty'))
  })

  it('marks a row full only once every one of its six cards is held', () => {
    const [first, second, , , , third] = ROWS[0]!
    const rowLevels = rowLevelsFor(
      base('#A', [
        [first!, 1],
        [second!, 1],
        [third!, 1],
      ]),
    )
    // Three of six held: not full yet.
    assert.equal(rowLevels[0], 'empty')
  })

  it('needs only one copy, not more, to count a row as full', () => {
    const rowLevels = rowLevelsFor(base('#A', countsForRows([0])))
    assert.equal(rowLevels[0], 'full')
  })

  it('needs two copies of every card in the row to count it as doubled', () => {
    const [first, second, third, fourth, fifth, sixth] = ROWS[0]!
    // Five doubled, one held only once: full, not doubled — the minimum across
    // the row is what decides the level, not the average.
    const rowLevels = rowLevelsFor(
      base('#A', [
        [first!, 2],
        [second!, 2],
        [third!, 2],
        [fourth!, 2],
        [fifth!, 2],
        [sixth!, 1],
      ]),
    )
    assert.equal(rowLevels[0], 'full')
  })

  it('marks a row doubled once every one of its six cards is held at least twice', () => {
    const rowLevels = rowLevelsFor(base('#A', doubledCountsForRows([0])))
    assert.equal(rowLevels[0], 'double')
  })

  it('reports ten entries, in grid row order, for a base holding every card', () => {
    const all: [number, number][] = GRID.map((card) => [card.id, 1])
    const rowLevels = rowLevelsFor(base('#A', all))
    assert.equal(rowLevels.length, 10)
    assert.ok(rowLevels.every((level) => level === 'full'))
  })

  it('ignores counts the grid would not draw either, same as countMap elsewhere', () => {
    // A non-positive count does not complete a row, same rule `countMap` applies
    // to the grid and to `baseStandings`.
    const [first, second, third, fourth, fifth, sixth] = ROWS[0]!
    const rowLevels = rowLevelsFor(
      base('#A', [
        [first!, 1],
        [second!, 1],
        [third!, 1],
        [fourth!, 1],
        [fifth!, 1],
        [sixth!, 0],
      ]),
    )
    assert.equal(rowLevels[0], 'empty')
  })
})

describe('rowScoreFor — the score, from a level-per-row reading', () => {
  it('scores nothing for no full rows', () => {
    assert.deepEqual(rowScoreFor(levels({})), {
      fullRowCount: 0,
      doubleRowCount: 0,
      streakBonus: 0,
      score: 0,
    })
  })

  it('scores one full row as 10: no streak bonus for a run of one', () => {
    assert.deepEqual(rowScoreFor(levels({ 0: 'full' })), {
      fullRowCount: 1,
      doubleRowCount: 0,
      streakBonus: 0,
      score: 10,
    })
  })

  it('scores two separate full rows as 20, not 20 + streak — neither run is two long', () => {
    // Rows 0 and 2 full, row 1 empty between them: not adjacent, so neither
    // contributes to the streak bonus on its own.
    assert.deepEqual(rowScoreFor(levels({ 0: 'full', 2: 'full' })), {
      fullRowCount: 2,
      doubleRowCount: 0,
      streakBonus: 0,
      score: 20,
    })
  })

  it('scores two adjacent full rows as 20 + 5, one streak of two — one adjacent pair', () => {
    assert.deepEqual(rowScoreFor(levels({ 0: 'full', 1: 'full' })), {
      fullRowCount: 2,
      doubleRowCount: 0,
      streakBonus: 5,
      score: 25,
    })
  })

  it('sums every qualifying streak, not just the longest', () => {
    // Runs of 1, 3 and 2 — the run of 1 contributes nothing, the other two both do.
    // 3 pairs in the run of three, 1 pair in the run of two: (3 + 1) × 5 = 20.
    const rowLevels = levels({ 0: 'full', 2: 'full', 3: 'full', 4: 'full', 6: 'full', 7: 'full' })
    assert.deepEqual(rowScoreFor(rowLevels), {
      fullRowCount: 6,
      doubleRowCount: 0,
      streakBonus: 20,
      score: 80, // 60 + 20
    })
  })

  /*
   * The exact shape reported live, 2026-08-12: two bases each with 5 of 10 rows
   * full. One as a run of three plus two rows on their own (no streak bonus for
   * either) — the other as a run of three plus a *separate* run of two, both
   * qualifying. The then-current longest-run-only formula scored these
   * identically (65 for both); summing every qualifying run's row count was
   * the fix at the time, which is what this test originally pinned.
   *
   * Reported live again, 2026-08-13: that row-count sum let a run of three plus
   * a separate run of two (5 rows split into two pieces) outscore a single run
   * of four or five (4 or 5 rows, unsplit) — see the module doc's worked
   * examples. `streakBonus` counts adjacent *pairs* within each run instead,
   * which is convex in run length: a run of three (3 pairs, 15 points) still
   * beats a run of three plus two isolated rows (also 3 pairs — the isolated
   * ones form no pair), but a run of three plus a *separate* run of two (3 + 1
   * = 4 pairs, 20 points) no longer catches up to what an unsplit run of the
   * same total rows would have scored.
   */
  it('still ranks a run of three plus a separate run of two above a run of three plus two scattered rows', () => {
    const scatteredExtra = rowScoreFor(levels({ 0: 'full', 1: 'full', 2: 'full', 5: 'full', 8: 'full' }))
    const secondStreak = rowScoreFor(levels({ 0: 'full', 1: 'full', 2: 'full', 5: 'full', 6: 'full' }))
    assert.equal(scatteredExtra.streakBonus, 15) // 3 pairs × 5
    assert.equal(scatteredExtra.score, 65) // 50 + 15
    assert.equal(secondStreak.streakBonus, 20) // (3 + 1) pairs × 5
    assert.equal(secondStreak.score, 70) // 50 + 20
    assert.ok(secondStreak.score > scatteredExtra.score)
  })

  it('scores a doubled row as 20: the full 10 plus 10 more for doubled', () => {
    assert.deepEqual(rowScoreFor(levels({ 0: 'double' })), {
      fullRowCount: 1,
      doubleRowCount: 1,
      streakBonus: 0,
      score: 20,
    })
  })

  it('counts a doubled row toward the streak the same as a merely full one', () => {
    const rowLevels = levels({ 0: 'double', 1: 'full' })
    assert.deepEqual(rowScoreFor(rowLevels), {
      fullRowCount: 2,
      doubleRowCount: 1,
      streakBonus: 5,
      score: 35, // 20 (full×2) + 5 (one adjacent pair) + 10 (one doubled)
    })
  })

  it('scores all ten rows doubled as the maximum: 100 + 225 + 100 = 425', () => {
    // One run of ten: 10 × 9 / 2 = 45 adjacent pairs, at 5 points each.
    assert.deepEqual(rowScoreFor(new Array(10).fill('double') as RowLevel[]), {
      fullRowCount: 10,
      doubleRowCount: 10,
      streakBonus: 225,
      score: 425,
    })
  })
})

describe('rowStandings — the leaderboard built on those scores', () => {
  it('scores a base with zero cards at zero, and ranks it last rather than dropping it', () => {
    const rows = rowStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', countsForRows([0]))])
    const anna = rows.find((row) => row.label === 'Anna')!
    assert.equal(anna.score, 0)
    assert.equal(anna.fullRowCount, 0)
    assert.equal(anna.streakBonus, 0)
    assert.ok(anna.rowLevels.every((level) => level === 'empty'))
  })

  it('scores one full row as 10, with no streak of its own', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0]))])
    assert.equal(row?.score, 10)
    assert.equal(row?.fullRowCount, 1)
    assert.equal(row?.streakBonus, 0)
    assert.equal(row?.rowLevels[0], 'full')
    assert.ok(row?.rowLevels.slice(1).every((level) => level === 'empty'))
  })

  it('scores two separate full rows as 20, not 20 + a streak bonus', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0, 2]))])
    assert.equal(row?.fullRowCount, 2)
    assert.equal(row?.streakBonus, 0)
    assert.equal(row?.score, 20)
  })

  it('scores two adjacent full rows as 20 + 5, one adjacent pair', () => {
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', countsForRows([0, 1]))])
    assert.equal(row?.fullRowCount, 2)
    assert.equal(row?.streakBonus, 5)
    assert.equal(row?.score, 25)
  })

  it('gives a base holding every card twice the maximum: 10 full rows, all doubled, score 425', () => {
    const all: [number, number][] = GRID.map((card) => [card.id, 2])
    const [row] = rowStandings([named('#A', 'Anna')], [base('#A', all)])
    assert.equal(row?.fullRowCount, 10)
    assert.equal(row?.doubleRowCount, 10)
    assert.equal(row?.streakBonus, 225) // 45 adjacent pairs × 5
    assert.equal(row?.score, 425)
    assert.ok(row?.rowLevels.every((level) => level === 'double'))
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
   * The tie the fullRowCount tiebreak exists for: three full rows as one
   * unbroken run (3 pairs × 5 = 15, score 30 + 15 = 45) versus four full rows
   * as a run of two (1 pair × 5 = 5) plus two rows on their own (30 + 10 + 5 =
   * 45). Same score, reached two different ways — the base that completed
   * more rows outright ranks first.
   */
  it('breaks a score tie by full-row count, ahead of name', () => {
    const rows = rowStandings(
      [named('#Z', 'Zack'), named('#A', 'Anna')],
      [
        base('#Z', countsForRows([0, 1, 2])), // one run of three: 30 + 15 = 45
        base('#A', countsForRows([0, 1, 4, 7])), // a run of two plus two on their own: 40 + 5 = 45
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
