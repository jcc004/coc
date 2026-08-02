import type { SavedClan } from './saved-clans.ts'
import type { SavedPlayer } from './saved.ts'

/**
 * Pure logic behind the saved tables: ordering, paging, and working out which of
 * a bulk owner change needs the user's approval. Kept out of the components so
 * it can be reasoned about and tested without a DOM.
 */

export type SortKey = 'name' | 'owner' | 'tag' | 'townHallLevel' | 'trophies' | 'clanName'

export const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Name', numeric: false },
  { key: 'owner', label: 'Owner', numeric: false },
  { key: 'tag', label: 'Tag', numeric: false },
  { key: 'townHallLevel', label: 'TH', numeric: true },
  { key: 'trophies', label: 'Trophies', numeric: true },
  { key: 'clanName', label: 'Clan', numeric: false },
]

/** Stats read best highest-first; text reads best A→Z. */
export const DESCENDING_BY_DEFAULT: SortKey[] = ['townHallLevel', 'trophies']

/**
 * Blank and unknown values sort last in *both* directions — reversing a column
 * should not drag a wall of dashes to the top.
 */
function textCompare(a: string | undefined, b: string | undefined, ascending: boolean): number {
  const left = a?.trim() ?? ''
  const right = b?.trim() ?? ''
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  return ascending ? left.localeCompare(right) : right.localeCompare(left)
}

function numberCompare(a: number | undefined, b: number | undefined, ascending: boolean): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return ascending ? a - b : b - a
}

export function compareEntries(
  a: SavedPlayer,
  b: SavedPlayer,
  key: SortKey,
  ascending: boolean,
): number {
  switch (key) {
    case 'name':
      return textCompare(a.name, b.name, ascending)
    case 'owner':
      return textCompare(a.owner, b.owner, ascending)
    case 'tag':
      return textCompare(a.tag, b.tag, ascending)
    case 'clanName':
      return textCompare(a.clanName, b.clanName, ascending)
    case 'townHallLevel':
      return numberCompare(a.townHallLevel, b.townHallLevel, ascending)
    case 'trophies':
      return numberCompare(a.trophies, b.trophies, ascending)
  }
}

export function sortEntries(
  entries: SavedPlayer[],
  key: SortKey,
  ascending: boolean,
): SavedPlayer[] {
  return [...entries].sort((a, b) => {
    const primary = compareEntries(a, b, key, ascending)
    // Stable, predictable tie-break so equal values never shuffle between renders.
    return primary !== 0 ? primary : a.name.localeCompare(b.name)
  })
}

/* ---------- saved clans ---------- */

export type ClanSortKey = 'name' | 'tag' | 'clanLevel' | 'members' | 'clanPoints' | 'warLeague'

export const CLAN_COLUMNS: { key: ClanSortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Name', numeric: false },
  { key: 'tag', label: 'Tag', numeric: false },
  { key: 'clanLevel', label: 'Level', numeric: true },
  { key: 'members', label: 'Members', numeric: true },
  { key: 'clanPoints', label: 'Points', numeric: true },
  { key: 'warLeague', label: 'War league', numeric: false },
]

export const CLAN_DESCENDING_BY_DEFAULT: ClanSortKey[] = ['clanLevel', 'members', 'clanPoints']

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

/** A selected row whose existing owner would be replaced. */
export interface OwnerConflict {
  tag: string
  name: string
  currentOwner: string
  nextOwner: string
}

export interface OwnerChangePlan {
  /** Rows with no owner yet — safe to write without asking. */
  toApply: SavedPlayer[]
  /** Rows that already carry a different owner — each needs explicit approval. */
  conflicts: OwnerConflict[]
  /** Already matches, or blank and being cleared: nothing to do. */
  unchanged: SavedPlayer[]
}

/**
 * Splits a bulk owner assignment into the part that can happen silently and the
 * part that destroys existing information.
 *
 * Clearing the owner (an empty `nextOwner`) counts as destructive for any row
 * that currently has one, so it goes through the same approval path.
 */
export function planOwnerChange(selected: SavedPlayer[], nextOwner: string): OwnerChangePlan {
  const trimmed = nextOwner.trim()
  const plan: OwnerChangePlan = { toApply: [], conflicts: [], unchanged: [] }

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
