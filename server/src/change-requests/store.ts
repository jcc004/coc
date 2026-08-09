import type { DatabaseSync } from 'node:sqlite'
import type {
  ChangeRequest,
  ChangeRequestAmendment,
  ChangeRequestResolutionType,
} from '@coc/shared'
import { asText, asTextOrNull } from '../row.ts'

/**
 * "Propose a change" storage — the only code that touches `change_requests` and
 * `change_request_amendments` (migration v15).
 *
 * **Authorization is not this file's job.** Every write here trusts the caller
 * to have already checked `access.ts`, the same division `trades-store.ts`
 * draws against `trade-access.ts`: this repo's own `CLAUDE.md` calls that split
 * out as the one place authorization should live, and re-checking it here would
 * be the "reimplement it inline" this file exists to avoid, just one layer down.
 *
 * **No transactional guard the way `trades-store.ts` has one.** Completing a
 * trade moves real card counts and has to be atomic against a concurrent
 * completion; nothing here moves anything but text and timestamps, so a plain
 * read-then-write is enough — the same level of rigor `base-order/store.ts`
 * uses for a per-user preference, not `trades-store.ts`'s guarded
 * `UPDATE ... WHERE status = 'pending'`. The one place a guard is still useful
 * is `cancel`, which is written to be idempotent (`WHERE canceled_at IS NULL`)
 * so calling it twice just confirms the first cancellation rather than
 * clobbering its timestamp with a second `now`.
 */

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return asInt(value)
}

export interface NewChangeRequest {
  subject: string
  body: string
}

export interface ChangeRequestResolutionInput {
  type: ChangeRequestResolutionType
  note: string | null
  commitHash: string | null
  commitSubject: string | null
}

export interface ChangeRequestStore {
  /** This account's own requests, newest first — every one they have ever submitted. */
  listMine(userId: number): ChangeRequest[]
  /** Every request from every account. Admin-only at the route; this store trusts that. */
  listAll(): ChangeRequest[]
  /**
   * How many requests are neither canceled nor resolved — the account-menu
   * badge's whole answer. A `COUNT(*)` rather than `listAll().length` filtered
   * in the caller, so a badge that renders on every page load does not pull
   * every request's subject, body and amendments across the wire to read one
   * number off it.
   */
  countOpen(): number
  find(id: number): ChangeRequest | undefined
  submit(input: NewChangeRequest, userId: number): ChangeRequest
  /** Appends an amendment. Throws if `id` does not name a request — the route checks first. */
  amend(id: number, body: string, userId: number): ChangeRequest
  /** Idempotent: a request already canceled keeps its original `canceledAt`. */
  cancel(id: number, userId: number): ChangeRequest
  setHidden(id: number, hidden: boolean): ChangeRequest
  /** Overwrites any prior resolution — see `mayResolveChangeRequest` for why that is allowed. */
  resolve(id: number, resolution: ChangeRequestResolutionInput, adminId: number): ChangeRequest
}

/* Display names are joined at read time, not copied onto the row, so a rename
   cannot leave an old request credited to a stale name — the same reason every
   other store here (`trades-store.ts`, `cards/store.ts`) joins its attribution. */
const REQUEST_SELECT = `
  SELECT r.id, r.subject, r.body, r.requested_by_user_id, r.requested_at,
         r.canceled_at, r.hidden_at,
         r.resolution_type, r.resolution_note, r.resolution_commit_hash, r.resolution_commit_subject,
         r.resolved_by_user_id, r.resolved_at,
         u.display_name AS requested_by, ru.display_name AS resolved_by
    FROM change_requests r
    LEFT JOIN users u ON u.id = r.requested_by_user_id
    LEFT JOIN users ru ON ru.id = r.resolved_by_user_id
`

const AMENDMENT_SELECT = `
  SELECT a.id, a.body, a.created_at, a.created_by_user_id, u.display_name AS created_by
    FROM change_request_amendments a
    LEFT JOIN users u ON u.id = a.created_by_user_id
   WHERE a.request_id = ?
   ORDER BY a.id
`

function toAmendment(row: Record<string, unknown>): ChangeRequestAmendment {
  return {
    id: asInt(row['id']),
    body: asText(row['body']),
    createdAt: asText(row['created_at']),
    createdByUserId: asIntOrNull(row['created_by_user_id']),
    createdBy: asTextOrNull(row['created_by']),
  }
}

function toRequest(row: Record<string, unknown>, amendments: ChangeRequestAmendment[]): ChangeRequest {
  const resolutionType = asTextOrNull(row['resolution_type']) as ChangeRequestResolutionType | null
  const resolvedAt = asTextOrNull(row['resolved_at'])

  return {
    id: asInt(row['id']),
    subject: asText(row['subject']),
    body: asText(row['body']),
    requestedByUserId: asIntOrNull(row['requested_by_user_id']),
    requestedBy: asTextOrNull(row['requested_by']),
    requestedAt: asText(row['requested_at']),
    amendments,
    canceledAt: asTextOrNull(row['canceled_at']),
    // The CHECK in migration v15 guarantees resolutionType and resolvedAt rise
    // and fall together, so this reads either both or neither.
    resolution:
      resolutionType === null || resolvedAt === null
        ? null
        : {
            type: resolutionType,
            note: asTextOrNull(row['resolution_note']),
            commitHash: asTextOrNull(row['resolution_commit_hash']),
            commitSubject: asTextOrNull(row['resolution_commit_subject']),
            resolvedByUserId: asIntOrNull(row['resolved_by_user_id']),
            resolvedBy: asTextOrNull(row['resolved_by']),
            resolvedAt,
          },
    hiddenAt: asTextOrNull(row['hidden_at']),
  }
}

export function createChangeRequestStore(db: DatabaseSync): ChangeRequestStore {
  const statements = {
    listMine: db.prepare(`${REQUEST_SELECT} WHERE r.requested_by_user_id = ? ORDER BY r.id DESC`),
    listAll: db.prepare(`${REQUEST_SELECT} ORDER BY r.id DESC`),
    // Served by `change_requests_open`, the index migration v15 declares for
    // exactly this shape of query.
    countOpen: db.prepare(
      `SELECT COUNT(*) AS n FROM change_requests WHERE canceled_at IS NULL AND resolved_at IS NULL`,
    ),
    find: db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`),
    amendmentsFor: db.prepare(AMENDMENT_SELECT),
    insert: db.prepare(
      `INSERT INTO change_requests (subject, body, requested_by_user_id, requested_at)
       VALUES (?, ?, ?, ?)`,
    ),
    insertAmendment: db.prepare(
      `INSERT INTO change_request_amendments (request_id, body, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?)`,
    ),
    // `AND canceled_at IS NULL` is what makes this idempotent: a second call
    // changes nothing, so the original cancellation time survives.
    cancel: db.prepare(
      `UPDATE change_requests SET canceled_at = ? WHERE id = ? AND canceled_at IS NULL`,
    ),
    setHidden: db.prepare(`UPDATE change_requests SET hidden_at = ? WHERE id = ?`),
    resolve: db.prepare(
      `UPDATE change_requests
          SET resolution_type = ?, resolution_note = ?,
              resolution_commit_hash = ?, resolution_commit_subject = ?,
              resolved_by_user_id = ?, resolved_at = ?
        WHERE id = ?`,
    ),
  }

  function find(id: number): ChangeRequest | undefined {
    const row = statements.find.get(id)
    if (!row) return undefined
    const amendments = statements.amendmentsFor.all(id).map(toAmendment)
    return toRequest(row, amendments)
  }

  function list(rows: Record<string, unknown>[]): ChangeRequest[] {
    return rows.map((row) => {
      const amendments = statements.amendmentsFor.all(row['id'] as number).map(toAmendment)
      return toRequest(row, amendments)
    })
  }

  function mustFind(id: number, verb: string): ChangeRequest {
    const request = find(id)
    if (!request) throw new Error(`change request ${id} disappeared while ${verb}`)
    return request
  }

  return {
    listMine(userId) {
      return list(statements.listMine.all(userId))
    },

    listAll() {
      return list(statements.listAll.all())
    },

    countOpen() {
      const row = statements.countOpen.get() as { n: number | bigint } | undefined
      return asInt(row?.n)
    },

    find,

    submit(input, userId) {
      const now = new Date().toISOString()
      const inserted = statements.insert.run(input.subject, input.body, userId, now)
      return mustFind(Number(inserted.lastInsertRowid), 'reading back a fresh submission')
    },

    amend(id, body, userId) {
      const now = new Date().toISOString()
      statements.insertAmendment.run(id, body, now, userId)
      return mustFind(id, 'reading back a fresh amendment')
    },

    cancel(id, userId) {
      // `userId` is not consulted here — the route already ran
      // `mayCancelChangeRequest`, which is where authorship is checked. It stays
      // a parameter for symmetry with `amend`/`resolve` and because a future
      // caller reading this store's interface should not have to guess whether
      // canceling records who did it (it does: `requested_by_user_id` already
      // says so, since only the author may ever cancel).
      void userId
      statements.cancel.run(new Date().toISOString(), id)
      return mustFind(id, 'canceling')
    },

    setHidden(id, hidden) {
      statements.setHidden.run(hidden ? new Date().toISOString() : null, id)
      return mustFind(id, 'setting hidden')
    },

    resolve(id, resolution, adminId) {
      statements.resolve.run(
        resolution.type,
        resolution.note,
        resolution.commitHash,
        resolution.commitSubject,
        adminId,
        new Date().toISOString(),
        id,
      )
      return mustFind(id, 'resolving')
    },
  }
}
