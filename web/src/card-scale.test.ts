import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_COLUMN_STEPS,
  DEFAULT_CARD_COLUMNS,
  MIN_OPTIONAL_TILE,
  cardColumnOptions,
  cardScaleIsUseful,
  resolveCardColumns,
  tileWidthFor,
} from './card-scale.ts'

/*
 * Widths taken from the layout as it is measured, not invented: the shell caps at
 * 1280px with 20px padding each side, and the phone cases are the two the grid was
 * checked at. Gaps are the stylesheet's — 10px above 600px, 4px below.
 */
const DESKTOP = { width: 1240, gap: 10 }
const TABLET = { width: 728, gap: 10 }
const PHONE = { width: 350, gap: 4 }
const SMALL_PHONE = { width: 320, gap: 4 }

describe('tileWidthFor', () => {
  it('accounts for the gaps between columns, not around them', () => {
    // Six columns have five gaps.
    assert.equal(tileWidthFor(1240, 6, 10), (1240 - 50) / 6)
  })

  it('answers 0 for a nonsense column count rather than dividing by zero', () => {
    assert.equal(tileWidthFor(1240, 0, 10), 0)
    assert.equal(tileWidthFor(1240, -3, 10), 0)
  })
})

describe('cardColumnOptions', () => {
  it('offers every step on a desktop', () => {
    assert.deepEqual(cardColumnOptions(DESKTOP.width, DESKTOP.gap), [...CARD_COLUMN_STEPS])
  })

  it('drops the steps a tablet cannot carry', () => {
    // Measured rather than assumed: at 728px, ten across gives 63.8px — a whisker
    // under the floor, so only six and eight survive. My first guess here was
    // [6, 8, 10]; the test caught the arithmetic, not the code.
    const options = cardColumnOptions(TABLET.width, TABLET.gap)
    assert.deepEqual(options, [6, 8])
    assert.ok(tileWidthFor(TABLET.width, 10, TABLET.gap) < MIN_OPTIONAL_TILE)
    assert.ok(tileWidthFor(TABLET.width, 12, TABLET.gap) < MIN_OPTIONAL_TILE)
  })

  it('offers only the default on a phone, so the control can hide itself', () => {
    assert.deepEqual(cardColumnOptions(PHONE.width, PHONE.gap), [DEFAULT_CARD_COLUMNS])
    assert.deepEqual(cardColumnOptions(SMALL_PHONE.width, SMALL_PHONE.gap), [DEFAULT_CARD_COLUMNS])
  })

  it('always includes the default, even where it is under the optional floor', () => {
    // Six across on a small phone is ~48px, below MIN_OPTIONAL_TILE. That is a
    // decision already taken and measured; this must not quietly overrule it.
    assert.ok(tileWidthFor(SMALL_PHONE.width, 6, SMALL_PHONE.gap) < MIN_OPTIONAL_TILE)
    assert.ok(cardColumnOptions(SMALL_PHONE.width, SMALL_PHONE.gap).includes(DEFAULT_CARD_COLUMNS))
  })

  it('never offers a step that would breach the floor', () => {
    for (const { width, gap } of [DESKTOP, TABLET, PHONE, SMALL_PHONE]) {
      for (const columns of cardColumnOptions(width, gap)) {
        if (columns === DEFAULT_CARD_COLUMNS) continue
        assert.ok(
          tileWidthFor(width, columns, gap) >= MIN_OPTIONAL_TILE,
          `${columns} across at ${width}px gives ${tileWidthFor(width, columns, gap)}px`,
        )
      }
    }
  })

  it('returns the steps in ascending order, so a picker reads sparse to dense', () => {
    const options = cardColumnOptions(DESKTOP.width, DESKTOP.gap)
    assert.deepEqual(options, [...options].sort((a, b) => a - b))
  })
})

describe('cardScaleIsUseful', () => {
  it('is true where there is a real choice', () => {
    assert.equal(cardScaleIsUseful(DESKTOP.width, DESKTOP.gap), true)
    assert.equal(cardScaleIsUseful(TABLET.width, TABLET.gap), true)
  })

  it('is false on a phone — "only useful on larger screens", made explicit', () => {
    assert.equal(cardScaleIsUseful(PHONE.width, PHONE.gap), false)
    assert.equal(cardScaleIsUseful(SMALL_PHONE.width, SMALL_PHONE.gap), false)
  })
})

describe('resolveCardColumns', () => {
  it('keeps a stored choice that is still offered', () => {
    assert.equal(resolveCardColumns(10, DESKTOP.width, DESKTOP.gap), 10)
  })

  it('clamps a desktop choice down when the same account opens a phone', () => {
    // The preference is shared across devices, so this is the common case, not an edge.
    assert.equal(resolveCardColumns(12, PHONE.width, PHONE.gap), DEFAULT_CARD_COLUMNS)
  })

  it('lands on the nearest offered step rather than the default', () => {
    // 12 is not offered on a tablet; 8 is nearer than falling back to 6, and it
    // preserves what the user actually asked for — more on screen.
    assert.equal(resolveCardColumns(12, TABLET.width, TABLET.gap), 8)
  })

  it('prefers the denser step on a tie, because "more on screen" was the request', () => {
    // 9 is equidistant from 8 and 10, both of which a desktop offers.
    assert.equal(resolveCardColumns(9, DESKTOP.width, DESKTOP.gap), 10)
  })

  it('falls back to the default for anything unusable', () => {
    for (const stored of [null, undefined, '', 'wide', 0, -6, 6.5, NaN, {}, []]) {
      assert.equal(
        resolveCardColumns(stored, DESKTOP.width, DESKTOP.gap),
        DEFAULT_CARD_COLUMNS,
        `for ${JSON.stringify(stored) ?? String(stored)}`,
      )
    }
  })

  it('reads a numeric string, since storage hands back text', () => {
    assert.equal(resolveCardColumns('10', DESKTOP.width, DESKTOP.gap), 10)
  })

  it('always returns something the grid can render', () => {
    for (const { width, gap } of [DESKTOP, TABLET, PHONE, SMALL_PHONE]) {
      for (const stored of [1, 6, 7, 12, 40, 'x', null]) {
        const columns = resolveCardColumns(stored, width, gap)
        assert.ok(Number.isInteger(columns) && columns > 0, `${stored} at ${width} -> ${columns}`)
        assert.ok(cardColumnOptions(width, gap).includes(columns))
      }
    }
  })
})
