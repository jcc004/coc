import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { combineNotes, combineSnapshotNotes } from './progress-diff.ts'

describe('combineNotes — both present', () => {
  it('joins auto note then manual note with a visual separator', () => {
    const result = combineNotes('TH 17->18', 'Rushed heroes on purpose')
    assert.equal(result.combined, 'TH 17->18 — Rushed heroes on purpose')
    assert.equal(result.hasContent, true)
    assert.equal(result.autoNote, 'TH 17->18')
    assert.equal(result.notes, 'Rushed heroes on purpose')
  })
})

describe('combineNotes — only one present', () => {
  it('prints the auto note alone with no trailing separator', () => {
    const result = combineNotes('TH 17->18', null)
    assert.equal(result.combined, 'TH 17->18')
  })

  it('prints the manual note alone with no leading separator', () => {
    const result = combineNotes(null, 'Rushed heroes on purpose')
    assert.equal(result.combined, 'Rushed heroes on purpose')
  })

  it('treats a whitespace-only note the same as no note', () => {
    const result = combineNotes('  ', 'Rushed heroes on purpose')
    assert.equal(result.combined, 'Rushed heroes on purpose')
    assert.equal(result.autoNote, null)
  })
})

describe('combineNotes — neither present', () => {
  it('reports no content and an empty combined string, not a placeholder word', () => {
    const result = combineNotes(null, null)
    assert.equal(result.hasContent, false)
    assert.equal(result.combined, '')
    assert.equal(result.autoNote, null)
    assert.equal(result.notes, null)
  })
})

describe('combineSnapshotNotes — reads straight off a snapshot', () => {
  it('agrees with calling combineNotes on the same two fields', () => {
    const snapshot = { autoNote: 'TH 17->18', notes: 'Pushing walls next' }
    assert.deepEqual(combineSnapshotNotes(snapshot), combineNotes(snapshot.autoNote, snapshot.notes))
  })
})
