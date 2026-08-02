import type { DatabaseSync } from 'node:sqlite'
import {
  normalizeTag,
  type ImportCounts,
  type ImportRequest,
  type ImportResponse,
  type OwnerBulkConflict,
  type OwnerBulkResponse,
  type OwnerBulkRow,
  type OwnerRecord,
  type SavedClanInput,
  type SavedClanRecord,
} from '@coc/shared'

/**
 * Saved clans and owner assignments — the shared data.
 *
 * Deliberately **not** keyed by user. Ten people looking at the same clan need one
 * canonical answer to "who owns this base"; per-user copies would give ten
 * disagreeing answers and no way to reconcile them. The cost of that choice is
 * that two people can race on the same row, which is what the expected-value check
 * in `applyOwners` exists to handle.
 *
 * The only thing recorded *about* a user is `updated_by_user_id`, for attribution,
 * and it is nullable: the data outlives the account.
 */

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asIntOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

/** `undefined` rather than `null` on the wire, so an absent stat renders as a dash. */
function toSavedClan(row: Record<string, unknown>): SavedClanRecord {
  const record: SavedClanRecord = {
    tag: asText(row['clan_tag']),
    name: asText(row['name']),
    updatedAt: asText(row['updated_at']),
    updatedBy: asTextOrNull(row['updated_by']),
  }

  if (asIntOrUndefined(row['custom'])) record.custom = true

  const clanLevel = asIntOrUndefined(row['clan_level'])
  if (clanLevel !== undefined) record.clanLevel = clanLevel
  const members = asIntOrUndefined(row['members'])
  if (members !== undefined) record.members = members
  const clanPoints = asIntOrUndefined(row['clan_points'])
  if (clanPoints !== undefined) record.clanPoints = clanPoints
  const warLeague = asTextOrNull(row['war_league'])
  if (warLeague !== null) record.warLeague = warLeague

  return record
}

function toOwner(row: Record<string, unknown>): OwnerRecord {
  return {
    tag: asText(row['player_tag']),
    owner: asText(row['owner']),
    updatedAt: asText(row['updated_at']),
    updatedBy: asTextOrNull(row['updated_by']),
  }
}

/** A tag that cannot be normalised could never be looked up, so it is dropped. */
function canonical(tag: string): string | undefined {
  try {
    return normalizeTag(tag)
  } catch {
    return undefined
  }
}

export interface SharedDataStore {
  listSavedClans(): SavedClanRecord[]
  /**
   * Insert or refresh. An existing `custom` label survives, the same way the old
   * browser store worked, so `Refresh all` cannot undo somebody's rename.
   */
  saveClan(input: SavedClanInput, userId: number): SavedClanRecord
  /** Renaming only. Returns `undefined` if the clan is not saved. */
  renameClan(tag: string, name: string, userId: number): SavedClanRecord | undefined
  removeClan(tag: string): boolean

  listOwners(): OwnerRecord[]
  removeOwner(tag: string): boolean
  /**
   * Optimistic-concurrency bulk apply: a row is written only if the stored owner
   * still equals the `expectedOwner` the client sent. Mismatches come back as
   * conflicts carrying the *real* current value, and the rows that did match are
   * still applied — one stale row must not block the other nine.
   */
  applyOwners(rows: OwnerBulkRow[], userId: number): OwnerBulkResponse

  /**
   * One-time upload of a browser's `localStorage`. **Fills gaps only** — a tag the
   * server already knows is left exactly as it is. With shared data and several
   * people importing, overwriting would mean whoever logs in last wins.
   */
  importFromBrowser(input: ImportRequest, userId: number): ImportResponse
}

/* Attribution is joined on read rather than copied onto the row, so a display-name
   change cannot leave old edits credited to a stale name. */
const CLAN_SELECT = `
  SELECT c.clan_tag, c.name, c.custom, c.clan_level, c.members, c.clan_points,
         c.war_league, c.updated_at, u.display_name AS updated_by
    FROM saved_clans c LEFT JOIN users u ON u.id = c.updated_by_user_id
`

const OWNER_SELECT = `
  SELECT o.player_tag, o.owner, o.updated_at, u.display_name AS updated_by
    FROM owner_assignments o LEFT JOIN users u ON u.id = o.updated_by_user_id
`

export function createSharedDataStore(db: DatabaseSync): SharedDataStore {
  const statements = {
    listClans: db.prepare(`${CLAN_SELECT} ORDER BY c.name COLLATE NOCASE`),
    findClan: db.prepare(`${CLAN_SELECT} WHERE c.clan_tag = ?`),
    findClanRaw: db.prepare('SELECT name, custom FROM saved_clans WHERE clan_tag = ?'),
    upsertClan: db.prepare(
      `INSERT INTO saved_clans
         (clan_tag, name, custom, clan_level, members, clan_points, war_league,
          updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(clan_tag) DO UPDATE SET
         name = excluded.name,
         custom = excluded.custom,
         clan_level = excluded.clan_level,
         members = excluded.members,
         clan_points = excluded.clan_points,
         war_league = excluded.war_league,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    ),
    // Fill-gaps-only: DO NOTHING is what makes import non-destructive, and the
    // `changes` count is what tells applied from skipped.
    insertClanIfAbsent: db.prepare(
      `INSERT INTO saved_clans
         (clan_tag, name, custom, clan_level, members, clan_points, war_league,
          updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(clan_tag) DO NOTHING`,
    ),
    renameClan: db.prepare(
      `UPDATE saved_clans SET name = ?, custom = 1, updated_at = ?, updated_by_user_id = ?
        WHERE clan_tag = ?`,
    ),
    deleteClan: db.prepare('DELETE FROM saved_clans WHERE clan_tag = ?'),

    listOwners: db.prepare(`${OWNER_SELECT} ORDER BY o.player_tag`),
    findOwner: db.prepare(`${OWNER_SELECT} WHERE o.player_tag = ?`),
    upsertOwner: db.prepare(
      `INSERT INTO owner_assignments (player_tag, owner, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_tag) DO UPDATE SET
         owner = excluded.owner,
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    ),
    insertOwnerIfAbsent: db.prepare(
      `INSERT INTO owner_assignments (player_tag, owner, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(player_tag) DO NOTHING`,
    ),
    deleteOwner: db.prepare('DELETE FROM owner_assignments WHERE player_tag = ?'),
  }

  function findClan(tag: string): SavedClanRecord | undefined {
    const row = statements.findClan.get(tag)
    return row ? toSavedClan(row) : undefined
  }

  function findOwner(tag: string): OwnerRecord | undefined {
    const row = statements.findOwner.get(tag)
    return row ? toOwner(row) : undefined
  }

  /** `null` for an absent optional stat, so the column reads as unknown not zero. */
  const orNull = (value: number | undefined) => value ?? null

  return {
    listSavedClans() {
      return statements.listClans.all().map(toSavedClan)
    },

    saveClan(input, userId) {
      const tag = normalizeTag(input.tag)
      const existing = statements.findClanRaw.get(tag)
      const existingCustom = Boolean(asIntOrUndefined(existing?.['custom']))

      // A label somebody chose outranks the in-game name a refresh brings back.
      const name = existingCustom ? asText(existing?.['name']) : input.name
      const custom = existingCustom || input.custom === true

      statements.upsertClan.run(
        tag,
        name,
        custom ? 1 : 0,
        orNull(input.clanLevel),
        orNull(input.members),
        orNull(input.clanPoints),
        input.warLeague ?? null,
        new Date().toISOString(),
        userId,
      )

      const saved = findClan(tag)
      if (!saved) throw new Error('Saved clan vanished immediately after upsert')
      return saved
    },

    renameClan(tag, name, userId) {
      const canonicalTag = normalizeTag(tag)
      const result = statements.renameClan.run(
        name.trim(),
        new Date().toISOString(),
        userId,
        canonicalTag,
      )
      return Number(result.changes) > 0 ? findClan(canonicalTag) : undefined
    },

    removeClan(tag) {
      return Number(statements.deleteClan.run(normalizeTag(tag)).changes) > 0
    },

    listOwners() {
      return statements.listOwners.all().map(toOwner)
    },

    removeOwner(tag) {
      return Number(statements.deleteOwner.run(normalizeTag(tag)).changes) > 0
    },

    applyOwners(rows, userId) {
      const applied: OwnerRecord[] = []
      const cleared: string[] = []
      const conflicts: OwnerBulkConflict[] = []
      const now = new Date().toISOString()

      for (const row of rows) {
        const tag = canonical(row.tag)
        if (!tag) continue

        const current = findOwner(tag)
        const storedOwner = current?.owner.trim() ?? ''
        const expected = row.expectedOwner.trim()

        /*
         * The whole point: if the stored value is not what this client last saw,
         * somebody else changed it in between. Refuse the write and hand back the
         * real value so the UI can re-ask, rather than silently overwriting a
         * decision the user never saw.
         */
        if (storedOwner !== expected) {
          conflicts.push({
            tag,
            expectedOwner: expected,
            currentOwner: storedOwner,
            ...(current?.updatedAt ? { updatedAt: current.updatedAt } : {}),
            updatedBy: current?.updatedBy ?? null,
          })
          continue
        }

        const next = row.owner.trim()
        if (!next) {
          // Clearing removes the row rather than storing an empty owner, so
          // "no owner" has exactly one representation.
          if (current) statements.deleteOwner.run(tag)
          cleared.push(tag)
          continue
        }

        statements.upsertOwner.run(tag, next, now, userId)
        const saved = findOwner(tag)
        if (saved) applied.push(saved)
      }

      return { applied, cleared, conflicts }
    },

    importFromBrowser(input, userId) {
      const now = new Date().toISOString()
      const owners: ImportCounts = { applied: 0, skipped: 0, invalid: 0 }
      const clans: ImportCounts = { applied: 0, skipped: 0, invalid: 0 }

      /*
       * Idempotent by construction: a second run finds every tag already present
       * and counts it as skipped. There is no flag to get wrong on the server —
       * the browser's flag only saves the round trip.
       */
      for (const entry of input.owners ?? []) {
        const tag = canonical(entry.tag)
        const owner = entry.owner.trim()
        if (!tag || !owner) {
          owners.invalid += 1
          continue
        }

        const result = statements.insertOwnerIfAbsent.run(tag, owner, now, userId)
        if (Number(result.changes) > 0) owners.applied += 1
        else owners.skipped += 1
      }

      for (const entry of input.clans ?? []) {
        const tag = canonical(entry.tag)
        const name = entry.name?.trim()
        if (!tag || !name) {
          clans.invalid += 1
          continue
        }

        const result = statements.insertClanIfAbsent.run(
          tag,
          name,
          entry.custom === true ? 1 : 0,
          orNull(entry.clanLevel),
          orNull(entry.members),
          orNull(entry.clanPoints),
          entry.warLeague ?? null,
          now,
          userId,
        )
        if (Number(result.changes) > 0) clans.applied += 1
        else clans.skipped += 1
      }

      return { owners, clans }
    },
  }
}
