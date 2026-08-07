import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, renderHook } from '@testing-library/react'
import { installTestCleanup } from './test-support.ts'
import { rowsToWalls, useWallRows, wallsToRows, type WallRow } from './wall-rows.ts'

installTestCleanup()

describe('wallsToRows', () => {
  it('sorts levels ascending numerically, not lexically', () => {
    const rows = wallsToRows({ '9': 1, '14': 2, '2': 3 })
    assert.deepEqual(
      rows.map((row) => row.level),
      ['2', '9', '14'],
    )
  })

  it('carries each count through as a string', () => {
    const rows = wallsToRows({ '17': 250 })
    assert.equal(rows[0]?.count, '250')
  })

  it('gives one blank starter row for an empty map', () => {
    const rows = wallsToRows({})
    assert.deepEqual(
      rows.map(({ level, count }) => ({ level, count })),
      [{ level: '', count: '' }],
    )
  })

  it('gives one blank starter row for null — a base with nothing entered yet', () => {
    const rows = wallsToRows(null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.level, '')
  })

  it('assigns every row a distinct key', () => {
    const rows = wallsToRows({ '9': 1, '14': 2 })
    assert.notEqual(rows[0]?.key, rows[1]?.key)
  })
})

describe('rowsToWalls', () => {
  function row(level: string, count: string): WallRow {
    return { key: 'k', level, count }
  }

  it('parses whole non-negative counts back to the sparse wire shape', () => {
    assert.deepEqual(rowsToWalls([row('17', '250'), row('16', '4')]), { '17': 250, '16': 4 })
  })

  it('drops a row with no level rather than sending it', () => {
    assert.deepEqual(rowsToWalls([row('', '5')]), {})
  })

  it('drops a row whose level is not a whole number', () => {
    assert.deepEqual(rowsToWalls([row('12.5', '5')]), {})
  })

  it('drops a row whose count is negative or not finite', () => {
    assert.deepEqual(rowsToWalls([row('12', '-1'), row('13', 'NaN')]), {})
  })

  it('truncates a fractional count rather than rejecting the row', () => {
    assert.deepEqual(rowsToWalls([row('12', '5.9')]), { '12': 5 })
  })

  it('returns an empty object for no rows at all', () => {
    assert.deepEqual(rowsToWalls([]), {})
  })
})

describe('useWallRows', () => {
  it('seeds from the walls passed in on mount', () => {
    const { result } = renderHook(() => useWallRows({ '17': 4 }))
    assert.equal(result.current.rows.length, 1)
    assert.equal(result.current.rows[0]?.level, '17')
    assert.equal(result.current.rows[0]?.count, '4')
  })

  it('addRow appends one blank row, updateRow edits one by key, removeRow drops it', () => {
    const { result } = renderHook(() => useWallRows(null))
    const startKey = result.current.rows[0]!.key

    act(() => result.current.addRow())
    assert.equal(result.current.rows.length, 2)

    act(() => result.current.updateRow(startKey, { level: '17', count: '10' }))
    assert.deepEqual(
      result.current.rows.find((row) => row.key === startKey),
      { key: startKey, level: '17', count: '10' },
    )

    act(() => result.current.removeRow(startKey))
    assert.equal(result.current.rows.length, 1)
    assert.equal(result.current.rows.find((row) => row.key === startKey), undefined)
  })

  it('updateRow leaves every other row untouched', () => {
    const { result } = renderHook(() => useWallRows({ '17': 4, '16': 2 }))
    const [first, second] = result.current.rows
    assert.ok(first && second)

    act(() => result.current.updateRow(first.key, { count: '99' }))
    assert.equal(result.current.rows.find((row) => row.key === second.key)?.count, second.count)
  })
})
