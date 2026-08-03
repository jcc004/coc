/**
 * The compass rosette's geometry, in one place, because the mark is now drawn
 * twice: as inline SVG beside the title (`CompassRosette` in `App.tsx`) and as the
 * browser tab's favicon (emitted by the plugin in `vite.config.ts`).
 *
 * Two copies of a hand-drawn path would drift the first time one of them was
 * nudged, and the tab is the copy nobody looks at while editing — so the path data
 * lives here and both consumers read it. Nothing in this module renders anything;
 * it is strings and numbers, so `vite.config.ts` can import it without pulling
 * React into the config.
 *
 * **The favicon is a deliberate simplification, not the same drawing scaled down.**
 * A tab icon is 16 device pixels: the topbar mark's 1.25-unit ring becomes 0.8px,
 * and the paler diagonal star fills the gaps between the cardinal arms until the
 * whole thing is a smudge. So the icon keeps the one shape that survives — the
 * solid four-point cardinal star — and replaces the open ring with a filled gold
 * disc, which is the same enclosing circle read as mass rather than as a hairline.
 * The result also matches what the topbar actually looks like: dark ink on a gold
 * plate with a `--gold-edge` rim.
 */

/** Shared by both drawings, so the two cannot end up on different grids. */
export const ROSETTE_VIEWBOX = '0 0 24 24'

/** N, E, S, W: the long solid arms that read as the needle. */
export const ROSETTE_CARDINAL_PATH =
  'M12 1.7 14.3 9.7 22.3 12 14.3 14.3 12 22.3 9.7 14.3 1.7 12 9.7 9.7Z'

/** NE, SE, SW, NW: shorter, paler, and dropped from the favicon (see above). */
export const ROSETTE_DIAGONAL_PATH =
  'M17.3 6.7 14.2 12 17.3 17.3 12 14.2 6.7 17.3 9.8 12 6.7 6.7 12 9.8Z'

/** `opacity`, not a second colour, so the topbar mark stays single-`currentColor`. */
export const ROSETTE_DIAGONAL_OPACITY = 0.45
export const ROSETTE_RING_OPACITY = 0.5
export const ROSETTE_RING_RADIUS = 10.75
export const ROSETTE_RING_WIDTH = 1.25

/*
 * The favicon's three colours are the *light* values of the tokens the topbar
 * plate already uses — `--gold`, `--gold-edge` and `--on-gold`. They are literals
 * here because a favicon has no CSS context to inherit from: `currentColor` and
 * `var()` both resolve to nothing in a document icon. A gold disc is legible on a
 * light and a dark tab strip alike, which is why the icon does not try to answer
 * `prefers-color-scheme` with a second palette.
 */
export const FAVICON_PLATE = '#f2b431'
export const FAVICON_RIM = '#8a5a08'
export const FAVICON_INK = '#33240f'

/**
 * The favicon, as a standalone SVG document.
 *
 * `xmlns` is required — this one is parsed as a file rather than inlined in HTML,
 * where the parser supplies the namespace. The 1.5-unit rim is 1px at tab size,
 * the same hairline the topbar's `--gold-edge` border draws.
 */
export function rosetteFaviconSvg(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ROSETTE_VIEWBOX}">`,
    `<circle cx="12" cy="12" r="12" fill="${FAVICON_PLATE}"/>`,
    `<circle cx="12" cy="12" r="11.25" fill="none" stroke="${FAVICON_RIM}" stroke-width="1.5"/>`,
    `<path d="${ROSETTE_CARDINAL_PATH}" fill="${FAVICON_INK}"/>`,
    '</svg>',
    '',
  ].join('\n')
}
