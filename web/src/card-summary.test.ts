import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory, CardCategory } from '@coc/shared'
import { summariseBase } from './card-summary.ts'

/*
 * The same toy deck `card-trades.test.ts` uses, for the same reason: the rules are
 * about counts and categories, not about which sixty cards the event shipped. Two
 * Elixir, two Dark Elixir, one Super Troop, and id 9 deliberately has no category.
 */
const CATEGORY: Record<number, CardCategory> = {
  1: 'Elixir',
  2: 'Elixir',
  3: 'Dark Elixir',
  4: 'Dark Elixir',
  5: 'Super Troop',
}

const categoryOf = (id: number): CardCategory | undefined => CATEGORY[id]

function base(
  tag: string,
  counts: Record<number, number>,
  updatedAt?: string,
): BaseInventory {
  return {
    tag,
    counts: Object.entries(counts).map(([cardId, count]) => ({ cardId: Number(cardId), count })),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** `Elixir 2/3` style, so a whole summary line can be asserted in one string. */
function decks(summary: ReturnType<typeof summariseBase>): string[] {
  return summary.byCategory.map(
    (entry) => `${entry.category} ${entry.distinct}/${entry.total}/${entry.spares}`,
  )
}

describe('summariseBase — a base with nothing recorded', () => {
  it('reads as unrecorded when no base row exists, not as zeroes', () => {
    const summary = summariseBase('#AAA', [base('#BBB', { 1: 2 })], categoryOf)

    assert.equal(summary.recorded, false)
    assert.equal(summary.total, 0)
    assert.equal(summary.distinct, 0)
    assert.equal(summary.hasTrades, false)
    // Every deck is still reported, so the panel can print all four at zero once
    // there *is* something recorded.
    assert.deepEqual(decks(summary), [
      'Elixir 0/0/0',
      'Dark Elixir 0/0/0',
      'Builder Base 0/0/0',
      'Super Troop 0/0/0',
    ])
  })

  it('reads as recorded when a base was saved and then cleared to zero', () => {
    // No count rows survive a clear-out, but the stamp does — somebody checked
    // this base, which is a different fact from nobody ever having entered it.
    const summary = summariseBase('#AAA', [base('#AAA', {}, '2026-08-01T00:00:00Z')], categoryOf)

    assert.equal(summary.recorded, true)
    assert.equal(summary.total, 0)
  })

  it('reads as unrecorded for a tag that could never name a base', () => {
    const summary = summariseBase('!!', [base('#AAA', { 1: 2 })], categoryOf)

    assert.equal(summary.recorded, false)
    assert.deepEqual(summary.tradePartners, [])
  })
})

describe('summariseBase — counting per deck', () => {
  it('counts cards, copies and spares in the deck each card belongs to', () => {
    const summary = summariseBase(
      '#AAA',
      [base('#AAA', { 1: 3, 2: 1, 3: 2, 5: 4 })],
      categoryOf,
    )

    assert.deepEqual(decks(summary), [
      // Two Elixir cards, four copies, two of them spare.
      'Elixir 2/4/2',
      'Dark Elixir 1/2/1',
      'Builder Base 0/0/0',
      'Super Troop 1/4/3',
    ])
    assert.equal(summary.distinct, 4)
    assert.equal(summary.total, 10)
    assert.equal(summary.spares, 6)
  })

  it('leaves the other decks at zero when only one deck is held', () => {
    const summary = summariseBase('#AAA', [base('#AAA', { 3: 2, 4: 1 })], categoryOf)

    assert.deepEqual(decks(summary), [
      'Elixir 0/0/0',
      'Dark Elixir 2/3/1',
      'Builder Base 0/0/0',
      'Super Troop 0/0/0',
    ])
    assert.equal(summary.recorded, true)
    assert.equal(summary.distinct, 2)
  })

  it('reports the decks asked for, in the order asked for', () => {
    const summary = summariseBase('#AAA', [base('#AAA', { 1: 2 })], categoryOf, [
      'Super Troop',
      'Elixir',
    ])

    assert.deepEqual(decks(summary), ['Super Troop 0/0/0', 'Elixir 1/2/1'])
  })

  it('ignores counts that cannot mean a holding, and cards it cannot place', () => {
    const summary = summariseBase(
      '#AAA',
      [{ tag: '#AAA', counts: [
        { cardId: 1, count: 0 },
        { cardId: 2, count: -3 },
        { cardId: 3, count: 1.5 },
        // No category, so no deck can show it.
        { cardId: 9, count: 4 },
        // Repeated: the larger value wins, as in the trade engine.
        { cardId: 5, count: 1 },
        { cardId: 5, count: 3 },
      ] }],
      categoryOf,
    )

    assert.deepEqual(decks(summary), [
      'Elixir 0/0/0',
      'Dark Elixir 0/0/0',
      'Builder Base 0/0/0',
      'Super Troop 1/3/2',
    ])
    assert.equal(summary.total, 3)
  })

  it('matches a tag however it was written in the URL', () => {
    const summary = summariseBase('2gcj2qpu', [base('#2GCJ2QPU', { 1: 2 })], categoryOf)
    assert.equal(summary.recorded, true)
    assert.equal(summary.total, 2)
  })
})

describe('summariseBase — whether a trade is waiting', () => {
  it('finds no trade for a base holding spares with no counterpart', () => {
    // #AAA has two Elixir spares, but #BBB holds one of each already (rule 2)
    // and its own spare is in another deck (rule 3).
    const summary = summariseBase(
      '#AAA',
      [base('#AAA', { 1: 2, 2: 3 }), base('#BBB', { 1: 1, 2: 1, 3: 2 })],
      categoryOf,
    )

    assert.equal(summary.spares, 3, 'it does have something to give')
    assert.equal(summary.hasTrades, false, 'but nobody can give it anything back')
    assert.deepEqual(summary.tradePartners, [])
  })

  it('finds no trade for a base whose only copies are its last ones', () => {
    const summary = summariseBase(
      '#AAA',
      [base('#AAA', { 1: 1 }), base('#BBB', { 2: 2 })],
      categoryOf,
    )

    assert.equal(summary.hasTrades, false)
  })

  it('finds the trade when a genuine swap exists, and names the partner', () => {
    const summary = summariseBase(
      '#AAA',
      [
        base('#AAA', { 1: 2 }),
        // Holds an Elixir spare #AAA lacks, and lacks the one #AAA can give.
        base('#BBB', { 2: 2 }),
        // Same deck but nothing spare, so not a partner.
        base('#CCC', { 2: 1 }),
      ],
      categoryOf,
    )

    assert.equal(summary.hasTrades, true)
    assert.deepEqual(summary.tradePartners, ['#BBB'])
  })

  it('lists every partner once, in tag order, however the bases arrived', () => {
    const summary = summariseBase(
      '#BBB',
      [base('#CCC', { 2: 2 }), base('#BBB', { 1: 2 }), base('#AAA', { 2: 4 })],
      categoryOf,
    )

    assert.deepEqual(summary.tradePartners, ['#AAA', '#CCC'])
  })

  it('never counts the base itself as its own partner', () => {
    const summary = summariseBase(
      '#AAA',
      // The same tag twice is one base, however it got into the list.
      [base('#AAA', { 1: 2 }), base('#AAA', { 2: 2 })],
      categoryOf,
    )

    assert.equal(summary.hasTrades, false)
  })

  it('will not cross decks to make a trade', () => {
    const summary = summariseBase(
      '#AAA',
      [base('#AAA', { 1: 2 }), base('#BBB', { 3: 2 })],
      categoryOf,
    )

    assert.equal(summary.hasTrades, false, 'Elixir cannot be swapped for Dark Elixir')
  })
})
