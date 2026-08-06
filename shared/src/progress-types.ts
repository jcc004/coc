/**
 * Weekly per-base progress tracking, as it crosses the wire.
 *
 * Replaces a spreadsheet kept by hand: Town Hall, heroes, hero equipment, pets,
 * troop and spell levels are captured automatically from the API by a scheduled
 * job; walls, how many buildings are left to upgrade, and free-text notes are
 * typed in by a person. One row per `(playerTag, weekStart)` — see
 * `server/src/progress/store.ts`, the only code that touches it.
 */

/** One unit's level, next to the cap it is climbing toward. */
export interface UnitLevel {
  name: string
  level: number
  maxLevel: number
}

/** The five kinds of unit `max_level_reference` holds a cap for. */
export type UnitCategory = 'hero' | 'pet' | 'troop' | 'spell' | 'equipment'

/**
 * The two categories `refresh-reference.ts`'s wiki scrape cannot cover — see its
 * header. `hero`, `troop`, `spell` and `wall_reference` are all kept current by
 * that weekly job; `pet` and `equipment` are hand-entered instead, through
 * `PUT /api/admin/progress/reference/:category`. Restricting the route to this
 * type, rather than all of `UnitCategory`, is what keeps a manual edit from
 * racing the next scheduled refresh for the categories the scraper already owns.
 */
export type HandEnteredReferenceCategory = Extract<UnitCategory, 'pet' | 'equipment'>

/**
 * What the scheduled auto-capture job writes for one base in one week.
 *
 * Every field is independently optional, so a partial capture — the API
 * answering less than everything, or a job that only refreshes heroes — still
 * merges cleanly against whatever the week already had. See `upsertSnapshot`.
 */
export interface AutoCapturePayload {
  thLevel?: number
  heroes?: UnitLevel[]
  equipment?: UnitLevel[]
  /** Sparse — unlocked pets only, the same way card counts are sparse. */
  pets?: UnitLevel[]
  troops?: UnitLevel[]
  spells?: UnitLevel[]
}

/** What a person types in by hand. Never written to by the auto-capture job. */
export interface ManualCapturePayload {
  /** `{"<wallLevel>": count}`. */
  walls?: Record<string, number>
  /** A digit string, or the literal `'LOTS'` or `'DONE!'`. */
  buildingsLeft?: string
  notes?: string
}

/**
 * Who or what made one write to `base_progress` — `upsertSnapshot`'s fourth
 * argument. A closed union rather than a free-text label, so a caller cannot
 * invent a fourth kind of writer the read side does not know how to resolve.
 *
 * Only `'manual'` names an account: `'auto'` (the scheduled job) and `'import'`
 * (the one-off historical backfill) are not attributable to a person, and
 * carry no `userId` for the same reason `card_inventory`'s season is never a
 * request value — there is nothing to resolve because nobody typed anything.
 */
export type CapturedBy = { source: 'auto' } | { source: 'import' } | { source: 'manual'; userId: number }

/**
 * One week's row, as read back.
 *
 * Every captured field is nullable rather than optional: a week can genuinely
 * have no wall data yet, or belong to a base whose Town Hall was never
 * auto-captured, and `null` says so unambiguously where an absent key would not.
 */
export interface ProgressSnapshot {
  /** Canonical `#TAG`. */
  playerTag: string
  /** ISO date, `YYYY-MM-DD` — the Tuesday this entry covers. */
  weekStart: string
  thLevel: number | null
  heroes: UnitLevel[] | null
  equipment: UnitLevel[] | null
  pets: UnitLevel[] | null
  troops: UnitLevel[] | null
  spells: UnitLevel[] | null
  walls: Record<string, number> | null
  buildingsLeft: string | null
  notes: string | null
  /**
   * A summary of what changed since the prior week — `"TH 17->18; Barbarian
   * King 106->107"`. Computed by the store from the diff against the most
   * recent earlier row and overwritten on every save. `null` when there was no
   * prior row, or nothing tracked changed.
   */
  autoNote: string | null
  /**
   * `'auto'` for the scheduled job, `'import'` for the one-off historical
   * backfill, or the account that made a manual save — resolved to a display
   * name the same way every other attribution column in this schema is,
   * rather than a bare id the reader has to look up a second time.
   */
  capturedBy: 'auto' | 'import' | { userId: number; displayName: string | null }
  updatedAt: string
}

/** What `upsertMaxLevelReference` accepts — one unit's cap at one Town Hall. */
export interface MaxLevelReferenceInput {
  category: UnitCategory
  name: string
  thLevel: number
  maxLevel: number
}

/** A stored cap, as `getAllMaxLevelReference` reads it back. */
export interface MaxLevelReferenceRow extends MaxLevelReferenceInput {
  updatedAt: string
}

/** What `upsertWallReference` accepts — one Town Hall's wall cap and count. */
export interface WallReferenceInput {
  thLevel: number
  maxWallLevel: number
  totalWallCount: number
}

/** A stored wall reference row, as `getAllWallReference` reads it back. */
export interface WallReferenceRow extends WallReferenceInput {
  updatedAt: string
}
