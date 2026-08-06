import type { DatabaseSync } from 'node:sqlite'

/**
 * Per-user base ordering (migration v12) — the only code that touches
 * `base_order`.
 *
 * One row per user, the whole order replaced on every save. There is no
 * per-position update here on purpose: the routes layer accepts a caller's
 * whole submitted sequence and this store just remembers it, the same "whole
 * thing at once" shape `progress/store.ts`'s manual saves and `cards/store.ts`'s
 * base-level saves already use for a person editing their own small set of
 * values by hand.
 */

// A type predicate rather than an assertion, the same way `progress/store.ts`'s
// `isUnitLevel` narrows `unknown` without a cast.
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function parseTagOrder(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return isStringArray(parsed) ? parsed : []
}

export interface BaseOrderStore {
  /** The saved order for `userId`, or `[]` if they have never saved one. */
  getOrder(userId: number): string[]

  /**
   * Replaces `userId`'s whole order with `tags`, in the given sequence.
   * Insert-or-replace, like every other single-row-per-key save in this app —
   * there is no earlier order to merge against, the caller's list *is* the new
   * order.
   */
  setOrder(userId: number, tags: string[]): void
}

export function createBaseOrderStore(db: DatabaseSync): BaseOrderStore {
  const statements = {
    find: db.prepare('SELECT tag_order FROM base_order WHERE user_id = ?'),
    upsert: db.prepare(
      `INSERT INTO base_order (user_id, tag_order, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         tag_order = excluded.tag_order,
         updated_at = excluded.updated_at`,
    ),
  }

  return {
    getOrder(userId) {
      const row = statements.find.get(userId)
      return row ? parseTagOrder(row['tag_order']) : []
    },

    setOrder(userId, tags) {
      statements.upsert.run(userId, JSON.stringify(tags), new Date().toISOString())
    },
  }
}
