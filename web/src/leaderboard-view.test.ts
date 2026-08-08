import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cardCategoriesInOrder } from './cards.ts'
import {
  LEADERBOARD_VIEWS,
  parseLeaderboardCategory,
  parseLeaderboardView,
} from './leaderboard-view.ts'

describe('LEADERBOARD_VIEWS — the picker’s seven options', () => {
  it('offers exactly these seven, in this order', () => {
    assert.deepEqual(
      LEADERBOARD_VIEWS.map((option) => option.value),
      ['overall', 'rarity', 'category', 'rows', 'decks', 'spares', 'traders'],
    )
  })

  it('labels them exactly as agreed, not a paraphrase', () => {
    assert.deepEqual(
      LEADERBOARD_VIEWS.map((option) => option.label),
      ['Overall', 'Rarity', 'By category', 'Full rows', 'Full decks', 'Spares on hand', 'Most active trader'],
    )
  })
})

describe('parseLeaderboardView', () => {
  it('reads back a stored, still-offered value', () => {
    assert.equal(parseLeaderboardView('rarity'), 'rarity')
    assert.equal(parseLeaderboardView('traders'), 'traders')
  })

  it('falls back to overall for nothing stored', () => {
    assert.equal(parseLeaderboardView(null), 'overall')
  })

  it('falls back to overall for a value no longer offered, rather than throwing', () => {
    assert.equal(parseLeaderboardView('points'), 'overall')
    assert.equal(parseLeaderboardView('{"view":"rarity"}'), 'overall')
  })
})

describe('parseLeaderboardCategory', () => {
  const [first, second] = cardCategoriesInOrder()

  it('reads back a stored, currently-offered category', () => {
    assert.equal(parseLeaderboardCategory(second!), second)
  })

  it('defaults to the first category in grid order for nothing stored', () => {
    assert.equal(parseLeaderboardCategory(null), first)
  })

  it('defaults to the first category for an unrecognized value, rather than throwing', () => {
    assert.equal(parseLeaderboardCategory('Not A Deck'), first)
  })
})
