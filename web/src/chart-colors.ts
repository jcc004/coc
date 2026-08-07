/**
 * Color assignment for the historical-progress charts (`components/charts.tsx`).
 * Kept pure and separate from the rendering components for the same reason
 * every other rule module in this app is: it is the one place the "which
 * series gets which color" decision is made, so it can be pinned down with
 * plain assertions instead of read off a rendered SVG.
 *
 * Two encodings, matching the dataviz skill's categorical-vs-sequential split:
 *
 * - **Categorical** (`seriesColor`) — heroes, pets, spells, troops-heatmap
 *   legends: identity, no inherent order. Backed by eight `--series-N` custom
 *   properties in `styles.css`, holding the skill's validated eight-hue order,
 *   re-validated against *this app's* own `--surface` (warm parchment /
 *   dark wood, not the skill's neutral gray default — see the CSS comment
 *   beside them for the validator output). Referencing the custom property
 *   rather than a literal hex is what makes a chart theme-aware for free: the
 *   light/dark swap already lives in the stylesheet, the same way `Meter`
 *   never hardcodes `--accent`'s value.
 * - **Sequential, multi-hue** (`wallLevelColor`) — wall levels: level 14
 *   still needs to sit visually "between" 13 and 15, but a single hue ramped
 *   only by `color-mix` toward `--surface`/`--accent` (this function's
 *   previous shape) read as indistinguishable shades of blue once a base
 *   held more than five or six levels at once — a live-review finding, not a
 *   guess. The dataviz skill's default is one hue, light→dark, but it
 *   carves out an explicit exception for exactly this: "Analogous neighbors
 *   … are the only multi-hue sequential exceptions, always with a scale
 *   legend" (`anti-patterns.md`) — and `LineChart` always renders a legend
 *   once a chart has 2+ series, which every wall chart with more than one
 *   held level does. So this ramps through five **anchor** hues instead of
 *   one — `--wall-ramp-1` (amber, low levels) through `--wall-ramp-5` (deep
 *   teal-blue, high levels) in `styles.css`, each pair of neighbors ~30°
 *   apart on the hue wheel, never jumping across the wheel the way a
 *   "rainbow" ramp would. Lightness still falls monotonically end to end in
 *   both themes (validated with the dataviz skill's `validateOrdinal`
 *   check, run against light `--surface: #f6efdc` and dark
 *   `--surface: #241d14` — see the CSS comment beside the tokens for the
 *   exact numbers), so the ordering still reads even for a reader who only
 *   sees lightness. `wallLevelColor` interpolates between whichever two
 *   anchors bracket a level's rank, `color-mix(in oklab, ...)` between them
 *   — `oklab` over `oklch` for the same reason as before: adjacent anchors
 *   are picked close enough in hue that the two interpolation spaces mostly
 *   agree, but `oklab`'s linear a/b axes are the safer default and match
 *   every other mix in this file.
 * - **Sequential, single-hue** (`percentHeatColor`) — the troop heatmap's
 *   cell shading is unchanged: one hue (the app's existing blue accent)
 *   ramped by `color-mix(in oklab, var(--surface), var(--accent) N%)`. It
 *   was not part of the "shades of blue are indistinguishable" complaint
 *   (a heatmap cell carries its own percent as text, so adjacent cells never
 *   have to be told apart by color alone the way adjacent wall-chart lines
 *   do), so it keeps the simpler one-hue ramp rather than picking up the
 *   wall ramp's anchors for no reported problem.
 *
 * **Colors follow identity, never rank.** Every caller here is handed a
 * *stable* index — a series' fixed position in the full (unfiltered) list the
 * data layer built, never its position among only the currently-visible
 * series — so hiding one line in the legend cannot repaint the others. See
 * `anti-patterns.md`'s "recolor-on-filter" entry in the dataviz skill.
 */

/** How many hue families `--series-1`..`--series-8` cover. */
const CATEGORICAL_HUE_COUNT = 8

/**
 * The dash patterns a color cycles through once a chart has passed eight
 * series (pets can reach 12, spells 18) — composite encoding rather than a
 * ninth generated hue, which the dataviz skill's anti-patterns explicitly
 * rules out ("cycling / generating hues past 8"). `undefined` is a solid
 * line; index 0 of this list is also solid so the first eight series (the
 * common case) never carry a dash at all.
 */
const DASH_PATTERNS: (string | undefined)[] = [undefined, '7 4', '2 3']

/** One series' stroke color and dash pattern, by its stable position. */
export interface SeriesStyle {
  color: string
  dash?: string
}

/**
 * The categorical style for the `index`-th series in a fixed, stable
 * ordering. Cycles through `--series-1`..`--series-8` and, past eight, pairs
 * a repeated hue with the next dash pattern — so up to 24 series (8 hues x 3
 * dash patterns) stay pairwise distinct by hue+dash even though hue alone
 * runs out after eight. Spells (18) is the largest real category and fits
 * inside two dash cycles.
 */
export function seriesStyle(index: number): SeriesStyle {
  const hueSlot = (index % CATEGORICAL_HUE_COUNT) + 1
  const dashCycle = Math.floor(index / CATEGORICAL_HUE_COUNT) % DASH_PATTERNS.length
  return { color: `var(--series-${hueSlot})`, dash: DASH_PATTERNS[dashCycle] }
}

/** How many anchor hues `--wall-ramp-1`..`--wall-ramp-5` cover — see the module doc. */
const WALL_RAMP_STOPS = 5

/**
 * Where `rank` (0-indexed, lowest level first) sits in the five-anchor
 * multi-hue sequential ramp of `count` wall levels — a CSS color ready to
 * drop straight into a `style`/`color` prop. See the module doc for why this
 * is five anchor hues rather than one.
 *
 * `rank`/`count` is mapped onto the four gaps between the five anchors
 * (`0..4` in "anchor space"); the two anchors bracketing that position are
 * mixed by how far into the gap it falls. Landing exactly on an anchor
 * (every `count <= 5`, and every `count > 5` at the endpoints) returns that
 * anchor's bare `var(...)` rather than a same-color 0%/100% mix — simpler
 * output for the common case, and exactly matches what the old function
 * returned at rank 0 and rank `count - 1` (bare endpoints, no mix). A single
 * level (`count === 1`) gets the ramp's midpoint anchor, since there is
 * nothing to rank it against.
 */
export function wallLevelColor(rank: number, count: number): string {
  if (count <= 1) return `var(--wall-ramp-3)`

  const positionInAnchorSpace = (rank / (count - 1)) * (WALL_RAMP_STOPS - 1)
  const lowerAnchor = Math.min(WALL_RAMP_STOPS - 2, Math.floor(positionInAnchorSpace))
  const localFraction = positionInAnchorSpace - lowerAnchor

  const from = `var(--wall-ramp-${lowerAnchor + 1})`
  const to = `var(--wall-ramp-${lowerAnchor + 2})`
  if (localFraction <= 0) return from
  if (localFraction >= 1) return to
  return `color-mix(in oklab, ${from}, ${to} ${(localFraction * 100).toFixed(1)}%)`
}

/**
 * The same ramp, for a percent-to-cap value (0–100) rather than a rank — the
 * troop heatmap's cell shading. Unlike {@link wallLevelColor} this is already
 * a 0–100 scale, so no rank/count bounding is needed; it is bounded to the
 * same 15–85 band for the same legibility reason (0% must not vanish into the
 * surface, 100% must not collide with `--accent` used live elsewhere on the
 * page).
 */
export function percentHeatColor(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent))
  const mix = 15 + (clamped / 100) * 70
  return `color-mix(in oklab, var(--surface), var(--accent) ${mix.toFixed(1)}%)`
}
