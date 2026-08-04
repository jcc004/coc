/**
 * Color maths: WCAG contrast, and whether two colors can still be told apart.
 *
 * This is the arithmetic half of the user-chosen scheme. Nothing in here knows what
 * a role is or which color the app uses for what — `color-scheme.ts` does that, and
 * this file is the part that has to be *right* rather than the part that has to be
 * agreed. It is a module with its own tests for the reason every rule in this repo is:
 * a guard that decides whether somebody can read the site is not a `useMemo`.
 *
 * Two things it deliberately does not do.
 *
 * **No averaged brightness.** Contrast is computed from WCAG relative luminance —
 * each channel linearized out of sRGB's transfer curve, then weighted 0.2126 /
 * 0.7152 / 0.0722. The naive `(r + g + b) / 3` model calls `#0000ff` and `#00ff00`
 * equally bright; against white they are 8.59:1 and 1.37:1, which is the difference
 * between a readable link and an invisible one. The tests pin both numbers.
 *
 * **No color library.** Everything here is ~200 lines of published formulae, and the
 * repo's rule is that a dependency has to earn itself. The Lab conversion is here
 * because the stylesheet already reasons in ΔE — see the `--dev` note in `styles.css`,
 * which records the tarnished-gold plate as "ΔE 19 light and 15 dark" — so a
 * difference measured any other way could not be compared with the decisions already
 * taken.
 */

/** An sRGB color. Channels are 0–255 and always whole numbers. */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Hue in degrees 0–360, saturation and lightness 0–1. */
export interface Hsl {
  readonly h: number
  readonly s: number
  readonly l: number
}

/** CIE L*a*b*, D65. `l` is 0–100. */
export interface Lab {
  readonly l: number
  readonly a: number
  readonly b: number
}

/* ---------- hex ---------- */

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * `#rgb` or `#rrggbb` to channels, and `null` for anything else.
 *
 * `unknown` in, because the callers are a `localStorage` read and an `<input>` value
 * — a string somebody could have edited, or one an older build wrote in a shape this
 * one has never seen. Neither is allowed to reach the maths.
 */
export function parseHex(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null
  const match = HEX_PATTERN.exec(value.trim())
  if (!match) return null

  const digits = match[1] as string
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

function channelHex(channel: number): string {
  return Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0')
}

/** Always the six-digit lowercase form, so two equal colors compare equal as strings. */
export function formatHex(rgb: Rgb): string {
  return `#${channelHex(rgb.r)}${channelHex(rgb.g)}${channelHex(rgb.b)}`
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/* ---------- WCAG luminance and contrast ---------- */

/**
 * sRGB's transfer curve, from IEC 61966-2-1.
 *
 * WCAG 2.x quotes the knee as **0.03928** where the sRGB specification says
 * **0.04045**; the WCAG figure is a rounding of an early draft that was never
 * corrected. It cannot matter here and the test says so: at 8 bits the channel either
 * side of the pair is 10/255 = 0.03922 and 11/255 = 0.04314, so no representable
 * color falls between the two thresholds.
 */
const SRGB_KNEE = 0.04045
const SRGB_SLOPE = 12.92
const SRGB_OFFSET = 0.055
const SRGB_GAMMA = 2.4

/** The CIE 1931 luminance weights, which are why blue text is so much darker than green. */
const LUMINANCE_R = 0.2126
const LUMINANCE_G = 0.7152
const LUMINANCE_B = 0.0722

/** WCAG adds this to both terms so that black against black is 1:1 rather than 0/0. */
const CONTRAST_FLARE = 0.05

/** One channel, 0–255, to linear light 0–1. */
export function linearizeChannel(channel: number): number {
  const value = clamp(channel, 0, 255) / 255
  if (value <= SRGB_KNEE) return value / SRGB_SLOPE
  return ((value + SRGB_OFFSET) / (1 + SRGB_OFFSET)) ** SRGB_GAMMA
}

function delinearizeChannel(linear: number): number {
  const value = clamp(linear, 0, 1)
  const encoded =
    value <= SRGB_KNEE / SRGB_SLOPE
      ? value * SRGB_SLOPE
      : (1 + SRGB_OFFSET) * value ** (1 / SRGB_GAMMA) - SRGB_OFFSET
  return Math.round(encoded * 255)
}

/** WCAG relative luminance: 0 for black, 1 for white. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    LUMINANCE_R * linearizeChannel(rgb.r) +
    LUMINANCE_G * linearizeChannel(rgb.g) +
    LUMINANCE_B * linearizeChannel(rgb.b)
  )
}

/** WCAG contrast ratio, 1–21, and symmetric in its arguments. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + CONTRAST_FLARE) / (darker + CONTRAST_FLARE)
}

/* ---------- HSL, which is how a shade is moved ---------- */

export function rgbToHsl(rgb: Rgb): Hsl {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  const l = (max + min) / 2

  if (span === 0) return { h: 0, s: 0, l }

  const s = span / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / span) % 6
  else if (max === g) h = (b - r) / span + 2
  else h = (r - g) / span + 4

  return { h: (h * 60 + 360) % 360, s, l }
}

export function hslToRgb(hsl: Hsl): Rgb {
  const h = ((hsl.h % 360) + 360) % 360
  const s = clamp(hsl.s, 0, 1)
  const l = clamp(hsl.l, 0, 1)
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const base = l - chroma / 2

  const [r, g, b] =
    h < 60
      ? [chroma, second, 0]
      : h < 120
        ? [second, chroma, 0]
        : h < 180
          ? [0, chroma, second]
          : h < 240
            ? [0, second, chroma]
            : h < 300
              ? [second, 0, chroma]
              : [chroma, 0, second]

  return {
    r: Math.round((r + base) * 255),
    g: Math.round((g + base) * 255),
    b: Math.round((b + base) * 255),
  }
}

/** The same hue and saturation at another lightness. This is how a color is clamped. */
export function withLightness(rgb: Rgb, lightness: number): Rgb {
  const hsl = rgbToHsl(rgb)
  return hslToRgb({ h: hsl.h, s: hsl.s, l: clamp(lightness, 0, 1) })
}

/**
 * `over` painted on `base` at `alpha`, the way a CSS `rgba()` background paints.
 *
 * **Mixed in the encoded values, not in linear light.** That is what a browser does
 * when a translucent background sits on an opaque one, so a physically "correct"
 * linear blend here would disagree with the pixels a contrast checker would sample
 * off the screen. The one place this app needs it is a ground rather than ink: the
 * topbar's controls are a white wash over the banner, so the ink under a control is
 * not sitting on the banner itself.
 */
export function blend(base: Rgb, over: Rgb, alpha: number): Rgb {
  const mix = clamp(alpha, 0, 1)
  const channel = (from: number, to: number) => Math.round(from + (to - from) * mix)
  return {
    r: channel(clamp(base.r, 0, 255), clamp(over.r, 0, 255)),
    g: channel(clamp(base.g, 0, 255), clamp(over.g, 0, 255)),
    b: channel(clamp(base.b, 0, 255), clamp(over.b, 0, 255)),
  }
}

/** The same lightness and saturation at another hue. This is how a clash is escaped. */
export function withHue(rgb: Rgb, hue: number): Rgb {
  const hsl = rgbToHsl(rgb)
  return hslToRgb({ h: hue, s: hsl.s, l: hsl.l })
}

/* ---------- Lab and ΔE ---------- */

const D65_X = 0.95047
const D65_Y = 1
const D65_Z = 1.08883
const LAB_EPSILON = 216 / 24389
const LAB_KAPPA = 24389 / 27

function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116
}

export function rgbToLab(rgb: Rgb): Lab {
  const r = linearizeChannel(rgb.r)
  const g = linearizeChannel(rgb.g)
  const b = linearizeChannel(rgb.b)

  const x = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65_X)
  const y = labF((0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65_Y)
  const z = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65_Z)

  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

/**
 * CIE76 ΔE. Older and blunter than CIEDE2000, and chosen for it: the numbers already
 * written down in `styles.css` are ΔE76, and a threshold is only useful next to the
 * measurements it will be compared against.
 */
export function deltaE76(a: Rgb, b: Rgb): number {
  const first = rgbToLab(a)
  const second = rgbToLab(b)
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b)
}

/**
 * The shorter way round the hue circle, in degrees, 0–180.
 *
 * A color with almost no chroma has no meaningful hue — `#3a3a3a` is not "red at 0°"
 * — so a near-gray is reported as maximally distant rather than as accidentally
 * adjacent to whatever hue the arithmetic fell out at. Distance in hue is the *weak*
 * test here anyway; see `distinguishable` below.
 */
export const GRAY_SATURATION = 0.08

export function hueDistance(a: Rgb, b: Rgb): number {
  const first = rgbToHsl(a)
  const second = rgbToHsl(b)
  if (first.s < GRAY_SATURATION || second.s < GRAY_SATURATION) return 180
  const raw = Math.abs(first.h - second.h) % 360
  return raw > 180 ? 360 - raw : raw
}

/* ---------- color vision deficiency ---------- */

export type ColorVision = 'deuteranopia' | 'protanopia'

/**
 * Viénot, Brettel and Mollon (1999), applied in linear light.
 *
 * Red-green only. Deuteranopia and protanopia are together about 6% of men and cover
 * essentially every pair this app could get wrong; tritanopia is rare enough, and its
 * confusion axis (blue-yellow) far enough from the pairs below, that simulating it
 * would add a third matrix and no decision.
 *
 * This is a simulation, not a diagnosis: it answers "would these two still be two
 * colors" well enough to refuse a genuinely bad pair, which is all it is asked.
 */
const VISION_MATRIX: Record<ColorVision, readonly number[]> = {
  // prettier-ignore
  protanopia: [
    0.11238, 0.88762, 0,
    0.11238, 0.88762, 0,
    0.00401, -0.00401, 1,
  ],
  // prettier-ignore
  deuteranopia: [
    0.29275, 0.70725, 0,
    0.29275, 0.70725, 0,
    -0.02234, 0.02234, 1,
  ],
}

export function simulateVision(rgb: Rgb, vision: ColorVision): Rgb {
  const m = VISION_MATRIX[vision]
  const r = linearizeChannel(rgb.r)
  const g = linearizeChannel(rgb.g)
  const b = linearizeChannel(rgb.b)

  return {
    r: delinearizeChannel((m[0] as number) * r + (m[1] as number) * g + (m[2] as number) * b),
    g: delinearizeChannel((m[3] as number) * r + (m[4] as number) * g + (m[5] as number) * b),
    b: delinearizeChannel((m[6] as number) * r + (m[7] as number) * g + (m[8] as number) * b),
  }
}

/* ---------- "still two colors" ---------- */

/**
 * ΔE between two colors as somebody with red-green color blindness would see them.
 * The worse of the two simulations, because passing one and failing the other is
 * failing.
 */
export function colorBlindDelta(a: Rgb, b: Rgb): number {
  return Math.min(
    deltaE76(simulateVision(a, 'deuteranopia'), simulateVision(b, 'deuteranopia')),
    deltaE76(simulateVision(a, 'protanopia'), simulateVision(b, 'protanopia')),
  )
}

/**
 * Why a pair was refused, or `null` when it was not. The string is shown to the user,
 * so it says which test failed rather than "invalid".
 */
export type ClashReason = 'too-similar' | 'too-similar-color-blind' | 'too-close-in-hue'

export interface Distinguishability {
  readonly ok: boolean
  readonly reason: ClashReason | null
  readonly deltaE: number
  readonly colorBlindDeltaE: number
  readonly hueDegrees: number
}

/**
 * Whether two colors that *mean different things* can still be read as two colors.
 *
 * Three tests, and the order they are written in is the order they matter in:
 *
 *  1. **ΔE in ordinary vision.** The real one. It moves with lightness, chroma and
 *     hue together, which is what "different color" actually means.
 *  2. **ΔE under red-green color blindness.** A blue/green pair can be 60 apart for
 *     most people and 6 apart for a deuteranope. Lower bar than (1) because the
 *     simulation flattens every pair somewhat, including ones nobody confuses.
 *  3. **Hue separation.** The weakest of the three and the one the brief asked for by
 *     name. It is here as an *extra* constraint, never as the guard: two colors can
 *     sit 180° apart in hue and be the same lightness, which is white-on-white with a
 *     color cast. It earns its place for a different job — keeping a pair that
 *     encodes *category* reading as two colors rather than as two shades of one.
 */
export const MIN_DELTA_E = 25
export const MIN_COLOR_BLIND_DELTA_E = 15
export const MIN_HUE_DEGREES = 18

export function distinguishable(a: Rgb, b: Rgb): Distinguishability {
  const deltaE = deltaE76(a, b)
  const blind = colorBlindDelta(a, b)
  const hue = hueDistance(a, b)

  const reason: ClashReason | null =
    deltaE < MIN_DELTA_E
      ? 'too-similar'
      : blind < MIN_COLOR_BLIND_DELTA_E
        ? 'too-similar-color-blind'
        : hue < MIN_HUE_DEGREES
          ? 'too-close-in-hue'
          : null

  return { ok: reason === null, reason, deltaE, colorBlindDeltaE: blind, hueDegrees: hue }
}
