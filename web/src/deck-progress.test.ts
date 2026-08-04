import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_CATEGORIES, type CardCategory } from '@coc/shared'
import type { CategoryHolding } from './card-summary.ts'
import { deckProgress, deckSizes } from './deck-progress.ts'

/*
 * A toy deck, like `card-summary.test.ts` uses: the arithmetic is about a
 * numerator, a denominator and a clamp, not about which sixty cards the event
 * shipped. The real sixty are checked once, at the bottom, against `deckSizes`.
 */
const SIZES: Record<string, number> = {
  Elixir: 19,
  'Dark Elixir': 13,
  'Builder Base': 11,
  'Super Troop': 17,
}
const sizeOf = (category: CardCategory): number | undefined => SIZES[category]

function holding(category: CardCategory, distinct: number): CategoryHolding {
  // `total` and `spares` are the panel's other numbers; a plaque only reads
  // `distinct`, so they are deliberately set to values it must ignore.
  return { category, distinct, total: distinct * 3 + 1, spares: 99 }
}

describe('deckProgress — the numbers on the plaque', () => {
  it('prints held over deck size, and sizes the bar to match', () => {
    const [elixir] = deckProgress([holding('Elixir', 7)], sizeOf)
    assert.equal(elixir?.fraction, '7/19')
    assert.equal(elixir?.held, 7)
    assert.equal(elixir?.size, 19)
    assert.equal(elixir?.percent, 36.8)
  })

  it('reads `distinct`, not copies — a base with four Minions has collected one card', () => {
    const [deck] = deckProgress([{ category: 'Elixir', distinct: 1, total: 4, spares: 3 }], sizeOf)
    assert.equal(deck?.fraction, '1/19')
  })

  it('is empty, not absent, for a deck this base holds none of', () => {
    const [deck] = deckProgress([holding('Builder Base', 0)], sizeOf)
    assert.equal(deck?.fraction, '0/11')
    assert.equal(deck?.percent, 0)
  })

  it('fills the bar exactly at a complete deck', () => {
    const [deck] = deckProgress([holding('Dark Elixir', 13)], sizeOf)
    assert.equal(deck?.percent, 100)
    assert.equal(deck?.fraction, '13/13')
  })

  it('keeps every deck asked for, in the order asked for', () => {
    const decks = deckProgress(
      CARD_CATEGORIES.map((category) => holding(category, 2)),
      sizeOf,
    )
    assert.deepEqual(
      decks.map((deck) => deck.category),
      [...CARD_CATEGORIES],
    )
  })
})

describe('deckProgress — inputs that must not produce a broken bar', () => {
  it('caps the bar at full rather than overflowing its track', () => {
    // Only reachable if the card list and the counts disagree, which is exactly
    // when a bar wider than its plaque would be the least useful failure.
    const [deck] = deckProgress([holding('Builder Base', 25)], sizeOf)
    assert.equal(deck?.percent, 100)
    // The fraction still tells the truth, so the disagreement is visible.
    assert.equal(deck?.fraction, '25/11')
  })

  it('treats a deck it has no size for as empty rather than dropping the plaque', () => {
    const decks = deckProgress([holding('Elixir', 3)], () => undefined)
    assert.equal(decks.length, 1)
    assert.equal(decks[0]?.fraction, '3/0')
    assert.equal(decks[0]?.percent, 0)
  })

  it('never reports a negative bar', () => {
    const [deck] = deckProgress([{ category: 'Elixir', distinct: -2, total: 0, spares: 0 }], sizeOf)
    assert.equal(deck?.percent, 0)
    assert.equal(deck?.held, 0)
  })
})

describe('deckProgress — what a screen reader is given', () => {
  it('speaks the value rather than spelling out the slash', () => {
    const [deck] = deckProgress([holding('Elixir', 7)], sizeOf)
    assert.equal(deck?.fraction, '7/19') // printed
    assert.equal(deck?.spoken, '7 of 19') // announced
  })

  it('names the deck, the count and the total, so the bar is never the only telling', () => {
    const [deck] = deckProgress([holding('Super Troop', 2)], sizeOf)
    assert.equal(deck?.label, 'Super Troop cards: 2 of 17 collected')
    // The visible text is inside the accessible name, case-folded — the
    // label-in-name rule, since the plaque prints the deck and the fraction.
    assert.ok(deck?.label.toLowerCase().includes('super troop'))
  })

  it('hands CSS the deck as a slug, so no color is set from data', () => {
    const decks = deckProgress(
      CARD_CATEGORIES.map((category) => holding(category, 1)),
      sizeOf,
    )
    assert.deepEqual(
      decks.map((deck) => deck.slug),
      ['elixir', 'dark-elixir', 'builder-base', 'super-troop'],
    )
  })
})

describe('deckSizes — the real denominators', () => {
  it('covers all four decks and adds up to the sixty cards the event ships', () => {
    const sizes = deckSizes()
    assert.equal(sizes.size, 4)
    assert.equal([...sizes.values()].reduce((sum, size) => sum + size, 0), 60)
    for (const category of CARD_CATEGORIES) assert.ok((sizes.get(category) ?? 0) > 0)
  })
})
