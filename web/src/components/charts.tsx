import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatDate } from '../format.ts'
import { percentHeatColor } from '../chart-colors.ts'

/**
 * The first SVG chart primitives in this app — `Meter` (`primitives.tsx`) is
 * the only prior "visual magnitude" primitive, and it is a plain div bar with
 * no axis, no series and no history to plot. This app has never added a
 * charting dependency (native drag-and-drop instead of a DnD library,
 * hand-rolled headless-Chrome browser testing instead of a test-browser
 * package — see `CLAUDE.md`), so `LineChart` and `Heatmap` are hand-rolled
 * inline SVG / HTML, matching that pattern rather than breaking it.
 *
 * Both consume already-shaped data (`progress-history.ts` / `progress-trends.ts`)
 * and know nothing about `ProgressSnapshot`, `UnitLevel` or any of this
 * feature's own types — the same "component renders, a pure module computes"
 * split the rest of this app follows.
 *
 * Colors are always a CSS value referencing this app's own custom
 * properties (`--series-N`, `--accent`, `--surface`) — see `chart-colors.ts` —
 * never a literal hex here, which is what makes every chart theme-aware for
 * free: light/dark already live in `styles.css`.
 */

export interface ChartSeries {
  /** Stable identity — legend toggling and color assignment key on this, never on array position. */
  id: string
  label: string
  color: string
  /** SVG `stroke-dasharray`, for a series past the eighth categorical hue. */
  dash?: string
  /** Aligned to the chart's `weeks` — `null` is a real gap, never coerced to 0. */
  points: (number | null)[]
}

const CHART_WIDTH = 720
const PAD_LEFT = 46
const PAD_RIGHT = 16
const PAD_TOP = 14
const PAD_BOTTOM = 30

/** ~`count` round tick values spanning `[min, max]` — 1/2/5/10 step sizes, never an odd one. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min]
  const rawStep = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const residual = rawStep / magnitude
  const step = (residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1) * magnitude
  const ticks: number[] = []
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    ticks.push(Math.round(value * 1000) / 1000)
  }
  return ticks
}

function defaultFormatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * A hand-rolled inline-SVG line chart over a **categorical** week axis (never
 * a continuous time scale — see `progress-history.ts`'s module doc for why).
 *
 * - A legend toggles a series' visibility on click when there are 2+ series;
 *   a single series gets no legend box (the chart's `ariaLabel` already says
 *   what is plotted, matching the dataviz skill's "a box with one swatch
 *   restates the title" rule).
 * - Hovering or focusing the plot draws a crosshair and a tooltip listing
 *   every visible series' value at that week — the line itself is the whole
 *   mark; there is no per-point dot to hit or hover.
 * - A "Show as table" disclosure holds the same weeks x series values as a
 *   plain HTML table — the relief this app's categorical palette's light-mode
 *   contrast WARN requires (see the token comment in `styles.css`), and the
 *   fallback for a value a hover can't reach at all (no pointer, no JS).
 *
 * **No point markers** — pure lines, nothing drawn at each `(week, value)`
 * coordinate. Earlier drafts drew a small circle at every point, then grew a
 * second "maxed" treatment on top of it (a bigger ring for a unit at its
 * TH-relative cap); live review found the dots crowded a chart carrying a
 * full season of weekly points across several series, and the maxed ring
 * made that worse rather than better. Removed rather than shrunk again: the
 * value at a point is still reachable two other ways — the hover/keyboard
 * crosshair and tooltip below, and the "Show as table" fallback — and once
 * `PlayerProgressPanel.tsx` brought back an old-style detailed block for the
 * current week (icons, fractions, "maxed" in text), the chart no longer had
 * to carry that status at all, which is what let `ChartSeries.maxed` and the
 * marker-color machinery it drove go with the dots rather than staying as
 * dead code with nothing left to draw.
 */
export function LineChart({
  weeks,
  series,
  ariaLabel,
  height = 240,
  formatWeek = formatDate,
  formatValue = defaultFormatValue,
  yBounds,
  yUnit = '',
  emptyMessage = 'Nothing captured yet.',
}: {
  weeks: string[]
  series: ChartSeries[]
  ariaLabel: string
  height?: number
  formatWeek?: (week: string) => string
  formatValue?: (value: number) => string
  /**
   * The outer limits a *bounded* stat's y-axis may never cross — `[0, 100]`
   * for a percent chart — not a fixed axis. The axis still auto-fits to the
   * padded range of whatever is actually plotted, the same as the default
   * (unbounded) case below; this only clamps that fit so it never extends
   * past a limit the stat itself cannot cross (a percent chart never shows
   * 104% just because padding would otherwise add it).
   *
   * Was a fixed `[0, 100]` "always start the axis at the floor" domain before
   * a live-review finding: real clan data on the trends comparison section
   * clustered entirely in the 60–100% band, so a 0-anchored axis wasted its
   * bottom 60% and compressed every real difference into a thin top strip.
   * Auto-fitting within these bounds instead means a tightly clustered stat
   * actually zooms in and shows its real spread — the tick labels are always
   * the real values (`niceTicks` below), never hidden or omitted, so the
   * zoomed-in range is legible as exactly what it is rather than reading as
   * more variation than the axis backs up. Omitted, the axis is fully
   * unbounded — the plain "pad whatever the data span is" behavior every
   * non-percent chart on this page still uses.
   */
  yBounds?: [number, number]
  yUnit?: string
  emptyMessage?: string
}) {
  const titleId = useId()
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  // Visibility narrows which series draw and which feed the y-range, but
  // never reorders or recolors `series` itself — a hidden line keeps its
  // color and its legend position, so un-hiding it never looks like a new
  // series (see chart-colors.ts's "color follows identity, never rank").
  const visible = useMemo(() => series.filter((entry) => !hiddenIds.has(entry.id)), [series, hiddenIds])

  const { min, max } = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const entry of visible) {
      for (const point of entry.points) {
        if (point === null) continue
        if (point < lo) lo = point
        if (point > hi) hi = point
      }
    }
    if (lo === Infinity) return { min: yBounds?.[0] ?? 0, max: yBounds?.[1] ?? 1 }

    let paddedLo: number
    let paddedHi: number
    if (lo === hi) {
      paddedLo = lo - 1
      paddedHi = hi + 1
    } else {
      const pad = (hi - lo) * 0.1
      paddedLo = lo - pad
      paddedHi = hi + pad
    }
    if (!yBounds) return { min: paddedLo, max: paddedHi }
    return { min: Math.max(yBounds[0], paddedLo), max: Math.min(yBounds[1], paddedHi) }
  }, [visible, yBounds])

  const plotWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = height - PAD_TOP - PAD_BOTTOM
  const ticks = useMemo(() => niceTicks(min, max), [min, max])

  function xAt(index: number): number {
    return PAD_LEFT + (weeks.length <= 1 ? plotWidth / 2 : (index / (weeks.length - 1)) * plotWidth)
  }
  function yAt(value: number): number {
    return PAD_TOP + plotHeight - ((value - min) / (max - min || 1)) * plotHeight
  }

  function toggle(id: string) {
    setHiddenIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function indexFromPointer(event: ReactPointerEvent<SVGSVGElement>): number {
    const rect = event.currentTarget.getBoundingClientRect()
    const scaleX = CHART_WIDTH / rect.width
    const localX = (event.clientX - rect.left) * scaleX
    const ratio = weeks.length <= 1 ? 0 : (localX - PAD_LEFT) / plotWidth
    return Math.min(weeks.length - 1, Math.max(0, Math.round(ratio * (weeks.length - 1))))
  }

  // `weeks.length > 0` with no series at all happens when a category was
  // captured but genuinely empty that week (an auto-capture writing `[]`,
  // not `null`) — a base with no pets unlocked yet, say. There is still
  // nothing to plot, so this reads the same as no history at all rather
  // than an axis with no lines on it.
  if (weeks.length === 0 || series.length === 0) {
    return <p className="empty-hint">{emptyMessage}</p>
  }

  /** One series' points as one or more subpaths, breaking (never bridging) at a `null` gap. */
  function pathsFor(points: (number | null)[]): string[] {
    const segments: string[] = []
    let current = ''
    for (const [index, point] of points.entries()) {
      if (point === null) {
        if (current) segments.push(current)
        current = ''
        continue
      }
      current += `${current ? ' L' : 'M'}${xAt(index)},${yAt(point)}`
    }
    if (current) segments.push(current)
    return segments
  }

  // Thin x-axis labels so they don't collide — always keep the first and last.
  const labelStride = weeks.length > 8 ? Math.ceil(weeks.length / 8) : 1

  return (
    <div className="chart">
      <svg
        className="chart__plot"
        viewBox={`0 0 ${CHART_WIDTH} ${height}`}
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        onPointerMove={(event) => setHoverIndex(indexFromPointer(event))}
        onPointerLeave={() => setHoverIndex(null)}
        onFocus={() => setHoverIndex((current) => current ?? 0)}
        onBlur={() => setHoverIndex(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setHoverIndex((current) => Math.min(weeks.length - 1, (current ?? -1) + 1))
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setHoverIndex((current) => Math.max(0, (current ?? weeks.length) - 1))
          }
        }}
      >
        <title id={titleId}>{ariaLabel}</title>

        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="chart__gridline"
              x1={PAD_LEFT}
              x2={CHART_WIDTH - PAD_RIGHT}
              y1={yAt(tick)}
              y2={yAt(tick)}
            />
            <text className="chart__tick" x={PAD_LEFT - 8} y={yAt(tick)} textAnchor="end" dominantBaseline="middle">
              {formatValue(tick)}
              {yUnit}
            </text>
          </g>
        ))}

        <line
          className="chart__axis"
          x1={PAD_LEFT}
          x2={CHART_WIDTH - PAD_RIGHT}
          y1={PAD_TOP + plotHeight}
          y2={PAD_TOP + plotHeight}
        />

        {weeks.map((week, index) =>
          index % labelStride !== 0 && index !== weeks.length - 1 ? null : (
            <text key={week} className="chart__tick" x={xAt(index)} y={height - 8} textAnchor="middle">
              {formatWeek(week)}
            </text>
          ),
        )}

        {hoverIndex !== null ? (
          <line
            className="chart__crosshair"
            x1={xAt(hoverIndex)}
            x2={xAt(hoverIndex)}
            y1={PAD_TOP}
            y2={PAD_TOP + plotHeight}
          />
        ) : null}

        {visible.map((entry) => (
          <g key={entry.id}>
            {pathsFor(entry.points).map((d, segmentIndex) => (
              <path
                key={segmentIndex}
                d={d}
                fill="none"
                stroke={entry.color}
                strokeWidth={2}
                strokeDasharray={entry.dash}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </g>
        ))}
      </svg>

      {hoverIndex !== null ? (
        <div className="chart__tooltip" role="status">
          <div className="chart__tooltip-week">{formatWeek(weeks[hoverIndex] ?? '')}</div>
          <ul className="chart__tooltip-rows">
            {visible.map((entry) => {
              const value = entry.points[hoverIndex]
              return (
                <li key={entry.id}>
                  <span className="chart__tooltip-key" style={{ background: entry.color }} />
                  <span className="chart__tooltip-label">{entry.label}</span>
                  <span className="chart__tooltip-value">
                    {value === null || value === undefined ? '—' : `${formatValue(value)}${yUnit}`}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {series.length > 1 ? (
        <ul className="chart__legend">
          {series.map((entry) => {
            const hidden = hiddenIds.has(entry.id)
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={hidden ? 'chart__legend-item chart__legend-item--hidden' : 'chart__legend-item'}
                  onClick={() => toggle(entry.id)}
                  aria-pressed={!hidden}
                  aria-label={`${hidden ? 'Show' : 'Hide'} ${entry.label}`}
                >
                  <span
                    className="chart__legend-swatch"
                    style={{
                      borderTopColor: entry.color,
                      borderTopStyle: entry.dash ? 'dashed' : 'solid',
                    }}
                  />
                  {entry.label}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      <details className="chart__table-toggle">
        <summary>Show as table</summary>
        <div className="table-wrap">
          <table className="roster">
            <thead>
              <tr>
                <th scope="col">Week</th>
                {series.map((entry) => (
                  <th scope="col" key={entry.id}>
                    {entry.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week, index) => (
                <tr key={week}>
                  <th scope="row">{formatWeek(week)}</th>
                  {series.map((entry) => {
                    const value = entry.points[index]
                    return (
                      <td className="num" key={entry.id}>
                        {value === null || value === undefined ? '—' : `${formatValue(value)}${yUnit}`}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/**
 * The troop x week drill-down under the troops aggregate line — one row per
 * troop, one column per captured week, each cell shaded by percent-to-cap via
 * `percentHeatColor` — its own single-hue sequential ramp, keyed by value
 * rather than by rank. Deliberately not the wall chart's multi-hue ramp
 * (`wallLevelColor`): a heatmap cell carries its own percent as text, so
 * adjacent cells are never told apart by color alone the way the wall
 * chart's adjacent *lines* are — see `chart-colors.ts`'s module doc for why
 * the two sequential ramps in this app diverged. A cell also carries its
 * percent as text with a `text-shadow` halo in `--surface` (`.heatmap__value`
 * in `styles.css`) rather than color alone — the halo keeps the digits
 * legible against every step of the ramp in both themes without computing
 * per-cell contrast, the same "pick white or ink so it always clears
 * contrast" exception the dataviz skill carves out for in-fill labels.
 *
 * Troops/spells only started being captured for real in the last few weeks
 * (see `progress-history.ts`'s `buildTroopHeatmap`), so a one- or
 * few-column table is the expected, current shape of this data, not a bug —
 * it renders exactly the same way a wider one will once more weeks land.
 */
export function TroopHeatmap({
  weeks,
  troopNames,
  matrix,
  ariaLabel,
  formatWeek = formatDate,
  emptyMessage = 'Nothing captured yet.',
}: {
  weeks: string[]
  troopNames: string[]
  matrix: (number | null)[][]
  ariaLabel: string
  formatWeek?: (week: string) => string
  emptyMessage?: string
}) {
  if (weeks.length === 0 || troopNames.length === 0) {
    return <p className="empty-hint">{emptyMessage}</p>
  }

  return (
    <div className="table-wrap">
      <table className="roster heatmap" aria-label={ariaLabel}>
        <thead>
          <tr>
            <th scope="col">Troop</th>
            {weeks.map((week) => (
              <th scope="col" key={week}>
                {formatWeek(week)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {troopNames.map((name, rowIndex) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              {(matrix[rowIndex] ?? []).map((value, colIndex) => (
                <td
                  className="heatmap__cell"
                  key={weeks[colIndex]}
                  style={value === null ? undefined : { background: percentHeatColor(value) }}
                  title={`${name}, ${formatWeek(weeks[colIndex] ?? '')}: ${
                    value === null ? 'not unlocked yet' : `${Math.round(value)}% to cap`
                  }`}
                >
                  {value === null ? (
                    <span className="card-meta">—</span>
                  ) : (
                    <span className="heatmap__value">{Math.round(value)}%</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
