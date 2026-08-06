import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MaxLevelReferenceRow, ProgressSnapshot, WallReferenceRow } from '@coc/shared'
import { ALL_OWNERS, filterStandingsByOwner, standingOwnerOptions } from './card-standings.ts'
import {
  buildProgressGridRows,
  compareProgressGridRows,
  PROGRESS_GRID_HEROES,
  PROGRESS_GRID_PETS,
  sortProgressGridRows,
  type ProgressGridRow,
} from './progress-grid.ts'
import { UNASSIGNED_OWNER } from './saved-table.ts'

function wallRef(thLevel: number, maxWallLevel: number, totalWallCount: number): WallReferenceRow {
  return { thLevel, maxWallLevel, totalWallCount, updatedAt: '2026-08-01T00:00:00.000Z' }
}

function maxLevelRef(
  category: MaxLevelReferenceRow['category'],
  name: string,
  thLevel: number,
  maxLevel: number,
): MaxLevelReferenceRow {
  return { category, name, thLevel, maxLevel, updatedAt: '2026-08-01T00:00:00.000Z' }
}

function snapshot(overrides: Partial<ProgressSnapshot> & { playerTag: string }): ProgressSnapshot {
  return {
    weekStart: '2026-08-04',
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
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

const labelOf = (tag: string) => `Base ${tag}`
const noOwner = () => undefined
const noOwnerUserId = () => null

describe('buildProgressGridRows', () => {
  it('gives an untracked base a row with every hero and pet blank, not a dash', () => {
    const rows = buildProgressGridRows(
      ['#A', '#B'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A' })],
      [],
      [],
    )
    const untracked = rows.find((row) => row.tag === '#B')
    assert.ok(untracked)
    assert.equal(untracked.tracked, false)
    assert.equal(untracked.thLevel, null)
    assert.equal(untracked.wallsAtMax, null)
    assert.equal(untracked.wallsTotal, null)
    assert.equal(untracked.buildingsLeft, null)
    assert.equal(untracked.notes, '')
    assert.equal(untracked.label, 'Base #B')
    assert.equal(untracked.owner, null)
    for (const hero of PROGRESS_GRID_HEROES) assert.equal(untracked.heroes[hero], null)
    for (const pet of PROGRESS_GRID_PETS) assert.equal(untracked.pets[pet], null)
  })

  it('fills in a level for every hero and pet the base has actually unlocked, and blanks the rest', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [
        snapshot({
          playerTag: '#A',
          thLevel: 17,
          heroes: [
            { name: 'Barbarian King', level: 80, maxLevel: 110 },
            { name: 'Archer Queen', level: 85, maxLevel: 110 },
          ],
          pets: [{ name: 'L.A.S.S.I', level: 10, maxLevel: 15 }],
        }),
      ],
      [],
      [],
    )
    const row = rows[0]
    assert.ok(row)
    assert.equal(row.heroes['Barbarian King'], 80)
    assert.equal(row.heroes['Archer Queen'], 85)
    assert.equal(row.heroes['Grand Warden'], null)
    assert.equal(row.pets['L.A.S.S.I'], 10)
    assert.equal(row.pets['Mighty Yak'], null)
  })

  it('ignores a captured unit that is not one of the fixed columns', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A', thLevel: 17, heroes: [{ name: 'Some Future Hero', level: 1, maxLevel: 1 }] })],
      [],
      [],
    )
    assert.deepEqual(Object.keys(rows[0]?.heroes ?? {}), [...PROGRESS_GRID_HEROES])
  })

  it('scores walls at max against the reference table for the base TH', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A', thLevel: 17, walls: { '17': 24, '16': 6 } })],
      [wallRef(17, 17, 40)],
      [],
    )
    assert.equal(rows[0]?.wallsAtMax, 24)
    assert.equal(rows[0]?.wallsTotal, 40)
  })

  it('leaves walls null when the reference table has no row for this Town Hall', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A', thLevel: 17, walls: { '17': 24 } })],
      [],
      [],
    )
    assert.equal(rows[0]?.wallsAtMax, null)
    assert.equal(rows[0]?.wallsTotal, null)
  })

  it('leaves walls null when this week has no wall entry at all', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A', thLevel: 17 })],
      [wallRef(17, 17, 40)],
      [],
    )
    assert.equal(rows[0]?.wallsAtMax, null)
    assert.equal(rows[0]?.wallsTotal, null)
  })

  it('attaches the owner looked up for the tag, tracked or not, normalizing a missing one to null', () => {
    const ownerOf = (tag: string) => ({ '#A': 'Rae' })[tag]
    const rows = buildProgressGridRows(
      ['#A', '#B'],
      labelOf,
      ownerOf,
      noOwnerUserId,
      [snapshot({ playerTag: '#A' })],
      [],
      [],
    )
    assert.equal(rows.find((row) => row.tag === '#A')?.owner, 'Rae')
    assert.equal(rows.find((row) => row.tag === '#B')?.owner, null)
  })

  it('attaches the linked account id looked up for the tag, the field the owner filter now keys on', () => {
    const ownerUserIdOf = (tag: string) => ({ '#A': 7 })[tag] ?? null
    const rows = buildProgressGridRows(
      ['#A', '#B'],
      labelOf,
      noOwner,
      ownerUserIdOf,
      [snapshot({ playerTag: '#A' })],
      [],
      [],
    )
    assert.equal(rows.find((row) => row.tag === '#A')?.ownerUserId, 7)
    assert.equal(rows.find((row) => row.tag === '#B')?.ownerUserId, null)
  })

  it('marks a hero or pet maxed only at or above its own Town Hall cap, and never without one', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [
        snapshot({
          playerTag: '#A',
          thLevel: 17,
          heroes: [
            { name: 'Barbarian King', level: 95, maxLevel: 110 }, // at the TH17 cap
            { name: 'Archer Queen', level: 90, maxLevel: 110 }, // below it
          ],
          pets: [{ name: 'L.A.S.S.I', level: 15, maxLevel: 15 }], // no reference row for this TH
        }),
      ],
      [],
      [
        maxLevelRef('hero', 'Barbarian King', 17, 95),
        maxLevelRef('hero', 'Archer Queen', 17, 110),
      ],
    )
    const row = rows[0]
    assert.ok(row)
    assert.equal(row.heroesMaxed['Barbarian King'], true)
    assert.equal(row.heroesMaxed['Archer Queen'], false)
    // Grand Warden was never captured at all — nothing to be "at the cap" of.
    assert.equal(row.heroesMaxed['Grand Warden'], false)
    // L.A.S.S.I has a level but no reference row for TH17 — no cap, no highlight.
    assert.equal(row.petsMaxed['L.A.S.S.I'], false)
  })

  it('never marks anything maxed when the base has no known Town Hall', () => {
    const rows = buildProgressGridRows(
      ['#A'],
      labelOf,
      noOwner,
      noOwnerUserId,
      [snapshot({ playerTag: '#A', heroes: [{ name: 'Barbarian King', level: 95, maxLevel: 110 }] })],
      [],
      [maxLevelRef('hero', 'Barbarian King', 17, 95)],
    )
    assert.equal(rows[0]?.heroesMaxed['Barbarian King'], false)
  })
})

function row(overrides: Partial<ProgressGridRow> & { tag: string; label: string }): ProgressGridRow {
  return {
    owner: null,
    ownerUserId: null,
    tracked: true,
    thLevel: null,
    heroes: {},
    heroesMaxed: {},
    pets: {},
    petsMaxed: {},
    wallsAtMax: null,
    wallsTotal: null,
    buildingsLeft: null,
    notes: '',
    ...overrides,
  }
}

describe('compareProgressGridRows', () => {
  it('sorts by an individual hero column', () => {
    const a = row({ tag: '#A', label: 'Alpha', heroes: { 'Barbarian King': 50 } })
    const b = row({ tag: '#B', label: 'Beta', heroes: { 'Barbarian King': 90 } })
    assert.equal(compareProgressGridRows(a, b, 'hero:Barbarian King', true) < 0, true)
    assert.equal(compareProgressGridRows(a, b, 'hero:Barbarian King', false) > 0, true)
  })

  it('sorts by an individual pet column, sending an unlocked-nowhere base to the bottom either way', () => {
    const a = row({ tag: '#A', label: 'Alpha', pets: { Frosty: 5 } })
    const b = row({ tag: '#B', label: 'Beta', pets: {} })
    const ascending = sortProgressGridRows([b, a], 'pet:Frosty', true)
    assert.deepEqual(ascending.map((entry) => entry.label), ['Alpha', 'Beta'])
    const descending = sortProgressGridRows([b, a], 'pet:Frosty', false)
    assert.deepEqual(descending.map((entry) => entry.label), ['Alpha', 'Beta'])
  })
})

describe('sortProgressGridRows', () => {
  it('sorts an untracked base into its alphabetical place by label, not to the bottom', () => {
    const rows = [
      row({ tag: '#A', label: 'Alpha' }),
      row({ tag: '#B', label: 'Beta', tracked: false }),
      row({ tag: '#C', label: 'Charlie' }),
    ]
    const sorted = sortProgressGridRows(rows, 'label', true)
    assert.deepEqual(sorted.map((entry) => entry.label), ['Alpha', 'Beta', 'Charlie'])
  })

  it('sends a missing value to the bottom on a numeric column, in either direction', () => {
    const rows = [
      row({ tag: '#A', label: 'Alpha', thLevel: 15 }),
      row({ tag: '#B', label: 'Beta' }),
      row({ tag: '#C', label: 'Charlie', thLevel: 17 }),
    ]
    const ascending = sortProgressGridRows(rows, 'thLevel', true)
    assert.deepEqual(ascending.map((entry) => entry.label), ['Alpha', 'Charlie', 'Beta'])
    const descending = sortProgressGridRows(rows, 'thLevel', false)
    assert.deepEqual(descending.map((entry) => entry.label), ['Charlie', 'Alpha', 'Beta'])
  })
})

/**
 * `standingOwnerOptions` / `filterStandingsByOwner` (`card-standings.ts`) are
 * generic over `Ownable` precisely so this board's rows can share them with
 * `BaseStanding` — this is the check that the sharing actually holds for this
 * row shape, not just that it compiles.
 */
describe('the shared owner filter, applied to progress grid rows', () => {
  // Same account per label as `card-standings.test.ts` uses, since both cover the
  // same generic functions over the same `ownerUserId`-keyed rule.
  const RAE = 1
  const SAM = 2

  function ownedRow(
    tag: string,
    label: string,
    owner: string | null,
    ownerUserId: number | null,
  ): ProgressGridRow {
    return row({ tag, label, owner, ownerUserId })
  }

  it('offers Everyone, the unassigned sentinel only when a row lacks an owner, and each name once', () => {
    const rows = [
      ownedRow('#A', 'Alpha', 'Rae', RAE),
      ownedRow('#B', 'Beta', null, null),
      ownedRow('#C', 'Charlie', 'Rae', RAE),
    ]
    assert.deepEqual(
      standingOwnerOptions(rows).map((option) => option.value),
      [ALL_OWNERS, UNASSIGNED_OWNER, String(RAE)],
    )
  })

  it('narrows to one owner, or to the unassigned rows, without touching the rest', () => {
    const rows = [
      ownedRow('#A', 'Alpha', 'Rae', RAE),
      ownedRow('#B', 'Beta', null, null),
      ownedRow('#C', 'Charlie', 'Sam', SAM),
    ]
    assert.deepEqual(filterStandingsByOwner(rows, String(RAE)).map((entry) => entry.tag), ['#A'])
    assert.deepEqual(filterStandingsByOwner(rows, UNASSIGNED_OWNER).map((entry) => entry.tag), ['#B'])
    assert.deepEqual(
      filterStandingsByOwner(rows, ALL_OWNERS).map((entry) => entry.tag),
      ['#A', '#B', '#C'],
    )
  })

  it('folds an unlinked legacy label into the unassigned rows, not a group of its own', () => {
    // A row can carry a display label with no linked account (`ownerUserId: null`) —
    // that is the same "no id" state as a row with no assignment at all, and the
    // filter now only ever groups on the id.
    const rows = [ownedRow('#A', 'Alpha', 'Dave', null), ownedRow('#B', 'Beta', null, null)]
    assert.deepEqual(
      standingOwnerOptions(rows).map((option) => option.value),
      [ALL_OWNERS, UNASSIGNED_OWNER],
    )
    assert.deepEqual(
      filterStandingsByOwner(rows, UNASSIGNED_OWNER).map((entry) => entry.tag),
      ['#A', '#B'],
    )
  })
})
