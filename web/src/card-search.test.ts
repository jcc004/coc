import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CardCategory } from '@coc/shared'
import { ALL_CARDS, cardCategoriesInOrder } from './cards.ts'
import type { GeneratedCard } from './cards.ts'
import { cardsInGridOrder } from './card-standings.ts'
import { decksPresent, foldCardName, searchCards } from './card-search.ts'

const names = (cards: readonly GeneratedCard[]) => cards.map((card) => card.name)

describe('foldCardName', () => {
  it('folds case and drops punctuation, so nobody has to type the stops', () => {
    // The live card list really does contain P.E.K.K.A, and nobody types it that way.
    for (const written of ['P.E.K.K.A', 'pekka', 'PEKKA', 'p.e.k.k.a.', 'P E K K A']) {
      assert.equal(foldCardName(written), 'pekka', `for ${JSON.stringify(written)}`)
    }
  })

  it('drops spaces, so "babydragon" finds Baby Dragon', () => {
    assert.equal(foldCardName('Baby Dragon'), 'babydragon')
  })

  it('keeps unicode letters — a card name is data, not an identifier', () => {
    assert.equal(foldCardName('Ünal'), 'ünal')
  })

  it('folds an empty or punctuation-only string to nothing', () => {
    for (const written of ['', '   ', '...', '-', '  .. ']) {
      assert.equal(foldCardName(written), '', `for ${JSON.stringify(written)}`)
    }
  })
})

describe('searchCards', () => {
  const grid = cardsInGridOrder()

  it('is not filtering at all for an empty query', () => {
    // Clearing the box must restore the whole grid without a second code path.
    for (const query of ['', '   ', '.', '--']) {
      const result = searchCards(grid, query)
      assert.equal(result.filtering, false, `for ${JSON.stringify(query)}`)
      assert.equal(result.cards.length, 60)
    }
  })

  it('matches a substring, not only a prefix', () => {
    // Half the reason to search is not remembering which dragon it was.
    const found = names(searchCards(grid, 'dragon').cards)
    assert.deepEqual(found, [
      'Dragon',
      'Baby Dragon',
      'Electro Dragon',
      'Dragon Rider',
      'Baby Dragon (Builder)',
      'Super Dragon',
      'Inferno Dragon',
    ])
  })

  it('finds one card when the name is specific', () => {
    assert.deepEqual(names(searchCards(grid, 'Electro Dragon').cards), ['Electro Dragon'])
  })

  it('finds a punctuated name typed without the punctuation', () => {
    assert.deepEqual(names(searchCards(grid, 'pekka').cards), ['P.E.K.K.A', 'Power P.E.K.K.A'])
  })

  it('ignores case and surrounding space', () => {
    assert.deepEqual(names(searchCards(grid, '  ELECTRO dragon ').cards), ['Electro Dragon'])
  })

  it('spans decks: a name can appear in more than one', () => {
    const found = searchCards(grid, 'barbarian')
    assert.deepEqual(names(found.cards), ['Barbarian', 'Raged Barbarian', 'Super Barbarian'])
    assert.equal(new Set(found.cards.map((c) => c.category)).size, 3)
  })

  it('returns nothing rather than everything when nothing matches', () => {
    const result = searchCards(grid, 'hovercraft')
    assert.deepEqual(result.cards, [])
    assert.equal(result.filtering, true)
    assert.equal(result.total, 60)
  })

  it('**never reorders**: matches come back in grid order', () => {
    // The fixed grid's whole value is that a card's position is stable. Relevance
    // ranking would move a card depending on what was typed.
    for (const query of ['dragon', 'a', 'super', 'e']) {
      const result = searchCards(grid, query)
      const expected = grid.filter((card) => result.cards.includes(card))
      assert.deepEqual(names(result.cards), names(expected), `for ${JSON.stringify(query)}`)
    }
  })

  it('reports the total searched, so the count line can be honest', () => {
    assert.equal(searchCards(grid, 'dragon').total, 60)
    assert.equal(searchCards(grid.slice(0, 10), 'dragon').total, 10)
  })

  it('does not mutate or alias the list it was given', () => {
    const before = names(grid)
    const result = searchCards(grid, '')
    result.cards.length = 0
    assert.deepEqual(names(cardsInGridOrder()), before)
  })

  it('every card is findable by its own exact name', () => {
    // The guarantee that matters: no card is unreachable through search.
    for (const card of ALL_CARDS) {
      const found = searchCards(grid, card.name).cards
      assert.ok(
        found.some((c) => c.id === card.id),
        `${card.name} was not found by its own name`,
      )
    }
  })
})

describe('decksPresent', () => {
  const order = cardCategoriesInOrder()
  const grid = cardsInGridOrder()

  it('lists every deck when nothing is filtered', () => {
    assert.deepEqual(decksPresent(grid, order), order)
  })

  it('drops decks with no matches, so no empty named group is rendered', () => {
    // An empty role="group" with a heading is noise for anything reading the page.
    const found = searchCards(grid, 'pekka').cards
    const decks = decksPresent(found, order)
    assert.ok(decks.length > 0 && decks.length < order.length)
    for (const deck of decks) assert.ok(found.some((card) => card.category === deck))
  })

  it('keeps the given order rather than order of appearance', () => {
    const reversed = [...order].reverse() as CardCategory[]
    assert.deepEqual(decksPresent(grid, reversed), reversed)
  })

  it('answers empty for no cards', () => {
    assert.deepEqual(decksPresent([], order), [])
  })
})
