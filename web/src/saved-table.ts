import type { ClanMember } from '@coc/shared'
import type { SavedClan } from './saved-clans.ts'

/**
 * Pure logic behind the app's tables: ordering, paging, and working out which of
 * a bulk owner change needs the user's approval. Kept out of the components so
 * it can be reasoned about and tested without a DOM.
 */

/**
 * Blank and unknown values sort last in *both* directions — reversing a column
 * should not drag a wall of dashes to the top. Both comparators are exported so
 * every table shares this one behavior instead of reimplementing it.
 */
export function textCompare(
  a: string | undefined,
  b: string | undefined,
  ascending: boolean,
): number {
  const left = a?.trim() ?? ''
  const right = b?.trim() ?? ''
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  return ascending ? left.localeCompare(right) : right.localeCompare(left)
}

export function numberCompare(
  a: number | undefined,
  b: number | undefined,
  ascending: boolean,
): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return ascending ? a - b : b - a
}

/* ---------- clan roster ---------- */

/** A live clan member joined with the local owner annotation for its tag. */
export interface RosterRow extends ClanMember {
  owner?: string
}

/**
 * Owner-filter sentinel for "nobody is set on this base". `''` already means "no
 * filter", so the third state needs a value of its own. A leading `#` cannot
 * collide with a real owner: owner names are trimmed free text, and anything
 * starting with `#` would be a tag.
 */
export const UNASSIGNED_OWNER = '#unassigned'

export interface RosterFilters {
  /** Town Hall level as a string, `''` for all. */
  townHall: string
  /** Exact owner, `''` for all, or {@link UNASSIGNED_OWNER}. */
  owner: string
  /** Case-insensitive substring of the member name. */
  member: string
}

export const NO_ROSTER_FILTERS: RosterFilters = { townHall: '', owner: '', member: '' }

export function hasRosterFilters(filters: RosterFilters): boolean {
  return filters.townHall !== '' || filters.owner !== '' || filters.member.trim() !== ''
}

/** Every filter ANDs with the others, and an empty one never excludes anything. */
export function filterRosterRows(rows: RosterRow[], filters: RosterFilters): RosterRow[] {
  const needle = filters.member.trim().toLowerCase()

  return rows.filter((row) => {
    if (filters.townHall !== '' && String(row.townHallLevel) !== filters.townHall) return false

    if (filters.owner === UNASSIGNED_OWNER) {
      // Blank counts as unassigned as well as absent: the store deletes the field
      // on clear, but a row that came from elsewhere could still carry `''`.
      if (row.owner?.trim()) return false
    } else if (filters.owner !== '' && row.owner !== filters.owner) {
      return false
    }

    if (needle && !row.name.toLowerCase().includes(needle)) return false
    return true
  })
}

/** Town Hall levels present in these rows, highest first, for the filter options. */
export function rosterTownHallLevels(rows: RosterRow[]): number[] {
  return [...new Set(rows.map((row) => row.townHallLevel))].sort((a, b) => b - a)
}

export type RosterSortKey =
  | 'clanRank'
  | 'name'
  | 'owner'
  | 'townHallLevel'
  | 'trophies'
  | 'donations'
  | 'donationsReceived'

/**
 * `long` is the name this column answers to when it is read on its own rather
 * than at the top of its column — in the stacked layout's Sort menu, where "#"
 * and "TH" have no column of numbers underneath to explain them. Only the
 * abbreviated headings need one.
 */
export interface TableColumn<K> {
  key: K
  label: string
  numeric: boolean
  long?: string
}

export const ROSTER_COLUMNS: TableColumn<RosterSortKey>[] = [
  { key: 'clanRank', label: '#', numeric: true, long: 'Clan rank' },
  { key: 'name', label: 'Member', numeric: false },
  { key: 'owner', label: 'Owner', numeric: false },
  { key: 'townHallLevel', label: 'TH', numeric: true, long: 'Town Hall' },
  { key: 'trophies', label: 'Trophies', numeric: true },
  { key: 'donations', label: 'Donated', numeric: true },
  { key: 'donationsReceived', label: 'Received', numeric: true },
]

/** Ranks and text read best ascending; every stat reads best highest-first. */
export const ROSTER_ASCENDING_BY_DEFAULT: RosterSortKey[] = ['clanRank', 'name', 'owner']

/**
 * The header text for one column.
 *
 * Below the phone breakpoint the roster stacks and each cell prints its own
 * label from `data-label` instead of sitting under a column head. Looking the
 * text up here rather than repeating it in the JSX is what stops the two
 * spellings drifting apart the next time a column is renamed.
 */
export function rosterColumnLabel(key: RosterSortKey): string {
  return ROSTER_COLUMNS.find((column) => column.key === key)?.label ?? key
}

/** How a column names itself in the stacked Sort menu. See {@link TableColumn.long}. */
export function sortOptionLabel<K>(column: TableColumn<K>): string {
  return column.long ?? column.label
}

/**
 * What clicking a column head does: a fresh column adopts its natural direction,
 * the column already sorted just reverses.
 *
 * Both sortable tables ran their own copy of this and they had drifted — the
 * roster listed the keys that default to *ascending* and the saved-clans table
 * listed the ones that default to *descending*, so the two read as opposites.
 * One function, one meaning, and the Sort control and the column heads share it.
 */
export function nextSortState<K>(
  current: { key: K; ascending: boolean },
  chosen: K,
  ascendingByDefault: readonly K[],
): { key: K; ascending: boolean } {
  if (chosen === current.key) return { key: chosen, ascending: !current.ascending }
  return { key: chosen, ascending: ascendingByDefault.includes(chosen) }
}

export function compareRosterRows(
  a: RosterRow,
  b: RosterRow,
  key: RosterSortKey,
  ascending: boolean,
): number {
  switch (key) {
    case 'name':
      return textCompare(a.name, b.name, ascending)
    case 'owner':
      return textCompare(a.owner, b.owner, ascending)
    case 'clanRank':
      return numberCompare(a.clanRank, b.clanRank, ascending)
    case 'townHallLevel':
      return numberCompare(a.townHallLevel, b.townHallLevel, ascending)
    case 'trophies':
      return numberCompare(a.trophies, b.trophies, ascending)
    case 'donations':
      return numberCompare(a.donations, b.donations, ascending)
    case 'donationsReceived':
      return numberCompare(a.donationsReceived, b.donationsReceived, ascending)
  }
}

export function sortRosterRows(
  rows: RosterRow[],
  key: RosterSortKey,
  ascending: boolean,
): RosterRow[] {
  return [...rows].sort((a, b) => {
    const primary = compareRosterRows(a, b, key, ascending)
    // Stable, predictable tie-break so equal values never shuffle between renders.
    return primary !== 0 ? primary : a.name.localeCompare(b.name)
  })
}

/* ---------- saved clans ---------- */

export type ClanSortKey = 'name' | 'tag' | 'clanLevel' | 'members' | 'clanPoints' | 'warLeague'

export const CLAN_COLUMNS: TableColumn<ClanSortKey>[] = [
  { key: 'name', label: 'Name', numeric: false },
  { key: 'tag', label: 'Tag', numeric: false },
  { key: 'clanLevel', label: 'Level', numeric: true },
  { key: 'members', label: 'Members', numeric: true },
  { key: 'clanPoints', label: 'Points', numeric: true },
  { key: 'warLeague', label: 'War league', numeric: false },
]

export const CLAN_DESCENDING_BY_DEFAULT: ClanSortKey[] = ['clanLevel', 'members', 'clanPoints']

/**
 * The same fact as {@link CLAN_DESCENDING_BY_DEFAULT}, stated the way
 * {@link nextSortState} wants it, and derived from it so the two cannot disagree.
 */
export const CLAN_ASCENDING_BY_DEFAULT: ClanSortKey[] = CLAN_COLUMNS.map(
  (column) => column.key,
).filter((key) => !CLAN_DESCENDING_BY_DEFAULT.includes(key))

/** As {@link rosterColumnLabel}, for the saved-clans table. */
export function clanColumnLabel(key: ClanSortKey): string {
  return CLAN_COLUMNS.find((column) => column.key === key)?.label ?? key
}

export function compareClanEntries(
  a: SavedClan,
  b: SavedClan,
  key: ClanSortKey,
  ascending: boolean,
): number {
  switch (key) {
    case 'name':
      return textCompare(a.name, b.name, ascending)
    case 'tag':
      return textCompare(a.tag, b.tag, ascending)
    case 'warLeague':
      return textCompare(a.warLeague, b.warLeague, ascending)
    case 'clanLevel':
      return numberCompare(a.clanLevel, b.clanLevel, ascending)
    case 'members':
      return numberCompare(a.members, b.members, ascending)
    case 'clanPoints':
      return numberCompare(a.clanPoints, b.clanPoints, ascending)
  }
}

export function sortClanEntries(
  entries: SavedClan[],
  key: ClanSortKey,
  ascending: boolean,
): SavedClan[] {
  return [...entries].sort((a, b) => {
    const primary = compareClanEntries(a, b, key, ascending)
    return primary !== 0 ? primary : a.name.localeCompare(b.name)
  })
}

/* ---------- paging ---------- */

/** Rows per page, or `'all'` for no limit at all. */
export type RowLimit = number | 'all'

export interface PagedRows<T> {
  rows: T[]
  /** The page actually shown — clamped into range, so it is never past the end. */
  page: number
  pageCount: number
  /** 1-based inclusive bounds of the visible slice; both `0` on an empty list. */
  from: number
  to: number
  total: number
}

/**
 * Slices `rows` for display. The returned `page` is authoritative: a caller
 * holding a stale page number (rows were removed, or the limit grew) gets the
 * clamped one back rather than an empty view past the end.
 */
export function paginate<T>(rows: T[], limit: RowLimit | null, page: number): PagedRows<T> {
  const total = rows.length

  if (limit === null || limit === 'all' || limit <= 0) {
    return { rows, page: 1, pageCount: 1, from: total > 0 ? 1 : 0, to: total, total }
  }

  const pageCount = Math.max(1, Math.ceil(total / limit))
  const requested = Number.isFinite(page) ? Math.trunc(page) : 1
  const clamped = Math.min(Math.max(requested, 1), pageCount)
  const start = (clamped - 1) * limit
  const slice = rows.slice(start, start + limit)

  return {
    rows: slice,
    page: clamped,
    pageCount,
    from: total > 0 ? start + 1 : 0,
    to: start + slice.length,
    total,
  }
}

/** Restores a persisted row limit, ignoring anything that is not a usable value. */
export function parseRowLimit(stored: string | null, fallback: RowLimit): RowLimit {
  if (stored === 'all') return 'all'
  if (stored === null) return fallback
  const parsed = Number(stored)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** The minimum a row needs to take part in a bulk owner change. */
export interface OwnableRow {
  tag: string
  name: string
  owner?: string
}

/** A selected row whose existing owner would be replaced. */
export interface OwnerConflict {
  tag: string
  name: string
  currentOwner: string
  nextOwner: string
}

export interface OwnerChangePlan<T extends OwnableRow> {
  /** Rows with no owner yet — safe to write without asking. */
  toApply: T[]
  /** Rows that already carry a different owner — each needs explicit approval. */
  conflicts: OwnerConflict[]
  /** Already matches, or blank and being cleared: nothing to do. */
  unchanged: T[]
}

/**
 * Splits a bulk owner assignment into the part that can happen silently and the
 * part that destroys existing information.
 *
 * Clearing the owner (an empty `nextOwner`) counts as destructive for any row
 * that currently has one, so it goes through the same approval path.
 */
export function planOwnerChange<T extends OwnableRow>(
  selected: T[],
  nextOwner: string,
): OwnerChangePlan<T> {
  const trimmed = nextOwner.trim()
  const plan: OwnerChangePlan<T> = { toApply: [], conflicts: [], unchanged: [] }

  for (const entry of selected) {
    const current = entry.owner?.trim() ?? ''

    if (current === trimmed) {
      plan.unchanged.push(entry)
      continue
    }

    if (current) {
      plan.conflicts.push({
        tag: entry.tag,
        name: entry.name,
        currentOwner: current,
        nextOwner: trimmed,
      })
      continue
    }

    if (!trimmed) {
      plan.unchanged.push(entry)
      continue
    }

    plan.toApply.push(entry)
  }

  return plan
}
