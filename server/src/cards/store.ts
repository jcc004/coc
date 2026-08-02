import type { DatabaseSync } from 'node:sqlite'
import { normalizeTag, type BaseInventory, type CardCount } from '@coc/shared'

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

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

export interface CardInventoryStore {
  /** Every base with at least one card recorded this season, by tag. */
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

/* Attribution is joined on read rather than copied onto the row, so a
   display-name change cannot leave old edits credited to a stale name. */
const SELECT = `
  SELECT i.player_tag, i.card_id, i.count, i.updated_at, u.display_name AS updated_by
    FROM card_inventory i LEFT JOIN users u ON u.id = i.updated_by_user_id
`

/**
 * Folds the flat rows into one record per base.
 *
 * A base's stamp is the newest row it has, and the attribution is that same
 * row's. All sixty of a base's rows are written in one transaction with one
 * timestamp, so in practice they agree; taking the max is what keeps the answer
 * sensible if they ever do not.
 */
function groupByBase(rows: Record<string, unknown>[]): BaseInventory[] {
  const bases = new Map<string, BaseInventory>()

  for (const row of rows) {
    const tag = asText(row['player_tag'])
    let base = bases.get(tag)
    if (!base) {
      base = { tag, counts: [] }
      bases.set(tag, base)
    }

    base.counts.push({ cardId: asInt(row['card_id']), count: asInt(row['count']) })

    const updatedAt = asText(row['updated_at'])
    if (base.updatedAt === undefined || updatedAt > base.updatedAt) {
      base.updatedAt = updatedAt
      base.updatedBy = asTextOrNull(row['updated_by'])
    }
  }

  return [...bases.values()]
}

export function createCardInventoryStore(db: DatabaseSync): CardInventoryStore {
  const statements = {
    listAll: db.prepare(`${SELECT} WHERE i.season = ? ORDER BY i.player_tag, i.card_id`),
    listOne: db.prepare(
      `${SELECT} WHERE i.season = ? AND i.player_tag = ? ORDER BY i.card_id`,
    ),
    deleteBase: db.prepare('DELETE FROM card_inventory WHERE season = ? AND player_tag = ?'),
    insert: db.prepare(
      `INSERT INTO card_inventory
         (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
  }

  function readOne(season: string, tag: string): BaseInventory {
    const rows = statements.listOne.all(season, tag)
    return groupByBase(rows)[0] ?? { tag, counts: [] }
  }

  return {
    listInventory(season) {
      return groupByBase(statements.listAll.all(season))
    },

    getInventory(season, tag) {
      return readOne(season, normalizeTag(tag))
    },

    saveBase(season, tag, counts, userId) {
      const canonical = normalizeTag(tag)
      const now = new Date().toISOString()

      // One transaction, so a rejected row (a CHECK the route missed) leaves the
      // base as it was rather than half-erased.
      db.exec('BEGIN')
      try {
        statements.deleteBase.run(season, canonical)
        for (const entry of counts) {
          if (entry.count <= 0) continue
          statements.insert.run(season, canonical, entry.cardId, entry.count, now, userId)
        }
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }

      return readOne(season, canonical)
    },
  }
}
