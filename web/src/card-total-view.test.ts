import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CARD_TOTAL_VIEWS, parseCardTotalView } from './card-total-view.ts'

describe('CARD_TOTAL_VIEWS — the picker’s two options', () => {
  it('offers exactly these two, in this order', () => {
    assert.deepEqual(
      CARD_TOTAL_VIEWS.map((option) => option.value),
      ['totals', 'fodder'],
    )
  })

  it('labels them exactly as agreed, not a paraphrase', () => {
    assert.deepEqual(
      CARD_TOTAL_VIEWS.map((option) => option.label),
      ['Totals', 'Trade Fodder'],
    )
  })
})

describe('parseCardTotalView', () => {
  it('reads back a stored, still-offered value', () => {
    assert.equal(parseCardTotalView('totals'), 'totals')
    assert.equal(parseCardTotalView('fodder'), 'fodder')
  })

  it('falls back to totals for nothing stored', () => {
    assert.equal(parseCardTotalView(null), 'totals')
  })

  it('falls back to totals for a value no longer offered, rather than throwing', () => {
    assert.equal(parseCardTotalView('spares'), 'totals')
    assert.equal(parseCardTotalView('{"view":"fodder"}'), 'totals')
  })
})
