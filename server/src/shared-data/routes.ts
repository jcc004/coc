import type { Hono } from 'hono'
import { normalizeTag, type OwnerBulkRow, type SavedClanInput } from '@coc/shared'
import { currentUser, requireAdminFor, type AuthContext, type AuthEnv } from '../auth/middleware.ts'
import { errorBody } from '../http.ts'
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
 * owner writes (set, bulk apply, clear) sit behind `ownerWritesAreAdminOnly`; the
 * saved-clan routes are untouched, because a clan list is nobody's permission.
 *
 * `InvalidTagError` from `normalizeTag` is left to fall through to the app's error
 * handler, which already turns it into a 400 with the tag rule as a hint.
 */

const ADMIN_ASSIGNS_OWNERSHIP =
  'An admin assigns ownership of a base. Ask one to point this tag at the right account.'

const ownerWritesAreAdminOnly = requireAdminFor(
  ADMIN_ASSIGNS_OWNERSHIP,
  'Everyone can read every owner; only an admin can change one.',
)

async function readJson(c: AuthContext): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asPositiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asSavedClanInput(raw: Record<string, unknown>): SavedClanInput | undefined {
  const tag = asString(raw['tag'])
  const name = asString(raw['name']).trim()
  if (!tag || !name) return undefined

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

export function mountSharedDataRoutes(app: Hono<AuthEnv>, store: SharedDataStore): void {
  /* ---------- saved clans ---------- */

  app.get('/api/saved/clans', (c) => c.json({ clans: store.listSavedClans() }))

  app.post('/api/saved/clans', async (c) => {
    const input = asSavedClanInput(await readJson(c))
    if (!input) {
      return c.json(errorBody(400, 'badRequest', 'A saved clan needs a tag and a name.'), 400)
    }
    return c.json({ clan: store.saveClan(input, currentUser(c).id) })
  })

  app.patch('/api/saved/clans/:tag', async (c) => {
    const body = await readJson(c)
    const name = asString(body['name']).trim()
    if (!name) {
      return c.json(errorBody(400, 'badRequest', 'A display name cannot be blank.'), 400)
    }

    const clan = store.renameClan(c.req.param('tag'), name, currentUser(c).id)
    if (!clan) {
      return c.json(
        errorBody(404, 'notFound', `${normalizeTag(c.req.param('tag'))} is not a saved clan.`),
        404,
      )
    }
    return c.json({ clan })
  })

  app.delete('/api/saved/clans/:tag', (c) => {
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

    return c.json(store.applyOwners(rows, currentUser(c).id))
  })

  /* ---------- one-time import ---------- */

  /**
   * The upload is **not** admin-only: a member's own browser data is theirs to
   * bring across, and their saved clans grant nobody anything.
   *
   * Its owner half is, though — otherwise an import would be a way around the
   * gate on the routes above. A non-admin's owner rows are refused unexamined and
   * counted, rather than silently dropped, so the client can say what happened.
   */
  app.post('/api/import', async (c) => {
    const body = await readJson(c)
    const user = currentUser(c)

    const owners = asRecordArray(body['owners'])
      .map((entry) => ({ tag: asString(entry['tag']), owner: asString(entry['owner']) }))
      .filter((entry) => entry.tag !== '')

    const clans = asRecordArray(body['clans'])
      .map(asSavedClanInput)
      .filter((entry): entry is SavedClanInput => entry !== undefined)

    const mayWriteOwners = user.role === 'admin'
    const result = store.importFromBrowser(
      { owners: mayWriteOwners ? owners : [], clans },
      user.id,
    )
    if (!mayWriteOwners && owners.length > 0) result.owners.refused = owners.length

    return c.json(result)
  })
}
