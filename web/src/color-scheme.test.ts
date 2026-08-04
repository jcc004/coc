import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contrastRatio, distinguishable, parseHex, rgbToHsl, type Rgb } from './color-contrast.ts'
import {
  ACCENT_PRESETS,
  BODY_TEXT_RATIO,
  CHROME_PRESETS,
  colorSchemeKey,
  DEFAULT_SCHEME,
  describeAccent,
  describeChrome,
  fitAccent,
  fitChrome,
  GRAPHIC_RATIO,
  isDefaultScheme,
  MIN_PLATE_LIGHTNESS,
  nearestUsableAccent,
  parseScheme,
  presetsFor,
  SCHEME_ROLES,
  SCHEME_THEMES,
  SCHEME_VARIABLES,
  schemeSummary,
  schemeVariables,
  serialiseScheme,
  SHIPPED,
  THEME_BACKDROP,
  type AccentRoles,
  type SchemeTheme,
} from './color-scheme.ts'

const rgb = (hex: string): Rgb => {
  const parsed = parseHex(hex)
  assert.ok(parsed, `${hex} should parse`)
  return parsed
}

const ratio = (a: string, b: string): number => contrastRatio(rgb(a), rgb(b))

/** The accent's roles in one theme, or a failed assertion naming what was refused. */
function accentIn(hex: string, theme: SchemeTheme): AccentRoles {
  const fit = fitAccent(hex)
  assert.equal(fit.status, 'fitted', `${hex} should be usable as an accent`)
  if (fit.status !== 'fitted') throw new Error('unreachable')
  return (theme === 'light' ? fit.light : fit.dark).roles
}

describe('the shipped themes', () => {
  it('writes no variables at all when nothing has been chosen', () => {
    // The whole promise of the feature. Every role in styles.css is
    // `var(--user-…, <shipped>)`, so an empty map is the light and dark themes
    // rendering exactly the bytes they rendered before any of this existed.
    assert.deepEqual(schemeVariables(DEFAULT_SCHEME), {})
  })

  it('writes only the chosen half when one role is left alone', () => {
    const names = Object.keys(schemeVariables({ accent: '#7a4fd0', chrome: null }))
    assert.equal(
      names.every((name) => name.includes('accent') || name.includes('track')),
      true,
      names.join(', '),
    )
    assert.equal(
      Object.keys(schemeVariables({ accent: null, chrome: '#7fc9a8' })).some((name) =>
        name.includes('accent'),
      ),
      false,
    )
  })

  it('never writes a name the applier does not know how to clear', () => {
    // A variable missing from SCHEME_VARIABLES would survive a Reset as a colour
    // nobody can change again.
    for (const name of Object.keys(schemeVariables({ accent: '#12867f', chrome: '#e08a4c' }))) {
      assert.ok(SCHEME_VARIABLES.includes(name), `${name} is not in SCHEME_VARIABLES`)
    }
  })

  it('sets every variable it can, when both roles are chosen', () => {
    const written = Object.keys(schemeVariables({ accent: '#12867f', chrome: '#e08a4c' }))
    assert.deepEqual([...written].sort(), [...SCHEME_VARIABLES].sort())
  })

  it('leaves a stored colour the guard would now refuse out of the variables', () => {
    assert.deepEqual(schemeVariables({ accent: '#00ff00', chrome: null }), {})
  })
})

describe('fitting the accent', () => {
  it('gives every theme a shade that clears 4.5:1 on both of its grounds', () => {
    // Links are drawn in the accent, at body size, on the card surface *and* on the
    // page behind the footer.
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = accentIn(preset.hex, theme)
        const backdrop = THEME_BACKDROP[theme]
        assert.ok(
          ratio(roles.accent, backdrop.surface) >= BODY_TEXT_RATIO,
          `${preset.label} on ${theme} surface: ${ratio(roles.accent, backdrop.surface).toFixed(2)}`,
        )
        assert.ok(
          ratio(roles.accent, backdrop.plane) >= BODY_TEXT_RATIO,
          `${preset.label} on ${theme} plane: ${ratio(roles.accent, backdrop.plane).toFixed(2)}`,
        )
      }
    }
  })

  it('keeps the hover shade at least as readable as the resting one', () => {
    // Hover moves *away* from the page, so it can never be the state that fails a
    // ratio the resting colour passed.
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = accentIn(preset.hex, theme)
        const ground = THEME_BACKDROP[theme].surface
        assert.ok(
          ratio(roles.accentHover, ground) >= ratio(roles.accent, ground),
          `${preset.label}, ${theme}`,
        )
      }
    }
  })

  it('gives the meter fill 3:1 against its own groove', () => {
    // WCAG 1.4.11: a graphical object, not text, so 3 rather than 4.5.
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = accentIn(preset.hex, theme)
        assert.ok(
          ratio(roles.accent, roles.track) >= GRAPHIC_RATIO,
          `${preset.label}, ${theme}: ${ratio(roles.accent, roles.track).toFixed(2)}`,
        )
      }
    }
  })

  it('builds the groove out of the accent, not out of the parchment', () => {
    // A wash into the surface gave a blue accent a green-grey groove, because the
    // parchment carries its own hue. The shipped light track is #cfe0f2.
    const track = accentIn('#1f6cb0', 'light').track
    assert.ok(hueGap(track, '#1f6cb0') < 12, `${track} should still be the accent's hue`)
  })

  it('fits the same colour differently in the two themes', () => {
    // The reason a single stored hex is not enough, and the reason a picker that
    // refused colours failing on both grounds at once would refuse nearly everything.
    const light = accentIn('#7a4fd0', 'light').accent
    const dark = accentIn('#7a4fd0', 'dark').accent
    assert.notEqual(light, dark)
    assert.ok(luminanceOf(light) < luminanceOf(dark), 'darker on parchment, lighter on wood')
  })

  it('deepens the shipped blue rather than pretending 4.02:1 passes', () => {
    // styles.css ships #1f6cb0, which measures 4.02:1 against the plane. Picking it
    // moves it; the shipped theme itself is untouched, and is one Reset away.
    const fitted = fitAccent(SHIPPED.accent)
    assert.equal(fitted.status, 'fitted')
    if (fitted.status !== 'fitted') return
    assert.equal(fitted.light.moved, true)
    assert.ok(ratio(fitted.light.roles.accent, THEME_BACKDROP.light.plane) >= BODY_TEXT_RATIO)
  })

  it('stays near the colour that was asked for', () => {
    // Fitting is a nudge along one axis, not a substitution: hue and saturation are
    // the user's, and only lightness is the guard's.
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        assert.ok(hueGap(accentIn(preset.hex, theme).accent, preset.hex) < 6, preset.label)
      }
    }
  })

  it('clamps white and black instead of refusing them', () => {
    // Neither is a sensible accent and neither is an error. White becomes a dark grey
    // on parchment and stays near-white on wood, which is what the user asked for as
    // closely as the ground allows.
    for (const extreme of ['#ffffff', '#000000']) {
      const fit = fitAccent(extreme)
      assert.equal(fit.status, 'fitted', extreme)
      if (fit.status !== 'fitted') continue
      assert.equal(fit.light.moved || fit.dark.moved, true)
      assert.ok(ratio(fit.light.roles.accent, THEME_BACKDROP.light.surface) >= BODY_TEXT_RATIO)
      assert.ok(ratio(fit.dark.roles.accent, THEME_BACKDROP.dark.surface) >= BODY_TEXT_RATIO)
    }
  })

  it('rescues a colour that is invisible on the ground it was picked against', () => {
    // #dceaf6 is 1.07:1 on parchment — the white-on-white case, with a hue 164° away
    // to prove hue distance would not have caught it.
    assert.ok(ratio('#dceaf6', THEME_BACKDROP.light.surface) < 1.1)
    const fitted = accentIn('#dceaf6', 'light').accent
    assert.ok(ratio(fitted, THEME_BACKDROP.light.surface) >= BODY_TEXT_RATIO)
  })

  it('refuses nothing for contrast alone, because there is always a shade', () => {
    // Every hue at every saturation has a readable shade in each theme. This is what
    // makes fitting the right answer and rejection the exception.
    for (let hue = 0; hue < 360; hue += 30) {
      for (const saturation of [0.15, 0.55, 1]) {
        const fit = fitAccent(hexAt(hue, saturation, 0.5))
        assert.notEqual(fit.status, 'unreadable', `${hue}° at ${saturation}`)
        assert.notEqual(fit.status, 'invalid')
      }
    }
  })

  it('refuses a colour it cannot read at all', () => {
    assert.equal(fitAccent('not-a-colour').status, 'invalid')
    assert.equal(fitChrome('#zzzzzz').status, 'invalid')
  })

  it('gives the same answer every time it is asked', () => {
    assert.deepEqual(fitAccent('#b8399b'), fitAccent('#b8399b'))
  })
})

describe('the accent against the colours that mean something', () => {
  it('refuses a green, because the maxed meter is green', () => {
    // `.meter__fill` is the accent and `.meter__fill--max` is --good, in the same
    // list. An accent that matched it would delete the distinction.
    const fit = fitAccent('#3f9e28')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.equal(fit.against, 'good')
  })

  it('refuses a red, because an error notice is red', () => {
    const fit = fitAccent('#d62b22')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.ok(fit.against === 'critical' || fit.against === 'good')
  })

  it('refuses a colour only a colour-blind reader would confuse with the green', () => {
    // Pure red against the maxed green is 170 ΔE for most readers and 8 for a
    // deuteranope. This is the case hue distance and plain ΔE both wave through.
    const fit = fitAccent('#ff0000')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.equal(fit.reason, 'too-similar-colour-blind')
    assert.equal(fit.against, 'good')
  })

  it('keeps every fitted accent distinct from both status colours, in both themes', () => {
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const accent = accentIn(preset.hex, theme).accent
        for (const status of [THEME_BACKDROP[theme].good, THEME_BACKDROP[theme].critical]) {
          const verdict = distinguishable(rgb(accent), rgb(status))
          assert.equal(verdict.ok, true, `${preset.label} vs ${status} in ${theme}`)
        }
      }
    }
  })

  it('offers the nearest hue that would have worked, and that hue really works', () => {
    // "Not available" with nothing after it is the wall. The suggestion is a rotation
    // of the same colour, so it is recognisably what was asked for.
    const fit = fitAccent('#00ff00')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.ok(fit.suggestion, 'a green should be rescuable by turning the hue')
    if (!fit.suggestion) return
    assert.equal(fitAccent(fit.suggestion).status, 'fitted')
    assert.ok(hueGap(fit.suggestion, '#00ff00') < 90)
  })

  it('returns nothing to suggest for a colour it cannot even read', () => {
    assert.equal(nearestUsableAccent('nonsense'), null)
  })
})

describe('fitting the plate', () => {
  it('leaves the shipped gold exactly where it is', () => {
    const fit = fitChrome(SHIPPED.chrome)
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    assert.equal(fit.light.roles.gold, SHIPPED.chrome)
    assert.equal(fit.light.moved, false)
  })

  it('rediscovers the two decisions the stylesheet made by hand', () => {
    // styles.css: "Gold at full chroma fails contrast as text on parchment, so light
    // mode's --display is the deep gold and only dark mode uses the bright one." The
    // derivation arrives at the same place from the ratios alone.
    const fit = fitChrome(SHIPPED.chrome)
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    assert.equal(fit.dark.roles.display, fit.dark.roles.gold, 'bright gold sings on dark wood')
    assert.ok(
      luminanceOf(fit.light.roles.display) < luminanceOf(fit.light.roles.gold) / 2,
      'and is deepened on parchment',
    )
    assert.ok(ratio('#f2b431', THEME_BACKDROP.light.surface) < 2, 'the plate itself is ~1.9:1')
  })

  it('carries the plate ink across both stops of the gradient at 4.5:1', () => {
    // The topbar is a gradient and its buttons are 13px text; the ink has to survive
    // the darker end as well as the lighter one.
    for (const preset of CHROME_PRESETS) {
      const fit = fitChrome(preset.hex)
      assert.equal(fit.status, 'fitted', preset.label)
      if (fit.status !== 'fitted') continue
      for (const theme of SCHEME_THEMES) {
        const roles = (theme === 'light' ? fit.light : fit.dark).roles
        const ink = THEME_BACKDROP[theme].plateInk
        assert.ok(ratio(ink, roles.gold) >= BODY_TEXT_RATIO, `${preset.label} ${theme} top`)
        assert.ok(ratio(ink, roles.goldDeep) >= BODY_TEXT_RATIO, `${preset.label} ${theme} deep`)
      }
    }
  })

  it('keeps the display numerals readable on the card, whatever the plate is', () => {
    // `.section-title` is 12px, so 4.5:1 — the large-text allowance the 48px numerals
    // could claim is not available to the heading that shares the role.
    for (const preset of CHROME_PRESETS) {
      const fit = fitChrome(preset.hex)
      assert.equal(fit.status, 'fitted', preset.label)
      if (fit.status !== 'fitted') continue
      for (const theme of SCHEME_THEMES) {
        const roles = (theme === 'light' ? fit.light : fit.dark).roles
        assert.ok(
          ratio(roles.display, THEME_BACKDROP[theme].surface) >= BODY_TEXT_RATIO,
          `${preset.label} ${theme}: ${ratio(roles.display, THEME_BACKDROP[theme].surface).toFixed(2)}`,
        )
      }
    }
  })

  it('raises a dark pick into the band the plate was drawn for', () => {
    // The white bevel, the white button wash and the emboss under the title all
    // assume a light plate. Restricting the range is the constraint; the message says
    // what happened.
    const fit = fitChrome('#101010')
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    assert.ok(rgbToHsl(rgb(fit.light.roles.gold)).l >= MIN_PLATE_LIGHTNESS - 0.001)
    assert.equal(fit.light.moved, true)
  })

  it('keeps the edge and the deep stop darker than the plate, so it still reads as one', () => {
    for (const preset of CHROME_PRESETS) {
      const fit = fitChrome(preset.hex)
      if (fit.status !== 'fitted') continue
      const roles = fit.light.roles
      assert.ok(luminanceOf(roles.goldDeep) < luminanceOf(roles.gold), preset.label)
      assert.ok(luminanceOf(roles.goldEdge) < luminanceOf(roles.goldDeep), preset.label)
    }
  })

  it('never refuses a plate, because the ink is chosen after the shade', () => {
    for (let hue = 0; hue < 360; hue += 20) {
      for (const lightness of [0.1, 0.5, 0.95]) {
        assert.equal(fitChrome(hexAt(hue, 0.8, lightness)).status, 'fitted', `${hue}°`)
      }
    }
  })
})

describe('the offered swatches', () => {
  it('offers colours for both roles, each with an id and a label', () => {
    for (const role of SCHEME_ROLES) {
      const presets = presetsFor(role)
      assert.ok(presets.length >= 5, role)
      for (const preset of presets) {
        assert.match(preset.id, /^[a-z]+$/)
        assert.ok(preset.label.length > 0)
        assert.ok(parseHex(preset.hex), `${preset.id} is a colour`)
      }
    }
  })

  it('gives every swatch a distinct id and a distinct colour', () => {
    for (const role of SCHEME_ROLES) {
      const presets = presetsFor(role)
      assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length)
      assert.equal(new Set(presets.map((preset) => preset.hex)).size, presets.length)
    }
  })

  it('offers nothing the guard would refuse', () => {
    // The constrained path has to be a path: a swatch that produced a refusal would
    // be the picker arguing with itself.
    for (const preset of ACCENT_PRESETS) assert.equal(fitAccent(preset.hex).status, 'fitted')
    for (const preset of CHROME_PRESETS) assert.equal(fitChrome(preset.hex).status, 'fitted')
  })

  it('spreads the accents around the circle rather than offering six blues', () => {
    const hues = ACCENT_PRESETS.map((preset) => rgbToHsl(rgb(preset.hex)).h)
    for (let i = 0; i < hues.length; i += 1) {
      for (let j = i + 1; j < hues.length; j += 1) {
        const a = hues[i] as number
        const b = hues[j] as number
        const gap = Math.abs(a - b) % 360
        assert.ok(Math.min(gap, 360 - gap) > 8, `${a.toFixed(0)}° and ${b.toFixed(0)}° are close`)
      }
    }
  })
})

describe('what the picker says', () => {
  it('names the shade each theme was given', () => {
    const message = describeAccent('#7a4fd0', fitAccent('#7a4fd0'))
    assert.match(message, /#7042cc/)
    assert.match(message, /#9572d9/)
  })

  it('says so plainly when one shade serves both themes', () => {
    assert.match(describeChrome(SHIPPED.chrome, fitChrome(SHIPPED.chrome)), /both themes/)
  })

  it('says why a refused colour is refused, and what it collided with', () => {
    // A silently-refused input is the failure this message exists to prevent.
    const message = describeAccent('#00ff00', fitAccent('#00ff00'))
    assert.match(message, /Not available/)
    assert.match(message, /maxed/)
    assert.match(message, /nearest colour that works is #/)
  })

  it('names colour blindness when that is the test that failed', () => {
    assert.match(describeAccent('#ff0000', fitAccent('#ff0000')), /colour blindness/)
  })

  it('tells somebody who typed nonsense what to do instead', () => {
    assert.match(describeAccent('rebeccapurple', fitAccent('rebeccapurple')), /swatches/)
  })
})

describe('storage', () => {
  it('keys the scheme by account, the way the other per-person keys are', () => {
    assert.equal(colorSchemeKey(3), 'coc:colors:3')
    assert.notEqual(colorSchemeKey(1), colorSchemeKey(2))
  })

  it('round-trips a scheme through storage', () => {
    const scheme = { accent: '#12867f', chrome: '#e08a4c' }
    assert.deepEqual(parseScheme(serialiseScheme(scheme)), scheme)
  })

  it('normalises what it stores, so two spellings of one colour are one colour', () => {
    assert.deepEqual(parseScheme('{"accent":"#12867F","chrome":null}'), {
      accent: '#12867f',
      chrome: null,
    })
  })

  it('falls back to the shipped theme for anything it cannot read', () => {
    // Junk, an older shape, a hand-edited value, a missing key: all of them are the
    // shipped theme rather than a broken page.
    for (const stored of [
      null,
      undefined,
      '',
      'not json',
      '[]',
      '"#fff"',
      '42',
      '{}',
      '{"primary":"#ff0000"}',
      '{"accent":42}',
      '{"accent":"#zzzzzz"}',
      '{"accent":null,"chrome":null}',
    ]) {
      assert.deepEqual(parseScheme(stored), DEFAULT_SCHEME, JSON.stringify(stored))
    }
  })

  it('drops a stored colour that the guard would refuse today', () => {
    // A value written by a build with a laxer rule must not survive the rule change.
    assert.deepEqual(parseScheme('{"accent":"#00ff00","chrome":"#7fc9a8"}'), {
      accent: null,
      chrome: '#7fc9a8',
    })
  })

  it('keeps the good half of a half-broken value', () => {
    assert.deepEqual(parseScheme('{"accent":"#12867f","chrome":"oops"}'), {
      accent: '#12867f',
      chrome: null,
    })
  })

  it('takes an already-parsed object as well as a string', () => {
    assert.deepEqual(parseScheme({ accent: '#12867f', chrome: null }), {
      accent: '#12867f',
      chrome: null,
    })
  })
})

describe('the account menu line', () => {
  it('says Default until something is chosen', () => {
    assert.equal(schemeSummary(DEFAULT_SCHEME), 'Default')
    assert.equal(isDefaultScheme(DEFAULT_SCHEME), true)
  })

  it('distinguishes one customised role from both', () => {
    assert.equal(schemeSummary({ accent: '#12867f', chrome: null }), 'Custom accent')
    assert.equal(schemeSummary({ accent: null, chrome: '#e08a4c' }), 'Custom plate')
    assert.equal(schemeSummary({ accent: '#12867f', chrome: '#e08a4c' }), 'Custom')
    assert.equal(isDefaultScheme({ accent: '#12867f', chrome: null }), false)
  })
})

function luminanceOf(hex: string): number {
  return contrastRatio(rgb(hex), rgb('#000000'))
}

function hueGap(a: string, b: string): number {
  const gap = Math.abs(rgbToHsl(rgb(a)).h - rgbToHsl(rgb(b)).h) % 360
  return Math.min(gap, 360 - gap)
}

function hexAt(hue: number, saturation: number, lightness: number): string {
  const to255 = (value: number) => Math.round(value * 255)
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const base = lightness - chroma / 2
  const parts =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const channels = parts.map((part) =>
    to255(part + base)
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${channels.join('')}`
}
