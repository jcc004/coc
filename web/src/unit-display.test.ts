import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { artKindFor, unitFraction, isMaxed } from './unit-display.ts'

describe('artKindFor', () => {
  it('maps pet to troop, since pet art was vendored under the troop key', () => {
    assert.equal(artKindFor('pet'), 'troop')
  })

  it('passes every other category through unchanged', () => {
    assert.equal(artKindFor('hero'), 'hero')
    assert.equal(artKindFor('troop'), 'troop')
    assert.equal(artKindFor('spell'), 'spell')
    assert.equal(artKindFor('equipment'), 'equipment')
  })
})

describe('isMaxed', () => {
  it('is false when there is no reference cap to compare against', () => {
    assert.equal(isMaxed({ level: 40, maxForTh: null }), false)
  })

  it('is false below the cap', () => {
    assert.equal(isMaxed({ level: 76, maxForTh: 95 }), false)
  })

  it('is true at the cap', () => {
    assert.equal(isMaxed({ level: 95, maxForTh: 95 }), true)
  })

  it('is true past the cap', () => {
    assert.equal(isMaxed({ level: 96, maxForTh: 95 }), true)
  })
})

describe('unitFraction', () => {
  it('renders the raw level over the TH-relative cap', () => {
    assert.equal(unitFraction({ level: 26, maxForTh: 27 }), '26/27')
  })

  it('renders the fraction at the cap too, not a bare "100%"', () => {
    assert.equal(unitFraction({ level: 27, maxForTh: 27 }), '27/27')
  })

  it('falls back to the bare level when there is no reference row', () => {
    assert.equal(unitFraction({ level: 12, maxForTh: null }), 'Lv 12')
  })
})
