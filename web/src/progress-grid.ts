import type { MaxLevelReferenceRow, ProgressSnapshot, UnitLevel, WallReferenceRow } from '@coc/shared'
import { combineSnapshotNotes } from './progress-diff.ts'
import { wallProgress } from './progress-percent.ts'
import { numberCompare, textCompare, type TableColumn } from './saved-table.ts'

/**
 * The clan-wide progress board's rows, spreadsheet-shaped — one column per
 * individual stat rather than an aggregated percent. Replaces `progress-table.ts`'s
 * `ProgressRow` / `buildProgressRows`, which this board no longer uses: that shape
 * fit a "Heroes 82%, Walls 61%" summary, and there is no way to project a
 * per-hero, per-pet column layout back out of a single combined percent. Kept out
 * of the component for the same reason `progress-table.ts` was — reasoned about
 * and tested without a DOM.
 *
 * This is a fresh design, not an extension of `ProgressRow`, but it keeps that
 * module's two working conventions: an owner-gated-nothing board (every clan
 * member the server has ever captured a row for is a row here, not just bases
 * somebody has claimed — see `ProgressBoardView`'s original note, now this
 * component's), and the `Ownable` shape `card-standings.ts` filters on, so the
 * Owner select is the leaderboard's, not a second copy of it.
 */

/**
 * The app's six home-village heroes, fixed columns in this order. Not derived
 * from anything live — a base's own `heroes` array only ever lists the heroes it
 * has actually unlocked, so there is no single snapshot to read the full roster
 * off, and a roster this short is cheaper to state once than to infer.
 *
 * Spelled exactly as the API and `wiki-art.generated.ts` spell them (`apiName`),
 * since a name here is also the lookup key into a snapshot's `heroes` array and
 * into `artFor('hero', name)`.
 */
export const PROGRESS_GRID_HEROES = [
  'Barbarian King',
  'Archer Queen',
  'Grand Warden',
  'Royal Champion',
  'Minion Prince',
  'Dragon Duke',
] as const

/**
 * The twelve known pets, fixed columns for the same reason the heroes are: a
 * fixed roster reads as a stable table, one that does not reshuffle its own
 * columns when a filter or a sort narrows which rows are on screen. A pet a base
 * has not unlocked is a blank cell in its column (see {@link levelsFor}), not a
 * missing column — the alternative, showing only the pets *some* row in the
 * current view actually has, would mean paging or filtering could change which
 * columns exist at all, which is a worse reading experience than a wide table
 * with some empty cells in it.
 */
export const PROGRESS_GRID_PETS = [
  'L.A.S.S.I',
  'Electro Owl',
  'Mighty Yak',
  'Unicorn',
  'Frosty',
  'Diggy',
  'Poison Lizard',
  'Phoenix',
  'Spirit Fox',
  'Angry Jelly',
  'Sneezy',
  'Greedy Raven',
] as const

/** One base's row on the grid, whether or not it has ever been captured. */
export interface ProgressGridRow {
  tag: string
  label: string
  /** Same tri-state `BaseStanding.owner` and `ProgressRow.owner` use — see `Ownable`. */
  owner: string | null
  /** Same as `BaseStanding.ownerUserId` — what the shared owner filter actually keys on. */
  ownerUserId: number | null
  /** `false` when this base has an owner but no `base_progress` row at all. */
  tracked: boolean
  thLevel: number | null
  /**
   * One level per name in {@link PROGRESS_GRID_HEROES}. `null` for a hero this
   * base has not unlocked yet (or has never been captured) — rendered as a truly
   * blank cell, not a dash, so a low-TH base's row does not read as sixteen
   * missing answers.
   */
  heroes: Record<string, number | null>
  /**
   * Which of {@link PROGRESS_GRID_HEROES} are at this row's Town-Hall-relative
   * cap — the green-highlight signal, same "maxed" test `isMaxed`
   * (`unit-display.ts`) uses on the per-base panel, just precomputed per cell
   * here rather than re-looked-up at render time for every row on the page.
   * `false`, never absent, for a hero with no level or no reference row: nothing
   * is highlighted without a real "level >= cap" answer.
   */
  heroesMaxed: Record<string, boolean>
  /** As `heroes`, one level per name in {@link PROGRESS_GRID_PETS}. */
  pets: Record<string, number | null>
  /** As `heroesMaxed`, for {@link PROGRESS_GRID_PETS}. */
  petsMaxed: Record<string, boolean>
  /**
   * Walls at the Town Hall's max level, from `wallProgress`'s `atMax`. `null`
   * exactly when `wallsTotal` is `null` — either this week has no wall entry at
   * all, or the wall reference table has no row for this Town Hall to compare
   * against.
   */
  wallsAtMax: number | null
  /** The Town Hall's total wall count, from `wallProgress`'s `reference`. */
  wallsTotal: number | null
  buildingsLeft: string | null
  /** `combineSnapshotNotes`'s one-line join of the auto and manual notes. */
  notes: string
}

const NO_UNITS: readonly UnitLevel[] = []

/**
 * One category's levels, keyed by the fixed column names — `null` for a name not
 * present in `units` (not unlocked at this base, or not captured this week).
 * Shared by heroes and pets, since both are "a fixed roster of names, sparse
 * per base" in exactly the same shape.
 */
function levelsFor(
  names: readonly string[],
  units: readonly UnitLevel[] | null,
): Record<string, number | null> {
  const byName = new Map((units ?? NO_UNITS).map((unit) => [unit.name, unit.level]))
  const levels: Record<string, number | null> = {}
  for (const name of names) levels[name] = byName.get(name) ?? null
  return levels
}

function blankLevels(names: readonly string[]): Record<string, number | null> {
  return levelsFor(names, null)
}

/**
 * Which of `names` (already resolved to a level via {@link levelsFor}) are at
 * this row's Town-Hall-relative cap. `thLevel: null` (never captured, or the
 * wiki scrape has not reached this Town Hall) answers `false` for everything —
 * there is nothing to compare against, the same "no data, no highlight" stance
 * `UnitProgress.maxForTh: null` takes in `progress-percent.ts`.
 */
function maxedFor(
  names: readonly string[],
  levels: Record<string, number | null>,
  category: 'hero' | 'pet',
  thLevel: number | null,
  maxLevels: readonly MaxLevelReferenceRow[],
): Record<string, boolean> {
  const maxed: Record<string, boolean> = {}
  for (const name of names) {
    const level = levels[name]
    const cap =
      thLevel === null
        ? undefined
        : maxLevels.find(
            (row) => row.category === category && row.name === name && row.thLevel === thLevel,
          )
    maxed[name] = level !== null && level !== undefined && cap !== undefined && level >= cap.maxLevel
  }
  return maxed
}

function blankMaxed(names: readonly string[]): Record<string, boolean> {
  const maxed: Record<string, boolean> = {}
  for (const name of names) maxed[name] = false
  return maxed
}

/**
 * Every tracked base (an owner assignment), joined against its latest captured
 * week if it has one — the same identity-is-`tags` shape `buildProgressRows`
 * used, for the same reason: a base can have an owner and no progress row yet,
 * and it must still appear as a row, not be left out because `snapshots` has
 * nothing for it.
 */
export function buildProgressGridRows(
  tags: readonly string[],
  labelOf: (tag: string) => string,
  ownerOf: (tag: string) => string | undefined,
  ownerUserIdOf: (tag: string) => number | null,
  snapshots: readonly ProgressSnapshot[],
  wallReference: readonly WallReferenceRow[],
  maxLevels: readonly MaxLevelReferenceRow[],
): ProgressGridRow[] {
  const byTag = new Map(snapshots.map((snapshot) => [snapshot.playerTag, snapshot]))

  return tags.map((tag) => {
    const snapshot = byTag.get(tag)
    const label = labelOf(tag)
    const owner = ownerOf(tag) ?? null
    const ownerUserId = ownerUserIdOf(tag)

    if (!snapshot) {
      return {
        tag,
        label,
        owner,
        ownerUserId,
        tracked: false,
        thLevel: null,
        heroes: blankLevels(PROGRESS_GRID_HEROES),
        heroesMaxed: blankMaxed(PROGRESS_GRID_HEROES),
        pets: blankLevels(PROGRESS_GRID_PETS),
        petsMaxed: blankMaxed(PROGRESS_GRID_PETS),
        wallsAtMax: null,
        wallsTotal: null,
        buildingsLeft: null,
        notes: '',
      }
    }

    const walls =
      snapshot.walls !== null && snapshot.thLevel !== null
        ? wallProgress(snapshot.walls, snapshot.thLevel, wallReference)
        : null

    const heroes = levelsFor(PROGRESS_GRID_HEROES, snapshot.heroes)
    const pets = levelsFor(PROGRESS_GRID_PETS, snapshot.pets)

    return {
      tag,
      label,
      owner,
      ownerUserId,
      tracked: true,
      thLevel: snapshot.thLevel,
      heroes,
      heroesMaxed: maxedFor(PROGRESS_GRID_HEROES, heroes, 'hero', snapshot.thLevel, maxLevels),
      pets,
      petsMaxed: maxedFor(PROGRESS_GRID_PETS, pets, 'pet', snapshot.thLevel, maxLevels),
      wallsAtMax: walls?.atMax ?? null,
      wallsTotal: walls?.reference?.totalWallCount ?? null,
      buildingsLeft: snapshot.buildingsLeft,
      notes: combineSnapshotNotes(snapshot).combined,
    }
  })
}

/**
 * `hero:<name>` / `pet:<name>` cover every column in {@link PROGRESS_GRID_HEROES}
 * and {@link PROGRESS_GRID_PETS} without hand-listing thirty-odd literal keys —
 * a template literal type rather than a union, so it still narrows to `string`
 * for `SortControl<K extends string>` and the `<select>` it renders.
 */
export type ProgressGridSortKey =
  | 'label'
  | 'thLevel'
  | 'buildingsLeft'
  | 'wallsAtMax'
  | `hero:${string}`
  | `pet:${string}`

function heroColumn(name: string, label: string): TableColumn<ProgressGridSortKey> {
  return { key: `hero:${name}`, label, numeric: true, long: name }
}

function petColumn(name: string, label: string): TableColumn<ProgressGridSortKey> {
  return { key: `pet:${name}`, label, numeric: true, long: name }
}

/**
 * Community shorthand, not an invention here — these four letters are how the
 * game's own players refer to their heroes everywhere but this app.
 */
export const HERO_ABBREVIATIONS: Record<string, string> = {
  'Barbarian King': 'BK',
  'Archer Queen': 'AQ',
  'Grand Warden': 'GW',
  'Royal Champion': 'RC',
  'Minion Prince': 'MP',
  'Dragon Duke': 'DD',
}

/**
 * The original spreadsheet's own pet column letters, carried over rather than
 * invented here — there is no community-standard pet shorthand the way there is
 * for heroes, so this is specifically the abbreviation the user who kept that
 * sheet already used, in the same order as {@link PROGRESS_GRID_PETS}.
 */
export const PET_ABBREVIATIONS: Record<string, string> = {
  'L.A.S.S.I': 'L',
  'Electro Owl': 'O',
  'Mighty Yak': 'Y',
  Unicorn: 'U',
  Frosty: 'F',
  Diggy: 'D',
  'Poison Lizard': 'PL',
  Phoenix: 'PH',
  'Spirit Fox': 'SF',
  'Angry Jelly': 'AJ',
  Sneezy: 'S',
  'Greedy Raven': 'R',
}

/**
 * The grid's columns, in the original spreadsheet's order: Town Hall, each hero,
 * buildings left, walls, each pet. Notes is deliberately not in this list, the
 * same way `PROGRESS_COLUMNS` left it out — a free-text column is not worth
 * sorting by, so it is a plain trailing header instead (see `ProgressGridView`).
 */
export const PROGRESS_GRID_COLUMNS: TableColumn<ProgressGridSortKey>[] = [
  { key: 'label', label: 'Base', numeric: false },
  { key: 'thLevel', label: 'TH', numeric: true, long: 'Town Hall' },
  ...PROGRESS_GRID_HEROES.map((name) => heroColumn(name, HERO_ABBREVIATIONS[name] ?? name)),
  { key: 'buildingsLeft', label: 'Buildings', long: 'Buildings left', numeric: false },
  { key: 'wallsAtMax', label: 'Walls', numeric: true, long: 'Walls at max' },
  ...PROGRESS_GRID_PETS.map((name) => petColumn(name, PET_ABBREVIATIONS[name] ?? name)),
]

/** Every level and count reads best highest-first; text columns read best ascending. */
export const PROGRESS_GRID_DESCENDING_BY_DEFAULT: ProgressGridSortKey[] = [
  'thLevel',
  'wallsAtMax',
  ...PROGRESS_GRID_HEROES.map((name): ProgressGridSortKey => `hero:${name}`),
  ...PROGRESS_GRID_PETS.map((name): ProgressGridSortKey => `pet:${name}`),
]

/** Same fact as {@link PROGRESS_GRID_DESCENDING_BY_DEFAULT}, stated the way `nextSortState` wants it. */
export const PROGRESS_GRID_ASCENDING_BY_DEFAULT: ProgressGridSortKey[] = PROGRESS_GRID_COLUMNS.map(
  (column) => column.key,
).filter((key) => !PROGRESS_GRID_DESCENDING_BY_DEFAULT.includes(key))

export function progressGridColumnLabel(key: ProgressGridSortKey): string {
  return PROGRESS_GRID_COLUMNS.find((column) => column.key === key)?.label ?? key
}

/**
 * As `compareProgressRows`: `label` is never blank, so sorting by it places every
 * row, tracked or not, in the alphabet where it belongs. Every other column is
 * genuinely empty on an untracked (or not-yet-unlocked) cell, and `numberCompare`
 * / `textCompare` already send a blank to the bottom in both directions.
 */
export function compareProgressGridRows(
  a: ProgressGridRow,
  b: ProgressGridRow,
  key: ProgressGridSortKey,
  ascending: boolean,
): number {
  if (key === 'label') return textCompare(a.label, b.label, ascending)
  if (key === 'thLevel') return numberCompare(a.thLevel ?? undefined, b.thLevel ?? undefined, ascending)
  if (key === 'buildingsLeft') {
    return textCompare(a.buildingsLeft ?? undefined, b.buildingsLeft ?? undefined, ascending)
  }
  if (key === 'wallsAtMax') {
    return numberCompare(a.wallsAtMax ?? undefined, b.wallsAtMax ?? undefined, ascending)
  }
  if (key.startsWith('hero:')) {
    const name = key.slice('hero:'.length)
    return numberCompare(a.heroes[name] ?? undefined, b.heroes[name] ?? undefined, ascending)
  }
  const name = key.slice('pet:'.length)
  return numberCompare(a.pets[name] ?? undefined, b.pets[name] ?? undefined, ascending)
}

export function sortProgressGridRows(
  rows: readonly ProgressGridRow[],
  key: ProgressGridSortKey,
  ascending: boolean,
): ProgressGridRow[] {
  return [...rows].sort((a, b) => {
    const primary = compareProgressGridRows(a, b, key, ascending)
    return primary !== 0 ? primary : a.label.localeCompare(b.label)
  })
}
