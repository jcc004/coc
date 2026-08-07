import type { DatabaseSync } from 'node:sqlite'
import type { AuthEvent, AuthEventKind } from '@coc/shared'
import { asText, asTextOrNull } from '../row.ts'

/**
 * The audit trail for account actions: who signed in, who failed, who was locked
 * out, who was disabled, whose role moved, and who was issued a temporary
 * password.
 *
 * Why it is needed at all. `updated_by_user_id` on the shared tables records who
 * changed the *data*, and it is the only history this app had. Nothing recorded
 * the actions that grant access to that data, so "when did this account become an
 * admin", "was there a burst of failures before that login", and "who reset whose
 * password" had no answer anywhere — not even a wrong one. An append-only table is
 * the cheapest thing that gives them one.
 *
 * Deliberately **append-only**: there is no update and no delete, and no route
 * exposes either. A log an admin can edit answers a different, much weaker
 * question than one they cannot, and the accounts most worth auditing are exactly
 * the ones that would be able to do the editing.
 *
 * Deliberately **synchronous**, in the same tick as the action it describes. This
 * is a ten-user app against a local SQLite file in WAL mode, so a row costs
 * microseconds; buffering to batch them would trade that for the possibility of
 * losing the last few events in a crash, which is when they matter most. It is
 * also why recording is not allowed to fail a request — see `record`.
 *
 * **Nothing secret is ever written.** No password, no temporary password, no
 * session token, no hash. The columns are chosen so there is nowhere to put one:
 * the free-text `detail` is written only from literals in `routes.ts`, and the one
 * caller-supplied string that reaches this table is the login email, which is an
 * identifier the account holder types into a form, not a credential.
 */

/** Newest first, and capped — see `listAuthEvents`. */
export interface AuthEventQuery {
  /** Rows to return. Clamped to {@link AUTH_EVENT_PAGE_MAX}. */
  limit?: number
  /** Cursor: return only rows with a lower id. Absent means start at the newest. */
  beforeId?: number
}

export interface AuthEventInput {
  kind: AuthEventKind
  /** The signed-in account that performed it, if any. Absent for a login attempt. */
  actorUserId?: number | null
  /** The account it was done *to*, when that differs from the actor. */
  targetUserId?: number | null
  /** The login address an attempt used. Never a password. */
  email?: string | null
  /** Client IP as `clientIp` resolved it, i.e. `''` when there was none. */
  ip?: string | null
  /** A short literal from the calling route. Never carries caller input. */
  detail?: string | null
}

export interface AuthEventLog {
  record(input: AuthEventInput): void
  list(query?: AuthEventQuery): AuthEvent[]
  count(): number
}

/**
 * The ceiling on one page, and on the whole endpoint. An unbounded `SELECT *` over
 * a table that grows with every login is a slow query waiting to happen and a
 * response body nothing needs; a page plus a cursor covers "show me the recent
 * activity" and "walk the whole thing" with the same shape.
 */
export const AUTH_EVENT_PAGE_MAX = 200
export const AUTH_EVENT_PAGE_DEFAULT = 50

function asIntOrNull(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function toAuthEvent(row: Record<string, unknown>): AuthEvent {
  return {
    id: asIntOrNull(row['id']) ?? 0,
    at: asText(row['at']),
    kind: asText(row['kind']) as AuthEventKind,
    actorUserId: asIntOrNull(row['actor_user_id']),
    actorDisplayName: asTextOrNull(row['actor_display_name']),
    targetUserId: asIntOrNull(row['target_user_id']),
    targetDisplayName: asTextOrNull(row['target_display_name']),
    email: asTextOrNull(row['email']),
    ip: asTextOrNull(row['ip']),
    detail: asTextOrNull(row['detail']),
  }
}

/**
 * The display names are joined rather than copied into the row on write, so a
 * later rename shows the person as they are known now. The trade is that a deleted
 * account's name is lost while its id survives — accounts here are disabled rather
 * than deleted, and an id with no name is still a distinct actor, which is the
 * property the trail actually needs.
 */
const SELECT_COLUMNS = `
  e.id AS id, e.at AS at, e.kind AS kind,
  e.actor_user_id AS actor_user_id, actor.display_name AS actor_display_name,
  e.target_user_id AS target_user_id, target.display_name AS target_display_name,
  e.email AS email, e.ip AS ip, e.detail AS detail`

const FROM_CLAUSE = `
  FROM auth_events e
  LEFT JOIN users actor ON actor.id = e.actor_user_id
  LEFT JOIN users target ON target.id = e.target_user_id`

export function createAuthEventLog(db: DatabaseSync): AuthEventLog {
  const statements = {
    insert: db.prepare(
      `INSERT INTO auth_events (at, kind, actor_user_id, target_user_id, email, ip, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    // Two statements rather than one with `id < COALESCE(?, 1e18)`: a sentinel that
    // has to be bigger than every id it will ever meet is a bug with a long fuse.
    listNewest: db.prepare(
      `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} ORDER BY e.id DESC LIMIT ?`,
    ),
    listBefore: db.prepare(
      `SELECT ${SELECT_COLUMNS} ${FROM_CLAUSE} WHERE e.id < ? ORDER BY e.id DESC LIMIT ?`,
    ),
    count: db.prepare('SELECT COUNT(*) AS n FROM auth_events'),
  }

  return {
    record({ kind, actorUserId, targetUserId, email, ip, detail }) {
      /*
       * A failed audit write must not fail the action it was describing. Losing a
       * row is bad; refusing a login because the log is unwritable (a full disk, a
       * read-only mount) is worse, and would turn the audit trail into a new way
       * to take the app down. Logged to stderr so the loss itself is not silent.
       */
      try {
        statements.insert.run(
          new Date().toISOString(),
          kind,
          actorUserId ?? null,
          targetUserId ?? null,
          // Empty is stored as NULL: "no address was supplied" and "the empty
          // address" are the same thing here, and NULL says so once.
          email?.trim() || null,
          ip?.trim() || null,
          detail ?? null,
        )
      } catch (cause) {
        console.error(`Failed to record auth event "${kind}":`, cause)
      }
    },

    list({ limit, beforeId } = {}) {
      const capped = Math.min(
        Math.max(Number.isInteger(limit) ? (limit as number) : AUTH_EVENT_PAGE_DEFAULT, 1),
        AUTH_EVENT_PAGE_MAX,
      )

      const rows =
        beforeId === undefined
          ? statements.listNewest.all(capped)
          : statements.listBefore.all(beforeId, capped)

      return rows.map(toAuthEvent)
    },

    count() {
      return Number(statements.count.get()?.['n'] ?? 0)
    },
  }
}
