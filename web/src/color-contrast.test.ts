import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  blend,
  colorBlindDelta,
  contrastRatio,
  deltaE76,
  distinguishable,
  formatHex,
  GRAY_SATURATION,
  hslToRgb,
  hueDistance,
  linearizeChannel,
  MIN_DELTA_E,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  rgbToLab,
  simulateVision,
  withHue,
  withLightness,
  type Rgb,
} from './color-contrast.ts'

/**
 * The contrast maths is checked against **published** figures, not against itself.
 *
 * Every ratio below is one that can be looked up or derived by hand from the WCAG
 * definition — 21:1 for black on white, 4.54:1 for the well-known smallest passing
 * gray, 8.59:1 for blue on white — so these tests fail if the formula is wrong even
 * where the implementation is self-consistent. The pair that matters most is blue and
 * green: any brightness-average model calls them equally light, and the real answers
 * are 8.59:1 and 1.37:1.
 */

const rgb = (hex: string): Rgb => {
  const parsed = parseHex(hex)
  assert.ok(parsed, `${hex} should parse`)
  return parsed
}

const ratio = (a: string, b: string): number => contrastRatio(rgb(a), rgb(b))

describe('parseHex', () => {
  it('reads the six-digit form', () => {
    assert.deepEqual(parseHex('#1f6cb0'), { r: 31, g: 108, b: 176 })
  })

  it('reads the three-digit form as the doubled six-digit one', () => {
    assert.deepEqual(parseHex('#abc'), parseHex('#aabbcc'))
  })

  it('is case-insensitive and ignores surrounding space', () => {
    assert.deepEqual(parseHex('  #F2B431 '), parseHex('#f2b431'))
  })

  it('refuses everything that is not a hex color, rather than guessing', () => {
    // The callers are a localStorage read and an <input> value: a string somebody
    // could have edited, or one an older build wrote.
    for (const value of ['', 'red', '#', '#12', '#12345', '#1234567', '#gggggg', 'f2b431']) {
      assert.equal(parseHex(value), null, `${JSON.stringify(value)} is not a color`)
    }
  })

  it('refuses a value that is not a string at all', () => {
    for (const value of [null, undefined, 42, {}, ['#fff']]) {
      assert.equal(parseHex(value), null)
    }
  })

  it('round-trips through formatHex in the six-digit lowercase form', () => {
    // So that two equal colors compare equal as strings, which the picker relies on.
    assert.equal(formatHex(rgb('#ABC')), '#aabbcc')
    assert.equal(formatHex(rgb('#f2b431')), '#f2b431')
  })
})

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    assert.equal(relativeLuminance(rgb('#000000')), 0)
    assert.equal(Math.abs(relativeLuminance(rgb('#ffffff')) - 1) < 1e-12, true)
  })

  it('returns each CIE weight exactly for the corresponding primary', () => {
    // The three coefficients of the formula, read back one at a time.
    assert.equal(relativeLuminance(rgb('#ff0000')).toFixed(4), '0.2126')
    assert.equal(relativeLuminance(rgb('#00ff00')).toFixed(4), '0.7152')
    assert.equal(relativeLuminance(rgb('#0000ff')).toFixed(4), '0.0722')
  })

  it('uses the linear foot of the curve below the knee, not the power branch', () => {
    // 8/255 = 0.0314, which is below the knee: 0.0314 / 12.92.
    assert.equal(relativeLuminance(rgb('#080808')).toFixed(7), '0.0024282')
    assert.equal(linearizeChannel(8).toFixed(7), '0.0024282')
  })

  it("does not care that WCAG's knee is 0.03928 and sRGB's is 0.04045", () => {
    // The WCAG figure is a rounding of an early sRGB draft. No 8-bit channel lands
    // between the two, so the choice cannot change a single answer — which is why the
    // module uses the spec value without further ceremony.
    for (let channel = 0; channel <= 255; channel += 1) {
      const value = channel / 255
      assert.equal(value > 0.03928 && value < 0.04045, false, `channel ${channel}`)
    }
  })
})

describe('contrastRatio', () => {
  it('is 21:1 for black against white, the maximum the formula can produce', () => {
    assert.equal(ratio('#000000', '#ffffff').toFixed(4), '21.0000')
  })

  it('is 1:1 for a color against itself', () => {
    for (const hex of ['#000000', '#ffffff', '#1f6cb0', '#f2b431']) {
      assert.equal(ratio(hex, hex), 1)
    }
  })

  it('does not care which way round the two colors are given', () => {
    assert.equal(ratio('#1f6cb0', '#f6efdc'), ratio('#f6efdc', '#1f6cb0'))
  })

  it('agrees with the published figures for the standard grays', () => {
    // #767676 is the smallest gray that passes 4.5:1 on white, and #777777 the one
    // just below it — the pair every contrast checker is calibrated on.
    assert.equal(ratio('#767676', '#ffffff').toFixed(2), '4.54')
    assert.equal(ratio('#777777', '#ffffff').toFixed(2), '4.48')
    assert.equal(ratio('#595959', '#ffffff').toFixed(2), '7.00')
    assert.equal(ratio('#767676', '#000000').toFixed(2), '4.62')
  })

  it('gives blue and green wildly different answers on the same ground', () => {
    // The whole reason for the sRGB linearization and the CIE weights. A naive
    // brightness average calls #0000ff and #00ff00 equally bright; against white they
    // are 8.59:1 — a usable link — and 1.37:1, which is invisible.
    const blue = ratio('#0000ff', '#ffffff')
    const green = ratio('#00ff00', '#ffffff')
    assert.equal(blue.toFixed(2), '8.59')
    assert.equal(green.toFixed(2), '1.37')
    assert.ok(blue / green > 6, 'a brightness average would have made these equal')
  })

  it('agrees with the published figures for the primaries on black', () => {
    assert.equal(ratio('#00ff00', '#000000').toFixed(2), '15.30')
    assert.equal(ratio('#ff0000', '#000000').toFixed(2), '5.25')
    assert.equal(ratio('#0000ff', '#000000').toFixed(2), '2.44')
    assert.equal(ratio('#ff0000', '#ffffff').toFixed(2), '4.00')
  })

  it('measures the shipped light accent against the two grounds it sits on', () => {
    // Recorded rather than asserted as a pass: the accent clears 4.5:1 on the card
    // surface and measures 4.02:1 on the plane behind the footer's links. That second
    // figure is why a user who picks this same blue gets it deepened — see
    // `color-scheme.ts`.
    assert.equal(ratio('#1f6cb0', '#f6efdc').toFixed(2), '4.78')
    assert.equal(ratio('#1f6cb0', '#e6dcc3').toFixed(2), '4.02')
  })
})

describe('rgbToHsl and hslToRgb', () => {
  it('round-trips every hue to within one step per channel', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      const start = hslToRgb({ h: hue, s: 0.7, l: 0.45 })
      const back = hslToRgb(rgbToHsl(start))
      for (const channel of ['r', 'g', 'b'] as const) {
        assert.ok(Math.abs(start[channel] - back[channel]) <= 1, `hue ${hue}, ${channel}`)
      }
    }
  })

  it('reports a gray as having no saturation', () => {
    assert.equal(rgbToHsl(rgb('#808080')).s, 0)
  })

  it('moves lightness while holding hue, which is how a color is clamped', () => {
    const darker = withLightness(rgb('#1f6cb0'), 0.2)
    assert.ok(Math.abs(rgbToHsl(darker).h - rgbToHsl(rgb('#1f6cb0')).h) < 2)
    assert.ok(relativeLuminance(darker) < relativeLuminance(rgb('#1f6cb0')))
  })

  it('moves hue while holding lightness, which is how a clash is escaped', () => {
    const rotated = withHue(rgb('#1f6cb0'), 300)
    assert.ok(Math.abs(rgbToHsl(rotated).l - rgbToHsl(rgb('#1f6cb0')).l) < 0.01)
    assert.ok(hueDistance(rotated, rgb('#1f6cb0')) > 80)
  })
})

describe('blend', () => {
  it('returns the base untouched at zero and the overlay whole at one', () => {
    assert.deepEqual(blend(rgb('#1f6cb0'), rgb('#ffffff'), 0), rgb('#1f6cb0'))
    assert.deepEqual(blend(rgb('#1f6cb0'), rgb('#ffffff'), 1), rgb('#ffffff'))
  })

  it('mixes in the encoded values, the way a CSS rgba() background paints', () => {
    // Half of black over white is #808080 on screen, not the #bcbcbc a linear-light
    // mix would give. A ground measured the second way would not be the ground the
    // browser drew.
    assert.equal(formatHex(blend(rgb('#ffffff'), rgb('#000000'), 0.5)), '#808080')
  })

  it('gives the exact 28% white wash the topbar puts on its controls', () => {
    // 0.28 * 255 + 0.72 * 0xf2 = 245.6, 0.28 * 255 + 0.72 * 0xb4 = 201.0, and
    // 0.28 * 255 + 0.72 * 0x31 = 106.7.
    assert.equal(formatHex(blend(rgb('#f2b431'), rgb('#ffffff'), 0.28)), '#f6c96b')
  })

  it('always moves a light ground further from dark ink', () => {
    // The property the banner's light band rests on: a white wash over a light plate
    // can only raise the contrast the ink already had.
    const ink = rgb('#33240f')
    for (const plate of ['#f2b431', '#e8d4a1', '#aacce8', '#c9b3e5']) {
      const washed = blend(rgb(plate), rgb('#ffffff'), 0.28)
      assert.ok(contrastRatio(ink, washed) > contrastRatio(ink, rgb(plate)), plate)
    }
  })

  it('clamps an alpha outside the range instead of extrapolating', () => {
    assert.deepEqual(blend(rgb('#1f6cb0'), rgb('#ffffff'), -1), rgb('#1f6cb0'))
    assert.deepEqual(blend(rgb('#1f6cb0'), rgb('#ffffff'), 4), rgb('#ffffff'))
  })
})

describe('rgbToLab and deltaE76', () => {
  it('puts white at L*100 with no chroma and black at L*0', () => {
    const white = rgbToLab(rgb('#ffffff'))
    assert.equal(white.l.toFixed(3), '100.000')
    assert.ok(Math.abs(white.a) < 0.001 && Math.abs(white.b) < 0.001)
    assert.equal(rgbToLab(rgb('#000000')).l.toFixed(3), '0.000')
  })

  it('puts mid gray at L*53.6, not at 50 — Lab is perceptual, sRGB is not', () => {
    assert.equal(rgbToLab(rgb('#808080')).l.toFixed(1), '53.6')
  })

  it('is 0 for a color against itself and 100 for black against white', () => {
    assert.equal(deltaE76(rgb('#1f6cb0'), rgb('#1f6cb0')), 0)
    assert.equal(deltaE76(rgb('#000000'), rgb('#ffffff')).toFixed(3), '100.000')
  })
})

describe('hueDistance', () => {
  it('takes the shorter way round the circle', () => {
    assert.equal(Math.round(hueDistance(rgb('#ff0000'), rgb('#00ffff'))), 180)
    assert.ok(hueDistance(rgb('#ff0000'), rgb('#ff8800')) < 40)
    // 350° and 10° are 20 apart, not 340.
    assert.ok(hueDistance(hslToRgb({ h: 350, s: 0.8, l: 0.5 }), hslToRgb({ h: 10, s: 0.8, l: 0.5 })) < 21)
  })

  it('calls a near-gray maximally distant, because a gray has no hue', () => {
    assert.ok(rgbToHsl(rgb('#3a3a3a')).s < GRAY_SATURATION)
    assert.equal(hueDistance(rgb('#3a3a3a'), rgb('#00ff00')), 180)
  })

  it('cannot see the failure it is usually invoked for', () => {
    // The point the brief asks to be made explicit. These two are 164° apart in hue
    // and 1.07:1 in contrast: as far apart as colors get on the wheel, and one
    // invisible on the other. Hue distance is a *secondary* constraint here; contrast
    // is the guard.
    const pale = rgb('#dceaf6')
    const parchment = rgb('#f6efdc')
    assert.ok(hueDistance(pale, parchment) > 150)
    assert.ok(contrastRatio(pale, parchment) < 1.1)
  })
})

describe('simulateVision', () => {
  it('collapses red and green onto one axis for a deuteranope', () => {
    // Both become yellows; what is left of the difference is lightness.
    const red = simulateVision(rgb('#ff0000'), 'deuteranopia')
    const green = simulateVision(rgb('#00ff00'), 'deuteranopia')
    assert.equal(red.r, red.g, 'red and green channels equalize')
    assert.equal(green.r, green.g)
    assert.ok(deltaE76(red, green) < deltaE76(rgb('#ff0000'), rgb('#00ff00')) / 4)
  })

  it('leaves blue against yellow alone, which is why it is the safe axis', () => {
    const before = deltaE76(rgb('#0000ff'), rgb('#ffff00'))
    const after = colorBlindDelta(rgb('#0000ff'), rgb('#ffff00'))
    assert.ok(after > before * 0.9, `${after} should be close to ${before}`)
  })

  it('leaves a gray a gray', () => {
    const gray = simulateVision(rgb('#808080'), 'protanopia')
    assert.ok(Math.abs(gray.r - gray.b) <= 2 && Math.abs(gray.r - gray.g) <= 2)
  })
})

describe('distinguishable', () => {
  it('accepts the shipped accent against the shipped status colors', () => {
    for (const status of ['#3f9e28', '#c4342c', '#e8a022']) {
      assert.equal(distinguishable(rgb('#1f6cb0'), rgb(status)).ok, true, status)
    }
  })

  it('refuses a color against itself, and says the reason is similarity', () => {
    const same = distinguishable(rgb('#1f6cb0'), rgb('#1f6cb0'))
    assert.equal(same.ok, false)
    assert.equal(same.reason, 'too-similar')
    assert.equal(same.deltaE, 0)
  })

  it('refuses two colors that only a color-blind reader would confuse', () => {
    // The app's own green and red: 107 ΔE apart in ordinary vision and 8 apart under
    // deuteranopia. It is recorded here rather than fixed, because those two are not
    // the user's to change and the app never leans on the color alone — every status
    // in this UI carries a word as well. What it does mean is that a user-chosen
    // accent has to clear this bar, which is what the scheme module enforces.
    const pair = distinguishable(rgb('#3f9e28'), rgb('#c4342c'))
    assert.equal(pair.ok, false)
    assert.equal(pair.reason, 'too-similar-color-blind')
    assert.ok(pair.deltaE > 100, 'far apart for most readers')
    assert.ok(pair.colorBlindDeltaE < 10, 'and nearly the same color for some')
  })

  it('refuses a hue that is barely turned, even when the shades differ a little', () => {
    const close = distinguishable(
      hslToRgb({ h: 200, s: 0.7, l: 0.45 }),
      hslToRgb({ h: 205, s: 0.7, l: 0.62 }),
    )
    assert.equal(close.ok, false)
    assert.ok(close.hueDegrees < 18)
  })

  it('reports the three measurements whether or not it accepts the pair', () => {
    // The picker's message names which test failed, so every one of them has to be on
    // the result rather than folded into a boolean.
    const result = distinguishable(rgb('#1f6cb0'), rgb('#3f9e28'))
    assert.ok(result.deltaE > MIN_DELTA_E)
    assert.ok(result.colorBlindDeltaE > 0)
    assert.ok(result.hueDegrees > 0)
    assert.equal(result.reason, null)
  })
})
