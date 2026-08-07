import type { DatabaseSync } from 'node:sqlite'
import { normalizeTag, type BaseInventory, type CardCount } from '@coc/shared'
import { asText, asTextOrNull } from '../row.ts'

/**
 * Hand-entered card counts for the August event — the only code that touches
 * `card_inventory`.
 *
 * **Shared, not per-user**, for the same reason owner assignments are: how many
 * Barbarian cards a base holds is a fact about the base, and per-user copies
 * would make the trade suggestions disagree with each other. The only thing
 * recorded *about* a user is `updated_by_user_id`, for attribution, and it is
 * nullable — the data outlives the account.
 *
 * Every row is scoped to a season string so next August's counts cannot merge
 * into this August's. The season is the caller's to supply; in practice it is
 * always `CARD_SEASON`, since there is no season-switching UI.
 *
 * Concurrency is **last-write-wins per base**, deliberately unlike the owner
 * flow. A card count is a number somebody read off a screen a moment ago, not a
 * decision another person made, so an expected-value handshake per card would be
 * ceremony over a value that is about to be re-read anyway. What makes that
 * safe enough is that `updated_at` and `updated_by` are recorded and shown, so a
 * surprise is at least explainable.
 */

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

export interface CardInventoryStore {
  /**
   * Every base anyone has saved this season, by tag — **including** a base whose
   * counts are now all zero. Such a base has no `card_inventory` rows left but
   * still has its stamp, so "when was this last checked" has an answer for it.
   */
  listInventory(season: string): BaseInventory[]
  /** One base. A base with nothing recorded comes back with an empty `counts`. */
  getInventory(season: string, tag: string): BaseInventory
  /**
   * Replaces one base's whole season in a single transaction: existing rows are
   * dropped and the non-zero entries re-inserted, so a count of 0 (or an id the
   * caller simply omitted) deletes the row rather than storing a zero.
   *
   * Whole-base rather than per-card because the entry screen edits a base at a
   * time; sixty requests to save one screen would be sixty chances to half-apply.
   *
   * Range and duplicate checking belongs to the route, which rejects the whole
   * request; the schema's CHECKs are the backstop if anything ever gets past it.
   */
  saveBase(season: string, tag: string, counts: CardCount[], userId: number): BaseInventory
}

const COUNTS_SELECT = `
  SELECT player_tag, card_id, count FROM card_inventory WHERE season = ?
`

/* Attribution is joined on read rather than copied onto the row, so a
   display-name change cannot leave old edits credited to a stale name. The
   stamp comes from `card_base_updates`, not from the count rows, so it survives
   a base being emptied — see migration v5. */
const STAMP_SELECT = `
  SELECT b.player_tag, b.updated_at, u.display_name AS updated_by
    FROM card_base_updates b LEFT JOIN users u ON u.id = b.updated_by_user_id
   WHERE b.season = ?
`

/**
 * Folds count rows and stamp rows into one record per base.
 *
 * A base appears if it has *either*, so an emptied base keeps its entry and its
 * timestamp while reporting no cards, and a base with counts but somehow no
 * stamp still reports its counts.
 */
function groupByBase(
  countRows: Record<string, unknown>[],
  stampRows: Record<string, unknown>[],
): BaseInventory[] {
  const bases = new Map<string, BaseInventory>()

  const of = (tag: string): BaseInventory => {
    let base = bases.get(tag)
    if (!base) {
      base = { tag, counts: [] }
      bases.set(tag, base)
    }
    return base
  }

  for (const row of countRows) {
    of(asText(row['player_tag'])).counts.push({
      cardId: asInt(row['card_id']),
      count: asInt(row['count']),
    })
  }

  for (const row of stampRows) {
    const base = of(asText(row['player_tag']))
    base.updatedAt = asText(row['updated_at'])
    base.updatedBy = asTextOrNull(row['updated_by'])
  }

  return [...bases.values()].sort((a, b) => a.tag.localeCompare(b.tag))
}

export function createCardInventoryStore(db: DatabaseSync): CardInventoryStore {
  const statements = {
    listCounts: db.prepare(`${COUNTS_SELECT} ORDER BY player_tag, card_id`),
    listStamps: db.prepare(`${STAMP_SELECT} ORDER BY b.player_tag`),
    oneCounts: db.prepare(`${COUNTS_SELECT} AND player_tag = ? ORDER BY card_id`),
    oneStamp: db.prepare(`${STAMP_SELECT} AND b.player_tag = ?`),
    deleteBase: db.prepare('DELETE FROM card_inventory WHERE season = ? AND player_tag = ?'),
    insert: db.prepare(
      `INSERT INTO card_inventory
         (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    // Always written on a save, whatever the counts turn out to be — that is what
    // makes the edit time survive a base being cleared to nothing.
    upsertStamp: db.prepare(
      `INSERT INTO card_base_updates (season, player_tag, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(season, player_tag) DO UPDATE SET
         updated_at = excluded.updated_at,
         updated_by_user_id = excluded.updated_by_user_id`,
    ),
  }

  function readOne(season: string, tag: string): BaseInventory {
    const merged = groupByBase(
      statements.oneCounts.all(season, tag),
      statements.oneStamp.all(season, tag),
    )
    return merged[0] ?? { tag, counts: [] }
  }

  return {
    listInventory(season) {
      return groupByBase(statements.listCounts.all(season), statements.listStamps.all(season))
    },

    getInventory(season, tag) {
      return readOne(season, normalizeTag(tag))
    },

    saveBase(season, tag, counts, userId) {
      const canonical = normalizeTag(tag)
      const now = new Date().toISOString()

      // One transaction, so a rejected row (a CHECK the route missed) leaves the
      // base as it was rather than half-erased — and so the stamp can never land
      // without the counts it describes, or the other way round.
      db.exec('BEGIN')
      try {
        statements.deleteBase.run(season, canonical)
        for (const entry of counts) {
          if (entry.count <= 0) continue
          statements.insert.run(season, canonical, entry.cardId, entry.count, now, userId)
        }
        statements.upsertStamp.run(season, canonical, now, userId)
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }

      return readOne(season, canonical)
    },
  }
}
