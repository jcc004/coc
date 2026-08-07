import type { MaxLevelReferenceRow, ProgressSnapshot, UnitCategory, UnitLevel } from '@coc/shared'
import { percentToMax } from './progress-percent.ts'
import { excludeSuperTroops } from './super-troops.ts'

/**
 * Turns one base's full captured history (`ProgressSnapshot[]`, newest week
 * first — see `useProgressHistory`) into the shapes the historical charts on
 * `PlayerProgressPanel` actually draw: one named line per unit, one line per
 * wall level, the troops aggregate percent line, and the troop x week
 * heatmap matrix. Kept pure and tested here rather than inline in the
 * component, the same split `progress-percent.ts` and `progress-grid.ts`
 * already draw for this feature.
 *
 * **Raw levels, not percent-to-cap**, for every per-unit and per-wall-level
 * series — a hero's actual level over time, not a percentage, because the
 * TH-relative cap a percentage would divide by moves over the same span a
 * chart covers (see `docs/progress-tracking.md`'s "Percent-to-max" section).
 * The one exception is the troops *aggregate* line and heatmap, which are
 * percent-to-cap by design (see {@link buildTroopPercentSeries} and
 * {@link buildTroopHeatmap}) — there are too many troops to show 58 raw-level
 * lines on one chart, so that pair trades raw levels for a single comparable
 * number, the same tradeoff the existing progress grid already makes for its
 * "Walls at max" column.
 *
 * **The x-axis is categorical, by captured week — never a time scale.** Every
 * function below starts by keeping only the weeks where the field in
 * question was actually captured, sorted ascending, and returns that list as
 * `weeks`. A chart draws those weeks evenly spaced regardless of the true
 * calendar gap between them — spacing by elapsed time would visually
 * compress or stretch the line around a missed week, misrepresenting the
 * trend for a reason that has nothing to do with progress. `points[i]`
 * always lines up with `weeks[i]`.
 */

/** One line: a name (a unit, or a wall level as a string) and its levels/counts. */
export interface NamedSeries {
  name: string
  /** Aligned to the enclosing result's `weeks` — `null` is a real gap. */
  points: (number | null)[]
}

export interface CategorySeriesResult {
  /** Ascending `weekStart` values where this category was captured at all. */
  weeks: string[]
  /** One line per unit seen in any of `weeks`, alphabetical by name. */
  series: NamedSeries[]
}

const NO_UNITS: readonly UnitLevel[] = []

/** The five unit fields, exactly as `ProgressSnapshot` spells them. */
const UNIT_FIELD: Record<UnitCategory, 'heroes' | 'pets' | 'troops' | 'spells' | 'equipment'> = {
  hero: 'heroes',
  pet: 'pets',
  troop: 'troops',
  spell: 'spells',
  equipment: 'equipment',
}

/**
 * `snapshots`, oldest first, narrowed to the weeks where `field` is not
 * `null`. Every function below starts here: `ProgressSnapshot[]` arrives
 * newest-first (the server's own order — see `useProgressHistory`), and every
 * chart wants oldest-first, left to right, the way a reader's eye already
 * expects a trend to run.
 */
function weeksWithField<K extends keyof ProgressSnapshot>(
  snapshots: readonly ProgressSnapshot[],
  field: K,
): ProgressSnapshot[] {
  return snapshots
    .filter((snapshot) => snapshot[field] !== null)
    .slice()
    .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
}

/**
 * One category's raw levels over time — heroes, pets, spells or troops.
 * `equipment` is deliberately not accepted: it is out of scope for this
 * historical view (see the module doc on `PlayerProgressPanel.tsx`), so
 * narrowing the parameter type here is what keeps a caller from wiring it up
 * by accident.
 *
 * Troops get {@link excludeSuperTroops} applied before anything else, the
 * same as `CategorySection` on the panel this replaces — a Super Troop's
 * level is derived from its base troop's, so a second line repeating it
 * would be a duplicate, not new information.
 *
 * No "maxed" scoring here — an earlier version threaded a reference table
 * through to flag each point that had reached its TH-relative cap, for the
 * heroes chart alone to mark. That was removed along with `LineChart`'s point
 * markers (see that component's doc comment): once `PlayerProgressPanel.tsx`
 * brought back an old-style detailed block for the current week — icons,
 * fractions, "maxed" in text — the chart had nothing left to draw a maxed
 * marker onto, and no other caller had asked for the same treatment.
 */
export function buildCategorySeries(
  snapshots: readonly ProgressSnapshot[],
  category: Exclude<UnitCategory, 'equipment'>,
): CategorySeriesResult {
  const field = UNIT_FIELD[category]
  const included = weeksWithField(snapshots, field)
  const weeks = included.map((snapshot) => snapshot.weekStart)

  const unitsAt = (snapshot: ProgressSnapshot): readonly UnitLevel[] => {
    const units = snapshot[field] ?? NO_UNITS
    return category === 'troop' ? excludeSuperTroops(units) : units
  }

  const names = new Set<string>()
  for (const snapshot of included) {
    for (const unit of unitsAt(snapshot)) names.add(unit.name)
  }

  const series = [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    points: included.map((snapshot) => unitsAt(snapshot).find((unit) => unit.name === name)?.level ?? null),
  }))

  return { weeks, series }
}

/**
 * The walls chart's data: one line per wall level the base has held at some
 * point, count over time — asked for explicitly in place of the old single
 * "38/50 at max — 76%" summary line.
 *
 * **A level missing from one week's `walls` is a real 0, not a gap.** Unlike
 * the unit categories, `walls` is a base's *complete* sparse count for every
 * week it was entered (see `docs/progress-tracking.md`'s "card counts are
 * sparse" convention, which this mirrors) — a level that drops out of the map
 * because every wall at it was upgraded to the next level is zero walls at
 * that level, a real and meaningful point on its line, not an unanswered
 * question the way an unlocked-later hero is.
 */
export function buildWallsSeries(snapshots: readonly ProgressSnapshot[]): CategorySeriesResult {
  const included = weeksWithField(snapshots, 'walls')
  const weeks = included.map((snapshot) => snapshot.weekStart)

  const levels = new Set<string>()
  for (const snapshot of included) {
    for (const level of Object.keys(snapshot.walls ?? {})) levels.add(level)
  }

  const series = [...levels]
    .sort((a, b) => Number(a) - Number(b))
    .map((level) => ({
      name: level,
      points: included.map((snapshot) => snapshot.walls?.[level] ?? 0),
    }))

  return { weeks, series }
}

export interface PercentSeriesResult {
  weeks: string[]
  /** Aligned to `weeks` — `null` where `percentToMax` had no reference row. */
  points: (number | null)[]
}

/** One captured jump in Town Hall level — see {@link buildThUpgrades}. */
export interface ThUpgradeEvent {
  from: number
  to: number
  /**
   * The week this jump was *captured*, not necessarily the real-world day
   * the upgrade finished — capture is weekly (`capture-snapshot.ts`), so a
   * Town Hall that finished upgrading on a Thursday still reads as the
   * following Tuesday's date here. Honest about what was actually measured,
   * the same reasoning `null` gets elsewhere in this module.
   */
  weekStart: string
}

/**
 * Every Town Hall level increase across the captured weeks, oldest first —
 * "Overall progress" on `PlayerProgressPanel`, replacing the tiny
 * single-series line chart TH used to get. TH moves too rarely (months
 * between upgrades) to earn its own line chart against a weekly x-axis; a
 * short list of "TH N → N+1 — date" events says the same thing without an
 * axis that is flat for months at a time.
 *
 * Walks consecutive *captured* weeks (via {@link weeksWithField}, so a week
 * with no `thLevel` at all is skipped rather than breaking the comparison)
 * and emits an event wherever the level went up from one to the next. A week
 * where the level stayed flat contributes nothing; a level that *drops*
 * between two capture weeks (an account merge, a bad capture) is not
 * reported either — this narrates forward progress only, which is what
 * "Overall progress" is for.
 */
export function buildThUpgrades(snapshots: readonly ProgressSnapshot[]): ThUpgradeEvent[] {
  const included = weeksWithField(snapshots, 'thLevel')
  const events: ThUpgradeEvent[] = []
  for (let index = 1; index < included.length; index += 1) {
    const previous = included[index - 1]!.thLevel as number
    const current = included[index]!
    const currentLevel = current.thLevel as number
    if (currentLevel > previous) {
      events.push({ from: previous, to: currentLevel, weekStart: current.weekStart })
    }
  }
  return events
}

/**
 * The troops aggregate line — percent of troops maxed for the base's current
 * TH, over time. Reuses `percentToMax`'s `.percent` (called with
 * `category: 'troop'`) rather than recomputing anything; see that function's
 * own doc comment for why the aggregate excludes units the reference table
 * has nothing to say for instead of coercing them to 0%.
 *
 * Needs both `troops` and `thLevel` captured the same week — `percentToMax`
 * scores against the TH-relative cap, so a week with troops but no TH (or
 * vice versa) has nothing to plot and is left out of `weeks` entirely, the
 * same "no data, no invented point" stance every function in this module
 * takes.
 */
export function buildTroopPercentSeries(
  snapshots: readonly ProgressSnapshot[],
  reference: readonly MaxLevelReferenceRow[],
): PercentSeriesResult {
  const included = weeksWithField(snapshots, 'troops').filter((snapshot) => snapshot.thLevel !== null)
  const weeks = included.map((snapshot) => snapshot.weekStart)

  const points = included.map((snapshot) => {
    const troops = excludeSuperTroops(snapshot.troops ?? NO_UNITS)
    return percentToMax(troops, 'troop', snapshot.thLevel as number, reference).percent
  })

  return { weeks, points }
}

export interface TroopHeatmapResult {
  weeks: string[]
  /** Troop names, alphabetical, Super Troops already excluded. */
  troopNames: string[]
  /**
   * `matrix[row][col]` is `troopNames[row]`'s percent-to-cap at `weeks[col]`,
   * or `null` when that troop was not captured that week (not yet unlocked,
   * or the week had no troops capture at all). Per-unit `.percent`, not raw
   * level — comparable coloring across troops with very different level
   * ranges is the whole reason this is a heatmap and not another line chart.
   */
  matrix: (number | null)[][]
}

/**
 * The troop x week heatmap — the drill-down under the troops aggregate line.
 * Troops/spells/equipment only started being captured for real in the last
 * few weeks (the historical backfill's source, an old spreadsheet, never
 * tracked them), so `weeks` here will often be one to a handful of columns
 * right now; a one-column heatmap is the correct, current shape of the data,
 * not a bug, and grows on its own as `capture-snapshot.ts` runs weekly.
 */
export function buildTroopHeatmap(
  snapshots: readonly ProgressSnapshot[],
  reference: readonly MaxLevelReferenceRow[],
): TroopHeatmapResult {
  const included = weeksWithField(snapshots, 'troops').filter((snapshot) => snapshot.thLevel !== null)
  const weeks = included.map((snapshot) => snapshot.weekStart)

  const scoredByWeek = included.map((snapshot) =>
    percentToMax(
      excludeSuperTroops(snapshot.troops ?? NO_UNITS),
      'troop',
      snapshot.thLevel as number,
      reference,
    ),
  )

  const names = new Set<string>()
  for (const scored of scoredByWeek) {
    for (const unit of scored.units) names.add(unit.name)
  }
  const troopNames = [...names].sort((a, b) => a.localeCompare(b))

  const matrix = troopNames.map((name) =>
    scoredByWeek.map((scored) => scored.units.find((unit) => unit.name === name)?.percent ?? null),
  )

  return { weeks, troopNames, matrix }
}
