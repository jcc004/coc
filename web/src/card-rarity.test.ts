import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CardTotal } from './card-standings.ts'
import { cardsInGridOrder, cardTotals } from './card-standings.ts'
import { cardRarity, rarityPoints, RARITY_TIER_COUNT } from './card-rarity.ts'
import { ALL_CARDS } from './cards.ts'

/** A `CardTotal` fixture from just an id and a total — the fields `cardRarity`
 *  actually reads, without constructing a whole `BaseInventory`. */
function total(cardId: number, total: number): CardTotal {
  const card = ALL_CARDS.find((c) => c.id === cardId)
  if (!card) throw new Error(`no such card ${cardId}`)
  return { card, total, absent: total === 0 }
}

describe('cardRarity', () => {
  it('splits sixty cards into ten tiers of six, rarest first', () => {
    const totals = ALL_CARDS.map((card) => total(card.id, card.id)) // strictly increasing
    const rarity = cardRarity(totals)

    const byTier = new Map<number, number>()
    for (const { tier } of rarity.values()) byTier.set(tier, (byTier.get(tier) ?? 0) + 1)

    assert.equal(rarity.size, 60)
    assert.deepEqual([...byTier.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    for (const count of byTier.values()) assert.equal(count, 6)
  })

  it('gives the rarest tier the highest points, stepping down by 4 to a floor of 4', () => {
    const totals = ALL_CARDS.map((card) => total(card.id, card.id))
    const rarity = cardRarity(totals)

    // Card 1 has the lowest total (1), so it is tier 1 — the rarest.
    assert.deepEqual(rarity.get(1), { tier: 1, points: 40 })
    // Card 60 has the highest total, so it is tier 10 — the most common.
    assert.deepEqual(rarity.get(60), { tier: 10, points: 4 })
  })

  it('breaks a tied total by card id, deterministically', () => {
    // Every card tied at the same total: id order is the only thing left to sort by.
    const totals = ALL_CARDS.map((card) => total(card.id, 5))
    const rarity = cardRarity(totals)

    assert.equal(rarity.get(1)?.tier, 1) // lowest id, first tier
    assert.equal(rarity.get(60)?.tier, 10) // highest id, last tier
    // Run it again — the boundary must land in the same place every time, not
    // depend on `Array.sort`'s stability for equal keys across two calls.
    assert.deepEqual(cardRarity(totals), rarity)
  })

  it('reproduces the exact ten-tier boundaries the app was designed against', () => {
    // The clan's real clan-wide totals on 2026-08-08, the day this feature was
    // designed and the ten-tier boundaries were reviewed and approved against
    // them. Pinning the real numbers here means a change to the tiering algorithm
    // has to be a deliberate choice, not a silent drift.
    const realTotals: Record<number, number> = {
      51: 8, 54: 9, 48: 11, 37: 12, 46: 12, 53: 12, 35: 13, 49: 13, 56: 13, 57: 13,
      59: 13, 23: 14, 24: 15, 36: 15, 44: 15, 47: 15, 43: 16, 50: 16, 52: 16, 27: 17,
      41: 17, 58: 17, 6: 17, 14: 18, 29: 18, 32: 18, 33: 18, 42: 18, 55: 18, 34: 19,
      45: 19, 1: 20, 28: 20, 38: 20, 11: 21, 20: 21, 21: 21, 19: 22, 25: 22, 26: 22,
      30: 22, 39: 22, 40: 22, 60: 22, 31: 24, 13: 25, 16: 25, 22: 25, 4: 25, 15: 26,
      5: 26, 7: 26, 10: 27, 9: 27, 12: 28, 8: 29, 17: 33, 2: 33, 18: 35, 3: 36,
    }
    const rarity = cardRarity(Object.entries(realTotals).map(([id, n]) => total(Number(id), n)))

    for (const id of [51, 54, 48, 37, 46, 53]) {
      assert.equal(rarity.get(id)?.tier, 1, `card ${id} should be the rarest tier`)
    }
    for (const id of [12, 8, 17, 2, 18, 3]) {
      assert.equal(rarity.get(id)?.tier, RARITY_TIER_COUNT, `card ${id} should be the most common tier`)
    }
  })

  it('never throws on a card id it was not asked about', () => {
    const rarity = cardRarity(ALL_CARDS.map((card) => total(card.id, 1)))
    assert.equal(rarityPoints(rarity, 9999), 0)
  })

  it('stays a bounded, ten-tier split against real cardTotals() output too', () => {
    // `cardTotals()` with no bases is every card at total 0 — every card ties, and
    // the tiebreak (card id) is the only thing separating them. This is the shape
    // `cardRarity` gets called with for real, through the same pipe the totals
    // grid already uses.
    const rarity = cardRarity(cardTotals([], cardsInGridOrder()))
    assert.equal(rarity.size, 60)
    assert.equal(rarity.get(ALL_CARDS[0]!.id)?.tier, 1)
  })
})
