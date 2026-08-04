import {
  contrastRatio,
  distinguishable,
  formatHex,
  hslToRgb,
  parseHex,
  rgbToHsl,
  withHue,
  withLightness,
  type ClashReason,
  type Rgb,
} from './color-contrast.ts'

/**
 * The user's colour scheme: which of this app's colours they may choose, what is
 * derived from those choices, and what is refused.
 *
 * **The two themes are not touched.** Light and dark ship exactly as they are and are
 * what anybody who has chosen nothing gets; every value here is written as a `var()`
 * *override* with the shipped colour as the fallback (see the `--user-…` names in
 * `styles.css`), so an empty scheme is byte-for-byte the theme that was there before.
 *
 * ## What is exposed, and why so little
 *
 * Two colours, not forty.
 *
 *  - **Accent** — the app's one interactive/magnitude colour. Links, the focus ring,
 *    the meter fill, the progress bars, the checkbox tick, the notice edge. Changing
 *    it changes every affordance at once, which is what "my colour" means.
 *  - **Chrome** — the gold plate. The topbar, the panel edges, the committing buttons,
 *    the badge, and the display numerals. It is the app's *skin*; `styles.css` says of
 *    it that "gold is chrome only … it never encodes a value", which is precisely why
 *    it is safe to hand over.
 *
 * Everything else stays fixed and it is not an oversight:
 *
 *  - the **neutrals** (`--plane`, `--surface`, `--ink*`, `--grid`, `--border`) are the
 *    ground every contrast figure below is measured against. Let the user move both
 *    the text and its background and the guard has nothing left to stand on — that is
 *    the white-on-white the brief is about;
 *  - the **status palette** (`--good`, `--warning`, `--critical`) and the four **deck**
 *    colours encode meaning. They are shared vocabulary, not decoration, and a
 *    per-browser preference cannot be allowed to make one person's "error" another
 *    person's "fine";
 *  - `--dev`, the tarnished plate, exists to be *unmistakable* for the live host. A
 *    user who could restyle it could hide it.
 *
 * ## The guard
 *
 * A chosen colour names a **hue**. The **shade is not the user's to pick**: it is
 * fitted to each theme, separately, against the background it will actually sit on.
 * That is the whole trick, and it is why this almost never has to refuse anything —
 * the same blue that reads on parchment at 4.5:1 is invisible on dark wood, so one
 * colour could not have satisfied both, and asking the user to find one that did
 * would have been the wall the brief describes.
 *
 * The ratios, and where each applies:
 *
 * | Relationship | Floor | Why |
 * | --- | --- | --- |
 * | accent against `--surface` **and** `--plane` | **4.5:1** | it is link text, at body size, on both grounds |
 * | meter fill against its `--track` | **3:1** | a graphical object, WCAG 1.4.11 |
 * | `--on-gold` against **both** stops of the plate gradient | **4.5:1** | the topbar's controls are 13px text |
 * | `--display` against `--surface` | **4.5:1** | it is `.section-title` at 12px as well as a 48px numeral |
 *
 * 4.5 rather than 3 wherever text is involved, because every one of these roles is
 * used at body size *somewhere* — the large-text allowance would be claiming an
 * exemption the smallest use does not have.
 *
 * One honest note. The shipped light accent measures **4.02:1 against `--plane`**, the
 * ground behind the footer's links, so a user who types that exact blue gets it
 * deepened by one step to clear 4.5. The shipped theme is left alone: it is the
 * baseline this work was told not to change, and it is one Reset away.
 *
 * ## Hue is not the guard
 *
 * The brief asked that colours not be "too close in hue". Hue distance cannot prevent
 * the failure it is usually invoked for: two colours 180° apart can have identical
 * luminance, and that is white-on-white with a colour cast. **Contrast is the guard.**
 * Hue separation is kept as a *third* constraint, and only between colours that carry
 * different meanings — see `distinguishable` in `color-contrast.ts`, which tests ΔE in
 * ordinary vision first, ΔE under red-green colour blindness second, and hue last.
 *
 * The pairs it is applied to are real ones from this stylesheet: `.meter__fill` is the
 * accent and `.meter__fill--max` is `--good`, in the same list; `.notice` is edged in
 * the accent and `.notice--error` in `--critical`. An accent that collided with either
 * would make one of those distinctions vanish, so those two are the only refusals this
 * module can produce — and it offers the nearest hue that would have worked.
 */

/* ---------- the themes a colour has to survive ---------- */

export type SchemeTheme = 'light' | 'dark'

export const SCHEME_THEMES: readonly SchemeTheme[] = ['light', 'dark']

/**
 * The fixed part of each theme, copied from `styles.css`. Anything a user colour is
 * measured *against* lives here, which is also the list of things they cannot move.
 */
interface Backdrop {
  /** The card ground. Nearly all text sits on this. */
  readonly surface: string
  /** The page ground behind the cards, and behind the footer's links. */
  readonly plane: string
  /** The ink the gold plate carries, in this theme. */
  readonly plateInk: string
  /** Status colours the accent has to stay distinct from. */
  readonly good: string
  readonly critical: string
}

export const THEME_BACKDROP: Record<SchemeTheme, Backdrop> = {
  light: {
    surface: '#f6efdc',
    plane: '#e6dcc3',
    plateInk: '#33240f',
    good: '#3f9e28',
    critical: '#c4342c',
  },
  dark: {
    surface: '#241d14',
    plane: '#16120c',
    plateInk: '#241d14',
    good: '#4fb332',
    critical: '#e2564c',
  },
}

/* ---------- the floors ---------- */

/** WCAG 1.4.3 for text below 18.66px bold / 24px regular, which is all of this. */
export const BODY_TEXT_RATIO = 4.5

/** WCAG 1.4.11, for a graphical object: the meter's fill against its own groove. */
export const GRAPHIC_RATIO = 3

/**
 * How far the hover shade moves, in HSL lightness, and always *away* from the page.
 * Measured off the shipped pair: `#1f6cb0` → `#17558f` is 0.081 down in light,
 * `#66aeee` → `#8cc4f4` is 0.086 up in dark. Away from the background means the hover
 * state can never be the one that fails a ratio the resting state passed.
 */
const HOVER_STEP = 0.085

/**
 * The meter groove: the accent's own hue, a little desaturated, taken to the far end
 * of the theme. The two numbers are read off the shipped `--track` — `#cfe0f2` is that
 * blue at lightness 0.88 and 0.82 of its saturation, `#16304d` is the same recipe at
 * 0.19 — so a chosen accent gets the groove the designed one has.
 *
 * A wash into the *surface* was tried first and is wrong: mixing a blue into parchment
 * gives a green-grey groove, because the parchment carries its own hue.
 */
const TRACK_LIGHTNESS: Record<SchemeTheme, number> = { light: 0.88, dark: 0.19 }
const TRACK_SATURATION = 0.82
/** Nudges toward the theme's extreme, if the fill would not clear 3:1 on the groove. */
const TRACK_RESCUE_STEPS: readonly number[] = [0, 0.05, 0.1]

/**
 * The plate's second gradient stop and its edge, as drops in HSL lightness from the
 * plate itself. Shipped: gold → deep is 0.132 light and 0.201 dark; gold → edge is
 * 0.285 and 0.400. One pair of constants rather than four, because the plate has to
 * read as one object in both themes.
 */
const PLATE_DEEP_DROP = 0.14
const PLATE_EDGE_DROP = 0.3

/**
 * The plate stays light, and that is a deliberate restriction of the range rather
 * than a check that fires afterwards.
 *
 * Every rule that draws on the plate assumes a light one: the white bevel highlight,
 * the 28%-white wash on the topbar's buttons, the white emboss under the title, and
 * dark ink in *both* shipped themes. A dark plate would not fail a contrast ratio —
 * the ink would flip and pass — it would fail the drawing. So the picker only offers
 * the band the chrome was designed for, and says so.
 */
export const MIN_PLATE_LIGHTNESS = 0.45
const MAX_LIGHTNESS = 0.96
const MIN_LIGHTNESS = 0.04

/** Lightness search resolution. One per cent is finer than sRGB can show at 8 bits. */
const LIGHTNESS_STEP = 0.01

/* ---------- searching for a shade ---------- */

/**
 * Every lightness in the band, ordered by distance from where the user put it, so the
 * first acceptable answer is also the nearest one. Ties go to the *darker* candidate
 * in the light theme and the lighter one in dark — i.e. toward more contrast, which
 * is the direction the failure was in.
 */
function lightnessCandidates(
  from: number,
  low: number,
  high: number,
  preferDark: boolean,
): number[] {
  const start = Math.round(clamp(from, low, high) / LIGHTNESS_STEP)
  const first = Math.round(low / LIGHTNESS_STEP)
  const last = Math.round(high / LIGHTNESS_STEP)
  const out: number[] = [start]

  for (let step = 1; step <= last - first; step += 1) {
    const down = start - step
    const up = start + step
    const pair = preferDark ? [down, up] : [up, down]
    for (const candidate of pair) {
      if (candidate >= first && candidate <= last) out.push(candidate)
    }
  }

  return out.map((step) => step * LIGHTNESS_STEP)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** The nearest shade of this colour that clears `ratio` against every one of `grounds`. */
function fitToGrounds(
  color: Rgb,
  grounds: readonly Rgb[],
  ratio: number,
  preferDark: boolean,
  low = MIN_LIGHTNESS,
  high = MAX_LIGHTNESS,
): Rgb | null {
  const hsl = rgbToHsl(color)
  for (const lightness of lightnessCandidates(hsl.l, low, high, preferDark)) {
    const candidate = hslToRgb({ h: hsl.h, s: hsl.s, l: lightness })
    if (grounds.every((ground) => contrastRatio(candidate, ground) >= ratio)) return candidate
  }
  return null
}

/* ---------- the accent ---------- */

export interface AccentRoles {
  readonly accent: string
  readonly accentHover: string
  readonly track: string
}

export interface ChromeRoles {
  readonly gold: string
  readonly goldDeep: string
  readonly goldEdge: string
  readonly display: string
}

/** One theme's answer. `moved` is true when the shade is not the one that was picked. */
export interface ThemeFit<T> {
  readonly roles: T
  readonly moved: boolean
}

/** Which fixed colour a refused accent collided with. */
export type ClashPartner = 'good' | 'critical'

export type AccentFit =
  | {
      readonly status: 'fitted'
      readonly light: ThemeFit<AccentRoles>
      readonly dark: ThemeFit<AccentRoles>
    }
  | {
      readonly status: 'clash'
      readonly theme: SchemeTheme
      readonly against: ClashPartner
      readonly reason: ClashReason
      /** The nearest hue that would have worked, or `null` if the whole circle failed. */
      readonly suggestion: string | null
    }
  /** No shade of it clears the text floor on both grounds. Not reachable today; see
      `fitAccentToTheme`, which searches the whole lightness range. */
  | { readonly status: 'unreadable'; readonly theme: SchemeTheme }
  | { readonly status: 'invalid' }

export type ChromeFit =
  | {
      readonly status: 'fitted'
      readonly light: ThemeFit<ChromeRoles>
      readonly dark: ThemeFit<ChromeRoles>
    }
  | { readonly status: 'invalid' }

function trackFor(accent: Rgb, theme: SchemeTheme): Rgb {
  const hsl = rgbToHsl(accent)
  const toward = theme === 'light' ? 1 : -1
  let track = accent

  for (const step of TRACK_RESCUE_STEPS) {
    track = hslToRgb({
      h: hsl.h,
      s: hsl.s * TRACK_SATURATION,
      l: TRACK_LIGHTNESS[theme] + toward * step,
    })
    if (contrastRatio(accent, track) >= GRAPHIC_RATIO) return track
  }

  return track
}

/**
 * Fit one accent to one theme, or say which fixed colour it could not be told apart
 * from. Contrast first: a colour is moved to a readable shade *before* it is asked
 * whether it is still distinct, because the shade it will actually be drawn in is the
 * only one worth testing.
 */
type AccentAttempt =
  | { readonly outcome: 'ok'; readonly roles: AccentRoles; readonly shade: Rgb }
  | { readonly outcome: 'clash'; readonly against: ClashPartner; readonly reason: ClashReason }
  | { readonly outcome: 'unreadable' }

function fitAccentToTheme(color: Rgb, theme: SchemeTheme): AccentAttempt {
  const backdrop = THEME_BACKDROP[theme]
  const surface = requireHex(backdrop.surface)
  const plane = requireHex(backdrop.plane)
  const preferDark = theme === 'light'

  const hsl = rgbToHsl(color)
  let clash: AccentAttempt | null = null

  for (const lightness of lightnessCandidates(hsl.l, MIN_LIGHTNESS, MAX_LIGHTNESS, preferDark)) {
    const shade = hslToRgb({ h: hsl.h, s: hsl.s, l: lightness })
    if (contrastRatio(shade, surface) < BODY_TEXT_RATIO) continue
    if (contrastRatio(shade, plane) < BODY_TEXT_RATIO) continue

    const againstGood = distinguishable(shade, requireHex(backdrop.good))
    if (againstGood.reason !== null) {
      clash ??= { outcome: 'clash', against: 'good', reason: againstGood.reason }
      continue
    }
    const againstCritical = distinguishable(shade, requireHex(backdrop.critical))
    if (againstCritical.reason !== null) {
      clash ??= { outcome: 'clash', against: 'critical', reason: againstCritical.reason }
      continue
    }

    const hover = withLightness(shade, preferDark ? lightness - HOVER_STEP : lightness + HOVER_STEP)
    return {
      outcome: 'ok',
      shade,
      roles: {
        accent: formatHex(shade),
        accentHover: formatHex(hover),
        track: formatHex(trackFor(shade, theme)),
      },
    }
  }

  return clash ?? { outcome: 'unreadable' }
}

/**
 * The whole accent decision for a chosen colour: a shade per theme, or a refusal that
 * names what it collided with and offers the nearest hue that does not.
 */
export function fitAccent(hex: string): AccentFit {
  const picked = parseHex(hex)
  if (!picked) return { status: 'invalid' }

  const fit = rawFitAccent(picked)
  /* The suggestion is filled in here and not in `rawFitAccent`, because finding it
     means fitting candidate colours — and a suggestion that suggested itself would
     recur forever. */
  return fit.status === 'clash' ? { ...fit, suggestion: nearestUsableAccent(hex) } : fit
}

/** The fit itself, with no suggestion attached. The only form safe to call in a loop. */
function rawFitAccent(picked: Rgb): AccentFit {
  const attempts: ThemeFit<AccentRoles>[] = []
  for (const theme of SCHEME_THEMES) {
    const attempt = fitAccentToTheme(picked, theme)
    if (attempt.outcome === 'unreadable') return { status: 'unreadable', theme }
    if (attempt.outcome === 'clash') {
      return {
        status: 'clash',
        theme,
        against: attempt.against,
        reason: attempt.reason,
        suggestion: null,
      }
    }
    attempts.push({ roles: attempt.roles, moved: formatHex(attempt.shade) !== formatHex(picked) })
  }

  const [light, dark] = attempts
  if (!light || !dark) return { status: 'invalid' }
  return { status: 'fitted', light, dark }
}

/**
 * The nearest hue to the one picked that this module would accept, keeping the
 * saturation and lightness. Rotating outward one degree at a time and stopping at the
 * first that works means the offer is recognisably the colour the user asked for —
 * which is the difference between "no" and "not quite; try this".
 */
export function nearestUsableAccent(hex: string): string | null {
  const picked = parseHex(hex)
  if (!picked) return null
  const hue = rgbToHsl(picked).h

  for (let turn = 1; turn <= 180; turn += 1) {
    for (const direction of [1, -1]) {
      const candidate = withHue(picked, hue + turn * direction)
      if (rawFitAccent(candidate).status === 'fitted') return formatHex(candidate)
    }
  }
  return null
}

/* ---------- the chrome plate ---------- */

function fitChromeToTheme(color: Rgb, theme: SchemeTheme): { roles: ChromeRoles; plate: Rgb } | null {
  const backdrop = THEME_BACKDROP[theme]
  const surface = requireHex(backdrop.surface)
  const ink = requireHex(backdrop.plateInk)

  const hsl = rgbToHsl(color)
  /* Upward on a tie: the plate's whole design is light, so where a shade has to move
     it moves toward the band it was drawn for rather than out of it. */
  for (const lightness of lightnessCandidates(hsl.l, MIN_PLATE_LIGHTNESS, MAX_LIGHTNESS, false)) {
    const plate = hslToRgb({ h: hsl.h, s: hsl.s, l: lightness })
    const deep = withLightness(plate, lightness - PLATE_DEEP_DROP)
    /* Both stops of the gradient, not the average: the ink crosses the whole plate. */
    if (contrastRatio(ink, plate) < BODY_TEXT_RATIO) continue
    if (contrastRatio(ink, deep) < BODY_TEXT_RATIO) continue

    const edge = withLightness(plate, lightness - PLATE_EDGE_DROP)
    /* The numerals are their own role because the plate's own colour is unreadable as
       text on parchment — the reason `--display` exists at all. Fitted independently,
       against the card surface, and it may end up nothing like the plate. */
    const display = fitToGrounds(plate, [surface], BODY_TEXT_RATIO, theme === 'light')
    if (!display) continue

    return {
      plate,
      roles: {
        gold: formatHex(plate),
        goldDeep: formatHex(deep),
        goldEdge: formatHex(edge),
        display: formatHex(display),
      },
    }
  }

  return null
}

export function fitChrome(hex: string): ChromeFit {
  const picked = parseHex(hex)
  if (!picked) return { status: 'invalid' }

  const fits: ThemeFit<ChromeRoles>[] = []
  for (const theme of SCHEME_THEMES) {
    const fitted = fitChromeToTheme(picked, theme)
    /* Unreachable in practice — a light enough plate always takes the ink — but a
       `null` here must not be turned into a broken variable set. */
    if (!fitted) return { status: 'invalid' }
    fits.push({ roles: fitted.roles, moved: formatHex(fitted.plate) !== formatHex(picked) })
  }

  const [light, dark] = fits
  if (!light || !dark) return { status: 'invalid' }
  return { status: 'fitted', light, dark }
}

function requireHex(hex: string): Rgb {
  const rgb = parseHex(hex)
  /* The argument is always one of this module's own constants. */
  if (!rgb) throw new Error(`not a colour: ${hex}`)
  return rgb
}

/* ---------- the scheme itself ---------- */

export type SchemeRole = 'accent' | 'chrome'

export const SCHEME_ROLES: readonly SchemeRole[] = ['accent', 'chrome']

/**
 * What the user chose. `null` is not "no colour", it is **the shipped theme** — the
 * variables are simply not written, so the stylesheet's own fallback stands.
 */
export interface ColorScheme {
  readonly accent: string | null
  readonly chrome: string | null
}

export const DEFAULT_SCHEME: ColorScheme = { accent: null, chrome: null }

/** The shipped colours, for the picker to show as the current value of a default. */
export const SHIPPED: Record<SchemeRole, string> = { accent: '#1f6cb0', chrome: '#f2b431' }

export function colorSchemeKey(userId: number): string {
  /* Per account, like `coc:lastRoute:<id>` and `coc:baseScope:<id>`: one browser is
     shared, and a scheme is a preference of the person, not of the machine. */
  return `coc:colors:${userId}`
}

/**
 * A stored scheme, made safe.
 *
 * Everything that can be wrong here has to end at the shipped theme rather than at a
 * broken page: not JSON, JSON that is not an object, an older shape, a field that is
 * not a string, a string that is not a colour, and — the one worth spelling out — a
 * colour that *was* acceptable under an earlier version of the guard and no longer is.
 * Each field falls back on its own, so one bad half does not discard the other.
 */
export function parseScheme(stored: unknown): ColorScheme {
  const raw = readObject(stored)
  if (!raw) return DEFAULT_SCHEME

  const accent = typeof raw['accent'] === 'string' ? raw['accent'] : null
  const chrome = typeof raw['chrome'] === 'string' ? raw['chrome'] : null

  return {
    accent: accent !== null && fitAccent(accent).status === 'fitted' ? normalise(accent) : null,
    chrome: chrome !== null && fitChrome(chrome).status === 'fitted' ? normalise(chrome) : null,
  }
}

function normalise(hex: string): string {
  const rgb = parseHex(hex)
  return rgb ? formatHex(rgb) : hex
}

function readObject(stored: unknown): Record<string, unknown> | null {
  const value = typeof stored === 'string' ? tryParse(stored) : stored
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function serialiseScheme(scheme: ColorScheme): string {
  return JSON.stringify({ accent: scheme.accent, chrome: scheme.chrome })
}

/* ---------- the CSS custom properties ---------- */

/**
 * Every variable this module can write, so the applier can clear the ones a scheme
 * does not set. Missing one would leave a stale colour behind after a Reset, which is
 * the kind of bug that only shows up for the person who tried the feature.
 */
export const SCHEME_VARIABLES: readonly string[] = [
  '--user-accent-light',
  '--user-accent-hover-light',
  '--user-track-light',
  '--user-gold-light',
  '--user-gold-deep-light',
  '--user-gold-edge-light',
  '--user-display-light',
  '--user-accent-dark',
  '--user-accent-hover-dark',
  '--user-track-dark',
  '--user-gold-dark',
  '--user-gold-deep-dark',
  '--user-gold-edge-dark',
  '--user-display-dark',
]

/**
 * The scheme as custom properties for the root element. An unset role contributes
 * nothing at all — that is what keeps the shipped themes exactly as they were.
 */
export function schemeVariables(scheme: ColorScheme): Record<string, string> {
  const out: Record<string, string> = {}

  const accent = scheme.accent === null ? null : fitAccent(scheme.accent)
  if (accent?.status === 'fitted') {
    for (const theme of SCHEME_THEMES) {
      const roles = (theme === 'light' ? accent.light : accent.dark).roles
      out[`--user-accent-${theme}`] = roles.accent
      out[`--user-accent-hover-${theme}`] = roles.accentHover
      out[`--user-track-${theme}`] = roles.track
    }
  }

  const chrome = scheme.chrome === null ? null : fitChrome(scheme.chrome)
  if (chrome?.status === 'fitted') {
    for (const theme of SCHEME_THEMES) {
      const roles = (theme === 'light' ? chrome.light : chrome.dark).roles
      out[`--user-gold-${theme}`] = roles.gold
      out[`--user-gold-deep-${theme}`] = roles.goldDeep
      out[`--user-gold-edge-${theme}`] = roles.goldEdge
      out[`--user-display-${theme}`] = roles.display
    }
  }

  return out
}

/* ---------- what the picker offers, and what it says ---------- */

export interface Preset {
  /** Stable id, for keys and for a test to name without matching prose. */
  readonly id: string
  readonly label: string
  readonly hex: string
}

/**
 * The offered colours: the constrained path, and the one most people will take.
 *
 * Every one of them is checked by the tests against the same guard the custom input
 * goes through, so a preset can never be a colour the app would have refused. They are
 * spread around the hue circle and deliberately avoid the bands the accent cannot use
 * — which is the difference between a picker that guides and one that punishes.
 */
export const ACCENT_PRESETS: readonly Preset[] = [
  { id: 'sky', label: 'Sky', hex: '#1f6cb0' },
  { id: 'slate', label: 'Slate', hex: '#4a6572' },
  { id: 'teal', label: 'Teal', hex: '#12867f' },
  { id: 'indigo', label: 'Indigo', hex: '#4b5fd1' },
  { id: 'violet', label: 'Violet', hex: '#7a4fd0' },
  { id: 'magenta', label: 'Magenta', hex: '#b8399b' },
  { id: 'crimson', label: 'Crimson', hex: '#c2185b' },
]

export const CHROME_PRESETS: readonly Preset[] = [
  { id: 'gold', label: 'Gold', hex: '#f2b431' },
  { id: 'copper', label: 'Copper', hex: '#e08a4c' },
  { id: 'stone', label: 'Stone', hex: '#c8c3b4' },
  { id: 'jade', label: 'Jade', hex: '#7fc9a8' },
  { id: 'ice', label: 'Ice', hex: '#9cc6ea' },
  { id: 'rose', label: 'Rose', hex: '#e5a3b4' },
]

export function presetsFor(role: SchemeRole): readonly Preset[] {
  return role === 'accent' ? ACCENT_PRESETS : CHROME_PRESETS
}

const ROLE_NOUN: Record<SchemeRole, string> = {
  accent: 'accent',
  chrome: 'plate',
}

const CLASH_PARTNER_NOUN: Record<ClashPartner, string> = {
  good: 'the green that means "maxed"',
  critical: 'the red that means "error"',
}

const CLASH_REASON_NOUN: Record<ClashReason, string> = {
  'too-similar': 'too close to',
  'too-similar-colour-blind': 'too close, for a reader with red-green colour blindness, to',
  'too-close-in-hue': 'too close in hue to',
}

/**
 * The sentence under the picker. It is here rather than in the component for the
 * reason every other rule is: a refusal that does not say *why* is the silent wall
 * this codebase's messages exist to avoid, and a sentence in JSX is a sentence with no
 * test on it.
 */
export function describeAccent(hex: string, fit: AccentFit): string {
  switch (fit.status) {
    case 'invalid':
      return `${hex} is not a colour this picker can read. Pick one of the swatches instead.`
    case 'unreadable': {
      const where = fit.theme === 'light' ? 'parchment' : 'dark wood'
      return (
        `Not available: no shade of this colour reaches ${BODY_TEXT_RATIO}:1 against ` +
        `${where}, and links are drawn in the accent. Pick one of the swatches instead.`
      )
    }
    case 'clash': {
      const partner = CLASH_PARTNER_NOUN[fit.against]
      const reason = CLASH_REASON_NOUN[fit.reason]
      const where = fit.theme === 'light' ? 'the light theme' : 'the dark theme'
      const offer = fit.suggestion
        ? ` The nearest colour that works is ${fit.suggestion}.`
        : ' Try a swatch instead.'
      return (
        `Not available: in ${where} this accent is ${reason} ${partner}, ` +
        `and the two are drawn side by side — a maxed meter beside a part-filled one, ` +
        `and an error notice beside an ordinary one.${offer}`
      )
    }
    case 'fitted':
      return describeFitted('accent', fit.light.roles.accent, fit.dark.roles.accent)
  }
}

export function describeChrome(hex: string, fit: ChromeFit): string {
  switch (fit.status) {
    case 'invalid':
      return `${hex} is not a colour this picker can read. Pick one of the swatches instead.`
    case 'fitted':
      return describeFitted('chrome', fit.light.roles.gold, fit.dark.roles.gold)
  }
}

function describeFitted(role: SchemeRole, light: string, dark: string): string {
  const noun = ROLE_NOUN[role]
  if (light === dark) return `Used as ${light} for the ${noun} in both themes.`
  return (
    `Fitted to each theme, so it stays readable on both grounds: ` +
    `${light} for the ${noun} on parchment, ${dark} on dark wood.`
  )
}

/** What the account menu shows beside "Colours". */
export function schemeSummary(scheme: ColorScheme): string {
  if (scheme.accent === null && scheme.chrome === null) return 'Default'
  if (scheme.accent !== null && scheme.chrome !== null) return 'Custom'
  return scheme.accent === null ? 'Custom plate' : 'Custom accent'
}

/** True when there is anything for Reset to undo. */
export function isDefaultScheme(scheme: ColorScheme): boolean {
  return scheme.accent === null && scheme.chrome === null
}
