import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { percentHeatColor, seriesStyle, wallLevelColor } from './chart-colors.ts'

describe('seriesStyle', () => {
  it('cycles through the eight categorical custom properties in order', () => {
    const colors = Array.from({ length: 8 }, (_, index) => seriesStyle(index).color)
    assert.deepEqual(colors, [
      'var(--series-1)',
      'var(--series-2)',
      'var(--series-3)',
      'var(--series-4)',
      'var(--series-5)',
      'var(--series-6)',
      'var(--series-7)',
      'var(--series-8)',
    ])
  })

  it('keeps the first eight series solid (no dash)', () => {
    for (let index = 0; index < 8; index += 1) {
      assert.equal(seriesStyle(index).dash, undefined)
    }
  })

  it('repeats the hue but adds a dash pattern past eight series', () => {
    const ninth = seriesStyle(8)
    assert.equal(ninth.color, 'var(--series-1)')
    assert.notEqual(ninth.dash, undefined)

    const seventeenth = seriesStyle(16)
    assert.equal(seventeenth.color, 'var(--series-1)')
    assert.notEqual(seventeenth.dash, undefined)
    assert.notEqual(seventeenth.dash, ninth.dash)
  })

  it('never assigns the same (hue, dash) pair twice within 24 series — spells (18) fits', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 24; index += 1) {
      const { color, dash } = seriesStyle(index)
      const key = `${color}|${dash ?? 'solid'}`
      assert.equal(seen.has(key), false, `duplicate style at index ${index}`)
      seen.add(key)
    }
  })

  it('is a pure function of the index — color follows identity, not rank', () => {
    // Calling out of order (as a caller filtering a legend would) must not change
    // what an earlier index resolves to.
    const first = seriesStyle(2)
    seriesStyle(5)
    seriesStyle(0)
    const firstAgain = seriesStyle(2)
    assert.deepEqual(first, firstAgain)
  })
})

describe('wallLevelColor', () => {
  it('gives a single level the ramp midpoint anchor — nothing to rank it against', () => {
    assert.equal(wallLevelColor(0, 1), 'var(--wall-ramp-3)')
  })

  it('lands exactly on the first and last anchor at the ramp endpoints', () => {
    assert.equal(wallLevelColor(0, 5), 'var(--wall-ramp-1)')
    assert.equal(wallLevelColor(4, 5), 'var(--wall-ramp-5)')
  })

  it('lands exactly on each of the five anchors when count matches the anchor count', () => {
    const colors = [0, 1, 2, 3, 4].map((rank) => wallLevelColor(rank, 5))
    assert.deepEqual(colors, [
      'var(--wall-ramp-1)',
      'var(--wall-ramp-2)',
      'var(--wall-ramp-3)',
      'var(--wall-ramp-4)',
      'var(--wall-ramp-5)',
    ])
  })

  it('mixes between two neighboring anchors — never a bare, non-adjacent one — off the exact steps', () => {
    // count=9 puts rank 1 an eighth of the way from anchor 1 to anchor 2, not on an anchor at all.
    const color = wallLevelColor(1, 9)
    assert.match(color, /^color-mix\(in oklab, var\(--wall-ramp-1\), var\(--wall-ramp-2\) [\d.]+%\)$/)
  })

  it('never skips an anchor pair — mixes only between immediate neighbors', () => {
    for (let rank = 0; rank < 17; rank += 1) {
      const color = wallLevelColor(rank, 17)
      const match = color.match(/^color-mix\(in oklab, var\(--wall-ramp-(\d)\), var\(--wall-ramp-(\d)\) [\d.]+%\)$/)
      if (!match) continue // an exact anchor — fine, covered by the other tests
      const [, from, to] = match
      assert.equal(Number(to), Number(from) + 1, `${color} skips an anchor`)
    }
  })

  it('is monotonically non-decreasing through the anchor sequence as rank increases', () => {
    // Anchor index (1-5) plus the mix fraction toward the next one, so two adjacent
    // ranks are never assigned the *same* anchor pair in reverse order.
    function anchorPosition(color: string): number {
      const exact = color.match(/^var\(--wall-ramp-(\d)\)$/)
      if (exact) return Number(exact[1])
      const mix = color.match(/^color-mix\(in oklab, var\(--wall-ramp-(\d)\), var\(--wall-ramp-\d\) ([\d.]+)%\)$/)
      if (!mix) throw new Error(`unrecognized color: ${color}`)
      return Number(mix[1]) + Number(mix[2]) / 100
    }
    const positions = Array.from({ length: 17 }, (_, rank) => anchorPosition(wallLevelColor(rank, 17)))
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i]! > positions[i - 1]!, `rank ${i} should sit later in the ramp than rank ${i - 1}`)
    }
  })
})

describe('percentHeatColor', () => {
  it('maps 0% and 100% to the same 15-85 band as wallLevelColor', () => {
    const percentOf = (color: string) => Number(color.match(/([\d.]+)%\)$/)?.[1])
    assert.equal(percentOf(percentHeatColor(0)), 15)
    assert.equal(percentOf(percentHeatColor(100)), 85)
  })

  it('clamps out-of-range input rather than producing an invalid mix', () => {
    const percentOf = (color: string) => Number(color.match(/([\d.]+)%\)$/)?.[1])
    assert.equal(percentOf(percentHeatColor(-10)), 15)
    assert.equal(percentOf(percentHeatColor(150)), 85)
  })

  it('is monotonic in the input percent', () => {
    const percentOf = (color: string) => Number(color.match(/([\d.]+)%\)$/)?.[1])
    assert.ok(percentOf(percentHeatColor(80)) > percentOf(percentHeatColor(20)))
  })
})
