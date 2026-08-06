import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseBulkPasteRows } from './progress-bulk-paste.ts'

describe('parseBulkPasteRows', () => {
  it('reads one row per comma-separated line', () => {
    const result = parseBulkPasteRows('L.A.S.S.I, 7, 5\nMighty Yak, 9, 10')
    assert.deepEqual(result, {
      rows: [
        { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 },
        { name: 'Mighty Yak', thLevel: 9, maxLevel: 10 },
      ],
    })
  })

  it('reads a tab-separated line the same way, as a spreadsheet paste would produce', () => {
    const result = parseBulkPasteRows('Giant Gauntlet\t14\t18')
    assert.deepEqual(result, { rows: [{ name: 'Giant Gauntlet', thLevel: 14, maxLevel: 18 }] })
  })

  it('trims whitespace around each field', () => {
    const result = parseBulkPasteRows('  Frozen Arrow ,  10 ,  27  ')
    assert.deepEqual(result, { rows: [{ name: 'Frozen Arrow', thLevel: 10, maxLevel: 27 }] })
  })

  it('skips blank lines rather than failing on them', () => {
    const result = parseBulkPasteRows('\nL.A.S.S.I, 7, 5\n\n\nMighty Yak, 9, 10\n')
    assert.deepEqual(result, {
      rows: [
        { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 },
        { name: 'Mighty Yak', thLevel: 9, maxLevel: 10 },
      ],
    })
  })

  it('handles \\r\\n line endings', () => {
    const result = parseBulkPasteRows('L.A.S.S.I, 7, 5\r\nMighty Yak, 9, 10')
    assert.deepEqual(result, {
      rows: [
        { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 },
        { name: 'Mighty Yak', thLevel: 9, maxLevel: 10 },
      ],
    })
  })

  it('rejects the whole paste when one line has the wrong number of fields', () => {
    const result = parseBulkPasteRows('L.A.S.S.I, 7, 5\nMighty Yak, 9')
    assert.ok('problem' in result)
    assert.match(result.problem, /Line 2/)
  })

  it('rejects a blank name', () => {
    const result = parseBulkPasteRows(', 7, 5')
    assert.ok('problem' in result)
    assert.match(result.problem, /name cannot be blank/)
  })

  it('rejects a non-positive or non-integer town hall level', () => {
    for (const bad of ['0', '-1', '3.5', 'seven']) {
      const result = parseBulkPasteRows(`L.A.S.S.I, ${bad}, 5`)
      assert.ok('problem' in result, `thLevel ${bad} should be rejected`)
      assert.match(result.problem, /town hall level/)
    }
  })

  it('rejects a non-positive or non-integer max level', () => {
    for (const bad of ['0', '-1', '2.5', 'five']) {
      const result = parseBulkPasteRows(`L.A.S.S.I, 7, ${bad}`)
      assert.ok('problem' in result, `maxLevel ${bad} should be rejected`)
      assert.match(result.problem, /max level/)
    }
  })

  it('rejects an empty paste', () => {
    const result = parseBulkPasteRows('   \n  \n')
    assert.deepEqual(result, { problem: 'Paste at least one line: "name, town hall, max level".' })
  })

  it('is all-or-nothing: one bad line anywhere means nothing is returned', () => {
    const result = parseBulkPasteRows(
      'L.A.S.S.I, 7, 5\nMighty Yak, 9, 10\nElectro Owl, 0, 3\nUnicorn, 11, 8',
    )
    assert.ok('problem' in result)
    assert.match(result.problem, /Line 3/)
  })
})
