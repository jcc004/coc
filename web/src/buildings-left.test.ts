import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatBuildingsLeft, parseBuildingsLeft } from './buildings-left.ts'

describe('parseBuildingsLeft', () => {
  it('reads the two literals', () => {
    assert.deepEqual(parseBuildingsLeft('LOTS'), { mode: 'lots', count: 0 })
    assert.deepEqual(parseBuildingsLeft('DONE!'), { mode: 'done', count: 0 })
  })

  it('reads a digit string as a count', () => {
    assert.deepEqual(parseBuildingsLeft('7'), { mode: 'count', count: 7 })
    assert.deepEqual(parseBuildingsLeft('0'), { mode: 'count', count: 0 })
  })

  it('falls back to the unset count for nothing entered yet', () => {
    assert.deepEqual(parseBuildingsLeft(null), { mode: 'count', count: 0 })
    assert.deepEqual(parseBuildingsLeft(undefined), { mode: 'count', count: 0 })
  })

  it('falls back to the unset count for anything the server would reject', () => {
    assert.deepEqual(parseBuildingsLeft('lots'), { mode: 'count', count: 0 })
    assert.deepEqual(parseBuildingsLeft('-3'), { mode: 'count', count: 0 })
    assert.deepEqual(parseBuildingsLeft('3.5'), { mode: 'count', count: 0 })
    assert.deepEqual(parseBuildingsLeft(''), { mode: 'count', count: 0 })
    assert.deepEqual(parseBuildingsLeft('07'), { mode: 'count', count: 7 })
  })
})

describe('formatBuildingsLeft', () => {
  it('writes the two literals regardless of the count alongside them', () => {
    assert.equal(formatBuildingsLeft({ mode: 'lots', count: 0 }), 'LOTS')
    assert.equal(formatBuildingsLeft({ mode: 'done', count: 99 }), 'DONE!')
  })

  it('writes a whole, non-negative digit string for a count', () => {
    assert.equal(formatBuildingsLeft({ mode: 'count', count: 12 }), '12')
    assert.equal(formatBuildingsLeft({ mode: 'count', count: 0 }), '0')
  })

  it('clamps a count that should never reach here rather than sending it as typed', () => {
    assert.equal(formatBuildingsLeft({ mode: 'count', count: -4 }), '0')
    assert.equal(formatBuildingsLeft({ mode: 'count', count: 3.9 }), '3')
  })

  it('round-trips every wire value parseBuildingsLeft can produce', () => {
    for (const raw of ['LOTS', 'DONE!', '0', '42']) {
      assert.equal(formatBuildingsLeft(parseBuildingsLeft(raw)), raw)
    }
  })
})
