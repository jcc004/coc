import type { Hono } from 'hono'
import { normalizeTag, type OwnerBulkRow, type SavedClanInput } from '@coc/shared'
import {
  adminAccessRevoked,
  currentUser,
  requireAdminFor,
  stillActiveAdmin,
  type AuthEnv,
} from '../auth/middleware.ts'
import type { AuthStore } from '../auth/store.ts'
import { errorBody, readJson } from '../http.ts'
import type { SharedDataStore } from './store.ts'

/**
 * `/api/saved/*`, `/api/owners/*` and `/api/import`.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and none of these paths is on the public list. Every route is
 * therefore reachable only with a session, and `currentUser(c)` cannot be null.
 *
 * **Reading** has no per-user filter and that is still the design: the rows are
 * shared, so every signed-in caller sees every saved clan and every owner. Sharing
 * this data was the reason it moved to the server.
 *
 * **Writing the owner column is an admin decision**, because ownership now decides
 * who may edit a base's card counts — a member who could reassign a base could
 * grant themselves that write, which makes it not a permission at all. The three
 * owner writes (set, bulk apply, clear) sit behind `ownerWritesAreAdminOnly`.
 *
 * **Writing the saved-clan list is now an admin decision too**, for the same
 * reasoning: it is shared state every signed-in member sees, and a member who
 * could add, rename, or remove entries unilaterally could reshape what everyone
 * else sees without anyone entitled to that call having agreed to it. This used
 * to be untouched, on the theory that a clan list is nobody's permission — that
 * held only as long as nobody minded a member editing it out from under the
 * group, and the project owner has since decided otherwise. The three saved-clan
 * writes (add, rename, remove) sit behind `savedClansAreAdminOnly`.
 *
 * `InvalidTagError` from `normalizeTag` is left to fall through to the app's error
 * handler, which already turns it into a 400 with the tag rule as a hint.
 */

const ADMIN_ASSIGNS_OWNERSHIP =
  'An admin assigns ownership of a base. Ask one to point this tag at the right account.'

/**
 * The most rows one bulk owner apply or one import may carry.
 *
 * Sized against the install, not against the transport. This is a ten-account app
 * with one clan roster of about fifty members, so a genuine bulk apply is tens of
 * rows and a browser's whole `localStorage` is the same order. Without a cap the
 * only limit is nginx's 10 MB body, which is a few hundred thousand rows of JSON
 * parsing and per-row SQL for one authenticated request — cheap to send, not cheap
 * to serve.
 *
 * 200 rather than 60 because a roster turns over and a long-lived browser holds
 * tags for bases nobody plays any more. The point is a bound with obvious
 * headroom, not a tight fit; a real request will never come close.
 */
export const MAX_BULK_ROWS = 200

/**
 * A saved clan's label, capped at the same 64 as `DISPLAY_NAME_MAX` in
 * `auth/store.ts` — both end up in the same kind of table cell, and the in-game
 * clan name is far shorter than either. It had no maximum at all, which made it the
 * one free-text field in the app that a caller could stuff.
 */
export const SAVED_CLAN_NAME_MAX = 64

const ownerWritesAreAdminOnly = requireAdminFor(
  ADMIN_ASSIGNS_OWNERSHIP,
  'Everyone can read every owner; only an admin can change one.',
)

const savedClansAreAdminOnly = requireAdminFor(
  'An admin manages the saved clan list. Ask one to add, rename, or remove it.',
  'Everyone can read the saved clans; only an admin can change the list.',
)

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A whole number greater than zero, or `undefined` for anything else.
 *
 * Same semantics as `positiveInt` in `app.ts`, deliberately: malformed input is
 * *ignored* rather than rejected, because every field this guards is a cached stat
 * (`members`, `clanLevel`, `clanPoints`) that the clan list renders as a dash when
 * absent. Refusing the whole save over a bad stat would lose the tag and the name
 * the user actually asked to keep.
 *
 * It used to accept any finite number, so `members: -5` and `clanLevel: 0.5` both
 * stored and both rendered. The bug was less the stored value than the name: code
 * downstream trusts a guarantee the body did not make.
 */
function asPositiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * `undefined` for a body that could not be a saved clan. The name length is checked
 * here rather than at the route so the import path gets the same rule for free: an
 * over-long name is dropped from the upload exactly as a missing one already was,
 * which costs the user that row and not the other 199.
 */
function asSavedClanInput(raw: Record<string, unknown>): SavedClanInput | undefined {
  const tag = asString(raw['tag'])
  const name = asString(raw['name']).trim()
  if (!tag || !name || name.length > SAVED_CLAN_NAME_MAX) return undefined

  const input: SavedClanInput = { tag, name }
  if (raw['custom'] === true) input.custom = true

  const clanLevel = asPositiveIntOrUndefined(raw['clanLevel'])
  if (clanLevel !== undefined) input.clanLevel = clanLevel
  const members = asPositiveIntOrUndefined(raw['members'])
  if (members !== undefined) input.members = members
  const clanPoints = asPositiveIntOrUndefined(raw['clanPoints'])
  if (clanPoints !== undefined) input.clanPoints = clanPoints
  const warLeague = asString(raw['warLeague']).trim()
  if (warLeague) input.warLeague = warLeague

  return input
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
}

/**
 * `undefined` when the field is within {@link MAX_BULK_ROWS}, otherwise the message
 * to refuse it with.
 *
 * Counted on the **raw** array, before `asRecordArray` drops the entries that are
 * not objects. What is being bounded is parsing and iteration, and a million nulls
 * cost that as surely as a million rows — filtering first would let a caller hide
 * the size of what they sent.
 */
function tooManyRows(value: unknown, field: string): string | undefined {
  if (!Array.isArray(value) || value.length <= MAX_BULK_ROWS) return undefined
  return `${field} carries ${value.length} rows; the most this endpoint accepts is ${MAX_BULK_ROWS}.`
}

export function mountSharedDataRoutes(
  app: Hono<AuthEnv>,
  store: SharedDataStore,
  auth: AuthStore,
): void {
  /* ---------- saved clans ---------- */

  app.get('/api/saved/clans', (c) => c.json({ clans: store.listSavedClans() }))

  app.post('/api/saved/clans', savedClansAreAdminOnly, async (c) => {
    const input = asSavedClanInput(await readJson(c))
    if (!input) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          'A saved clan needs a tag and a name.',
          `A name is 1–${SAVED_CLAN_NAME_MAX} characters.`,
        ),
        400,
      )
    }

    if (!stillActiveAdmin(auth, currentUser(c).id)) return adminAccessRevoked(c)

    return c.json({ clan: store.saveClan(input, currentUser(c).id) })
  })

  app.patch('/api/saved/clans/:tag', savedClansAreAdminOnly, async (c) => {
    const body = await readJson(c)
    const name = asString(body['name']).trim()
    if (!name) {
      return c.json(errorBody(400, 'badRequest', 'A display name cannot be blank.'), 400)
    }
    if (name.length > SAVED_CLAN_NAME_MAX) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          `A display name is at most ${SAVED_CLAN_NAME_MAX} characters; that one is ${name.length}.`,
        ),
        400,
      )
    }

    if (!stillActiveAdmin(auth, currentUser(c).id)) return adminAccessRevoked(c)

    const clan = store.renameClan(c.req.param('tag'), name, currentUser(c).id)
    if (!clan) {
      return c.json(
        errorBody(404, 'notFound', `${normalizeTag(c.req.param('tag'))} is not a saved clan.`),
        404,
      )
    }
    return c.json({ clan })
  })

  app.delete('/api/saved/clans/:tag', savedClansAreAdminOnly, (c) => {
    const tag = c.req.param('tag')
    if (!store.removeClan(tag)) {
      return c.json(errorBody(404, 'notFound', `${normalizeTag(tag)} is not a saved clan.`), 404)
    }
    return c.json({ ok: true })
  })

  /* ---------- owners ---------- */

  app.get('/api/owners', (c) => c.json({ owners: store.listOwners() }))

  /**
   * The single set: hand one base to one account. A user id, not a name — a name
   * cannot be compared to the session of whoever is trying to write that base's
   * counts, which is the whole reason ownership moved onto `users`.
   */
  app.put('/api/owners/:tag', ownerWritesAreAdminOnly, async (c) => {
    const body = await readJson(c)
    const userId = body['userId']
    if (typeof userId !== 'number' || !Number.isInteger(userId)) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          'Send { "userId": <account id> } to assign a base.',
          'Ownership names an account. DELETE this path to clear it instead.',
        ),
        400,
      )
    }

    if (!stillActiveAdmin(auth, currentUser(c).id)) return adminAccessRevoked(c)

    const owner = store.setOwner(c.req.param('tag'), userId, currentUser(c).id)
    if (!owner) {
      return c.json(
        errorBody(404, 'notFound', `No account has id ${userId}, so nothing was assigned.`),
        404,
      )
    }
    return c.json({ owner })
  })

  app.delete('/api/owners/:tag', ownerWritesAreAdminOnly, (c) => {
    const tag = c.req.param('tag')
    if (!store.removeOwner(tag)) {
      return c.json(errorBody(404, 'notFound', `${normalizeTag(tag)} has no owner assigned.`), 404)
    }
    return c.json({ ok: true })
  })

  /**
   * Bulk apply with optimistic concurrency. `expectedOwner` is required on every
   * row — a missing one would default to `''`, which reads as "I believe nobody
   * owns this" and is exactly the silent clobber this endpoint exists to prevent.
   */
  app.post('/api/owners/bulk', ownerWritesAreAdminOnly, async (c) => {
    const body = await readJson(c)

    const oversized = tooManyRows(body['rows'], 'rows')
    if (oversized) {
      return c.json(
        errorBody(400, 'badRequest', oversized, 'Send it in batches. Nothing was written.'),
        400,
      )
    }

    const raw = asRecordArray(body['rows'])

    const rows: OwnerBulkRow[] = []
    for (const entry of raw) {
      const tag = asString(entry['tag'])
      if (!tag) continue
      if (typeof entry['expectedOwner'] !== 'string') {
        return c.json(
          errorBody(
            400,
            'badRequest',
            'Every row must carry expectedOwner — the value you believe is stored.',
            'Send "" when you believe the base has no owner.',
          ),
          400,
        )
      }
      rows.push({ tag, owner: asString(entry['owner']), expectedOwner: entry['expectedOwner'] })
    }

    if (!stillActiveAdmin(auth, currentUser(c).id)) return adminAccessRevoked(c)

    return c.json(store.applyOwners(rows, currentUser(c).id))
  })

  /* ---------- one-time import ---------- */

  /**
   * The upload route itself is not admin-only — a member's own browser data is
   * theirs to bring across, and asking them to find an admin just to hand off a
   * `localStorage` export would be its own kind of friction.
   *
   * Both halves of what it carries are admin-gated, though: the owner column for
   * the reasoning above the routes that write it, and the saved-clan list for the
   * same reasoning above `savedClansAreAdminOnly`. Gating only one would make this
   * route a way around the other's own gate — a member refused on
   * `POST /api/saved/clans` could otherwise get the identical write through here
   * instead. A non-admin's owner rows and clan rows are both refused unexamined
   * and counted, rather than silently dropped, so the client can say what
   * happened.
   */
  app.post('/api/import', async (c) => {
    const body = await readJson(c)
    const user = currentUser(c)

    // Both halves are capped, and either one being oversized refuses the whole
    // request: an import is one atomic "bring my browser across" from the user's
    // point of view, and applying half of it would leave them unable to tell what
    // arrived.
    for (const field of ['owners', 'clans'] as const) {
      const oversized = tooManyRows(body[field], field)
      if (oversized) {
        return c.json(errorBody(400, 'badRequest', oversized, 'Nothing was imported.'), 400)
      }
    }

    /*
     * The rows this route drops have to be *counted*, not merely filtered.
     *
     * They are the ones the store never sees — no tag, no name, a name past the
     * length cap — and until now they were counted nowhere at all. These numbers are
     * shown to the user as an account of what became of their data, so an import of
     * 40 clans reporting 39 is a summary that cannot be checked, and it quietly
     * loses the one row actually worth asking about. The store counts its own
     * rejects into `invalid`, so this is that same meaning applied one stage earlier.
     */
    const rawOwners = asRecordArray(body['owners'])
    const owners = rawOwners
      .map((entry) => ({ tag: asString(entry['tag']), owner: asString(entry['owner']) }))
      .filter((entry) => entry.tag !== '')
    const droppedOwners = rawOwners.length - owners.length

    const rawClans = asRecordArray(body['clans'])
    const clans = rawClans
      .map(asSavedClanInput)
      .filter((entry): entry is SavedClanInput => entry !== undefined)
    const droppedClans = rawClans.length - clans.length

    // Not behind `requireAdminFor` — this route is open to every signed-in
    // caller, and only the owner and clan halves of the payload are admin-gated.
    // Read fresh rather than off `user`'s request-start snapshot, for the same
    // reason `stillActiveAdmin`'s other call sites do: the two `tooManyRows`
    // checks and the `asRecordArray`/`map`/`filter` passes above ran since
    // the session was resolved, and a concurrent demotion in that window
    // should not let a no-longer-admin caller's rows through. One check covers
    // both halves — they are now the identical decision, and there is no reason
    // for them to ever diverge.
    const isStillAdmin = stillActiveAdmin(auth, user.id)
    const result = store.importFromBrowser(
      { owners: isStillAdmin ? owners : [], clans: isStillAdmin ? clans : [] },
      user.id,
    )

    /*
     * A refused half counts every row as refused, dropped ones included, and adds
     * nothing to `invalid`: those rows were never examined, so calling one both
     * refused and invalid would make the total overshoot what the client sent.
     */
    if (isStillAdmin) {
      result.owners.invalid += droppedOwners
      result.clans.invalid += droppedClans
    } else {
      if (rawOwners.length > 0) result.owners.refused = rawOwners.length
      if (rawClans.length > 0) result.clans.refused = rawClans.length
    }

    return c.json(result)
  })
}
