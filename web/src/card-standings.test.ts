import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import {
  baseStandings,
  cardPoints,
  cardsInGridOrder,
  cardTotals,
  type StandingBase,
} from './card-standings.ts'
import { ALL_CARDS, cardCategoriesInOrder, cardsInCategory } from './cards.ts'

/*
 * Real card ids, unlike `card-trades.test.ts`'s toy deck: both functions here go
 * through `countMap`, which drops anything the generated list does not know, so an
 * invented id would be silently thrown away and every assertion would read zero.
 * Ids 1 and 2 are Elixir, 20 is Dark Elixir, 44 is Super Troop.
 */
function base(tag: string, counts: [number, number][], updatedAt?: string): BaseInventory {
  return {
    tag,
    counts: counts.map(([cardId, count]) => ({ cardId, count })),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function named(tag: string, label: string, owner: string | null = null): StandingBase {
  return { tag, label, owner }
}

/*
 * The curve itself. `cardPoints` uses a closed-form arithmetic sum, which is easy to
 * get off by one — so it is checked against a naive loop over the same rule rather
 * than against more of my own arithmetic.
 */
function naiveCardPoints(copies: number): number {
  let points = 0
  for (let copy = 1; copy <= copies; copy += 1) points += copy <= 10 ? 11 - copy : 1
  return points
}

describe('cardPoints', () => {
  it('pays 10 for the first copy and one less for each after it', () => {
    assert.equal(cardPoints(1), 10)
    assert.equal(cardPoints(2), 19)
    assert.equal(cardPoints(3), 27)
  })

  it('bottoms out at 1 for the tenth copy', () => {
    assert.equal(cardPoints(10), 55)
  })

  it('pays a flat 1 for every copy past the tenth', () => {
    // Unreachable through the UI — MAX_CARD_COUNT caps entry at 10 — but implemented
    // so raising that cap cannot silently change what a base scores.
    assert.equal(cardPoints(11), 56)
    assert.equal(cardPoints(15), 60)
  })

  it('scores nothing for a card not held, or for nonsense', () => {
    assert.equal(cardPoints(0), 0)
    assert.equal(cardPoints(-3), 0)
    assert.equal(cardPoints(Number.NaN), 0)
    assert.equal(cardPoints(Number.POSITIVE_INFINITY), 0)
  })

  it('agrees with a naive loop across the whole range, cap and beyond', () => {
    for (let copies = 0; copies <= 20; copies += 1) {
      assert.equal(cardPoints(copies), naiveCardPoints(copies), `copies=${copies}`)
    }
  })

  it('tops out at 3,300 for a complete set at the cap', () => {
    assert.equal(cardPoints(10) * ALL_CARDS.length, 3300)
  })
})

describe('baseStandings — the measure', () => {
  /*
   * The same fixture the old distinct-only rule used, kept deliberately: it is the
   * case where the two measures disagree. Anna holds three cards once each (3 x 10 =
   * 30); Bert holds one card nine times (10+9+...+2 = 54). Under the old rule Anna
   * led; under points Bert does, because a deep stack of spares is worth more to a
   * group that trades than three cards nobody can trade for.
   */
  it('ranks by points, which can put copies above breadth', () => {
    const rows = baseStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 1], [2, 1], [3, 1]]), base('#B', [[1, 9]])],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[0]?.points, 54)
    assert.equal(rows[0]?.distinct, 1)
    assert.equal(rows[1]?.points, 30)
    assert.equal(rows[1]?.distinct, 3)
  })

  /*
   * A genuine points tie, which takes finding: 54 is reachable both as one card held
   * nine times (10+9+...+2) and as two cards held three times each (27+27). So the
   * two bases score identically while holding a different number of distinct cards —
   * which is exactly the case the tiebreak exists for.
   */
  it('orders a points tie by distinct, and still shares the rank', () => {
    const rows = baseStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 9]]), base('#B', [[1, 3], [2, 3]])],
    )

    assert.equal(rows[0]?.points, 54)
    assert.equal(rows[1]?.points, 54)

    // Bert first: same score across more of the sixty is the better position.
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[0]?.distinct, 2)
    assert.equal(rows[1]?.distinct, 1)

    // But neither out-scored the other, so the rank is shared rather than 1 and 2.
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('prints the fraction out of the sixty the event ships', () => {
    const [row] = baseStandings([named('#A', 'Anna')], [base('#A', [[1, 1]])])
    assert.equal(row?.size, 60)
    assert.equal(row?.size, ALL_CARDS.length)
  })

  it('keeps a base nobody has entered on the board, last, rather than dropping it', () => {
    const rows = baseStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', [[1, 1]])])
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[1]?.distinct, 0)
    assert.equal(rows[1]?.recorded, false)
  })

  it('reads a base cleared back to zero as checked, not as never entered', () => {
    const [row] = baseStandings([named('#A', 'Anna')], [base('#A', [], '2026-08-02T00:00:00.000Z')])
    assert.equal(row?.distinct, 0)
    assert.equal(row?.recorded, true)
  })

  it('carries the owner through, since the owner is who would trade', () => {
    const [row] = baseStandings([named('#A', 'Anna', 'Jared')], [])
    assert.equal(row?.owner, 'Jared')
  })

  it('ignores counts the grid would not draw either', () => {
    // An id outside 1–60 and a non-positive count are both absences, on the same
    // terms `countMap` applies to the grid.
    const [row] = baseStandings([named('#A', 'Anna')], [base('#A', [[1, 2], [999, 5], [2, 0]])])
    assert.equal(row?.distinct, 1)
    assert.equal(row?.total, 2)
  })
})

describe('baseStandings — the order is total, because ties are the common case', () => {
  it('breaks a tie on distinct with copies, descending', () => {
    const rows = baseStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 1], [2, 1]]), base('#B', [[1, 3], [2, 1]])],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
  })

  it('breaks a full tie by member name, so the list cannot reshuffle', () => {
    const bases = [named('#C', 'Zack'), named('#A', 'Anna'), named('#B', 'Mia')]
    const inventory = [base('#A', [[1, 1]]), base('#B', [[1, 1]]), base('#C', [[1, 1]])]
    const first = baseStandings(bases, inventory).map((row) => row.label)
    // Reversed input, identical output: the order depends on the data alone.
    const second = baseStandings([...bases].reverse(), inventory).map((row) => row.label)
    assert.deepEqual(first, ['Anna', 'Mia', 'Zack'])
    assert.deepEqual(second, first)
  })

  it('falls through to the tag when two bases share a name as well as a score', () => {
    const rows = baseStandings(
      [named('#ZZ', 'darek'), named('#AA', 'darek')],
      [base('#AA', [[1, 1]]), base('#ZZ', [[1, 1]])],
    )
    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })
})

describe('baseStandings — the rank number', () => {
  it('shares a rank between bases level on distinct and copies, then skips', () => {
    const rows = baseStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass'), named('#D', 'Dana')],
      [
        base('#A', [[1, 1], [2, 1], [3, 1]]),
        base('#B', [[1, 1], [2, 1]]),
        base('#C', [[4, 1], [5, 1]]),
        base('#D', [[1, 1]]),
      ],
    )
    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Anna', 1],
        ['Bert', 2],
        ['Cass', 2],
        ['Dana', 4],
      ],
    )
  })

  it('does not share a rank between bases separated only by copies', () => {
    // Same two distinct cards, different spares: Bert really is ahead.
    const rows = baseStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [[1, 1], [2, 1]]), base('#B', [[1, 2], [2, 1]])],
    )
    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Bert', 1],
        ['Anna', 2],
      ],
    )
  })
})

describe('cardsInGridOrder — the same order the grid draws', () => {
  it('is the grid’s own two calls, deck by deck, all sixty', () => {
    const expected = cardCategoriesInOrder().flatMap((category) =>
      cardsInCategory(category).map((card) => card.id),
    )
    assert.deepEqual(
      cardsInGridOrder().map((card) => card.id),
      expected,
    )
    assert.equal(cardsInGridOrder().length, 60)
  })

  it('groups each deck into one unbroken run, as the tiles do', () => {
    const runs: string[] = []
    for (const card of cardsInGridOrder()) {
      if (runs[runs.length - 1] !== card.category) runs.push(card.category)
    }
    assert.deepEqual(runs, cardCategoriesInOrder())
  })
})

describe('cardTotals — the counts move, the order does not', () => {
  it('adds every base’s copies together', () => {
    const totals = cardTotals([base('#A', [[1, 3]]), base('#B', [[1, 2]]), base('#C', [[2, 1]])])
    assert.equal(totals.find((entry) => entry.card.id === 1)?.total, 5)
    assert.equal(totals.find((entry) => entry.card.id === 2)?.total, 1)
  })

  it('counts a base with only a text-label owner like any other — the caller passes them all', () => {
    // There is nothing in here that can distinguish an unlinked base from a linked
    // one, which is the point: the filtering decision is the caller's and this
    // function cannot silently drop half the group.
    const totals = cardTotals([base('#unlinked', [[1, 4]])])
    assert.equal(totals.find((entry) => entry.card.id === 1)?.total, 4)
  })

  it('returns one entry per card, in the order handed in, whatever the counts', () => {
    const cards = cardsInGridOrder()
    // The last card in the list holds the most copies, the first holds none — a
    // count-sorted list would put them the other way round.
    const heaviest = cards[cards.length - 1]!
    const totals = cardTotals([base('#A', [[heaviest.id, 9]])], cards)
    assert.deepEqual(
      totals.map((entry) => entry.card.id),
      cards.map((card) => card.id),
    )
    assert.equal(totals[0]?.total, 0)
    assert.equal(totals[totals.length - 1]?.total, 9)
  })

  it('marks a card nobody holds without moving it', () => {
    const cards = cardsInGridOrder()
    const totals = cardTotals([base('#A', [[cards[1]!.id, 1]])], cards)
    assert.equal(totals[0]?.absent, true)
    assert.equal(totals[1]?.absent, false)
    // Position is untouched: entry n is still card n.
    assert.equal(totals[0]?.card.id, cards[0]?.id)
    assert.equal(totals[1]?.card.id, cards[1]?.id)
  })

  it('reports the whole list absent when no base has been entered', () => {
    const totals = cardTotals([])
    assert.equal(totals.length, 60)
    assert.ok(totals.every((entry) => entry.absent && entry.total === 0))
  })

  it('drops counts the grid would drop too, rather than inventing a row for them', () => {
    const totals = cardTotals([base('#A', [[999, 4], [1, 0], [2, 2]])])
    assert.equal(totals.length, 60)
    assert.equal(totals.find((entry) => entry.card.id === 1)?.total, 0)
    assert.equal(totals.find((entry) => entry.card.id === 2)?.total, 2)
  })
})
