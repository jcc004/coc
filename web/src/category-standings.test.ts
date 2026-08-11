import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { cardPoints, type StandingBase } from './card-standings.ts'
import { cardsInCategory } from './cards.ts'
import { categoryStandings } from './category-standings.ts'

/*
 * Real card ids, matching `card-standings.test.ts`'s fixture: an invented id would
 * be dropped by `countMap` and every assertion would read zero. From the manifest
 * (`cards.generated.ts`): 1–19 are Elixir, 20–32 Dark Elixir, 33–43 Builder Base,
 * 44–60 Super Troop.
 */
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

describe('categoryStandings — a deck only counts its own cards', () => {
  it('does not let a base’s Elixir cards leak into its Dark Elixir ranking', () => {
    // Anna: three Elixir cards, nothing in Dark Elixir. Bert: one Dark Elixir card.
    const bases = [named('#A', 'Anna'), named('#B', 'Bert')]
    const inventory = [
      base('#A', [[1, 5], [2, 5], [3, 5]]),
      base('#B', [[20, 1]]),
    ]
    const rankings = categoryStandings(bases, inventory)

    const anna = rankings['Dark Elixir'].find((row) => row.label === 'Anna')
    const bert = rankings['Dark Elixir'].find((row) => row.label === 'Bert')
    assert.equal(anna?.points, 0)
    assert.equal(anna?.distinct, 0)
    assert.equal(bert?.points, cardPoints(1))
    assert.equal(bert?.distinct, 1)

    // The same base's Elixir board sees the Elixir cards and only those.
    const annaElixir = rankings.Elixir.find((row) => row.label === 'Anna')
    assert.equal(annaElixir?.points, cardPoints(5) * 3)
    assert.equal(annaElixir?.distinct, 3)
    const bertElixir = rankings.Elixir.find((row) => row.label === 'Bert')
    assert.equal(bertElixir?.points, 0)
    assert.equal(bertElixir?.distinct, 0)
  })

  it('scores every deck for a base that only holds cards in one of them', () => {
    // Cass holds only Builder Base cards. Every other deck must still produce a
    // row for her — zero, not a missing entry.
    const bases = [named('#C', 'Cass')]
    const inventory = [base('#C', [[33, 4], [34, 2]])]
    const rankings = categoryStandings(bases, inventory)

    assert.equal(rankings['Builder Base'][0]?.points, cardPoints(4) + cardPoints(2))
    assert.equal(rankings['Builder Base'][0]?.distinct, 2)

    for (const deck of ['Elixir', 'Dark Elixir', 'Super Troop'] as const) {
      const [row] = rankings[deck]
      assert.equal(row?.points, 0, deck)
      assert.equal(row?.distinct, 0, deck)
    }
  })

  it('does not throw for a base with nothing recorded at all', () => {
    const rankings = categoryStandings([named('#A', 'Anna')], [])
    for (const deck of ['Elixir', 'Dark Elixir', 'Builder Base', 'Super Troop'] as const) {
      assert.equal(rankings[deck][0]?.points, 0)
      assert.equal(rankings[deck][0]?.distinct, 0)
    }
  })
})

describe('categoryStandings — the deck size a fraction is drawn from', () => {
  it('carries each deck’s own size, matching the manifest', () => {
    const rankings = categoryStandings([named('#A', 'Anna')], [])
    assert.equal(rankings.Elixir[0]?.size, cardsInCategory('Elixir').length)
    assert.equal(rankings['Dark Elixir'][0]?.size, cardsInCategory('Dark Elixir').length)
    assert.equal(rankings['Builder Base'][0]?.size, cardsInCategory('Builder Base').length)
    assert.equal(rankings['Super Troop'][0]?.size, cardsInCategory('Super Troop').length)
  })
})

describe('categoryStandings — the order is total, within one deck', () => {
  /*
   * The same points-vs-distinct tie `card-standings.test.ts` uses, confined to the
   * Elixir deck: 54 is reachable both as one card held nine times (10+9+...+2) and
   * as two cards held three times each (27+27) — same score, different breadth. Both
   * routes tie on points, so this only pins that distinct still decides between them
   * — it does not on its own distinguish a distinct-first sort from a points-first
   * one broken by distinct, which is what the next test is for.
   */
  it('breaks a points tie on distinct, descending', () => {
    const bases = [named('#A', 'Anna'), named('#B', 'Bert')]
    const inventory = [base('#A', [[1, 9]]), base('#B', [[1, 3], [2, 3]])]
    const rows = categoryStandings(bases, inventory).Elixir

    assert.equal(rows[0]?.points, 54)
    assert.equal(rows[1]?.points, 54)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[0]?.distinct, 2)
    assert.equal(rows[1]?.distinct, 1)
  })

  /*
   * The actual reported bug, 2026-08-11: on the live Elixir board, a base with 18 of
   * 19 cards but several stacked spares (higher points) outranked a base holding all
   * 19 (lower points, one copy each). Distinct must lead points even when points
   * disagree outright, not merely when they tie — the test above alone would not have
   * caught this, since it only exercises a points tie.
   */
  it('ranks a fully-held deck above a higher-scoring incomplete one', () => {
    const bases = [named('#A', 'Complete'), named('#B', 'Hoarder')]
    const inventory = [
      // One copy each of all 19 Elixir cards: distinct 19, points 19 * cardPoints(1).
      base(
        '#A',
        Array.from({ length: 19 }, (_, index) => [index + 1, 1] as [number, number]),
      ),
      // Nine copies each of 18 of the 19: distinct 18, but far more points.
      base(
        '#B',
        Array.from({ length: 18 }, (_, index) => [index + 1, 9] as [number, number]),
      ),
    ]
    const rows = categoryStandings(bases, inventory).Elixir

    const complete = rows.find((row) => row.label === 'Complete')!
    const hoarder = rows.find((row) => row.label === 'Hoarder')!
    assert.equal(complete.distinct, 19)
    assert.equal(hoarder.distinct, 18)
    assert.ok(hoarder.points > complete.points, 'fixture must reproduce the reported bug')
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Complete', 'Hoarder'],
    )
  })

  it('breaks a full points-and-distinct tie by member name', () => {
    const bases = [named('#A', 'Zack'), named('#B', 'Anna')]
    const inventory = [base('#A', [[4, 1]]), base('#B', [[5, 1]])]
    const rows = categoryStandings(bases, inventory).Elixir

    assert.equal(rows[0]?.points, rows[1]?.points)
    assert.equal(rows[0]?.distinct, rows[1]?.distinct)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Zack'],
    )
  })

  it('falls through to the tag when two bases in the same deck share a name too', () => {
    const bases = [named('#ZZ', 'darek'), named('#AA', 'darek')]
    const inventory = [base('#AA', [[6, 1]]), base('#ZZ', [[7, 1]])]
    const rows = categoryStandings(bases, inventory).Elixir

    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })

  it('shares a rank on a genuine distinct tie within one deck, and skips the number it consumes', () => {
    // Bert (cards 1,2 held three each) and Diane (cards 3,4 held one each) both hold
    // 2 distinct Elixir cards, at very different points (54 vs 20) — rank is on
    // distinct, so they share rank 1 regardless, and Anna (1 distinct) reads 3, not 2.
    const bases = [named('#A', 'Anna'), named('#B', 'Bert'), named('#D', 'Diane')]
    const inventory = [
      base('#A', [[1, 1]]),
      base('#B', [[1, 3], [2, 3]]),
      base('#D', [[3, 1], [4, 1]]),
    ]
    const rows = categoryStandings(bases, inventory).Elixir

    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Bert', 1],
        ['Diane', 1],
        ['Anna', 3],
      ],
    )
  })

  it('does not share a rank on a points tie when distinct differs', () => {
    // Anna (one card, nine copies) and Bert (two cards, three copies each) land on
    // the same points by two different routes — distinct still tells them apart for
    // ranking purposes even when points alone would suggest a tie.
    const bases = [named('#A', 'Anna'), named('#B', 'Bert')]
    const inventory = [base('#A', [[1, 9]]), base('#B', [[1, 3], [2, 3]])]
    const rows = categoryStandings(bases, inventory).Elixir

    assert.equal(rows[0]?.points, rows[1]?.points)
    assert.notEqual(rows[0]?.rank, rows[1]?.rank)
    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Bert', 1],
        ['Anna', 2],
      ],
    )
  })

  it('ranks each deck on its own standing, independently of the others', () => {
    // Anna leads Elixir (2 distinct cards to Bert's 1) but trails Dark Elixir (1 to
    // Bert's 2) — her rank in one deck must not leak into the other, the same
    // property the ordering test above pins for the sort. Distinct differs outright
    // in both decks (no tie to fall through to points for), so this pins rank on the
    // new primary key rather than incidentally passing via the points tiebreak.
    const bases = [named('#A', 'Anna'), named('#B', 'Bert')]
    const inventory = [
      base('#A', [[1, 1], [2, 1], [20, 1]]),
      base('#B', [[1, 1], [20, 1], [21, 1]]),
    ]
    const rankings = categoryStandings(bases, inventory)

    assert.deepEqual(
      rankings.Elixir.map((row) => [row.label, row.rank]),
      [
        ['Anna', 1],
        ['Bert', 2],
      ],
    )
    assert.deepEqual(
      rankings['Dark Elixir'].map((row) => [row.label, row.rank]),
      [
        ['Bert', 1],
        ['Anna', 2],
      ],
    )
  })

  it('reorders independently deck by deck: the Elixir order need not match Dark Elixir’s', () => {
    // Anna is ahead in Elixir but behind in Dark Elixir — each deck's list has to
    // reflect its own scores, not one base's overall standing. Same fixture as the
    // rank test above.
    const bases = [named('#A', 'Anna'), named('#B', 'Bert')]
    const inventory = [
      base('#A', [[1, 1], [2, 1], [20, 1]]),
      base('#B', [[1, 1], [20, 1], [21, 1]]),
    ]
    const rankings = categoryStandings(bases, inventory)

    assert.deepEqual(
      rankings.Elixir.map((row) => row.label),
      ['Anna', 'Bert'],
    )
    assert.deepEqual(
      rankings['Dark Elixir'].map((row) => row.label),
      ['Bert', 'Anna'],
    )
  })
})
