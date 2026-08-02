/**
 * Saved clans and owner assignments, as they cross the wire.
 *
 * These are **shared, not per-user**: one row per clan tag and one per player
 * tag for the whole install, so "who owns this base" has a single canonical
 * answer everybody sees. Per-user copies would let ten people curate ten
 * disagreeing lists, which is the problem this replaces.
 *
 * `updatedAt` / `updatedBy` are on every record so the UI can attribute a change
 * — with shared data, "who last touched this" is the question you ask next.
 */

/** A saved clan. `tag` (not `clanTag`) so the existing table sorters keep working. */
export interface SavedClanRecord {
  /** Canonical `#TAG`. The primary key. */
  tag: string
  /** Label shown in the list. Defaults to the in-game name. */
  name: string
  /** Set once someone renames, so a refresh stops overwriting their label. */
  custom?: boolean
  clanLevel?: number
  members?: number
  warLeague?: string
  clanPoints?: number
  /** ISO timestamp of the last write. Optional only so fixtures stay terse. */
  updatedAt?: string
  /** Display name of whoever last wrote it; `null` if that account is gone. */
  updatedBy?: string | null
}

/** Who owns which base, keyed by player tag. `owner` is always non-empty. */
export interface OwnerRecord {
  /** Canonical `#TAG`. The primary key. */
  tag: string
  /**
   * Free text, deliberately **not** a FK to `users`: a base owner is a person in
   * the clan, who need not have an account in this app.
   */
  owner: string
  updatedAt?: string
  updatedBy?: string | null
}

export interface SavedClansResponse {
  clans: SavedClanRecord[]
}

export interface OwnersResponse {
  owners: OwnerRecord[]
}

/** What `POST /api/saved/clans` accepts. Everything but tag and name is optional. */
export interface SavedClanInput {
  tag: string
  name: string
  custom?: boolean
  clanLevel?: number
  members?: number
  warLeague?: string
  clanPoints?: number
}

/**
 * One row of a bulk owner apply. `expectedOwner` is the value the client
 * *believed* was current (`''` for "nobody owned it"); the server writes only if
 * that still matches, so a stale tab cannot clobber a change it never saw.
 */
export interface OwnerBulkRow {
  tag: string
  /** `''` clears the assignment. */
  owner: string
  expectedOwner: string
}

/** A row the server refused, carrying the real current value to re-approve against. */
export interface OwnerBulkConflict {
  tag: string
  expectedOwner: string
  /** `''` when the row has since been deleted by someone else. */
  currentOwner: string
  updatedAt?: string
  updatedBy?: string | null
}

export interface OwnerBulkResponse {
  /** Rows written, in their new state. */
  applied: OwnerRecord[]
  /** Tags whose assignment was removed (an empty `owner` that matched). */
  cleared: string[]
  conflicts: OwnerBulkConflict[]
}

/** The one-time upload of whatever a browser still holds in `localStorage`. */
export interface ImportRequest {
  owners?: { tag: string; owner: string }[]
  clans?: SavedClanInput[]
}

export interface ImportCounts {
  /** Rows that filled a gap. */
  applied: number
  /** Rows the server already had — left exactly as they were. */
  skipped: number
  /** Rows that were not a usable tag at all. */
  invalid: number
}

export interface ImportResponse {
  owners: ImportCounts
  clans: ImportCounts
}
