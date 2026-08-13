import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import {
  activeOwnerFilter,
  ALL_OWNERS,
  baseStandings,
  cardPoints,
  cardsInGridOrder,
  cardTotals,
  filterStandingsByOwner,
  lastUpdatedCell,
  standingOwnerOptions,
  type StandingBase,
} from './card-standings.ts'
import { ALL_CARDS, cardCategoriesInOrder, cardsInCategory } from './cards.ts'
import { UNASSIGNED_OWNER } from './saved-table.ts'

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

/*
 * The filter now keys on the account id, not the label — see `Ownable` in
 * `card-standings.ts`. Fixtures still name an owner by a string, so this hands out a
 * stable id per label the first time it is seen, the same account across every base
 * that names the same person. A test that needs two *different* accounts sharing one
 * display name, or an unlinked legacy label, passes `ownerUserId` explicitly instead
 * of leaving it to be derived.
 */
let nextOwnerId = 1
const ownerIds = new Map<string, number>()
function ownerId(owner: string): number {
  let id = ownerIds.get(owner)
  if (id === undefined) {
    id = nextOwnerId
    nextOwnerId += 1
    ownerIds.set(owner, id)
  }
  return id
}

function named(
  tag: string,
  label: string,
  owner: string | null = null,
  ownerUserId?: number | null,
): StandingBase {
  return {
    tag,
    label,
    owner,
    ownerUserId: owner === null ? null : ownerUserId !== undefined ? ownerUserId : ownerId(owner),
  }
}

/** A save stamp, in the ISO form the server sends. */
const STAMP = '2026-08-02T09:30:00.000Z'

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

/*
 * A four-base board with two owners and one base nobody is assigned to, scored so that
 * every base holds a rank of its own: Anna 27, Bert 19, Cass 10, Dana nothing.
 * Anna and Cass are the same owner's and are deliberately *not* adjacent — filtering to
 * them has to produce 1 and 3, and it cannot do that by accident. Two of the four carry
 * a save stamp and two do not, which is the mix the Last updated column has to read
 * down.
 */
function board() {
  return baseStandings(
    [
      named('#A', 'Anna', 'Rae'),
      named('#B', 'Bert', 'Sam'),
      named('#C', 'Cass', 'Rae'),
      named('#D', 'Dana', null),
    ],
    [base('#A', [[1, 3]], STAMP), base('#B', [[1, 2]], STAMP), base('#C', [[1, 1]])],
  )
}

describe('baseStandings — when the counts were last saved', () => {
  it('carries the stamp through, so the board can say how stale a base is', () => {
    const [row] = baseStandings([named('#A', 'Anna')], [base('#A', [[1, 1]], STAMP)])
    assert.equal(row?.updatedAt, STAMP)
  })

  it('reports no stamp as null rather than undefined, because absent is a state', () => {
    // A base nobody has ever saved, and a base with counts the store has no row for:
    // both are "Never" on the board, and neither may reach a date formatter.
    const rows = baseStandings([named('#A', 'Anna'), named('#B', 'Bert')], [base('#B', [[1, 1]])])
    assert.equal(rows.find((row) => row.label === 'Anna')?.updatedAt, null)
    assert.equal(rows.find((row) => row.label === 'Bert')?.updatedAt, null)
  })

  it('keeps the stamp of a base cleared back to zero, which is the one worth having', () => {
    // Migration v5 gave the stamp its own table for exactly this: the counts are
    // sparse, so an emptied base has no rows left to derive a date from.
    const [row] = baseStandings([named('#A', 'Anna')], [base('#A', [], STAMP)])
    assert.equal(row?.updatedAt, STAMP)
    assert.equal(row?.recorded, true)
  })
})

describe('filterStandingsByOwner — the rank is the whole board’s, not the filter’s', () => {
  it('keeps each base’s standing among every tracked base, not 1 upwards', () => {
    /* The one column on this board that carries meaning. Renumbering an owner's bases
       1, 2, 3 would make a leaderboard of one out of a slice of the clan's. */
    const filtered = filterStandingsByOwner(board(), String(ownerId('Rae')))
    assert.deepEqual(
      filtered.map((row) => [row.label, row.rank]),
      [
        ['Anna', 1],
        ['Cass', 3],
      ],
    )
  })

  it('holds the shared rank of a tie even when only one side of it survives', () => {
    // Bert and Cass are level, so both are rank 2 and Dana is 4. Filtered to Cass's
    // owner alone, Cass is still 2 — a rank says how many bases are ahead, and three
    // of them being hidden does not move anybody up.
    const rows = baseStandings(
      [
        named('#A', 'Anna', 'Rae'),
        named('#B', 'Bert', 'Sam'),
        named('#C', 'Cass', 'Ivy'),
        named('#D', 'Dana', 'Sam'),
      ],
      [base('#A', [[1, 3]]), base('#B', [[1, 1]]), base('#C', [[2, 1]])],
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
    assert.deepEqual(
      filterStandingsByOwner(rows, String(ownerId('Ivy'))).map((row) => [row.label, row.rank]),
      [['Cass', 2]],
    )
  })

  it('returns the whole board for the everyone default, in the same order', () => {
    const rows = board()
    assert.deepEqual(
      filterStandingsByOwner(rows, ALL_OWNERS).map((row) => row.label),
      rows.map((row) => row.label),
    )
  })

  it('finds the bases no account and no label owns, under the sentinel', () => {
    assert.deepEqual(
      filterStandingsByOwner(board(), UNASSIGNED_OWNER).map((row) => [row.label, row.rank]),
      [['Dana', 4]],
    )
  })

  it('folds an unlinked legacy label in with the truly unassigned, since neither has an account id', () => {
    // Dave's label was never matched to an account, so `ownerUserId` is null exactly
    // like Dana's base with no assignment at all — the deliberate narrowing `Ownable`
    // documents: one definition of "is this my base" everywhere, not a label match here
    // and an id match everywhere else.
    const rows = baseStandings(
      [named('#A', 'Anna', 'Dave', null), named('#B', 'Bert', null)],
      [],
    )
    assert.deepEqual(
      filterStandingsByOwner(rows, UNASSIGNED_OWNER).map((row) => row.label),
      ['Anna', 'Bert'],
    )
  })

  it('keeps two accounts with the same display name apart, since the id decides sameness', () => {
    // A real if rare case a label comparison could not tell apart: two different
    // accounts that happen to share a display name.
    const rows = baseStandings(
      [named('#A', 'Anna', 'Sam', 101), named('#B', 'Bert', 'Sam', 202)],
      [],
    )
    assert.deepEqual(
      filterStandingsByOwner(rows, '101').map((row) => row.label),
      ['Anna'],
    )
    assert.deepEqual(
      filterStandingsByOwner(rows, '202').map((row) => row.label),
      ['Bert'],
    )
  })

  it('narrows to nothing for an owner who is not on the board, rather than to everything', () => {
    // The select cannot offer this, but a filter that fell back to "everybody" on a
    // value it did not recognize would be a filter that silently stopped filtering.
    // A non-numeric value parses to `NaN`, which matches no row's `ownerUserId` either.
    assert.deepEqual(filterStandingsByOwner(board(), 'Nobody'), [])
  })
})

describe('standingOwnerOptions — built from the owners actually on the board', () => {
  it('opens on everyone, then lists the owners in name order', () => {
    assert.deepEqual(standingOwnerOptions(board()), [
      { value: ALL_OWNERS, label: 'Everyone' },
      { value: UNASSIGNED_OWNER, label: 'No owner set' },
      { value: String(ownerId('Rae')), label: 'Rae' },
      { value: String(ownerId('Sam')), label: 'Sam' },
    ])
  })

  it('offers the unowned option only when a base on the board has no owner', () => {
    /* Every option has to keep at least one row: one that could only ever empty the
       board is a control that answers a press by doing nothing. */
    const owned = baseStandings([named('#A', 'Anna', 'Rae'), named('#B', 'Bert', 'Sam')], [])
    assert.deepEqual(
      standingOwnerOptions(owned).map((option) => option.value),
      [ALL_OWNERS, String(ownerId('Rae')), String(ownerId('Sam'))],
    )
  })

  it('folds an unlinked legacy label into the unassigned option, not one of its own', () => {
    // `mayWriteBaseCounts` still separates `ownerNotLinked` from `unowned` for
    // *permission*, but this select now answers a different question — grouping by
    // `ownerUserId` — and an unlinked label has none, the same as no assignment at all.
    const rows = baseStandings([named('#A', 'Anna', 'Dave', null), named('#B', 'Bert', null)], [])
    assert.deepEqual(
      standingOwnerOptions(rows).map((option) => option.value),
      [ALL_OWNERS, UNASSIGNED_OWNER],
    )
  })

  it('names one owner once, however many bases they hold', () => {
    const rows = baseStandings([named('#A', 'Anna', 'Rae'), named('#B', 'Bert', 'Rae')], [])
    assert.deepEqual(
      standingOwnerOptions(rows).map((option) => option.value),
      [ALL_OWNERS, String(ownerId('Rae'))],
    )
  })

  it('lists two accounts sharing a display name as two options, the label unaffected', () => {
    const rows = baseStandings(
      [named('#A', 'Anna', 'Sam', 301), named('#B', 'Bert', 'Sam', 302)],
      [],
    )
    assert.deepEqual(standingOwnerOptions(rows), [
      { value: ALL_OWNERS, label: 'Everyone' },
      { value: '301', label: 'Sam' },
      { value: '302', label: 'Sam' },
    ])
  })
})

describe('activeOwnerFilter — a chosen owner who has left the board', () => {
  it('keeps a choice the board can still offer', () => {
    const options = standingOwnerOptions(board())
    const sam = String(ownerId('Sam'))
    assert.equal(activeOwnerFilter(options, sam), sam)
    assert.equal(activeOwnerFilter(options, UNASSIGNED_OWNER), UNASSIGNED_OWNER)
  })

  it('falls back to everyone when the owner is no longer on it', () => {
    /* The board is re-read every ten seconds. An owner whose last base was
       reassigned would otherwise leave a select showing a value it has no option for,
       over an empty table. */
    const options = standingOwnerOptions(board())
    assert.equal(activeOwnerFilter(options, 'Gone'), ALL_OWNERS)
  })
})

describe('lastUpdatedCell — “Never” is a state, not a formatting accident', () => {
  const relative = () => '5 days ago'
  const exact = (date: Date) => date.toISOString()

  it('says Never for a base nobody has ever saved', () => {
    const cell = lastUpdatedCell(null, relative, exact)
    assert.equal(cell.never, true)
    assert.equal(cell.text, 'Never')
    // Nothing to expand, so the cell must not offer a tooltip over an empty string.
    assert.equal(cell.exact, null)
  })

  it('reads the age off the stamp and keeps the exact moment for the tooltip', () => {
    const cell = lastUpdatedCell(STAMP, relative, exact)
    assert.equal(cell.never, false)
    assert.equal(cell.text, '5 days ago')
    assert.equal(cell.exact, STAMP)
  })

  it('prints a stamp that is not a date at all rather than Invalid Date', () => {
    // The same call `parseStamp` exists to make, and the same choice the attribution
    // line above the grid makes with this value: the base *was* saved, so "Never"
    // would be the worse answer of the two.
    const cell = lastUpdatedCell('the other day', relative, exact)
    assert.equal(cell.never, false)
    assert.equal(cell.text, 'the other day')
    assert.equal(cell.exact, null)
  })

  it('gives every base on a board a cell, with the never ones told apart', () => {
    /* The column has to read down cleanly: no blanks, no `Invalid Date`, and the one
       state worth spotting distinguishable by something other than its wording. */
    const cells = board().map((row) => lastUpdatedCell(row.updatedAt, relative, exact))
    assert.deepEqual(
      cells.map((cell) => cell.text),
      ['5 days ago', '5 days ago', 'Never', 'Never'],
    )
    assert.deepEqual(
      cells.map((cell) => cell.never),
      [false, false, true, true],
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
