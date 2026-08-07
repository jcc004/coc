import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MaxLevelReferenceRow, ProgressSnapshot, UnitLevel, WallReferenceRow } from '@coc/shared'
import {
  alignBaseStatSeries,
  buildBaseStatSeries,
  selectTrendBases,
  TREND_STAT_OPTIONS,
  trendStatLabel,
  type TrendReference,
} from './progress-trends.ts'

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

function wallRef(thLevel: number, maxWallLevel: number, totalWallCount: number): WallReferenceRow {
  return { thLevel, maxWallLevel, totalWallCount, updatedAt: '2026-08-01T00:00:00.000Z' }
}

const NO_REFERENCE: TrendReference = { maxLevels: [], walls: [] }

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

describe('buildBaseStatSeries — thLevel', () => {
  it('reads the raw TH level, sorted ascending by week', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-11', thLevel: 17 }),
      snapshot({ weekStart: '2026-08-04', thLevel: 16 }),
    ]
    const result = buildBaseStatSeries(snapshots, 'thLevel', NO_REFERENCE)
    assert.deepEqual(result, { weeks: ['2026-08-04', '2026-08-11'], points: [16, 17] })
  })

  it('skips a week with no TH capture', () => {
    const snapshots = [snapshot({ weekStart: '2026-08-04', thLevel: null })]
    const result = buildBaseStatSeries(snapshots, 'thLevel', NO_REFERENCE)
    assert.deepEqual(result, { weeks: [], points: [] })
  })
})

describe('buildBaseStatSeries — hero:<name>', () => {
  it('reads one hero raw level by exact name', () => {
    const snapshots = [
      snapshot({ weekStart: '2026-08-04', heroes: [unit('Barbarian King', 78), unit('Archer Queen', 60)] }),
    ]
    const result = buildBaseStatSeries(snapshots, 'hero:Archer Queen', NO_REFERENCE)
    assert.deepEqual(result.points, [60])
  })

  it('is null for a week that captured heroes but not this one (not yet unlocked)', () => {
    const snapshots = [snapshot({ weekStart: '2026-08-04', heroes: [unit('Barbarian King', 78)] })]
    const result = buildBaseStatSeries(snapshots, 'hero:Archer Queen', NO_REFERENCE)
    // Week is still included (heroes were captured); the hero itself is absent.
    assert.deepEqual(result.weeks, ['2026-08-04'])
    assert.deepEqual(result.points, [null])
  })
})

describe('buildBaseStatSeries — wallsPercent', () => {
  it('reuses wallProgress against this week\'s own TH', () => {
    const reference: TrendReference = { maxLevels: [], walls: [wallRef(12, 14, 10)] }
    const snapshots = [snapshot({ weekStart: '2026-08-04', thLevel: 12, walls: { '14': 5 } })]
    const result = buildBaseStatSeries(snapshots, 'wallsPercent', reference)
    assert.equal(result.points[0], 50)
  })

  it('is left out of weeks entirely without a TH to score against', () => {
    const snapshots = [snapshot({ weekStart: '2026-08-04', thLevel: null, walls: { '14': 5 } })]
    const result = buildBaseStatSeries(snapshots, 'wallsPercent', NO_REFERENCE)
    assert.deepEqual(result.weeks, [])
  })
})

describe('buildBaseStatSeries — category percent aggregates', () => {
  it('scores troopsPercent against the reference, excluding Super Troops', () => {
    const reference: TrendReference = { maxLevels: [ref('troop', 'Barbarian', 12, 10)], walls: [] }
    const snapshots = [
      snapshot({
        weekStart: '2026-08-04',
        thLevel: 12,
        troops: [unit('Barbarian', 10), unit('Super Barbarian', 1)],
      }),
    ]
    const result = buildBaseStatSeries(snapshots, 'troopsPercent', reference)
    assert.equal(result.points[0], 100)
  })

  it('scores heroesPercent independently of troopsPercent for the same week', () => {
    const reference: TrendReference = { maxLevels: [ref('hero', 'Barbarian King', 12, 50)], walls: [] }
    const snapshots = [snapshot({ weekStart: '2026-08-04', thLevel: 12, heroes: [unit('Barbarian King', 25)] })]
    const result = buildBaseStatSeries(snapshots, 'heroesPercent', reference)
    assert.equal(result.points[0], 50)
  })
})

describe('TREND_STAT_OPTIONS / trendStatLabel', () => {
  it('lists Town Hall first and every hero individually', () => {
    assert.equal(TREND_STAT_OPTIONS[0]?.key, 'thLevel')
    const heroKeys = TREND_STAT_OPTIONS.filter((option) => option.key.startsWith('hero:')).map(
      (option) => option.key,
    )
    assert.equal(heroKeys.length, 6)
  })

  it('has no equipment option — out of scope for this pass', () => {
    assert.equal(
      TREND_STAT_OPTIONS.some((option) => option.key.toLowerCase().includes('equipment')),
      false,
    )
  })

  it('labels a known key and falls back to the raw key for an unknown one', () => {
    assert.equal(trendStatLabel('thLevel'), 'Town Hall')
    // @ts-expect-error deliberately an invalid key, to check the fallback path
    assert.equal(trendStatLabel('not-a-real-stat'), 'not-a-real-stat')
  })
})

describe('selectTrendBases', () => {
  function base(tag: string) {
    return { tag }
  }

  it('reorders the account\'s own bases to the saved order ahead of the cap', () => {
    // Owned order is C, A, B — but the filtered set (whatever order the
    // owner filter handed back) is A, B, C, D, with D belonging to nobody
    // this account's saved order names.
    const items = [base('#A'), base('#B'), base('#C'), base('#D')]
    const result = selectTrendBases(items, ['#C', '#A', '#B'], 10)
    assert.deepEqual(
      result.plotted.map((item) => item.tag),
      ['#C', '#A', '#B', '#D'],
    )
    assert.equal(result.capped, false)
  })

  it('caps the reordered list, keeping the account\'s own bases over everyone else\'s', () => {
    // Two bases this account owns and has ordered (#B before #A), plus two
    // other members' bases (#X, #Y) that arrived first in `items`. A cap of
    // 2 must keep the two owned bases, not the two that happened to sort
    // first before reordering.
    const items = [base('#X'), base('#Y'), base('#A'), base('#B')]
    const result = selectTrendBases(items, ['#B', '#A'], 2)
    assert.deepEqual(
      result.plotted.map((item) => item.tag),
      ['#B', '#A'],
    )
    assert.equal(result.capped, true)
  })

  it('falls back to the existing order, capped, when there is no saved order yet', () => {
    const items = [base('#A'), base('#B'), base('#C')]
    const result = selectTrendBases(items, [], 2)
    assert.deepEqual(
      result.plotted.map((item) => item.tag),
      ['#A', '#B'],
    )
    assert.equal(result.capped, true)
  })

  it('is not capped when the reordered list is exactly at the max', () => {
    const items = [base('#A'), base('#B')]
    const result = selectTrendBases(items, ['#B', '#A'], 2)
    assert.equal(result.capped, false)
  })
})

describe('alignBaseStatSeries', () => {
  it('unions every base\'s weeks and fills gaps with null rather than dropping bases', () => {
    const result = alignBaseStatSeries([
      { tag: '#A', series: { weeks: ['2026-08-04', '2026-08-18'], points: [10, 12] } },
      { tag: '#B', series: { weeks: ['2026-08-11'], points: [20] } },
    ])
    assert.deepEqual(result.weeks, ['2026-08-04', '2026-08-11', '2026-08-18'])
    const baseA = result.series.find((series) => series.tag === '#A')
    const baseB = result.series.find((series) => series.tag === '#B')
    assert.deepEqual(baseA?.points, [10, null, 12])
    assert.deepEqual(baseB?.points, [null, 20, null])
  })

  it('returns an empty axis and no crash for no bases at all', () => {
    assert.deepEqual(alignBaseStatSeries([]), { weeks: [], series: [] })
  })
})
