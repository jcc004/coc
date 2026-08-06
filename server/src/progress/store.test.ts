import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UnitLevel } from '@coc/shared'
import { openDatabase } from '../db.ts'
import { computeAutoNote, createProgressStore, type AutoNoteSnapshot } from './store.ts'

/*
 * `computeAutoNote` is tested on its own first, with no database in the loop —
 * it is the one piece of `upsertSnapshot` that is worth pinning independently.
 * The store tests that follow lean on an in-memory database, the same shape
 * every other store's tests in this repo use.
 */

const BARB_KING = (level: number): UnitLevel => ({
  name: 'Barbarian King',
  level,
  maxLevel: 100,
})

function snapshot(thLevel: number | null, heroes: UnitLevel[]): AutoNoteSnapshot {
  return { thLevel, heroes }
}

describe('computeAutoNote', () => {
  it('reports a Town Hall change', () => {
    assert.equal(computeAutoNote(snapshot(16, []), snapshot(17, [])), 'TH 16->17')
  })

  it('reports a hero level-up, matched by name', () => {
    const previous = snapshot(17, [BARB_KING(80)])
    const current = snapshot(17, [BARB_KING(81)])
    assert.equal(computeAutoNote(previous, current), 'Barbarian King 80->81')
  })

  it('reports nothing when nothing tracked changed', () => {
    const previous = snapshot(17, [BARB_KING(80)])
    const current = snapshot(17, [BARB_KING(80)])
    assert.equal(computeAutoNote(previous, current), null)
  })

  it('ignores a hero present in only one of the two weeks', () => {
    // Newly unlocked this week — no "before" to compare against.
    assert.equal(
      computeAutoNote(snapshot(17, []), snapshot(17, [BARB_KING(1)])),
      null,
      'a hero with no prior level contributes nothing',
    )
    // Dropped from this week's capture — no "after" to compare against.
    assert.equal(
      computeAutoNote(snapshot(17, [BARB_KING(80)]), snapshot(17, [])),
      null,
      'a hero missing from the current week contributes nothing',
    )
  })

  it('joins a Town Hall change and a hero change together', () => {
    const previous = snapshot(16, [BARB_KING(80)])
    const current = snapshot(17, [BARB_KING(81)])
    assert.equal(computeAutoNote(previous, current), 'TH 16->17; Barbarian King 80->81')
  })

  it('is null with nothing to compare against', () => {
    assert.equal(computeAutoNote(undefined, snapshot(17, [BARB_KING(80)])), null)
  })

  it('does not report a hero level decreasing', () => {
    const previous = snapshot(17, [BARB_KING(80)])
    const current = snapshot(17, [BARB_KING(79)])
    assert.equal(computeAutoNote(previous, current), null)
  })
})

const TAG = '#AAABBB'

describe('progress store', () => {
  function harness() {
    const db = openDatabase(':memory:')
    return createProgressStore(db)
  }

  it('merges an auto capture followed by a manual save, keeping both halves', () => {
    const store = harness()

    store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { auto: { thLevel: 16, heroes: [BARB_KING(80)] } },
      'auto',
    )
    const saved = store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { manual: { walls: { '17': 250 }, buildingsLeft: '3', notes: 'push next season' } },
      'user:1',
    )

    assert.equal(saved.thLevel, 16, 'the auto field must survive the manual save')
    assert.deepEqual(saved.heroes, [BARB_KING(80)])
    assert.deepEqual(saved.walls, { '17': 250 })
    assert.equal(saved.buildingsLeft, '3')
    assert.equal(saved.notes, 'push next season')
    assert.equal(saved.capturedBy, 'user:1', 'the most recent write is the attribution')
  })

  it('merges a manual save followed by an auto capture, keeping both halves', () => {
    const store = harness()

    store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { manual: { walls: { '17': 250 }, buildingsLeft: '3', notes: 'push next season' } },
      'user:1',
    )
    const saved = store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { auto: { thLevel: 16, heroes: [BARB_KING(80)] } },
      'auto',
    )

    assert.deepEqual(saved.walls, { '17': 250 }, 'the manual field must survive the auto capture')
    assert.equal(saved.buildingsLeft, '3')
    assert.equal(saved.notes, 'push next season')
    assert.equal(saved.thLevel, 16)
    assert.deepEqual(saved.heroes, [BARB_KING(80)])
    assert.equal(saved.capturedBy, 'auto')
  })

  it('merges field by field within a single payload, not payload by payload', () => {
    const store = harness()

    store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { auto: { thLevel: 16, heroes: [BARB_KING(80)], troops: [{ name: 'Barbarian', level: 9, maxLevel: 11 }] } },
      'auto',
    )
    // A second auto-capture that only refreshed heroes must not blank troops.
    const saved = store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { auto: { heroes: [BARB_KING(81)] } },
      'auto',
    )

    assert.equal(saved.thLevel, 16, 'a field omitted from the second auto payload is preserved')
    assert.deepEqual(saved.heroes, [BARB_KING(81)])
    assert.deepEqual(saved.troops, [{ name: 'Barbarian', level: 9, maxLevel: 11 }])
  })

  it('recomputes auto_note against the most recent prior week on every upsert', () => {
    const store = harness()

    store.upsertSnapshot(TAG, '2026-07-28', { auto: { thLevel: 16, heroes: [BARB_KING(80)] } }, 'auto')
    const week1 = store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { auto: { thLevel: 17, heroes: [BARB_KING(81)] } },
      'auto',
    )
    assert.equal(week1.autoNote, 'TH 16->17; Barbarian King 80->81')

    // A manual-only save that week must still carry the note the auto capture
    // already computed — it is recomputed from the merged row, not blanked by
    // a payload that touched neither thLevel nor heroes.
    const manualSave = store.upsertSnapshot(
      TAG,
      '2026-08-04',
      { manual: { notes: 'strong week' } },
      'user:1',
    )
    assert.equal(manualSave.autoNote, 'TH 16->17; Barbarian King 80->81')

    // The first ever week for a base has nothing to diff against.
    const firstWeek = store.getHistory(TAG).find((row) => row.weekStart === '2026-07-28')
    assert.equal(firstWeek?.autoNote, null)
  })

  it('orders history newest week first', () => {
    const store = harness()
    store.upsertSnapshot(TAG, '2026-07-21', { auto: { thLevel: 15 } }, 'auto')
    store.upsertSnapshot(TAG, '2026-08-04', { auto: { thLevel: 17 } }, 'auto')
    store.upsertSnapshot(TAG, '2026-07-28', { auto: { thLevel: 16 } }, 'auto')

    assert.deepEqual(
      store.getHistory(TAG).map((row) => row.weekStart),
      ['2026-08-04', '2026-07-28', '2026-07-21'],
    )
  })

  it('accepts a tag without the # and stores the canonical form', () => {
    const store = harness()
    store.upsertSnapshot('AAABBB', '2026-08-04', { auto: { thLevel: 16 } }, 'auto')
    assert.equal(store.getHistory('#AAABBB')[0]?.playerTag, '#AAABBB')
  })

  it('getLatestForClan returns one row per tag, in request order, skipping tags with none', () => {
    const store = harness()
    const other = '#CCCDDD'

    store.upsertSnapshot(TAG, '2026-07-28', { auto: { thLevel: 15 } }, 'auto')
    store.upsertSnapshot(TAG, '2026-08-04', { auto: { thLevel: 16 } }, 'auto')
    store.upsertSnapshot(other, '2026-08-04', { auto: { thLevel: 12 } }, 'auto')

    const latest = store.getLatestForClan([other, TAG, '#NOROWS1'])
    assert.deepEqual(
      latest.map((row) => [row.playerTag, row.weekStart, row.thLevel]),
      [
        [other, '2026-08-04', 12],
        [TAG, '2026-08-04', 16],
      ],
    )
  })

  it('getAllTrackedTags lists every distinct player_tag with a captured row, once each', () => {
    const store = harness()
    const other = '#CCCDDD'

    store.upsertSnapshot(TAG, '2026-07-28', { auto: { thLevel: 15 } }, 'auto')
    // A second week for the same tag must not produce a duplicate entry.
    store.upsertSnapshot(TAG, '2026-08-04', { auto: { thLevel: 16 } }, 'auto')
    store.upsertSnapshot(other, '2026-08-04', { auto: { thLevel: 12 } }, 'auto')

    assert.deepEqual(new Set(store.getAllTrackedTags()), new Set([TAG, other]))
    assert.equal(store.getAllTrackedTags().length, 2)
  })

  it('getAllTrackedTags returns an empty list when nothing has ever been captured', () => {
    const store = harness()
    assert.deepEqual(store.getAllTrackedTags(), [])
  })

  it('round-trips the max-level reference table, upserting on a repeat key', () => {
    const store = harness()

    store.upsertMaxLevelReference([
      { category: 'hero', name: 'Barbarian King', thLevel: 11, maxLevel: 40 },
      { category: 'pet', name: 'L.A.S.S.I', thLevel: 14, maxLevel: 10 },
    ])
    // Same (category, name, thLevel) key: this must update in place, not add a row.
    store.upsertMaxLevelReference([
      { category: 'hero', name: 'Barbarian King', thLevel: 11, maxLevel: 45 },
    ])

    const all = store.getAllMaxLevelReference()
    assert.deepEqual(
      all.map((row) => [row.category, row.name, row.thLevel, row.maxLevel]),
      [
        ['hero', 'Barbarian King', 11, 45],
        ['pet', 'L.A.S.S.I', 14, 10],
      ],
    )
    assert.ok(all.every((row) => typeof row.updatedAt === 'string' && row.updatedAt.length > 0))
  })

  it('round-trips the wall reference table, upserting on a repeat key', () => {
    const store = harness()

    store.upsertWallReference([
      { thLevel: 14, maxWallLevel: 15, totalWallCount: 500 },
      { thLevel: 15, maxWallLevel: 16, totalWallCount: 500 },
    ])
    store.upsertWallReference([{ thLevel: 14, maxWallLevel: 16, totalWallCount: 500 }])

    const all = store.getAllWallReference()
    assert.deepEqual(
      all.map((row) => [row.thLevel, row.maxWallLevel, row.totalWallCount]),
      [
        [14, 16, 500],
        [15, 16, 500],
      ],
    )
  })

  it('getWallReference finds one row by thLevel, or null when the wiki refresh has not covered it', () => {
    const store = harness()
    store.upsertWallReference([{ thLevel: 14, maxWallLevel: 15, totalWallCount: 500 }])

    const found = store.getWallReference(14)
    assert.deepEqual(
      found && [found.thLevel, found.maxWallLevel, found.totalWallCount],
      [14, 15, 500],
    )
    assert.equal(store.getWallReference(99), null)
  })

  it('getLatestThLevel returns the most recent week that actually carried a TH level', () => {
    const store = harness()

    // An auto capture, then a manual-only save the same week (th_level stays what
    // it was) and a later manual-only week (th_level null on that row) — the last
    // *known* TH must still be 17, not null just because the newest row has none.
    store.upsertSnapshot(TAG, '2026-07-28', { auto: { thLevel: 17 } }, 'auto')
    store.upsertSnapshot(TAG, '2026-08-04', { manual: { notes: 'no auto capture this week' } }, 'user:1')

    assert.equal(store.getLatestThLevel(TAG), 17)
  })

  it('getLatestThLevel is null for a base that has never been auto-captured', () => {
    const store = harness()
    store.upsertSnapshot(TAG, '2026-08-04', { manual: { notes: 'manual only' } }, 'user:1')

    assert.equal(store.getLatestThLevel(TAG), null)
  })

  it('getLatestThLevel is null for a tag with no rows at all', () => {
    const store = harness()
    assert.equal(store.getLatestThLevel('#NOROWS1'), null)
  })
})
