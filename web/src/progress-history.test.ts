import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MaxLevelReferenceRow, ProgressSnapshot, UnitLevel } from '@coc/shared'
import {
  buildCategorySeries,
  buildThUpgrades,
  buildTroopHeatmap,
  buildTroopPercentSeries,
  buildWallsSeries,
} from './progress-history.ts'

function unit(name: string, level: number): UnitLevel {
  return { name, level, maxLevel: 999 }
}

function ref(
  category: MaxLevelReferenceRow['category'],
  name: string,
  thLevel: number,
  maxLevel: number,
): MaxLevelReferenceRow {
  return { category, name, thLevel, maxLevel, updatedAt: '2026-08-01T00:00:00.000Z' }
}

function snapshot(overrides: Partial<ProgressSnapshot> & { weekStart: string }): ProgressSnapshot {
  return {
    playerTag: '#TESTBASE',
    thLevel: null,
    heroes: null,
    equipment: null,
    pets: null,
    troops: null,
    spells: null,
    walls: null,
    buildingsLeft: null,
    notes: null,
    autoNote: null,
    capturedBy: 'auto',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildCategorySeries', () => {
  it('sorts weeks ascending regardless of input order, and aligns points to them', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-11', heroes: [unit('Barbarian King', 80)] }),
      snapshot({ weekStart: '2026-08-04', heroes: [unit('Barbarian King', 78)] }),
    ]
    const result = buildCategorySeries(snapshots, 'hero')
    assert.deepEqual(result.weeks, ['2026-08-04', '2026-08-11'])
    assert.deepEqual(result.series, [{ name: 'Barbarian King', points: [78, 80] }])
  })

  it('skips weeks where the category was never captured', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', heroes: [unit('Barbarian King', 78)] }),
      snapshot({ weekStart: '2026-08-11', heroes: null }),
    ]
    const result = buildCategorySeries(snapshots, 'hero')
    assert.deepEqual(result.weeks, ['2026-08-04'])
  })

  it('leaves a gap (null), not a zero, for a unit not yet unlocked at an earlier week', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', heroes: [unit('Barbarian King', 78)] }),
      snapshot({
        weekStart: '2026-08-11',
        heroes: [unit('Barbarian King', 79), unit('Archer Queen', 60)],
      }),
    ]
    const result = buildCategorySeries(snapshots, 'hero')
    const queen = result.series.find((series) => series.name === 'Archer Queen')
    assert.deepEqual(queen?.points, [null, 60])
  })

  it('excludes Super Troops from the troop category', () => {
    const snapshots = [
      snapshot({
        weekStart: '2026-08-04',
        troops: [unit('Barbarian', 10), unit('Super Barbarian', 5)],
      }),
    ]
    const result = buildCategorySeries(snapshots, 'troop')
    assert.deepEqual(
      result.series.map((series) => series.name),
      ['Barbarian'],
    )
  })

  it('does not exclude a non-troop unit that happens to share a Super Troop name pattern', () => {
    // Sanity check that exclusion is scoped to category === 'troop'.
    const snapshots = [snapshot({ weekStart: '2026-08-04', spells: [unit('Rage Spell', 5)] })]
    const result = buildCategorySeries(snapshots, 'spell')
    assert.deepEqual(
      result.series.map((series) => series.name),
      ['Rage Spell'],
    )
  })

  it('returns empty weeks and series when nothing was ever captured', () => {
    const result = buildCategorySeries([], 'pet')
    assert.deepEqual(result, { weeks: [], series: [] })
  })
})

describe('buildWallsSeries', () => {
  it('treats a level missing from a later week as a real zero, not a gap', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', walls: { '13': 10, '14': 5 } }),
      // Every level-13 wall got upgraded to 14 — 13 drops out of the map.
      snapshot({ weekStart: '2026-08-11', walls: { '14': 15 } }),
    ]
    const result = buildWallsSeries(snapshots)
    const level13 = result.series.find((series) => series.name === '13')
    assert.deepEqual(level13?.points, [10, 0])
  })

  it('orders series numerically by level, not lexically', () => {
    const snapshots = [snapshot({ weekStart: '2026-08-04', walls: { '9': 1, '14': 1, '2': 1 } })]
    const result = buildWallsSeries(snapshots)
    assert.deepEqual(
      result.series.map((series) => series.name),
      ['2', '9', '14'],
    )
  })

  it('skips weeks with no wall entry at all', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', walls: { '13': 10 } }),
      snapshot({ weekStart: '2026-08-11', walls: null }),
    ]
    const result = buildWallsSeries(snapshots)
    assert.deepEqual(result.weeks, ['2026-08-04'])
  })
})

describe('buildTroopPercentSeries', () => {
  it('scores against the TH-relative cap for that same week', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10)]
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 12, troops: [unit('Barbarian', 5)] }),
    ]
    const result = buildTroopPercentSeries(snapshots, reference)
    assert.deepEqual(result.weeks, ['2026-08-04'])
    assert.equal(result.points[0], 50)
  })

  it('excludes Super Troops from the aggregate', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10)]
    const snapshots = [
      snapshot({
        weekStart: '2026-08-04',
        thLevel: 12,
        troops: [unit('Barbarian', 10), unit('Super Barbarian', 1)],
      }),
    ]
    const result = buildTroopPercentSeries(snapshots, reference)
    // If the Super Troop leaked in unscored, percent would come out under 100
    // (its level 1 has no reference row so it would be excluded from the
    // denominator too — but only checking the covered/total shape here would
    // miss a leak, so assert the clean 100% a Barbarian-only capture gives).
    assert.equal(result.points[0], 100)
  })

  it('skips a week with troops but no TH capture — nothing to score against', () => {
    const snapshots = [snapshot({ weekStart: '2026-08-04', thLevel: null, troops: [unit('Barbarian', 5)] })]
    const result = buildTroopPercentSeries(snapshots, [])
    assert.deepEqual(result.weeks, [])
  })

  it('degrades to a single point rather than crashing on one week of real data', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10)]
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 12, troops: [unit('Barbarian', 5)] }),
    ]
    const result = buildTroopPercentSeries(snapshots, reference)
    assert.equal(result.weeks.length, 1)
    assert.equal(result.points.length, 1)
  })
})

describe('buildThUpgrades', () => {
  it('emits an event only where the level actually increased between two captured weeks', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 16 }),
      snapshot({ weekStart: '2026-08-11', thLevel: 16 }), // no change — no event
      snapshot({ weekStart: '2026-08-18', thLevel: 17 }),
    ]
    const result = buildThUpgrades(snapshots)
    assert.deepEqual(result, [{ from: 16, to: 17, weekStart: '2026-08-18' }])
  })

  it('skips weeks with no TH capture rather than treating them as a drop or a jump', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 16 }),
      snapshot({ weekStart: '2026-08-11', thLevel: null }),
      snapshot({ weekStart: '2026-08-18', thLevel: 17 }),
    ]
    const result = buildThUpgrades(snapshots)
    assert.deepEqual(result, [{ from: 16, to: 17, weekStart: '2026-08-18' }])
  })

  it('reports nothing for a level that only ever drops (an account merge, a bad capture)', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 17 }),
      snapshot({ weekStart: '2026-08-11', thLevel: 16 }),
    ]
    const result = buildThUpgrades(snapshots)
    assert.deepEqual(result, [])
  })

  it('returns an ordered list across several upgrades, oldest first', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-18', thLevel: 18 }),
      snapshot({ weekStart: '2026-08-04', thLevel: 16 }),
      snapshot({ weekStart: '2026-08-11', thLevel: 17 }),
    ]
    const result = buildThUpgrades(snapshots)
    assert.deepEqual(result, [
      { from: 16, to: 17, weekStart: '2026-08-11' },
      { from: 17, to: 18, weekStart: '2026-08-18' },
    ])
  })

  it('returns nothing for one week or no history at all — nothing to compare against', () => {
    assert.deepEqual(buildThUpgrades([]), [])
    assert.deepEqual(buildThUpgrades([snapshot({ weekStart: '2026-08-04', thLevel: 16 })]), [])
  })
})

describe('buildTroopHeatmap', () => {
  it('builds one row per troop and one column per scoreable week', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10), ref('troop', 'Archer', 12, 8)]
    const snapshots = [
      snapshot({
        weekStart: '2026-08-04',
        thLevel: 12,
        troops: [unit('Barbarian', 5), unit('Archer', 4)],
      }),
      snapshot({ weekStart: '2026-08-11', thLevel: 12, troops: [unit('Barbarian', 10)] }),
    ]
    const result = buildTroopHeatmap(snapshots, reference)
    assert.deepEqual(result.weeks, ['2026-08-04', '2026-08-11'])
    assert.deepEqual(result.troopNames, ['Archer', 'Barbarian'])

    const archerRow = result.matrix[result.troopNames.indexOf('Archer')]
    const barbarianRow = result.matrix[result.troopNames.indexOf('Barbarian')]
    assert.deepEqual(archerRow, [50, null])
    assert.deepEqual(barbarianRow, [50, 100])
  })

  it('is a legitimate single-column matrix when only one week has real troop data', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10)]
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', thLevel: 12, troops: [unit('Barbarian', 5)] }),
    ]
    const result = buildTroopHeatmap(snapshots, reference)
    assert.equal(result.weeks.length, 1)
    assert.deepEqual(result.matrix, [[50]])
  })

  it('excludes Super Troops from the rows', () => {
    const reference = [ref('troop', 'Barbarian', 12, 10)]
    const snapshots = [
      snapshot({
        weekStart: '2026-08-04',
        thLevel: 12,
        troops: [unit('Barbarian', 5), unit('Super Barbarian', 1)],
      }),
    ]
    const result = buildTroopHeatmap(snapshots, reference)
    assert.deepEqual(result.troopNames, ['Barbarian'])
  })

  it('returns an empty matrix, not a crash, with no troop history at all', () => {
    const result = buildTroopHeatmap([], [])
    assert.deepEqual(result, { weeks: [], troopNames: [], matrix: [] })
  })
})
