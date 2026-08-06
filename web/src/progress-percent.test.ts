import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MaxLevelReferenceRow, UnitLevel, WallReferenceRow } from '@coc/shared'
import { percentToMax, wallProgress } from './progress-percent.ts'

function ref(
  category: MaxLevelReferenceRow['category'],
  name: string,
  thLevel: number,
  maxLevel: number,
): MaxLevelReferenceRow {
  return { category, name, thLevel, maxLevel, updatedAt: '2026-08-01T00:00:00.000Z' }
}

function wallRef(thLevel: number, maxWallLevel: number, totalWallCount: number): WallReferenceRow {
  return { thLevel, maxWallLevel, totalWallCount, updatedAt: '2026-08-01T00:00:00.000Z' }
}

function unit(name: string, level: number): UnitLevel {
  // maxLevel here is the API's absolute game-max, deliberately not read by
  // percentToMax — the reference table is what decides the TH-relative cap.
  return { name, level, maxLevel: 999 }
}

describe('percentToMax — a unit the reference table knows', () => {
  it('scores level over the TH-relative cap, not the API max', () => {
    const reference = [ref('hero', 'Barbarian King', 17, 95)]
    const result = percentToMax([unit('Barbarian King', 76)], 'hero', 17, reference)
    assert.equal(result.units[0]?.maxForTh, 95)
    assert.equal(result.units[0]?.percent, (76 / 95) * 100)
    assert.equal(result.covered, 1)
    assert.equal(result.atMax, 0)
  })

  it('counts a unit at its cap as maxed', () => {
    const reference = [ref('hero', 'Barbarian King', 17, 95)]
    const result = percentToMax([unit('Barbarian King', 95)], 'hero', 17, reference)
    assert.equal(result.units[0]?.percent, 100)
    assert.equal(result.atMax, 1)
  })
})

describe('percentToMax — a unit absent from the reference table', () => {
  it('leaves maxForTh and percent null rather than coercing to 0 or 100', () => {
    const result = percentToMax([unit('Unlisted Hero', 10)], 'hero', 17, [])
    assert.equal(result.units[0]?.maxForTh, null)
    assert.equal(result.units[0]?.percent, null)
  })

  it('excludes it from the aggregate, with the gap visible in covered vs total', () => {
    const reference = [ref('hero', 'Barbarian King', 17, 95)]
    const result = percentToMax(
      [unit('Barbarian King', 95), unit('Not Yet Scraped', 40)],
      'hero',
      17,
      reference,
    )
    // The covered unit is fully maxed; if the uncovered one were coerced to 0%
    // the aggregate would come out under 100.
    assert.equal(result.percent, 100)
    assert.equal(result.covered, 1)
    assert.equal(result.total, 2)
  })

  it('reports the aggregate as null when nothing in the set has a reference row', () => {
    const result = percentToMax([unit('Ghost', 1)], 'hero', 17, [])
    assert.equal(result.percent, null)
    assert.equal(result.covered, 0)
  })

  it('matches on category and Town Hall as well as name', () => {
    // Same name, wrong TH and wrong category: neither should match.
    const reference = [ref('hero', 'Barbarian King', 16, 90), ref('pet', 'Barbarian King', 17, 10)]
    const result = percentToMax([unit('Barbarian King', 76)], 'hero', 17, reference)
    assert.equal(result.units[0]?.maxForTh, null)
  })
})

describe('percentToMax — an aggregate over a mixed set', () => {
  it('sums level and cap only across the covered units', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10), ref('troop', 'Archer', 12, 10)]
    const result = percentToMax(
      [unit('Barbarian', 5), unit('Archer', 10), unit('Wall Breaker', 3)],
      'troop',
      12,
      reference,
    )
    // (5 + 10) / (10 + 10) = 75%, Wall Breaker excluded entirely.
    assert.equal(result.percent, 75)
    assert.equal(result.covered, 2)
    assert.equal(result.total, 3)
    assert.equal(result.atMax, 1)
  })

  it('returns an empty result for an empty unit list', () => {
    const result = percentToMax([], 'spell', 12, [])
    assert.deepEqual(result.units, [])
    assert.equal(result.percent, null)
    assert.equal(result.total, 0)
  })
})

describe('wallProgress — a Town Hall with no wall reference row at all', () => {
  it('leaves reference, atMax and percent null, but still reports what was held', () => {
    const result = wallProgress({ '15': 20, '14': 20 }, 17, [wallRef(16, 15, 40)])
    assert.equal(result.reference, null)
    assert.equal(result.atMax, null)
    assert.equal(result.percent, null)
    assert.equal(result.totalHeld, 40)
    assert.deepEqual(
      result.levels.map((l) => l.level).sort(),
      ['14', '15'],
    )
  })
})

describe('wallProgress — a Town Hall with a reference row', () => {
  it('scores walls at the max level against the total wall count', () => {
    const result = wallProgress({ '17': 30, '16': 10 }, 17, [wallRef(17, 17, 40)])
    assert.equal(result.atMax, 30)
    assert.equal(result.percent, 75)
    assert.equal(result.totalHeld, 40)
  })

  it('treats a level not present in walls as zero at max, not as missing data', () => {
    const result = wallProgress({ '16': 40 }, 17, [wallRef(17, 17, 40)])
    assert.equal(result.atMax, 0)
    assert.equal(result.percent, 0)
  })
})
