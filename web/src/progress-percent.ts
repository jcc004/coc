import type { MaxLevelReferenceRow, UnitCategory, UnitLevel, WallReferenceRow } from '@coc/shared'

/**
 * "% maxed for current TH" — a snapshot's captured levels, held up against the
 * wiki-scraped cap for the account's own Town Hall.
 *
 * `UnitLevel.maxLevel` (as the API sends it) is **not** what this compares
 * against: it is the unit's absolute game-max, the same number regardless of
 * the account's Town Hall — a Barbarian King reads `maxLevel: 110` whether the
 * base is TH9 or TH17. The number that means something on a per-week progress
 * page is the TH-relative cap, which only `MaxLevelReferenceRow` carries. So
 * every function here takes the reference table and ignores the API's own
 * `maxLevel` entirely.
 *
 * Pure and client-side: no fetching, no server dependency. `heroes`,
 * `equipment`, `pets`, `troops` and `spells` are all `UnitLevel[]`, so one
 * function serves all five — the caller picks the field and the category.
 */

/** One unit, next to the TH-relative cap it is climbing toward. */
export interface UnitProgress {
  name: string
  level: number
  /**
   * The cap for this unit at this Town Hall, or `null` when the reference
   * table has nothing to say — the wiki scrape has not covered it, or the
   * unit is not yet unlocked at this TH. `null` here, not 0 or the level
   * itself: either of those would read as a real answer ("maxed" or
   * "impossible to progress") about a unit this function has no data on.
   */
  maxForTh: number | null
  /** `null` exactly when `maxForTh` is `null` — there is nothing to divide by. */
  percent: number | null
}

/** The aggregate across one category's units. */
export interface CategoryProgress {
  units: UnitProgress[]
  /**
   * Combined level over combined cap, across only the units that had a
   * reference row. A unit missing its cap is excluded here rather than
   * folded in at 0% or 100% — either would move the aggregate toward an
   * answer nobody actually measured. `null` when every unit in the category
   * lacked a reference row (or the category was empty), so there is nothing
   * to average.
   */
  percent: number | null
  /** Units maxed (`level >= maxForTh`) among those with a known cap. */
  atMax: number
  /** Units this function had a cap for, out of the total handed in. */
  covered: number
  total: number
}

function referenceIndex(
  reference: readonly MaxLevelReferenceRow[],
): Map<string, MaxLevelReferenceRow> {
  const index = new Map<string, MaxLevelReferenceRow>()
  for (const row of reference) {
    index.set(`${row.category} ${row.name} ${row.thLevel}`, row)
  }
  return index
}

/**
 * One category's units (heroes, equipment, pets, troops or spells), scored
 * against the reference table for `thLevel`.
 *
 * `units` is a plain `UnitLevel[]` — pass whichever of a `ProgressSnapshot`'s
 * five unit fields is being shown, after narrowing away `null`. A snapshot
 * with no capture for that field simply is not called with one.
 */
export function percentToMax(
  units: readonly UnitLevel[],
  category: UnitCategory,
  thLevel: number,
  reference: readonly MaxLevelReferenceRow[],
): CategoryProgress {
  const index = referenceIndex(reference)

  const scored = units.map((unit) => {
    const row = index.get(`${category} ${unit.name} ${thLevel}`)
    if (!row) return { name: unit.name, level: unit.level, maxForTh: null, percent: null }
    const percent = row.maxLevel <= 0 ? null : Math.min(100, (unit.level / row.maxLevel) * 100)
    return { name: unit.name, level: unit.level, maxForTh: row.maxLevel, percent }
  })

  let levelSum = 0
  let capSum = 0
  let atMax = 0
  let covered = 0
  for (const unit of scored) {
    if (unit.maxForTh === null) continue
    covered += 1
    levelSum += unit.level
    capSum += unit.maxForTh
    if (unit.level >= unit.maxForTh) atMax += 1
  }

  return {
    units: scored,
    percent: capSum > 0 ? (levelSum / capSum) * 100 : null,
    atMax,
    covered,
    total: units.length,
  }
}

/** One wall level, next to how many of that level the base could have. */
export interface WallLevelProgress {
  level: string
  count: number
}

/** Walls-toward-max for one Town Hall, read off a snapshot's sparse `walls`. */
export interface WallProgress {
  /**
   * `null` when `WallReferenceRow` has no row for this Town Hall at all —
   * the API supplies no wall data of its own, so an uncovered TH has nothing
   * to compare against, not a 0% wall progress.
   */
  reference: { maxWallLevel: number; totalWallCount: number } | null
  /** Every level present in the snapshot's `walls`, sparse counts as given. */
  levels: WallLevelProgress[]
  /** Walls at the TH's max level, or `null` when there is no reference row. */
  atMax: number | null
  /** Total walls the snapshot accounts for (sum of `walls`' counts). */
  totalHeld: number
  /**
   * `atMax / totalWallCount`, or `null` without a reference row. Not
   * `atMax / totalHeld`: a base that has not entered every wall yet should
   * not read as more "done" than it is because the denominator shrank.
   */
  percent: number | null
}

/**
 * A snapshot's `walls` (`{"<level>": count}`), scored against `WallReferenceRow`
 * for `thLevel`.
 *
 * Takes `walls` already non-null — a snapshot with no wall entry yet is the
 * caller's decision not to call this, the same shape `percentToMax` uses for
 * the unit fields.
 */
export function wallProgress(
  walls: Readonly<Record<string, number>>,
  thLevel: number,
  reference: readonly WallReferenceRow[],
): WallProgress {
  const row = reference.find((entry) => entry.thLevel === thLevel) ?? null

  const levels = Object.entries(walls).map(([level, count]) => ({ level, count }))
  const totalHeld = levels.reduce((sum, entry) => sum + entry.count, 0)
  const atMax = row ? (walls[String(row.maxWallLevel)] ?? 0) : null

  const percent =
    row && row.totalWallCount > 0 ? Math.min(100, ((atMax ?? 0) / row.totalWallCount) * 100) : null

  return {
    reference: row ? { maxWallLevel: row.maxWallLevel, totalWallCount: row.totalWallCount } : null,
    levels,
    atMax,
    totalHeld,
    percent,
  }
}
