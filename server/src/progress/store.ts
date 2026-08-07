import type { DatabaseSync } from 'node:sqlite'
import {
  normalizeTag,
  type AutoCapturePayload,
  type CapturedBy,
  type ManualCapturePayload,
  type MaxLevelReferenceInput,
  type MaxLevelReferenceRow,
  type ProgressSnapshot,
  type UnitCategory,
  type UnitLevel,
  type WallReferenceInput,
  type WallReferenceRow,
} from '@coc/shared'
import { asText, asTextOrNull } from '../row.ts'

/**
 * Weekly per-base progress tracking — the only code that touches
 * `base_progress`, `max_level_reference` and `wall_reference` (migration v11).
 *
 * `base_progress` has two writers that must never step on each other: a
 * scheduled job capturing whatever the Clash of Clans API can answer (Town
 * Hall, heroes, equipment, pets, troops, spells), and a person typing in what
 * it cannot (walls, buildings left, notes). `upsertSnapshot` is what makes that
 * safe — a true per-field merge against whatever the week's row already holds,
 * so an auto-capture that runs after a manual save that week does not erase the
 * notes, and a manual save after an auto-capture does not erase the levels.
 *
 * `auto_note` belongs to neither writer. It is recomputed from the merged
 * result on every call, by diffing against the most recent *earlier* week for
 * the same base — never accepted from a caller, the same way the season and
 * every other server-owned value in this schema are never taken from a
 * request. `computeAutoNote` is exported on its own because the diffing is the
 * one piece of this file worth testing without a database in the loop.
 */

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asIntOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

/**
 * Tolerant of anything the column might hold — including a hand-edited row —
 * the same way `web/src/recents.ts` tolerates whatever `localStorage` has in
 * it. The store itself only ever writes objects shaped like this, so the cast
 * inside the predicate is what a runtime shape check on `unknown` looks like
 * without a schema library.
 */
function isUnitLevel(value: unknown): value is UnitLevel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as UnitLevel).name === 'string' &&
    typeof (value as UnitLevel).level === 'number' &&
    typeof (value as UnitLevel).maxLevel === 'number'
  )
}

function parseUnitLevels(raw: unknown): UnitLevel[] | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed.filter(isUnitLevel) : null
}

function isWalls(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((count) => typeof count === 'number')
}

function parseWalls(raw: unknown): Record<string, number> | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return isWalls(parsed) ? parsed : null
}

/**
 * `captured_by` is `'auto'`, `'import'`, or `'manual'` (migration v13) — only
 * the last names an account, resolved here from the `captured_by_user_id` join
 * every read query below adds. A `'manual'` row somehow missing the id (should
 * not happen; the store always writes both together) falls back to `'auto'`
 * rather than fabricating a userId, the same "do not invent an attribution"
 * stance `card_inventory`'s columns take.
 */
function toCapturedBy(row: Record<string, unknown>): ProgressSnapshot['capturedBy'] {
  const label = asText(row['captured_by'])
  if (label !== 'manual') return label === 'import' ? 'import' : 'auto'

  const userId = asIntOrNull(row['captured_by_user_id'])
  if (userId === null) return 'auto'
  return { userId, displayName: asTextOrNull(row['captured_by_display_name']) }
}

function toSnapshot(row: Record<string, unknown>): ProgressSnapshot {
  return {
    playerTag: asText(row['player_tag']),
    weekStart: asText(row['week_start']),
    thLevel: asIntOrNull(row['th_level']),
    heroes: parseUnitLevels(row['heroes_json']),
    equipment: parseUnitLevels(row['equipment_json']),
    pets: parseUnitLevels(row['pets_json']),
    troops: parseUnitLevels(row['troops_json']),
    spells: parseUnitLevels(row['spells_json']),
    walls: parseWalls(row['walls_json']),
    buildingsLeft: asTextOrNull(row['buildings_left']),
    notes: asTextOrNull(row['notes']),
    autoNote: asTextOrNull(row['auto_note']),
    capturedBy: toCapturedBy(row),
    updatedAt: asText(row['updated_at']),
  }
}

// The store is the only writer, and always writes one of the five kinds — a
// cast rather than a parse, the same reasoning `trades-store.ts` gives for
// `category`.
function toMaxLevelReference(row: Record<string, unknown>): MaxLevelReferenceRow {
  return {
    category: asText(row['category']) as UnitCategory,
    name: asText(row['name']),
    thLevel: asInt(row['th_level']),
    maxLevel: asInt(row['max_level']),
    updatedAt: asText(row['updated_at']),
  }
}

function toWallReference(row: Record<string, unknown>): WallReferenceRow {
  return {
    thLevel: asInt(row['th_level']),
    maxWallLevel: asInt(row['max_wall_level']),
    totalWallCount: asInt(row['total_wall_count']),
    updatedAt: asText(row['updated_at']),
  }
}

/** The slice of a row `computeAutoNote` actually looks at. */
export type AutoNoteSnapshot = Pick<ProgressSnapshot, 'thLevel' | 'heroes'>

/**
 * What changed since `previous`, as the one-line summary shown beside a row —
 * `"TH 17->18; Barbarian King 106->107"`.
 *
 * `undefined` (no prior week to compare against) always yields `null`: a base's
 * first tracked week has nothing to have changed *from*. Otherwise:
 *
 * - Town Hall is reported on any change, up or down (a TH is never rebuilt down
 *   in practice, but the diff does not assume that).
 * - A hero is reported only on an **increase**, matched by name across the two
 *   weeks. A hero present in only one week — not yet unlocked, or dropped from
 *   the auto-capture payload — contributes nothing, since there is no "before"
 *   or no "after" to compare.
 *
 * Pure and DB-free on purpose: this is the one piece of `upsertSnapshot` worth
 * testing without a database in the loop.
 */
export function computeAutoNote(
  previous: AutoNoteSnapshot | undefined,
  current: AutoNoteSnapshot,
): string | null {
  if (!previous) return null

  const fragments: string[] = []

  if (
    previous.thLevel !== null &&
    current.thLevel !== null &&
    previous.thLevel !== current.thLevel
  ) {
    fragments.push(`TH ${previous.thLevel}->${current.thLevel}`)
  }

  const priorLevels = new Map((previous.heroes ?? []).map((hero) => [hero.name, hero.level]))
  for (const hero of current.heroes ?? []) {
    const before = priorLevels.get(hero.name)
    if (before !== undefined && hero.level > before) {
      fragments.push(`${hero.name} ${before}->${hero.level}`)
    }
  }

  return fragments.length > 0 ? fragments.join('; ') : null
}

export interface ProgressStore {
  /**
   * Writes one base's row for one week, merging field by field against
   * whatever that `(tag, weekStart)` already holds: an omitted `auto` or
   * `manual` field — or an omitted payload entirely — leaves the existing
   * value exactly as it was, so the scheduled job and a manual save can land in
   * either order without either clobbering the other.
   *
   * `capturedBy` is stamped on every call, unmerged: it names whoever made
   * *this* write, not a running history of every contributor to the week.
   *
   * `autoNote` is never read from either payload — see {@link computeAutoNote}.
   */
  upsertSnapshot(
    playerTag: string,
    weekStart: string,
    capture: { auto?: AutoCapturePayload; manual?: ManualCapturePayload },
    capturedBy: CapturedBy,
  ): ProgressSnapshot

  /** Every week recorded for one base, newest first. */
  getHistory(playerTag: string): ProgressSnapshot[]

  /**
   * One base's row for exactly one week, or `null` if that `(playerTag, weekStart)`
   * pair has never been captured. This is what `PUT /api/progress/:tag/manual`
   * checks a caller-supplied `weekStart` against — a past-week correction may only
   * target a week that already has a row, never invent one, so the route needs a
   * single-row lookup rather than pulling the whole history to search it.
   */
  getWeek(playerTag: string, weekStart: string): ProgressSnapshot | null

  /**
   * The single latest row per tag, in the order the tags were given. A tag
   * with no rows at all is simply absent — there is no placeholder to filter
   * back out.
   */
  getLatestForClan(playerTags: string[]): ProgressSnapshot[]

  /** Bulk upsert of unit level caps, keyed `(category, name, thLevel)`. */
  upsertMaxLevelReference(rows: MaxLevelReferenceInput[]): void
  /** Bulk upsert of wall caps, keyed by `thLevel`. */
  upsertWallReference(rows: WallReferenceInput[]): void

  /** The whole reference table, for a percent-to-max computation done in bulk. */
  getAllMaxLevelReference(): MaxLevelReferenceRow[]
  getAllWallReference(): WallReferenceRow[]

  /**
   * One Town Hall's wall cap — `null` when the weekly wiki refresh has not
   * covered it. The single-row counterpart to {@link getAllWallReference},
   * for `PUT /api/progress/:tag/manual`'s validation: it needs exactly one
   * TH's cap, not the whole table, on every manual save.
   */
  getWallReference(thLevel: number): WallReferenceRow | null

  /**
   * The most recently *known* Town Hall for a base — the latest row where
   * `th_level` is not null, not simply the latest row. A week captured by a
   * manual-only save can hold `th_level: null` (see `upsertSnapshot`'s
   * per-field merge), and that row must not read as "TH unknown, was TH X" —
   * it should be skipped in favor of the last week that actually had one.
   * `null` when this base has never been auto-captured at all, which is
   * `PUT .../manual`'s signal that there is no TH-derived cap to validate
   * walls against yet.
   */
  getLatestThLevel(playerTag: string): number | null

  /**
   * Every distinct `player_tag` this table has ever captured a row for, in no
   * particular order. This is what lets `GET /api/progress` show a clan member who
   * has no owner assignment but *has* been captured by the scheduled job, without
   * that route making a live roster call of its own on every load — see
   * `capture-snapshot.ts`'s header for where the roster itself is fetched, and
   * `mountProgressRoutes` for how this is unioned with `listOwners()`.
   */
  getAllTrackedTags(): string[]
}

export function createProgressStore(db: DatabaseSync): ProgressStore {
  // `captured_by_display_name` is only ever populated for a `'manual'` row —
  // the join is on `captured_by_user_id`, which is `NULL` for `'auto'` and
  // `'import'` rows, and a `LEFT JOIN` leaves the column `NULL` right along
  // with it. `toCapturedBy` is what turns the pair back into the read shape.
  const BASE_PROGRESS_SELECT = `
    SELECT base_progress.*, users.display_name AS captured_by_display_name
      FROM base_progress
      LEFT JOIN users ON users.id = base_progress.captured_by_user_id`

  const statements = {
    find: db.prepare(`${BASE_PROGRESS_SELECT} WHERE player_tag = ? AND week_start = ?`),
    findPrior: db.prepare(
      `SELECT * FROM base_progress
        WHERE player_tag = ? AND week_start < ?
        ORDER BY week_start DESC
        LIMIT 1`,
    ),
    listHistory: db.prepare(
      `${BASE_PROGRESS_SELECT} WHERE player_tag = ? ORDER BY week_start DESC`,
    ),
    latestForTag: db.prepare(
      `${BASE_PROGRESS_SELECT} WHERE player_tag = ? ORDER BY week_start DESC LIMIT 1`,
    ),
    upsert: db.prepare(
      `INSERT INTO base_progress
         (player_tag, week_start, th_level, heroes_json, equipment_json, pets_json,
          troops_json, spells_json, walls_json, buildings_left, notes, auto_note,
          captured_by, captured_by_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_tag, week_start) DO UPDATE SET
         th_level = excluded.th_level,
         heroes_json = excluded.heroes_json,
         equipment_json = excluded.equipment_json,
         pets_json = excluded.pets_json,
         troops_json = excluded.troops_json,
         spells_json = excluded.spells_json,
         walls_json = excluded.walls_json,
         buildings_left = excluded.buildings_left,
         notes = excluded.notes,
         auto_note = excluded.auto_note,
         captured_by = excluded.captured_by,
         captured_by_user_id = excluded.captured_by_user_id,
         updated_at = excluded.updated_at`,
    ),
    upsertMaxLevel: db.prepare(
      `INSERT INTO max_level_reference (category, name, th_level, max_level, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(category, name, th_level) DO UPDATE SET
         max_level = excluded.max_level,
         updated_at = excluded.updated_at`,
    ),
    listMaxLevel: db.prepare(
      `SELECT category, name, th_level, max_level, updated_at
         FROM max_level_reference ORDER BY category, th_level, name`,
    ),
    upsertWall: db.prepare(
      `INSERT INTO wall_reference (th_level, max_wall_level, total_wall_count, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(th_level) DO UPDATE SET
         max_wall_level = excluded.max_wall_level,
         total_wall_count = excluded.total_wall_count,
         updated_at = excluded.updated_at`,
    ),
    listWall: db.prepare(
      'SELECT th_level, max_wall_level, total_wall_count, updated_at FROM wall_reference ORDER BY th_level',
    ),
    findWall: db.prepare(
      'SELECT th_level, max_wall_level, total_wall_count, updated_at FROM wall_reference WHERE th_level = ?',
    ),
    listTrackedTags: db.prepare(
      'SELECT DISTINCT player_tag FROM base_progress ORDER BY player_tag',
    ),
    latestThLevel: db.prepare(
      `SELECT th_level FROM base_progress
        WHERE player_tag = ? AND th_level IS NOT NULL
        ORDER BY week_start DESC
        LIMIT 1`,
    ),
  }

  return {
    upsertSnapshot(playerTag, weekStart, capture, capturedBy) {
      const tag = normalizeTag(playerTag)

      // BEGIN IMMEDIATE, not the plain BEGIN used elsewhere in this file: this
      // merge reads `existing`/`prior` and then writes a value computed from
      // that read, and the scheduled auto-capture job and a manual save are
      // separate OS processes that can both be doing that at once (see the
      // interface doc above). A plain BEGIN only takes SQLite's write lock at
      // the first write, so both processes could still read the same stale
      // `existing` row before either commits — a lost update, silently. BEGIN
      // IMMEDIATE takes the write lock up front, so the second writer blocks
      // (openDatabase's busy_timeout gives it something to wait *for*) until
      // the first one's write has landed, and reads it fresh.
      db.exec('BEGIN IMMEDIATE')
      try {
        const existing = statements.find.get(tag, weekStart)
        const prior = statements.findPrior.get(tag, weekStart)

        // Per field, not per payload: an auto-capture naming only `heroes` must
        // not blank out `troops` the previous capture already had, and the same
        // goes for each manual field.
        const thLevel = capture.auto?.thLevel ?? asIntOrNull(existing?.['th_level'])
        const heroes = capture.auto?.heroes ?? parseUnitLevels(existing?.['heroes_json'])
        const equipment = capture.auto?.equipment ?? parseUnitLevels(existing?.['equipment_json'])
        const pets = capture.auto?.pets ?? parseUnitLevels(existing?.['pets_json'])
        const troops = capture.auto?.troops ?? parseUnitLevels(existing?.['troops_json'])
        const spells = capture.auto?.spells ?? parseUnitLevels(existing?.['spells_json'])
        const walls = capture.manual?.walls ?? parseWalls(existing?.['walls_json'])
        const buildingsLeft =
          capture.manual?.buildingsLeft ?? asTextOrNull(existing?.['buildings_left'])
        const notes = capture.manual?.notes ?? asTextOrNull(existing?.['notes'])

        const autoNote = computeAutoNote(
          prior
            ? {
                thLevel: asIntOrNull(prior['th_level']),
                heroes: parseUnitLevels(prior['heroes_json']),
              }
            : undefined,
          { thLevel, heroes },
        )

        const now = new Date().toISOString()

        statements.upsert.run(
          tag,
          weekStart,
          thLevel,
          heroes ? JSON.stringify(heroes) : null,
          equipment ? JSON.stringify(equipment) : null,
          pets ? JSON.stringify(pets) : null,
          troops ? JSON.stringify(troops) : null,
          spells ? JSON.stringify(spells) : null,
          walls ? JSON.stringify(walls) : null,
          buildingsLeft,
          notes,
          autoNote,
          capturedBy.source,
          capturedBy.source === 'manual' ? capturedBy.userId : null,
          now,
        )
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }

      const saved = statements.find.get(tag, weekStart)
      if (!saved) throw new Error('the progress row just upserted could not be read back')
      return toSnapshot(saved)
    },

    getHistory(playerTag) {
      return statements.listHistory.all(normalizeTag(playerTag)).map(toSnapshot)
    },

    getWeek(playerTag, weekStart) {
      const row = statements.find.get(normalizeTag(playerTag), weekStart)
      return row ? toSnapshot(row) : null
    },

    getLatestForClan(playerTags) {
      if (playerTags.length === 0) return []
      const tags = playerTags.map(normalizeTag)
      const placeholders = tags.map(() => '?').join(', ')
      // One query, not one per tag: a correlated subquery picks each tag's max
      // week_start, aliased so it isn't shadowed by its own FROM base_progress.
      const rows = db
        .prepare(
          `SELECT bp.*, users.display_name AS captured_by_display_name
             FROM base_progress bp
             LEFT JOIN users ON users.id = bp.captured_by_user_id
            WHERE bp.player_tag IN (${placeholders})
              AND bp.week_start = (
                SELECT MAX(prior.week_start) FROM base_progress prior
                 WHERE prior.player_tag = bp.player_tag
              )`,
        )
        .all(...tags)

      const byTag = new Map(rows.map((row) => [asText(row['player_tag']), row]))
      const result: ProgressSnapshot[] = []
      for (const tag of tags) {
        const row = byTag.get(tag)
        if (row) result.push(toSnapshot(row))
      }
      return result
    },

    upsertMaxLevelReference(rows) {
      const now = new Date().toISOString()
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          statements.upsertMaxLevel.run(row.category, row.name, row.thLevel, row.maxLevel, now)
        }
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
    },

    upsertWallReference(rows) {
      const now = new Date().toISOString()
      db.exec('BEGIN')
      try {
        for (const row of rows) {
          statements.upsertWall.run(row.thLevel, row.maxWallLevel, row.totalWallCount, now)
        }
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
    },

    getAllMaxLevelReference() {
      return statements.listMaxLevel.all().map(toMaxLevelReference)
    },

    getAllWallReference() {
      return statements.listWall.all().map(toWallReference)
    },

    getWallReference(thLevel) {
      const row = statements.findWall.get(thLevel)
      return row ? toWallReference(row) : null
    },

    getAllTrackedTags() {
      return statements.listTrackedTags.all().map((row) => asText(row['player_tag']))
    },

    getLatestThLevel(playerTag) {
      const row = statements.latestThLevel.get(normalizeTag(playerTag))
      return row ? asIntOrNull(row['th_level']) : null
    },
  }
}
