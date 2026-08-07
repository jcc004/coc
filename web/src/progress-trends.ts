import type { MaxLevelReferenceRow, ProgressSnapshot, WallReferenceRow } from '@coc/shared'
import { applyBaseOrder } from './base-order.ts'
import { PROGRESS_GRID_HEROES } from './progress-grid.ts'
import { percentToMax, wallProgress } from './progress-percent.ts'
import { excludeSuperTroops } from './super-troops.ts'

/**
 * The progress grid's base-to-base comparison section (`ProgressTrendsSection`):
 * one stat, plotted as one line per selected base. Distinct from
 * `progress-history.ts`, which turns *one* base's history into *per-unit*
 * series for the player page — this module turns *many* bases' histories into
 * one stat's series each, which is the shape a cross-base comparison chart
 * actually needs.
 *
 * Every stat here reduces to one clean number per base per week, on purpose:
 * a per-hero raw level (comparable across bases the same way the existing
 * grid's hero columns are) or a percent-to-cap aggregate (comparable across
 * bases at different Town Halls, the same tradeoff `ProgressGridRow.wallsAtMax`
 * already makes). There is no per-unit troop/spell/pet option here — that
 * would be 12 or 18 lines *per base*, the exact problem the troops heatmap on
 * the player page exists to solve differently, and this section compares
 * bases, not units.
 */

export interface TrendBaseSelection<T> {
  /** `items`, reordered by the account's own saved base order and capped at `max`. */
  plotted: T[]
  /** True when `items` (after reordering) had more than `max` entries. */
  capped: boolean
}

/**
 * Which bases the trends chart actually plots, and in what order — the
 * signed-in account's own saved base order (`applyBaseOrder`, `base-order.ts`)
 * applied to the owner-filtered set *before* the `MAX_TREND_BASES` cap, not
 * after. Order matters here beyond cosmetics: `order` only ever names tags
 * this account owns (`useBaseOrder`'s own reconciliation never adds anyone
 * else's base to it), so applying it first means this account's own bases
 * sort to the front — in the order that account chose on `#/base-order` — and
 * every other member's base is appended afterward in whatever order `items`
 * already had. Capping *that* sequence means a user tracking more bases than
 * the cap sees their own preferentially, not an arbitrary slice of whatever
 * order the owner filter happened to hand back.
 */
export function selectTrendBases<T extends { tag: string }>(
  items: readonly T[],
  order: readonly string[],
  max: number,
): TrendBaseSelection<T> {
  const reordered = applyBaseOrder(items, order)
  return { plotted: reordered.slice(0, max), capped: reordered.length > max }
}

export type BaseStatKey =
  | 'thLevel'
  | `hero:${(typeof PROGRESS_GRID_HEROES)[number]}`
  | 'wallsPercent'
  | 'heroesPercent'
  | 'petsPercent'
  | 'troopsPercent'
  | 'spellsPercent'

export interface TrendStatOption {
  key: BaseStatKey
  label: string
}

/**
 * The stat picker's options, in the order they appear in the `<select>`:
 * Town Hall, each hero individually (matching the grid's own hero-column
 * order), then walls and the four remaining categories as percent-to-cap
 * aggregates. Equipment has no aggregate option — out of scope for this pass,
 * the same as everywhere else in the historical view.
 */
export const TREND_STAT_OPTIONS: TrendStatOption[] = [
  { key: 'thLevel', label: 'Town Hall' },
  ...PROGRESS_GRID_HEROES.map((name): TrendStatOption => ({ key: `hero:${name}`, label: name })),
  { key: 'wallsPercent', label: 'Walls (% to max)' },
  { key: 'heroesPercent', label: 'Heroes (% to max)' },
  { key: 'petsPercent', label: 'Pets (% to max)' },
  { key: 'troopsPercent', label: 'Troops (% to max)' },
  { key: 'spellsPercent', label: 'Spells (% to max)' },
]

export function trendStatLabel(key: BaseStatKey): string {
  return TREND_STAT_OPTIONS.find((option) => option.key === key)?.label ?? key
}

/** The two reference tables every percent-to-cap stat needs. */
export interface TrendReference {
  maxLevels: readonly MaxLevelReferenceRow[]
  walls: readonly WallReferenceRow[]
}

const PERCENT_CATEGORY = {
  heroesPercent: 'hero',
  petsPercent: 'pet',
  troopsPercent: 'troop',
  spellsPercent: 'spell',
} as const

const CATEGORY_FIELD = { hero: 'heroes', pet: 'pets', troop: 'troops', spell: 'spells' } as const

/**
 * Whether a given week can answer `stat` at all — every percent-to-cap stat
 * needs *both* its category's field and `thLevel` captured the same week
 * (the reference table is TH-relative), so a week with troops but no TH is
 * excluded from the axis entirely rather than kept with a `null` point. Raw
 * stats (`thLevel` itself, a named hero's level) need only their own field.
 */
function weekHasStat(snapshot: ProgressSnapshot, stat: BaseStatKey): boolean {
  if (stat === 'thLevel') return snapshot.thLevel !== null
  if (stat.startsWith('hero:')) return snapshot.heroes !== null
  if (stat === 'wallsPercent') return snapshot.walls !== null && snapshot.thLevel !== null
  const category = PERCENT_CATEGORY[stat as keyof typeof PERCENT_CATEGORY]
  return snapshot[CATEGORY_FIELD[category]] !== null && snapshot.thLevel !== null
}

function statAtWeek(snapshot: ProgressSnapshot, stat: BaseStatKey, reference: TrendReference): number | null {
  if (stat === 'thLevel') return snapshot.thLevel

  if (stat.startsWith('hero:')) {
    const name = stat.slice('hero:'.length)
    return snapshot.heroes?.find((unit) => unit.name === name)?.level ?? null
  }

  if (stat === 'wallsPercent') {
    if (snapshot.walls === null || snapshot.thLevel === null) return null
    return wallProgress(snapshot.walls, snapshot.thLevel, reference.walls).percent
  }

  const category = PERCENT_CATEGORY[stat as keyof typeof PERCENT_CATEGORY]
  if (snapshot.thLevel === null) return null
  const units = snapshot[CATEGORY_FIELD[category]]
  if (units === null) return null
  const scoped = category === 'troop' ? excludeSuperTroops(units) : units
  return percentToMax(scoped, category, snapshot.thLevel, reference.maxLevels).percent
}

export interface StatSeriesResult {
  weeks: string[]
  points: (number | null)[]
}

/**
 * One base's chosen stat, oldest week first, over only the weeks that could
 * answer it — a week missing the field `stat` needs (no TH capture, no walls
 * entry, ...) is left out of `weeks` entirely rather than plotted as a gap,
 * the same "no data, no invented point" rule `progress-history.ts` follows.
 */
export function buildBaseStatSeries(
  snapshots: readonly ProgressSnapshot[],
  stat: BaseStatKey,
  reference: TrendReference,
): StatSeriesResult {
  const included = snapshots
    .filter((snapshot) => weekHasStat(snapshot, stat))
    .slice()
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))

  return {
    weeks: included.map((snapshot) => snapshot.weekStart),
    points: included.map((snapshot) => statAtWeek(snapshot, stat, reference)),
  }
}

export interface AlignedBaseSeries {
  tag: string
  /** Aligned to the result's `weeks` — `null` where this base has no answer. */
  points: (number | null)[]
}

export interface AlignedTrendResult {
  /** The union of every base's own weeks for this stat, ascending. */
  weeks: string[]
  series: AlignedBaseSeries[]
}

/**
 * Many bases' single-stat series, aligned onto one shared week axis — the
 * shape the chart component wants. `weeks` is the union of every base's own
 * captured weeks, not each base's local axis, because they are plotted
 * together on one x-axis; a base's `points` is `null` at any week it did not
 * itself capture, so its line breaks there rather than appearing to
 * interpolate across a week it has no answer for (an irregular capture
 * history is the normal case here — see the module doc's "space points
 * evenly by which weeks were actually captured" note in
 * `progress-history.ts`, which this equally applies to).
 */
export function alignBaseStatSeries(
  perBase: readonly { tag: string; series: StatSeriesResult }[],
): AlignedTrendResult {
  const weekSet = new Set<string>()
  for (const { series } of perBase) for (const week of series.weeks) weekSet.add(week)
  const weeks = [...weekSet].sort()

  const series = perBase.map(({ tag, series: baseSeries }) => {
    const byWeek = new Map(baseSeries.weeks.map((week, index) => [week, baseSeries.points[index] ?? null]))
    return { tag, points: weeks.map((week) => byWeek.get(week) ?? null) }
  })

  return { weeks, series }
}
