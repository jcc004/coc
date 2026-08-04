import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { migrateLegacySaved } from './owners.ts'

/*
 * `coc:saved` held a curated player list for the (now removed) saved-bases table;
 * only the owner annotation is worth keeping. Whatever is actually in a browser's
 * localStorage has to survive this, so every one of these is a real possibility.
 */

describe('migrateLegacySaved', () => {
  it('keeps only entries that carry an owner', () => {
    const raw = JSON.stringify([
      { tag: '#AAA', name: 'darek', owner: 'Jared', townHallLevel: 18 },
      { tag: '#BBB', name: 'Alt one' },
      { tag: '#CCC', name: 'Turtle', owner: 'Sam' },
    ])

    assert.deepEqual(migrateLegacySaved(raw), [
      { tag: '#AAA', owner: 'Jared' },
      { tag: '#CCC', owner: 'Sam' },
    ])
  })

  it('drops the rest of the old record, keeping tag, owner and updatedAt', () => {
    const raw = JSON.stringify([
      {
        tag: '#AAA',
        name: 'darek',
        custom: true,
        owner: 'Jared',
        clanTag: '#G88CYQP',
        clanName: 'Reddit',
        townHallLevel: 18,
        trophies: 5200,
        updatedAt: '2026-07-31T00:00:00.000Z',
      },
    ])

    assert.deepEqual(migrateLegacySaved(raw), [
      { tag: '#AAA', owner: 'Jared', updatedAt: '2026-07-31T00:00:00.000Z' },
    ])
  })

  it('returns nothing when the key was never set', () => {
    assert.deepEqual(migrateLegacySaved(null), [])
  })

  it('returns nothing for malformed JSON', () => {
    assert.deepEqual(migrateLegacySaved('{not json'), [])
    assert.deepEqual(migrateLegacySaved(''), [])
  })

  it('returns nothing for JSON that is not an array', () => {
    assert.deepEqual(migrateLegacySaved('{"tag":"#AAA","owner":"Jared"}'), [])
    assert.deepEqual(migrateLegacySaved('null'), [])
    assert.deepEqual(migrateLegacySaved('42'), [])
    assert.deepEqual(migrateLegacySaved('"#AAA"'), [])
  })

  it('skips junk entries without losing the good ones around them', () => {
    const raw = JSON.stringify([
      null,
      'nope',
      42,
      { name: 'no tag at all', owner: 'Jared' },
      { tag: 42, owner: 'Jared' },
      { tag: '#AAA', owner: 5 },
      { tag: '#BBB', owner: '   ' },
      { tag: '#CCC', owner: 'Sam' },
    ])

    assert.deepEqual(migrateLegacySaved(raw), [{ tag: '#CCC', owner: 'Sam' }])
  })

  it('trims the owner and canonicalizes the tag', () => {
    // Lowercase and the letter O, both of which normalizeTag corrects.
    const raw = JSON.stringify([{ tag: 'g88cyqp', owner: '  Jared  ' }])
    assert.deepEqual(migrateLegacySaved(raw), [{ tag: '#G88CYQP', owner: 'Jared' }])
  })

  it('discards an owner attached to a tag that cannot be a tag', () => {
    // Nothing could ever look this up, so the annotation has nothing to annotate.
    const raw = JSON.stringify([
      { tag: '#!!', owner: 'Jared' },
      { tag: '', owner: 'Jared' },
      { tag: '#WAYTOOLONGATAG', owner: 'Jared' },
    ])
    assert.deepEqual(migrateLegacySaved(raw), [])
  })

  it('keeps the first of two entries for the same tag', () => {
    const raw = JSON.stringify([
      { tag: '#G88CYQP', owner: 'Jared' },
      { tag: 'g88cyqp', owner: 'Sam' },
    ])
    assert.deepEqual(migrateLegacySaved(raw), [{ tag: '#G88CYQP', owner: 'Jared' }])
  })

  it('handles an empty list', () => {
    assert.deepEqual(migrateLegacySaved('[]'), [])
  })
})
