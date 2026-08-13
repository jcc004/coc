import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory } from '@coc/shared'
import { deckCompletionStandings } from './deck-completion-standings.ts'
import { ALL_CARDS, cardsInCategory } from './cards.ts'

/*
 * Real card ids, matching `card-standings.test.ts`'s own fixture note: both this
 * module and the one it is modeled on go through `countMap`, which drops
 * anything the generated list does not know, so an invented id would be
 * silently thrown away. Builder Base (33–43, 11 cards) is the smallest deck, so
 * it is the one a fixture actually finishes without listing all sixty ids.
 */
function base(tag: string, cardIds: readonly number[], updatedAt?: string): BaseInventory {
  return {
    tag,
    counts: cardIds.map((cardId) => ({ cardId, count: 1 })),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/** Same as `base()`, but every card held twice — for the doubled-deck tests. */
function doubledBase(tag: string, cardIds: readonly number[]): BaseInventory {
  return { tag, counts: cardIds.map((cardId) => ({ cardId, count: 2 })) }
}

function named(tag: string, label: string) {
  return { tag, label, owner: null, ownerUserId: null }
}

const BUILDER_BASE = cardsInCategory('Builder Base').map((card) => card.id)
const ELIXIR = cardsInCategory('Elixir').map((card) => card.id)
const DARK_ELIXIR = cardsInCategory('Dark Elixir').map((card) => card.id)
const SUPER_TROOP = cardsInCategory('Super Troop').map((card) => card.id)

describe('deckCompletionStandings — the count', () => {
  it('credits a base that finished exactly one deck, and says which one', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna')],
      // The whole Builder Base deck, plus two Elixir cards that do not finish it.
      [base('#A', [...BUILDER_BASE, ELIXIR[0]!, ELIXIR[1]!])],
    )
    assert.equal(rows[0]?.completedCount, 1)
    assert.deepEqual(rows[0]?.completedDecks, ['Builder Base'])
  })

  it('credits a base holding nothing, and one holding a partial spread, with zero', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#B', [ELIXIR[0]!, DARK_ELIXIR[0]!, BUILDER_BASE[0]!])],
    )
    const anna = rows.find((row) => row.label === 'Anna')
    const bert = rows.find((row) => row.label === 'Bert')
    assert.equal(anna?.completedCount, 0)
    assert.deepEqual(anna?.completedDecks, [])
    assert.equal(bert?.completedCount, 0)
    assert.deepEqual(bert?.completedDecks, [])
  })

  it('credits a base that finished all four decks, holding the full sixty', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna')],
      [base('#A', ALL_CARDS.map((card) => card.id))],
    )
    assert.equal(rows[0]?.completedCount, 4)
    assert.deepEqual(rows[0]?.completedDecks, ['Elixir', 'Dark Elixir', 'Builder Base', 'Super Troop'])
  })

  it('does not credit a deck missing even one card', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna')],
      // Every Builder Base card but the last.
      [base('#A', BUILDER_BASE.slice(0, -1))],
    )
    assert.equal(rows[0]?.completedCount, 0)
    assert.deepEqual(rows[0]?.completedDecks, [])
  })

  it('keeps a base with no inventory row on the board, at zero, rather than dropping it', () => {
    const rows = deckCompletionStandings([named('#A', 'Anna')], [])
    assert.equal(rows[0]?.completedCount, 0)
    assert.deepEqual(rows[0]?.completedDecks, [])
  })
})

describe('deckCompletionStandings — the order is total, because ties are the common case', () => {
  it('ranks a base with more finished decks above one with fewer', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', BUILDER_BASE), base('#B', [ELIXIR[0]!])],
    )
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Anna', 'Bert'],
    )
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 2)
  })

  /*
   * Both finish Builder Base (completedCount 1 each), so the count alone cannot
   * separate them. Bert holds more cards elsewhere — closer to a second deck —
   * so the distinct-overall tiebreak has to put Bert first.
   */
  it('breaks a tie on completed-deck count with distinct cards overall', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [
        base('#A', BUILDER_BASE),
        base('#B', [...BUILDER_BASE, ...ELIXIR.slice(0, 5)]),
      ],
    )
    assert.equal(rows[0]?.completedCount, 1)
    assert.equal(rows[1]?.completedCount, 1)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.equal(rows[0]?.distinct, BUILDER_BASE.length + 5)
    assert.equal(rows[1]?.distinct, BUILDER_BASE.length)

    // Completed-deck count alone decides the rank, same as `baseStandings`'s
    // points: Bert and Anna have not out-finished one another, so they share
    // rank 1 even though the tiebreak orders Bert first on the page.
    assert.equal(rows[0]?.rank, 1)
    assert.equal(rows[1]?.rank, 1)
  })

  it('shares a rank, and skips the number it consumes, on a genuine tie', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass')],
      [base('#A', BUILDER_BASE), base('#B', BUILDER_BASE)],
    )
    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Anna', 1],
        ['Bert', 1],
        ['Cass', 3],
      ],
    )
  })

  it('breaks a full tie by member name, so the list cannot reshuffle', () => {
    const bases = [named('#C', 'Zack'), named('#A', 'Anna'), named('#B', 'Mia')]
    const first = deckCompletionStandings(bases, []).map((row) => row.label)
    const second = deckCompletionStandings([...bases].reverse(), []).map((row) => row.label)
    assert.deepEqual(first, ['Anna', 'Mia', 'Zack'])
    assert.deepEqual(second, first)
  })

  it('falls through to the tag when two bases share a name as well as a score', () => {
    const rows = deckCompletionStandings(
      [named('#ZZ', 'darek'), named('#AA', 'darek')],
      [base('#AA', SUPER_TROOP), base('#ZZ', SUPER_TROOP)],
    )
    assert.deepEqual(
      rows.map((row) => row.tag),
      ['#AA', '#ZZ'],
    )
  })
})

describe('deckCompletionStandings — doubled decks', () => {
  it('does not credit a deck as doubled just for being complete', () => {
    const rows = deckCompletionStandings([named('#A', 'Anna')], [base('#A', BUILDER_BASE)])
    assert.equal(rows[0]?.completedCount, 1)
    assert.equal(rows[0]?.doubledCount, 0)
    assert.deepEqual(rows[0]?.doubledDecks, [])
  })

  it('credits a deck as doubled once every one of its cards is held at least twice', () => {
    const rows = deckCompletionStandings([named('#A', 'Anna')], [doubledBase('#A', BUILDER_BASE)])
    assert.equal(rows[0]?.completedCount, 1)
    assert.equal(rows[0]?.doubledCount, 1)
    assert.deepEqual(rows[0]?.doubledDecks, ['Builder Base'])
  })

  it('does not call a deck doubled while even one of its cards is held only once', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna')],
      [
        {
          tag: '#A',
          counts: [
            ...BUILDER_BASE.slice(0, -1).map((cardId) => ({ cardId, count: 2 })),
            { cardId: BUILDER_BASE[BUILDER_BASE.length - 1]!, count: 1 },
          ],
        },
      ],
    )
    assert.equal(rows[0]?.completedCount, 1)
    assert.equal(rows[0]?.doubledCount, 0)
  })

  /*
   * Both finish Builder Base outright (completedCount 1 each), so that alone
   * cannot separate them — but Bert has doubled it and Anna has not, which now
   * decides ahead of the distinct-overall tiebreak below it.
   */
  it('breaks a completed-deck tie with doubled-deck count, ahead of distinct cards', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert')],
      [base('#A', [...BUILDER_BASE, ...ELIXIR.slice(0, 5)]), doubledBase('#B', BUILDER_BASE)],
    )
    assert.equal(rows[0]?.completedCount, 1)
    assert.equal(rows[1]?.completedCount, 1)
    // Anna has more distinct cards overall (BUILDER_BASE + 5 Elixir) than Bert
    // (Builder Base only), so distinct alone would put Anna first — doubled
    // must be checked first for Bert to still lead.
    assert.ok((rows.find((row) => row.label === 'Anna')?.distinct ?? 0) > BUILDER_BASE.length)
    assert.deepEqual(
      rows.map((row) => row.label),
      ['Bert', 'Anna'],
    )
    assert.notEqual(rows[0]?.rank, rows[1]?.rank)
  })

  it('shares a rank between two bases doubled on the same deck', () => {
    const rows = deckCompletionStandings(
      [named('#A', 'Anna'), named('#B', 'Bert'), named('#C', 'Cass')],
      [doubledBase('#A', BUILDER_BASE), doubledBase('#B', BUILDER_BASE), base('#C', BUILDER_BASE)],
    )
    assert.deepEqual(
      rows.map((row) => [row.label, row.rank]),
      [
        ['Anna', 1],
        ['Bert', 1],
        ['Cass', 3],
      ],
    )
  })
})

describe('deckCompletionStandings — hygiene shared with countMap', () => {
  it('ignores counts the grid would not draw either', () => {
    // An id outside 1–60 and a non-positive count are both absences.
    const rows = deckCompletionStandings(
      [named('#A', 'Anna')],
      [
        {
          tag: '#A',
          counts: [
            ...BUILDER_BASE.slice(0, -1).map((cardId) => ({ cardId, count: 1 })),
            { cardId: 999, count: 5 },
            { cardId: BUILDER_BASE[BUILDER_BASE.length - 1]!, count: 0 },
          ],
        },
      ],
    )
    assert.equal(rows[0]?.completedCount, 0)
  })
})
