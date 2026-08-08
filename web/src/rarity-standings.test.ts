import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import type { StandingBase } from './card-standings.ts'
import { rarityStandings } from './rarity-standings.ts'

/*
 * Real card ids, same reasoning `card-standings.test.ts` gives for its own fixtures:
 * `countMap` drops anything the generated list does not know, so an invented id
 * would be silently thrown away and every assertion would read zero. Ids 1-60 are
 * confirmed contiguous — see `cards.generated.ts`.
 */
function base(tag: string, counts: [number, number][]): BaseInventory {
  return { tag, counts: counts.map(([cardId, count]) => ({ cardId, count })) }
}

function named(tag: string, label: string, owner: string | null = null): StandingBase {
  return { tag, label, owner, ownerUserId: null }
}

/*
 * `rarityStandings()` computes scarcity from *every* card in the real 60-card
 * manifest, not just the ones a test happens to mention — an id nobody in the
 * fixture holds is still "total 0," and with only sixty cards and ten tiers of six,
 * those absent cards alone fill the rarest eight tiers before a single held card is
 * considered. So every fixture below reads from one shared clan baseline, `#FILLER`,
 * which alone is enough to fix which of two card groups is which tier:
 *
 * - ids 1-6 ("RARE"), clan total 1 each. 48 untouched ids (13-60) fill tiers 1-8;
 *   RARE fills tier 9, worth 8 points a card.
 * - ids 7-12 ("COMMON"), clan total 10 each — comfortably above RARE's 1-3 even
 *   after a ranked base in a test adds a copy or two — so COMMON always sorts after
 *   RARE and fills tier 10, worth 4 points a card.
 *
 * A ranked base holding a RARE or COMMON id on top of the filler nudges that one
 * id's total up by a copy or two but never far enough to cross into the other
 * group's range, so the two point values (8 and 4) are fixed for every test here
 * regardless of which combination of bases hold which ids.
 */
const RARE_IDS = [1, 2, 3, 4, 5, 6]
const COMMON_IDS = [7, 8, 9, 10, 11, 12]
const RARE_POINTS = 8
const COMMON_POINTS = 4

function filler(): BaseInventory {
  return base('#FILLER', [
    ...RARE_IDS.map((id): [number, number] => [id, 1]),
    ...COMMON_IDS.map((id): [number, number] => [id, 10]),
  ])
}

describe('rarityStandings — the measure', () => {
  it('sums rarity points once per distinct card, ignoring copy depth', () => {
    const rows = rarityStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass')],
      [
        filler(),
        // Three RARE ids, the third held three times over — same score as once.
        base('#A', [[1, 1], [2, 1], [3, 3]]),
        base('#B', [[7, 1], [8, 1]]),
        // Cass has no inventory row at all.
      ],
    )

    const anna = rows.find((row) => row.tag === '#A')
    const bert = rows.find((row) => row.tag === '#B')
    const cass = rows.find((row) => row.tag === '#C')

    assert.equal(anna?.rarityScore, 3 * RARE_POINTS)
    assert.equal(anna?.distinct, 3)
    assert.equal(bert?.rarityScore, 2 * COMMON_POINTS)
    assert.equal(bert?.distinct, 2)
    assert.equal(cass?.rarityScore, 0)
    assert.equal(cass?.distinct, 0)
  })

  it('ranks rarity score above everything else, and skips no rank when nothing ties', () => {
    const rows = rarityStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass')],
      [filler(), base('#A', [[1, 1], [2, 1], [3, 1]]), base('#B', [[7, 1], [8, 1]])],
    )
    assert.deepEqual(
      rows.map((row) => [row.tag, row.rank]),
      [
        ['#A', 1],
        ['#B', 2],
        ['#C', 3],
      ],
    )
  })

  it('ignores counts the grid would not draw either', () => {
    // An id outside 1-60 and a non-positive count are both absences, on the same
    // terms `countMap` applies elsewhere.
    const rows = rarityStandings(
      [named('#A', 'Anna')],
      [filler(), base('#A', [[1, 2], [999, 5], [2, 0]])],
    )
    assert.equal(rows[0]?.distinct, 1)
    assert.equal(rows[0]?.rarityScore, RARE_POINTS)
  })
})

describe('rarityStandings — the order is total, because ties are the common case', () => {
  it('breaks a rarity-score tie by distinct cards held, descending', () => {
    // Dee: one RARE card (8 points, distinct 1). Eve: two COMMON cards (4+4=8
    // points, distinct 2). Same score, different breadth — Eve should lead.
    const rows = rarityStandings(
      [named('#D', 'Dee'), named('#E', 'Eve')],
      [filler(), base('#D', [[1, 1]]), base('#E', [[7, 1], [8, 1]])],
    )
    assert.equal(rows[0]?.rarityScore, rows[1]?.rarityScore)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Eve', 'Dee'],
    )
    // But neither out-scored the other on rarityScore itself, so the rank is shared.
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('falls through to member name, then to tag, when score and distinct both tie', () => {
    const bases = [named('#C', 'Zack'), named('#A', 'Anna'), named('#B', 'Mia')]
    const inventory = [filler(), base('#A', [[1, 1]]), base('#B', [[2, 1]]), base('#C', [[3, 1]])]
    const first = rarityStandings(bases, inventory).map((row) => row.label)
    // Reversed input, identical output: the order depends on the data alone.
    const second = rarityStandings([...bases].reverse(), inventory).map((row) => row.label)
    assert.deepEqual(first, ['Anna', 'Mia', 'Zack'])
    assert.deepEqual(second, first)

    const sameNameRows = rarityStandings(
      [named('#ZZ', 'darek'), named('#AA', 'darek')],
      [filler(), base('#AA', [[1, 1]]), base('#ZZ', [[2, 1]])],
    )
    assert.deepEqual(
      sameNameRows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })
})

describe('rarityStandings — a base holding nothing', () => {
  it('scores zero rather than throwing, whether untracked or recorded empty', () => {
    const rows = rarityStandings(
      [named('#NEVER', 'NoEntry'), named('#EMPTY', 'RecordedEmpty')],
      [filler(), base('#EMPTY', [])],
    )
    for (const row of rows) {
      assert.equal(row.rarityScore, 0)
      assert.equal(row.distinct, 0)
    }
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('carries the base identity through untouched', () => {
    const [row] = rarityStandings([named('#A', 'Anna', 'Jared')], [filler()])
    assert.equal(row?.tag, '#A')
    assert.equal(row?.label, 'Anna')
    assert.equal(row?.owner, 'Jared')
  })
})
