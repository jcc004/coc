import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_ID_MAX, MAX_CARD_COUNT, type BaseInventory } from '@coc/shared'
import {
  ALL_CARDS,
  cardById,
  cardCategoriesInOrder,
  cardsInCategory,
  categoryOfCard,
  clampCardCount,
  countMap,
  deckSlug,
  holdingsFor,
  inventorySummary,
  isCardId,
  toCardCounts,
} from './cards.ts'

/*
 * The generated list is machine-written, so these assert its *shape* rather than
 * its contents — the things a bad regeneration would break silently: the count,
 * contiguous ids, a category on every card, and both image paths present.
 */
describe('the generated card list', () => {
  it('holds exactly the sixty cards the schema allows', () => {
    assert.equal(ALL_CARDS.length, CARD_ID_MAX)
  })

  it('has contiguous ids from 1, which is what lets the grid treat them as a range', () => {
    assert.deepEqual(
      ALL_CARDS.map((card) => card.id),
      Array.from({ length: CARD_ID_MAX }, (_, index) => index + 1),
    )
  })

  it('gives every card a name and an absolute path into the vendored art', () => {
    for (const card of ALL_CARDS) {
      assert.ok(card.name.trim(), `card ${card.id} needs a name`)
      // Under /coc/, which is the gitignored art tree — so the file may well be
      // absent, but the path must still be one the app could serve.
      assert.match(card.image, /^\/coc\/[\w./-]+\.(webp|png)$/, `card ${card.id} art`)
    }
  })

  /*
   * Two cards *may* share one picture — "Baby Dragon" and "Baby Dragon (Builder)"
   * are one wiki file — so image paths are not unique and must not be treated as
   * an identity. The id is the identity, and the name is what the user reads.
   */
  it('keeps the id as the identity, since two cards can share a picture', () => {
    assert.equal(new Set(ALL_CARDS.map((card) => card.id)).size, ALL_CARDS.length)
  })

  it('spreads them over the four decks the event ships', () => {
    assert.deepEqual(cardCategoriesInOrder(), [
      'Elixir',
      'Dark Elixir',
      'Builder Base',
      'Super Troop',
    ])
    assert.deepEqual(
      cardCategoriesInOrder().map((category) => cardsInCategory(category).length),
      [19, 13, 11, 17],
    )
  })

  it('uses a distinct name for every card, so a grid tile is identifiable without art', () => {
    assert.equal(new Set(ALL_CARDS.map((card) => card.name)).size, ALL_CARDS.length)
  })
})

describe('deckSlug', () => {
  it('turns each category into the attribute value the CSS matches on', () => {
    assert.deepEqual(cardCategoriesInOrder().map(deckSlug), [
      'elixir',
      'dark-elixir',
      'builder-base',
      'super-troop',
    ])
  })

  it('gives every category a distinct slug, so no two decks share a frame', () => {
    const slugs = cardCategoriesInOrder().map(deckSlug)
    assert.equal(new Set(slugs).size, slugs.length)
  })
})

describe('cardById and categoryOfCard', () => {
  it('finds a card by its id', () => {
    assert.equal(cardById(1)?.name, 'Barbarian')
    assert.equal(cardById(CARD_ID_MAX)?.id, CARD_ID_MAX)
  })

  it('returns nothing for an id outside the list rather than the nearest card', () => {
    assert.equal(cardById(0), undefined)
    assert.equal(cardById(CARD_ID_MAX + 1), undefined)
    assert.equal(cardById(-3), undefined)
    assert.equal(categoryOfCard(999), undefined)
  })

  it('gives every real id a category', () => {
    for (const card of ALL_CARDS) assert.equal(categoryOfCard(card.id), card.category)
  })
})

describe('isCardId', () => {
  it('accepts the whole range and nothing outside it', () => {
    assert.equal(isCardId(1), true)
    assert.equal(isCardId(CARD_ID_MAX), true)
    assert.equal(isCardId(0), false)
    assert.equal(isCardId(CARD_ID_MAX + 1), false)
    assert.equal(isCardId(1.5), false)
    assert.equal(isCardId(Number.NaN), false)
  })
})

const inventory = (counts: Record<number, number>): BaseInventory => ({
  tag: '#AAA',
  counts: Object.entries(counts).map(([cardId, count]) => ({ cardId: Number(cardId), count })),
})

describe('countMap', () => {
  it('keeps positive counts for known cards', () => {
    assert.deepEqual([...countMap(inventory({ 1: 2, 5: 1 }))], [
      [1, 2],
      [5, 1],
    ])
  })

  it('drops zero, negative and unknown ids', () => {
    assert.deepEqual([...countMap(inventory({ 1: 0, 2: -1, 999: 4 }))], [])
  })

  it('treats an absent inventory as an empty one', () => {
    assert.deepEqual([...countMap(undefined)], [])
    assert.deepEqual([...countMap({ tag: '#AAA', counts: [] })], [])
  })
})

describe('holdingsFor', () => {
  it('expands the sparse rows to one entry per card, in id order', () => {
    const holdings = holdingsFor(inventory({ 3: 4 }))
    assert.equal(holdings.length, CARD_ID_MAX)
    assert.deepEqual(
      holdings.map((h) => h.card.id),
      ALL_CARDS.map((card) => card.id),
    )
    assert.equal(holdings[2]?.count, 4)
    assert.equal(holdings[0]?.count, 0, 'a card with no row reads as zero')
  })

  it('shows all sixty even for a base with nothing recorded', () => {
    const holdings = holdingsFor(undefined)
    assert.equal(holdings.length, CARD_ID_MAX)
    assert.ok(holdings.every((h) => h.count === 0))
  })
})

describe('toCardCounts', () => {
  it('emits only non-zero counts, ascending by id', () => {
    const counts = new Map([
      [7, 3],
      [2, 1],
      [4, 0],
    ])
    assert.deepEqual(toCardCounts(counts), [
      { cardId: 2, count: 1 },
      { cardId: 7, count: 3 },
    ])
  })

  it('drops an id the card list does not know', () => {
    assert.deepEqual(toCardCounts(new Map([[999, 5]])), [])
  })

  it('round-trips through countMap unchanged', () => {
    const original = inventory({ 1: 2, 9: 5, 60: 1 })
    assert.deepEqual(toCardCounts(countMap(original)), original.counts)
  })
})

describe('clampCardCount', () => {
  it('caps at the maximum rather than letting the server reject it', () => {
    assert.equal(clampCardCount('99'), MAX_CARD_COUNT)
    assert.equal(clampCardCount(String(MAX_CARD_COUNT)), MAX_CARD_COUNT)
  })

  it('floors a negative and an unparseable box at zero', () => {
    assert.equal(clampCardCount('-4'), 0)
    assert.equal(clampCardCount(''), 0)
    assert.equal(clampCardCount('abc'), 0)
  })

  it('passes an ordinary value through', () => {
    assert.equal(clampCardCount('0'), 0)
    assert.equal(clampCardCount('3'), 3)
    // A pasted decimal truncates rather than being refused outright.
    assert.equal(clampCardCount('2.9'), 2)
  })
})

describe('inventorySummary', () => {
  it('counts distinct cards, total copies, and the spares that could be traded', () => {
    assert.deepEqual(inventorySummary(inventory({ 1: 1, 2: 3, 3: 2 })), {
      distinct: 3,
      total: 6,
      duplicates: 3,
    })
  })

  it('counts no spares when nothing is held more than once', () => {
    assert.deepEqual(inventorySummary(inventory({ 1: 1, 2: 1 })), {
      distinct: 2,
      total: 2,
      duplicates: 0,
    })
  })

  it('is all zeroes for a base with nothing recorded', () => {
    assert.deepEqual(inventorySummary(undefined), { distinct: 0, total: 0, duplicates: 0 })
  })
})
