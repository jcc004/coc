import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MIN_TRADEABLE_COUNT, type BaseInventory } from '@coc/shared'
import { basesNeeding, cardDemand, cardHolders } from './card-holders.ts'
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

describe('cardDemand', () => {
  it('counts a reporting base with no row for the card as needing it', () => {
    /* The whole point, and the thing sparse storage makes easy to get wrong: `#BBB`
       reported, holds no Barbarian, and therefore has no Barbarian row at all. An
       implementation looking for a row whose count is 0 finds none and answers
       "nobody needs one", which is both wrong and the reading a screenshot agrees
       with. */
    const demand = cardDemand(
      [base('#AAA', [[BARBARIAN, 2]]), base('#BBB', [[ARCHER, 1]])],
      BARBARIAN,
    )

    assert.deepEqual(demand, { reporting: 2, needing: 1 })
  })

  it('counts a base saved and then cleared to nothing as reporting, and needing every card', () => {
    /* An emptied base keeps its stamp and comes back from the server with no counts —
       see `empties a base to zero cards but keeps its stamp` in the server suite. It
       has told us it holds nothing, which is an answer, so it reports and it needs. */
    const emptied: BaseInventory = { tag: '#CCC', counts: [], updatedAt: '2026-08-04T10:00:00Z' }

    assert.deepEqual(cardDemand([base('#AAA', [[BARBARIAN, 1]]), emptied], BARBARIAN), {
      reporting: 2,
      needing: 1,
    })
    assert.deepEqual(cardDemand([emptied], ARCHER), { reporting: 1, needing: 1 })
  })

  it('treats a stored zero and an unknown id as needing it, exactly as the grid does', () => {
    const demand = cardDemand(
      [base('#AAA', [[BARBARIAN, 0]]), base('#BBB', [[9999, 4]])],
      BARBARIAN,
    )

    assert.deepEqual(demand, { reporting: 2, needing: 2 })
  })

  it('adds up: the bases holding it plus the ones needing it are every reporting base', () => {
    /* The line prints all three numbers side by side, so a reader will do this sum.
       Asserted rather than guaranteed by subtraction — `cardDemand` scans, so the two
       can drift and this is what would catch it. */
    const inventory = [
      base('#AAA', [[BARBARIAN, 3]]),
      base('#BBB', [[ARCHER, 2]]),
      base('#CCC', [[BARBARIAN, 1]]),
      base('#ZZZ', []),
    ]

    const { reporting, needing } = cardDemand(inventory, BARBARIAN)

    assert.equal(cardHolders(inventory, BARBARIAN, labelOf).length + needing, reporting)
  })

  it('counts an empty inventory as nobody reporting, not as everybody needing it', () => {
    // What the panel is handed on the render before the store has loaded.
    assert.deepEqual(cardDemand([], BARBARIAN), { reporting: 0, needing: 0 })
  })
})

describe('basesNeeding', () => {
  it('excludes a base holding a copy', () => {
    const rows = basesNeeding([base('#AAA', [[BARBARIAN, 1]])], BARBARIAN, labelOf)

    assert.deepEqual(rows, [])
  })

  it('includes a base with no row for the card at all — the sparse-storage case', () => {
    /* The whole point, and the case most worth its own test: a base that reported and
       holds none of this card has no row for it anywhere, because a count of 0 deletes
       the row rather than being stored as one. A check for `count === 0` would find
       nothing here and answer "nobody needs it", which is both wrong and the reading a
       screenshot of the stored data would agree with. */
    const rows = basesNeeding(
      [base('#AAA', [[BARBARIAN, 2]]), base('#BBB', [[ARCHER, 1]])],
      BARBARIAN,
      labelOf,
    )

    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#BBB'],
    )
  })

  it('excludes a base that has not reported this season at all', () => {
    /* Mirrors `cardDemand`'s own `reporting` rule: a base nobody has entered has not
       told us it lacks the card, so it must never show up as "needing" one. Passing
       only the bases that *did* report — the same `bases` prop `CardHolders` is handed
       — is what keeps an unreported base out; there is no separate flag to check. */
    const reportingOnly = [base('#AAA', [[ARCHER, 1]])]

    const rows = basesNeeding(reportingOnly, BARBARIAN, labelOf)

    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AAA'],
    )
    assert.ok(!rows.some((row) => row.tag === '#ZZZ'))
  })

  it('orders by label then tag, the same total order cardHolders uses', () => {
    const rows = basesNeeding(
      [base('#ZZZ', []), base('#BBB', []), base('#AAA', [])],
      BARBARIAN,
      labelOf,
    )

    // `#ZZZ` first: no roster names it, so its label is its tag and `#` sorts ahead of
    // a letter, exactly as `cardHolders`' own ordering test explains.
    assert.deepEqual(
      rows.map((row) => row.label),
      ['#ZZZ', 'Alda', 'Brix'],
    )
  })

  it('comes back empty when every base holds it', () => {
    const rows = basesNeeding(
      [base('#AAA', [[BARBARIAN, 1]]), base('#BBB', [[BARBARIAN, 3]])],
      BARBARIAN,
      labelOf,
    )

    assert.deepEqual(rows, [])
  })

  it('comes back empty, not a throw, for an empty inventory', () => {
    assert.deepEqual(basesNeeding([], BARBARIAN, labelOf), [])
  })

  it('names the bases it counts the same way cardHolders and cardDemand do', () => {
    // The three functions read one truth off `countMap`: a holder, a needer or neither,
    // never both — asserted directly rather than trusted by inspection.
    const inventory = [
      base('#AAA', [[BARBARIAN, 3]]),
      base('#BBB', [[ARCHER, 2]]),
      base('#CCC', [[BARBARIAN, 0]]),
    ]

    const holders = cardHolders(inventory, BARBARIAN, labelOf)
    const needers = basesNeeding(inventory, BARBARIAN, labelOf)
    const { reporting, needing } = cardDemand(inventory, BARBARIAN)

    assert.equal(needers.length, needing)
    assert.equal(holders.length + needers.length, reporting)
    assert.deepEqual(
      needers.map((row) => row.tag).sort(),
      ['#BBB', '#CCC'],
    )
  })
})
