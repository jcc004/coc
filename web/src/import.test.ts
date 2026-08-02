import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildImportPayload, describeImport, isImportEmpty } from './import.ts'

/*
 * The one-time hand-off of a browser's `localStorage` to the shared server store.
 * Payload building is pure and separated from reading storage precisely so it can
 * be tested against what a browser might really be holding — which, after two
 * previous schema changes, is not necessarily what it ought to be.
 */

describe('buildImportPayload', () => {
  it('carries owners and clans across, canonicalising tags', () => {
    const owners = JSON.stringify([{ tag: 'g88cyqp', owner: '  Jared  ' }])
    const clans = JSON.stringify([
      {
        tag: '2gcj2qpu',
        name: 'Reddit',
        custom: true,
        clanLevel: 26,
        members: 48,
        clanPoints: 42000,
        warLeague: 'Crystal League I',
      },
    ])

    assert.deepEqual(buildImportPayload(owners, clans), {
      owners: [{ tag: '#G88CYQP', owner: 'Jared' }],
      clans: [
        {
          tag: '#2GCJ2QPU',
          name: 'Reddit',
          custom: true,
          clanLevel: 26,
          members: 48,
          clanPoints: 42000,
          warLeague: 'Crystal League I',
        },
      ],
    })
  })

  it('omits stats the browser never had rather than sending zeroes', () => {
    const clans = JSON.stringify([{ tag: '#AAA1', name: 'No stats yet' }])
    assert.deepEqual(buildImportPayload(null, clans).clans, [{ tag: '#AAA1', name: 'No stats yet' }])
  })

  it('returns an empty payload when the browser holds nothing', () => {
    const payload = buildImportPayload(null, null, null)
    assert.deepEqual(payload, { owners: [], clans: [] })
    assert.equal(isImportEmpty(payload), true)
  })

  it('survives malformed JSON and non-arrays in either key', () => {
    for (const junk of ['{not json', '', 'null', '42', '{"tag":"#AAA"}']) {
      const payload = buildImportPayload(junk, junk, junk)
      assert.deepEqual(payload, { owners: [], clans: [] }, `should survive ${junk}`)
    }
  })

  it('skips junk entries without losing the good ones around them', () => {
    const owners = JSON.stringify([
      null,
      'nope',
      { owner: 'no tag' },
      { tag: '#!!', owner: 'unusable tag' },
      { tag: '#BBB2', owner: '   ' },
      { tag: '#CCC3', owner: 'Sam' },
    ])
    const clans = JSON.stringify([
      null,
      { tag: '#G88CYQP' },
      { tag: 'way-too-long-a-tag', name: 'Nope' },
      { tag: '#DDD4', name: 'Anvil' },
    ])

    const payload = buildImportPayload(owners, clans)
    assert.deepEqual(payload.owners, [{ tag: '#CCC3', owner: 'Sam' }])
    assert.deepEqual(payload.clans, [{ tag: '#DDD4', name: 'Anvil' }])
  })

  it('folds in the pre-owners coc:saved key, letting coc:owners win', () => {
    // A browser that never ran the earlier localStorage migration still has the
    // old shape, and it is the only copy of those annotations.
    const legacy = JSON.stringify([
      { tag: '#AAA1', name: 'darek', owner: 'From the old key', townHallLevel: 18 },
      { tag: '#BBB2', name: 'Turtle', owner: 'Only in the old key' },
    ])
    const owners = JSON.stringify([{ tag: '#AAA1', owner: 'From the new key' }])

    assert.deepEqual(buildImportPayload(owners, null, legacy).owners, [
      { tag: '#AAA1', owner: 'From the new key' },
      { tag: '#BBB2', owner: 'Only in the old key' },
    ])
  })

  it('keeps one entry per tag when the same tag appears twice', () => {
    const owners = JSON.stringify([
      { tag: '#G88CYQP', owner: 'Jared' },
      { tag: 'g88cyqp', owner: 'Sam' },
    ])
    const clans = JSON.stringify([
      { tag: '#G88CYQP', name: 'First' },
      { tag: 'g88cyqp', name: 'Second' },
    ])

    // The owners map takes the last write; the clan list keeps the first.
    assert.equal(buildImportPayload(owners, clans).owners?.length, 1)
    assert.deepEqual(buildImportPayload(owners, clans).clans, [{ tag: '#G88CYQP', name: 'First' }])
  })
})

describe('describeImport', () => {
  it('reports what was added and what was left alone', () => {
    const summary = describeImport({
      owners: { applied: 3, skipped: 2, invalid: 0 },
      clans: { applied: 1, skipped: 0, invalid: 0 },
    })
    assert.match(summary, /3 owner assignments added/)
    // Skipped is stated, not hidden: it is how you know somebody else got there
    // first and your copy did not win.
    assert.match(summary, /2 owner assignments already on the server, left alone/)
    assert.match(summary, /1 saved clan added/)
  })

  it('says so plainly when nothing moved', () => {
    const summary = describeImport({
      owners: { applied: 0, skipped: 0, invalid: 0 },
      clans: { applied: 0, skipped: 0, invalid: 0 },
    })
    assert.equal(summary, "This browser had nothing left to import.")
  })
})
