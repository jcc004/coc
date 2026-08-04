import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  contrastRatio,
  distinguishable,
  parseHex,
  relativeLuminance,
  rgbToHsl,
  type Rgb,
} from './color-contrast.ts'
import {
  ACCENT_PRESETS,
  acceptsColor,
  BANNER_PRESETS,
  BODY_TEXT_RATIO,
  CHROME_PRESETS,
  colorSchemeKey,
  CONTROL_WASH_ALPHA,
  darkestBannerLuminance,
  DEFAULT_SCHEME,
  describeAccent,
  describeBanner,
  describeChrome,
  DEV_MARK,
  devMarkFloorAgainstBanner,
  fitAccent,
  fitBanner,
  fitChrome,
  GRAPHIC_RATIO,
  isDefaultScheme,
  MIN_PLATE_LIGHTNESS,
  nearestUsableAccent,
  parseScheme,
  presetsFor,
  roleOutcome,
  SCHEME_ROLES,
  SCHEME_THEMES,
  SCHEME_VARIABLES,
  schemeSummary,
  schemeVariables,
  serializeScheme,
  SHIPPED,
  THEME_BACKDROP,
  washedControlGround,
  withSchemeColor,
  type AccentRoles,
  type BannerRoles,
  type ColorScheme,
  type SchemeTheme,
} from './color-scheme.ts'

const rgb = (hex: string): Rgb => {
  const parsed = parseHex(hex)
  assert.ok(parsed, `${hex} should parse`)
  return parsed
}

const ratio = (a: string, b: string): number => contrastRatio(rgb(a), rgb(b))

/** A scheme with every role this test does not name left on the shipped theme. */
const scheme = (chosen: Partial<ColorScheme>): ColorScheme => ({ ...DEFAULT_SCHEME, ...chosen })

/** The accent's roles in one theme, or a failed assertion naming what was refused. */
function accentIn(hex: string, theme: SchemeTheme): AccentRoles {
  const fit = fitAccent(hex)
  assert.equal(fit.status, 'fitted', `${hex} should be usable as an accent`)
  if (fit.status !== 'fitted') throw new Error('unreachable')
  return (theme === 'light' ? fit.light : fit.dark).roles
}

/** The banner's roles in one theme, or a failed assertion naming what was refused. */
function bannerIn(hex: string, theme: SchemeTheme): BannerRoles {
  const fit = fitBanner(hex)
  assert.equal(fit.status, 'fitted', `${hex} should be usable as a banner`)
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

  it('writes only the chosen role when the other two are left alone', () => {
    const names = Object.keys(schemeVariables(scheme({ accent: '#7a4fd0' })))
    assert.equal(
      names.every((name) => name.includes('accent') || name.includes('track')),
      true,
      names.join(', '),
    )
    assert.equal(
      Object.keys(schemeVariables(scheme({ chrome: '#7fc9a8' }))).some((name) =>
        name.includes('accent'),
      ),
      false,
    )
  })

  it('leaves the banner to the plate when only the plate was chosen', () => {
    // The banner's fallback in styles.css is `var(--gold)`, not a color of its own, so
    // a plate with no banner has to write nothing for the banner and let the topbar
    // follow the plate — which is what everybody had before the banner existed.
    const names = Object.keys(schemeVariables(scheme({ chrome: '#e08a4c' })))
    assert.equal(
      names.some((name) => name.includes('banner')),
      false,
      names.join(', '),
    )
  })

  it('never writes a name the applier does not know how to clear', () => {
    // A variable missing from SCHEME_VARIABLES would survive a Reset as a color
    // nobody can change again.
    const chosen = { accent: '#12867f', chrome: '#e08a4c', banner: '#a9cbe8' }
    for (const name of Object.keys(schemeVariables(chosen))) {
      assert.ok(SCHEME_VARIABLES.includes(name), `${name} is not in SCHEME_VARIABLES`)
    }
  })

  it('sets every variable it can, when all three roles are chosen', () => {
    const written = Object.keys(
      schemeVariables({ accent: '#12867f', chrome: '#e08a4c', banner: '#a9cbe8' }),
    )
    assert.deepEqual([...written].sort(), [...SCHEME_VARIABLES].sort())
  })

  it('writes no ink variable for the banner, because the ink was never a choice', () => {
    // fitBanner moves the banner until the theme's plate ink clears the floor rather
    // than swapping the ink, so `--on-banner` stays the alias styles.css declares it
    // as. A `--user-on-banner-…` here would be a color with nothing deciding it.
    const written = Object.keys(schemeVariables(scheme({ banner: '#a9cbe8' })))
    assert.equal(
      written.some((name) => name.includes('on-banner')),
      false,
      written.join(', '),
    )
    assert.equal(written.length, 6, written.join(', '))
  })

  it('leaves a stored color the guard would now refuse out of the variables', () => {
    assert.deepEqual(schemeVariables(scheme({ accent: '#00ff00' })), {})
  })
})

/**
 * The half of the promise that lives in the other file.
 *
 * `schemeVariables` can only keep the shipped themes byte-identical if `styles.css`
 * holds up its end: every name written has to be read somewhere, every `var(--user-…)`
 * has to carry a fallback, and the banner's fallback has to be the plate rather than a
 * color somebody chose. None of that is visible from a unit test on the module, and
 * all of it breaks silently.
 */
describe('the stylesheet contract', () => {
  const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

  /** Every declaration block belonging to exactly this selector. */
  function bodiesFor(selector: string): string[] {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'g')
    return [...stylesheet.matchAll(pattern)].map((match) => match[1] ?? '')
  }

  it('reads every variable the scheme can write', () => {
    // A name the module writes and the stylesheet never mentions is a color that
    // reaches the root element and paints nothing.
    for (const name of SCHEME_VARIABLES) {
      assert.ok(stylesheet.includes(name), `${name} is written but never read`)
    }
  })

  it('gives every user variable a fallback, which is what keeps the themes shipped', () => {
    // `var(--user-x)` with nothing after the comma resolves to nothing at all when the
    // user has chosen nothing, so one missing fallback is one unpainted role.
    const missing = stylesheet.match(/var\(\s*--user-[a-z-]+\s*\)/g)
    assert.equal(missing, null, `${missing?.join(', ')} have no shipped value behind them`)
  })

  it('falls the banner back to the plate rather than to a color somebody picked', () => {
    // A default banner is not a color and must not become one: with nothing chosen,
    // and with a plate chosen and no banner, the topbar is whatever the gold is.
    for (const [role, gold] of [
      ['banner', 'gold'],
      ['banner-deep', 'gold-deep'],
      ['banner-edge', 'gold-edge'],
    ] as const) {
      for (const theme of SCHEME_THEMES) {
        assert.ok(
          stylesheet.includes(`--${role}: var(--user-${role}-${theme}, var(--${gold}))`),
          `--${role} in ${theme} should fall back to --${gold}`,
        )
      }
    }
  })

  it('paints the topbar from the banner and leaves the rest of the chrome on the gold', () => {
    const topbar = bodiesFor('.topbar').join('\n')
    assert.match(topbar, /background:\s*linear-gradient\([^)]*var\(--banner\)/)
    assert.match(topbar, /border:\s*1px solid var\(--banner-edge\)/)
    assert.equal(/var\(--gold/.test(topbar), false, 'the topbar no longer names the gold')

    // The three the split had to leave behind, or "banner" would just be "plate".
    for (const selector of ['.card-tile__badge', '.card,\n.tiles,\n.notice']) {
      assert.match(bodiesFor(selector).join('\n'), /var\(--gold/, selector)
    }
  })

  it('keeps the rosette on the ink the title link inherits', () => {
    // The mark paints in `currentColor` and has no color of its own, so the chain is
    // .topbar -> .topbar__title -> .topbar__title a -> the SVG. Give the rosette a
    // color, or drop `inherit` from the link, and the mark vanishes into the banner.
    assert.match(bodiesFor('.topbar').join('\n'), /color:\s*var\(--on-banner\)/)
    assert.match(bodiesFor('.topbar__title a').join('\n'), /color:\s*inherit/)
    const rosette = bodiesFor('.topbar__rosette').join('\n')
    assert.ok(rosette.length > 0, 'the rosette rule should exist')
    assert.equal(/(^|[;\s])(color|fill|stroke)\s*:/.test(rosette), false, rosette)
  })

  it('leaves the dev marker unreachable from the picker', () => {
    // The marker exists to be unmistakable for the live host, so a user who could
    // restyle it could hide it. This is what is left of the same guarantee after the
    // roles went from four to two: the tarnished plate is gone, but the two colors the
    // marker is drawn in still take nothing from --user-….
    for (const role of ['--dev', '--on-dev']) {
      const declarations = stylesheet.match(new RegExp(`${role}:[^;]*;`, 'g')) ?? []
      assert.ok(declarations.length > 0, role)
      for (const declaration of declarations) {
        assert.equal(declaration.includes('--user-'), false, declaration)
      }
    }
  })

  it('declares the dev marker in exactly the pair the module measures', () => {
    // DEV_MARK is a copy, the way THEME_BACKDROP is, and a copy that drifts is a
    // contrast figure measured against a color nobody is looking at.
    for (const [role, value] of [
      ['--dev', DEV_MARK.plate],
      ['--on-dev', DEV_MARK.ink],
    ] as const) {
      const declarations = stylesheet.match(new RegExp(`${role}:[^;]*;`, 'g')) ?? []
      assert.deepEqual(declarations, [`${role}: ${value};`], role)
    }
  })

  it('declares that pair once rather than once per theme', () => {
    // The marker sits on the banner and the banner is light in both themes, so a
    // second copy in a dark block would be a value with nothing to adapt to — and,
    // being a copy, the one that silently disagrees later.
    assert.equal((stylesheet.match(/--dev:/g) ?? []).length, 1)
    assert.equal((stylesheet.match(/--on-dev:/g) ?? []).length, 1)
  })

  it('lets the chosen banner win on a dev install, because nothing repaints it', () => {
    // The regression this replaced. `.topbar--dev` overrode the background, the
    // border, the ink and the shadow, and it came after `.topbar` at equal
    // specificity, so the banner color a user picked did nothing anywhere except
    // production — the one install where nobody is picking one. The rule is gone, the
    // modifier is gone from App.tsx with it, and the marker carries the warning alone.
    assert.equal(stylesheet.includes('topbar--dev'), false, 'the dev banner override is back')
    const topbar = bodiesFor('.topbar').join('\n')
    assert.equal(/var\(--dev|var\(--on-dev/.test(topbar), false, topbar)

    const marker = bodiesFor('.topbar__env').join('\n')
    assert.match(marker, /background:\s*var\(--dev\)/)
    assert.match(marker, /color:\s*var\(--on-dev\)/)
    // The title's emboss is drawn for dark ink on a light plate. Inherited onto the
    // marker's dark one it fringes the letters instead of lifting them.
    assert.match(marker, /text-shadow:\s*none/)
  })
})

/**
 * The marker that replaced the dev banner.
 *
 * Two claims, and the second is the one the change turns on. Its ink has to be readable
 * on its own plate, which is fixed arithmetic. And its plate has to stand off **every**
 * banner the picker can produce, which is not a fixed pair at all — the background under
 * the marker is now whatever the user chose. A tarnished-gold marker would have failed
 * that second one outright: a banner near `#c99a2e` puts it at 1:1 against itself.
 */
describe('the dev marker', () => {
  it('carries its own ink at the body-text floor', () => {
    // 6.70:1. The same two colors as the old banner, swapped, so this is a number that
    // was already measured rather than one this change had to find.
    const measured = ratio(DEV_MARK.ink, DEV_MARK.plate)
    assert.ok(measured >= BODY_TEXT_RATIO, `${measured.toFixed(2)}`)
  })

  it('is darker than the darkest banner, which is what makes the floor a floor', () => {
    // `devMarkFloorAgainstBanner` divides one luminance by the other and calls the
    // answer a worst case. That is only true while the marker sits below the whole
    // band; a lighter marker would land somewhere inside it and the quotient would
    // stop meaning anything.
    for (const theme of SCHEME_THEMES) {
      const plate = relativeLuminance(rgb(DEV_MARK.plate))
      assert.ok(plate < darkestBannerLuminance(theme), `${theme}: ${plate.toFixed(4)}`)
    }
  })

  it('clears the graphic floor against the darkest banner arithmetic allows', () => {
    // The proof, as opposed to the sweep below: every banner stop the app can paint
    // carries the plate ink at 4.5:1, which is a floor on its luminance, and this is
    // the marker measured against that floor. 5.18 light and 4.67 dark.
    for (const theme of SCHEME_THEMES) {
      const floor = devMarkFloorAgainstBanner(theme)
      assert.ok(floor >= GRAPHIC_RATIO, `${theme}: ${floor.toFixed(2)}`)
    }
  })

  it('stands off every banner the picker offers, at both stops and in both themes', () => {
    for (const preset of BANNER_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = bannerIn(preset.hex, theme)
        for (const stop of [roles.banner, roles.bannerDeep]) {
          const measured = ratio(DEV_MARK.plate, stop)
          assert.ok(
            measured >= GRAPHIC_RATIO,
            `${preset.label} ${theme} ${stop}: ${measured.toFixed(2)}`,
          )
        }
      }
    }
  })

  it('stands off a banner typed in by hand, anywhere on the circle', () => {
    // The presets are the guided path; the custom input is the one that can produce a
    // color nobody looked at. Nothing in here may bring the marker under the floor,
    // and nothing may come in under the derived worst case either — a sample below
    // the proof would mean the proof is wrong.
    for (let hue = 0; hue < 360; hue += 15) {
      for (const saturation of [0, 0.35, 0.7, 1]) {
        for (const lightness of [0.05, 0.5, 0.99]) {
          const chosen = hexAt(hue, saturation, lightness)
          for (const theme of SCHEME_THEMES) {
            const roles = bannerIn(chosen, theme)
            for (const stop of [roles.banner, roles.bannerDeep]) {
              const measured = ratio(DEV_MARK.plate, stop)
              const floor = Math.max(GRAPHIC_RATIO, devMarkFloorAgainstBanner(theme) - 0.01)
              assert.ok(measured >= floor, `${chosen} ${theme} ${stop}: ${measured.toFixed(2)}`)
            }
          }
        }
      }
    }
  })

  it('stands off the banner an unchosen scheme leaves behind, which is the plate', () => {
    // `--banner` falls back to `--gold`, so on a dev install with no banner chosen the
    // marker is sitting on whatever the plate is. The shipped gold leads CHROME_PRESETS
    // and is what almost every dev install actually shows.
    for (const preset of CHROME_PRESETS) {
      const fit = fitChrome(preset.hex)
      assert.equal(fit.status, 'fitted', preset.label)
      if (fit.status !== 'fitted') continue
      for (const theme of SCHEME_THEMES) {
        const roles = (theme === 'light' ? fit.light : fit.dark).roles
        for (const stop of [roles.gold, roles.goldDeep]) {
          const measured = ratio(DEV_MARK.plate, stop)
          assert.ok(
            measured >= GRAPHIC_RATIO,
            `${preset.label} ${theme} ${stop}: ${measured.toFixed(2)}`,
          )
        }
      }
    }
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
    // ratio the resting color passed.
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
    // A wash into the surface gave a blue accent a green-gray groove, because the
    // parchment carries its own hue. The shipped light track is #cfe0f2.
    const track = accentIn('#1f6cb0', 'light').track
    assert.ok(hueGap(track, '#1f6cb0') < 12, `${track} should still be the accent's hue`)
  })

  it('fits the same color differently in the two themes', () => {
    // The reason a single stored hex is not enough, and the reason a picker that
    // refused colors failing on both grounds at once would refuse nearly everything.
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

  it('stays near the color that was asked for', () => {
    // Fitting is a nudge along one axis, not a substitution: hue and saturation are
    // the user's, and only lightness is the guard's.
    for (const preset of ACCENT_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        assert.ok(hueGap(accentIn(preset.hex, theme).accent, preset.hex) < 6, preset.label)
      }
    }
  })

  it('clamps white and black instead of refusing them', () => {
    // Neither is a sensible accent and neither is an error. White becomes a dark gray
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

  it('rescues a color that is invisible on the ground it was picked against', () => {
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

  it('refuses a color it cannot read at all', () => {
    assert.equal(fitAccent('not-a-color').status, 'invalid')
    assert.equal(fitChrome('#zzzzzz').status, 'invalid')
  })

  it('gives the same answer every time it is asked', () => {
    assert.deepEqual(fitAccent('#b8399b'), fitAccent('#b8399b'))
  })
})

describe('the accent against the colors that mean something', () => {
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

  it('refuses a color only a color-blind reader would confuse with the green', () => {
    // Pure red against the maxed green is 170 ΔE for most readers and 8 for a
    // deuteranope. This is the case hue distance and plain ΔE both wave through.
    const fit = fitAccent('#ff0000')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.equal(fit.reason, 'too-similar-color-blind')
    assert.equal(fit.against, 'good')
  })

  it('keeps every fitted accent distinct from both status colors, in both themes', () => {
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
    // of the same color, so it is recognizably what was asked for.
    const fit = fitAccent('#00ff00')
    assert.equal(fit.status, 'clash')
    if (fit.status !== 'clash') return
    assert.ok(fit.suggestion, 'a green should be rescuable by turning the hue')
    if (!fit.suggestion) return
    assert.equal(fitAccent(fit.suggestion).status, 'fitted')
    assert.ok(hueGap(fit.suggestion, '#00ff00') < 90)
  })

  it('returns nothing to suggest for a color it cannot even read', () => {
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

describe('fitting the banner', () => {
  it('leaves the topbar exactly as it is when the shipped gold is chosen', () => {
    // The banner's shipped value is the plate's, because the plate is what paints the
    // topbar today. Choosing it explicitly must be a no-op on screen.
    const fit = fitBanner(SHIPPED.banner)
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    assert.equal(fit.light.roles.banner, SHIPPED.chrome)
    assert.equal(fit.light.moved, false)
  })

  it('carries the banner ink across both stops of the gradient at 4.5:1', () => {
    // The title, the rosette inside it and up to five controls all paint in one ink,
    // and the smallest of them is 13px, so 4.5 governs the whole banner. The gradient
    // means the ink has to survive the darker end as well as the lighter one.
    for (const preset of BANNER_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = bannerIn(preset.hex, theme)
        const ink = THEME_BACKDROP[theme].plateInk
        for (const [where, stop] of [
          ['top', roles.banner],
          ['deep', roles.bannerDeep],
        ] as const) {
          assert.ok(
            ratio(ink, stop) >= BODY_TEXT_RATIO,
            `${preset.label} ${theme} ${where}: ${ratio(ink, stop).toFixed(2)}`,
          )
        }
      }
    }
  })

  it('checks the ink against the washed ground a control actually gives it', () => {
    // `.topbar .icon-button` is rgba(255,255,255,0.28) over the banner, so the ink
    // under a control is not on the banner at all.
    for (const preset of BANNER_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = bannerIn(preset.hex, theme)
        const ink = rgb(THEME_BACKDROP[theme].plateInk)
        for (const stop of [roles.banner, roles.bannerDeep]) {
          const washed = washedControlGround(rgb(stop))
          assert.ok(
            contrastRatio(ink, washed) >= BODY_TEXT_RATIO,
            `${preset.label} ${theme}: ${contrastRatio(ink, washed).toFixed(2)}`,
          )
        }
      }
    }
  })

  it('is stricter at the gradient stops than under the wash, which is why the band holds', () => {
    // The claim the fit rests on: inside the light band, white at 28% moves the ground
    // *away* from the dark ink, so measuring the bare stops already covers the
    // controls. Outside the band it would invert, and that is the second reason the
    // banner is restricted rather than checked.
    assert.ok(CONTROL_WASH_ALPHA > 0 && CONTROL_WASH_ALPHA < 1)
    for (const preset of BANNER_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        const roles = bannerIn(preset.hex, theme)
        const ink = rgb(THEME_BACKDROP[theme].plateInk)
        for (const stop of [roles.banner, roles.bannerDeep]) {
          const bare = contrastRatio(ink, rgb(stop))
          const washed = contrastRatio(ink, washedControlGround(rgb(stop)))
          assert.ok(washed > bare, `${preset.label} ${theme}: ${washed} should beat ${bare}`)
        }
      }
    }
  })

  it('raises a dark pick into the band the topbar was drawn for', () => {
    // Every light-plate assumption in the stylesheet lands here: the 0.55 inset
    // highlight, the white emboss under the title, the 0.28 wash on the controls. A
    // dark banner would not fail a ratio, it would fail the drawing.
    const fit = fitBanner('#101010')
    assert.equal(fit.status, 'fitted')
    if (fit.status !== 'fitted') return
    for (const theme of SCHEME_THEMES) {
      const roles = (theme === 'light' ? fit.light : fit.dark).roles
      assert.ok(rgbToHsl(rgb(roles.banner)).l >= MIN_PLATE_LIGHTNESS - 0.001, theme)
    }
    assert.equal(fit.light.moved, true)
  })

  it('keeps the edge and the deep stop darker than the banner, so it still reads as one', () => {
    for (const preset of BANNER_PRESETS) {
      const roles = bannerIn(preset.hex, 'light')
      assert.ok(luminanceOf(roles.bannerDeep) < luminanceOf(roles.banner), preset.label)
      assert.ok(luminanceOf(roles.bannerEdge) < luminanceOf(roles.bannerDeep), preset.label)
    }
  })

  it('stays near the color that was asked for', () => {
    for (const preset of BANNER_PRESETS) {
      for (const theme of SCHEME_THEMES) {
        assert.ok(hueGap(bannerIn(preset.hex, theme).banner, preset.hex) < 6, preset.label)
      }
    }
  })

  it('never refuses a banner, for the same reason the plate is never refused', () => {
    for (let hue = 0; hue < 360; hue += 20) {
      for (const lightness of [0.05, 0.5, 0.98]) {
        assert.equal(fitBanner(hexAt(hue, 0.8, lightness)).status, 'fitted', `${hue}°`)
      }
    }
  })

  it('refuses a banner it cannot read at all', () => {
    assert.equal(fitBanner('not-a-color').status, 'invalid')
    assert.equal(fitBanner('#gggggg').status, 'invalid')
  })

  it('fits the banner independently of the plate', () => {
    // The whole point of the split: one choice must not move the other's variables.
    const both = schemeVariables({ accent: null, chrome: '#e08a4c', banner: '#a9cbe8' })
    const plateOnly = schemeVariables(scheme({ chrome: '#e08a4c' }))
    assert.equal(both['--user-gold-light'], plateOnly['--user-gold-light'])
    assert.notEqual(both['--user-banner-light'], both['--user-gold-light'])
  })

  it('does not derive a display color, because nothing banner-colored sits on a card', () => {
    const roles = bannerIn('#a9cbe8', 'light')
    assert.deepEqual(Object.keys(roles).sort(), ['banner', 'bannerDeep', 'bannerEdge'])
  })
})

describe('the offered swatches', () => {
  it('offers colors for all three roles, each with an id and a label', () => {
    for (const role of SCHEME_ROLES) {
      const presets = presetsFor(role)
      assert.ok(presets.length >= 5, role)
      for (const preset of presets) {
        assert.match(preset.id, /^[a-z]+$/)
        assert.ok(preset.label.length > 0)
        assert.ok(parseHex(preset.hex), `${preset.id} is a color`)
      }
    }
  })

  it('gives every swatch a distinct id and a distinct color', () => {
    for (const role of SCHEME_ROLES) {
      const presets = presetsFor(role)
      assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length)
      assert.equal(new Set(presets.map((preset) => preset.hex)).size, presets.length)
    }
  })

  it('offers nothing the guard would refuse', () => {
    // The constrained path has to be a path: a swatch that produced a refusal would
    // be the picker arguing with itself.
    for (const role of SCHEME_ROLES) {
      for (const preset of presetsFor(role)) {
        assert.equal(acceptsColor(role, preset.hex), true, `${role}: ${preset.label}`)
      }
    }
  })

  it('starts the banner on the gold the topbar already wears', () => {
    // The first swatch is the current appearance, so "put it back" is visible in the
    // row rather than only under Reset.
    assert.equal(BANNER_PRESETS[0]?.hex, SHIPPED.banner)
    assert.equal(SHIPPED.banner, SHIPPED.chrome)
  })

  it('keeps the banner swatches out of the plate band, so the two rows are not one row', () => {
    // The plate has to read as metal; the banner is one broad object where a flat
    // color reads as a color. Sharing five of six swatches would say otherwise.
    const plate = new Set(CHROME_PRESETS.map((preset) => preset.hex))
    const shared = BANNER_PRESETS.filter((preset) => plate.has(preset.hex))
    assert.deepEqual(
      shared.map((preset) => preset.id),
      ['gold'],
    )
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

  it('says why a refused color is refused, and what it collided with', () => {
    // A silently-refused input is the failure this message exists to prevent.
    const message = describeAccent('#00ff00', fitAccent('#00ff00'))
    assert.match(message, /Not available/)
    assert.match(message, /maxed/)
    assert.match(message, /nearest color that works is #/)
  })

  it('names color blindness when that is the test that failed', () => {
    assert.match(describeAccent('#ff0000', fitAccent('#ff0000')), /color blindness/)
  })

  it('tells somebody who typed nonsense what to do instead', () => {
    assert.match(describeAccent('rebeccapurple', fitAccent('rebeccapurple')), /swatches/)
  })

  it('calls the banner a banner, not a plate', () => {
    // Three roles, three nouns. "the plate" under the banner block would be the
    // picker telling somebody they had changed something else.
    assert.match(describeBanner('#a9cbe8', fitBanner('#a9cbe8')), /banner/)
    assert.equal(/plate/.test(describeBanner('#a9cbe8', fitBanner('#a9cbe8'))), false)
  })

  it('says the same thing through roleOutcome as through the describe functions', () => {
    // The component reads roleOutcome and nothing else, so the two must not drift.
    for (const [role, hex] of [
      ['accent', '#7a4fd0'],
      ['chrome', '#e08a4c'],
      ['banner', '#a9cbe8'],
    ] as const) {
      const outcome = roleOutcome(role, hex)
      assert.equal(outcome.refused, false, role)
      const { light, dark } = outcome
      assert.ok(light !== null && dark !== null, role)
      assert.match(outcome.message, new RegExp(light))
    }
  })

  it('carries the refusal and its offer through roleOutcome as well', () => {
    const outcome = roleOutcome('accent', '#00ff00')
    assert.equal(outcome.refused, true)
    assert.ok(outcome.suggestion, 'the offer survives the flattening')
    assert.equal(outcome.light, null)
  })

  it('never refuses through the two roles that only restrict the range', () => {
    assert.equal(roleOutcome('chrome', '#101010').refused, false)
    assert.equal(roleOutcome('banner', '#101010').refused, false)
    assert.equal(roleOutcome('banner', 'nonsense').refused, true)
  })
})

describe('storage', () => {
  it('keys the scheme by account, the way the other per-person keys are', () => {
    assert.equal(colorSchemeKey(3), 'coc:colors:3')
    assert.notEqual(colorSchemeKey(1), colorSchemeKey(2))
  })

  it('round-trips a scheme through storage', () => {
    const stored = { accent: '#12867f', chrome: '#e08a4c', banner: '#a9cbe8' }
    assert.deepEqual(parseScheme(serializeScheme(stored)), stored)
  })

  it('normalizes what it stores, so two spellings of one color are one color', () => {
    assert.deepEqual(
      parseScheme('{"accent":"#12867F","chrome":null,"banner":"#A9CBE8"}'),
      scheme({ accent: '#12867f', banner: '#a9cbe8' }),
    )
  })

  it('loads a scheme stored before the banner existed, without a banner', () => {
    // The two-field shape is in people's browsers right now. A missing key is not a
    // string, so it lands on null, and a null banner is the plate — which is exactly
    // what those browsers are already showing.
    assert.deepEqual(parseScheme('{"accent":"#12867f","chrome":"#e08a4c"}'), {
      accent: '#12867f',
      chrome: '#e08a4c',
      banner: null,
    })
    assert.deepEqual(
      schemeVariables(parseScheme('{"accent":null,"chrome":"#e08a4c"}')),
      schemeVariables(scheme({ chrome: '#e08a4c' })),
    )
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

  it('drops a stored color that the guard would refuse today', () => {
    // A value written by a build with a laxer rule must not survive the rule change.
    assert.deepEqual(
      parseScheme('{"accent":"#00ff00","chrome":"#7fc9a8","banner":"#a9cbe8"}'),
      scheme({ chrome: '#7fc9a8', banner: '#a9cbe8' }),
    )
  })

  it('keeps the good parts of a part-broken value', () => {
    assert.deepEqual(
      parseScheme('{"accent":"#12867f","chrome":"oops","banner":42}'),
      scheme({ accent: '#12867f' }),
    )
  })

  it('takes an already-parsed object as well as a string', () => {
    const chosen = scheme({ accent: '#12867f' })
    assert.deepEqual(parseScheme({ accent: '#12867f', chrome: null }), chosen)
  })

  it('replaces one role at a time and leaves the others alone', () => {
    const one = withSchemeColor(DEFAULT_SCHEME, 'banner', '#a9cbe8')
    assert.deepEqual(one, scheme({ banner: '#a9cbe8' }))
    assert.deepEqual(
      withSchemeColor(one, 'accent', '#12867f'),
      scheme({ accent: '#12867f', banner: '#a9cbe8' }),
    )
    assert.deepEqual(withSchemeColor(one, 'banner', null), DEFAULT_SCHEME)
  })
})

describe('the account menu line', () => {
  it('says Default until something is chosen', () => {
    assert.equal(schemeSummary(DEFAULT_SCHEME), 'Default')
    assert.equal(isDefaultScheme(DEFAULT_SCHEME), true)
  })

  it('names the one customized role, and gives up at two', () => {
    assert.equal(schemeSummary(scheme({ accent: '#12867f' })), 'Custom accent')
    assert.equal(schemeSummary(scheme({ chrome: '#e08a4c' })), 'Custom plate')
    assert.equal(schemeSummary(scheme({ banner: '#a9cbe8' })), 'Custom banner')
    assert.equal(schemeSummary(scheme({ accent: '#12867f', chrome: '#e08a4c' })), 'Custom')
    assert.equal(
      schemeSummary({ accent: '#12867f', chrome: '#e08a4c', banner: '#a9cbe8' }),
      'Custom',
    )
  })

  it('offers Reset while any one of the three is set', () => {
    for (const role of SCHEME_ROLES) {
      const chosen = withSchemeColor(DEFAULT_SCHEME, role, SHIPPED[role])
      assert.equal(isDefaultScheme(chosen), false, role)
    }
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
