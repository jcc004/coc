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
   * The label to show: the owning account's current display name when
   * `ownerUserId` is set, otherwise the legacy free text the row still carries.
   */
  owner: string
  /**
   * The account the base belongs to, and the only thing authorisation looks at —
   * it is what makes "only the owner may edit these card counts" answerable.
   *
   * `null` for a row whose `owner` text has never been matched to an account
   * (every pre-account assignment started that way). Such a row is a label and
   * nothing more: it grants nobody the write, so only an admin can edit that
   * base until an admin reassigns it.
   */
  ownerUserId?: number | null
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

/** What `PUT /api/owners/:tag` accepts — admin only, like every owner write. */
export interface OwnerAssignRequest {
  /** The account to hand the base to. There is no "assign to a name". */
  userId: number
}

export interface OwnerAssignResponse {
  owner: OwnerRecord
}

/**
 * One row of a bulk owner apply. `expectedOwner` is the value the client
 * *believed* was current (`''` for "nobody owned it"); the server writes only if
 * that still matches, so a stale tab cannot clobber a change it never saw.
 *
 * `owner` is still text here because the bulk bar is a typing surface. The server
 * links it to an account when it matches a display name — trimmed and
 * case-insensitively, the same rule the migration backfilled with — and stores it
 * as an unlinked label when it matches nobody.
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
  /**
   * Rows the caller was not allowed to write, and so were not even examined.
   * Only owner assignments can be refused, and only for a non-admin: the owner
   * column is an admin decision, while a member's saved clans are their own.
   * Absent when nothing was refused, which is the ordinary case.
   */
  refused?: number
}

export interface ImportResponse {
  owners: ImportCounts
  clans: ImportCounts
}
