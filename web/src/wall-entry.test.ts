import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WallReferenceRow } from '@coc/shared'
import { isWallLevelInRange, wallCapFor, wallsTotal } from './wall-entry.ts'

const TH17 = '2026-01-01'
function wallReference(rows: Partial<WallReferenceRow>[]): WallReferenceRow[] {
  return rows.map((row) => ({
    thLevel: 0,
    maxWallLevel: 0,
    totalWallCount: 0,
    updatedAt: TH17,
    ...row,
  }))
}

describe('wallCapFor', () => {
  it('finds the reference row for a known Town Hall', () => {
    const reference = wallReference([
      { thLevel: 17, maxWallLevel: 17, totalWallCount: 40 },
      { thLevel: 18, maxWallLevel: 18, totalWallCount: 45 },
    ])
    assert.deepEqual(wallCapFor(18, reference), reference[1])
  })

  it('is null when the Town Hall is unknown', () => {
    assert.equal(wallCapFor(null, wallReference([{ thLevel: 17 }])), null)
  })

  it('is null when the wiki refresh has not covered this Town Hall', () => {
    assert.equal(wallCapFor(19, wallReference([{ thLevel: 17 }])), null)
  })
})

describe('isWallLevelInRange', () => {
  const cap = wallReference([{ thLevel: 18, maxWallLevel: 18, totalWallCount: 250 }])[0] ?? null

  it('accepts a level at or below the cap', () => {
    assert.equal(isWallLevelInRange('18', cap), true)
    assert.equal(isWallLevelInRange('1', cap), true)
  })

  it('rejects a level above the cap', () => {
    assert.equal(isWallLevelInRange('19', cap), false)
  })

  it('rejects zero and negative-looking input', () => {
    assert.equal(isWallLevelInRange('0', cap), false)
    assert.equal(isWallLevelInRange('-1', cap), false)
  })

  it('rejects non-numeric input', () => {
    assert.equal(isWallLevelInRange('abc', cap), false)
    assert.equal(isWallLevelInRange('17.5', cap), false)
  })

  it('treats a blank row as valid — nothing typed yet is not yet wrong', () => {
    assert.equal(isWallLevelInRange('', cap), true)
    assert.equal(isWallLevelInRange('   ', cap), true)
  })

  it('accepts any positive whole number without a cap', () => {
    assert.equal(isWallLevelInRange('99', null), true)
    assert.equal(isWallLevelInRange('0', null), false)
  })
})

describe('wallsTotal', () => {
  it('sums whole counts', () => {
    assert.equal(wallsTotal(['10', '20', '5']), 35)
  })

  it('ignores blank, negative or non-numeric entries rather than throwing', () => {
    assert.equal(wallsTotal(['10', '', 'abc', '-5']), 10)
  })

  it('is 0 for no rows', () => {
    assert.equal(wallsTotal([]), 0)
  })

  it('truncates a fractional count', () => {
    assert.equal(wallsTotal(['10.9']), 10)
  })
})
