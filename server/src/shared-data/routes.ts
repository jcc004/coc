import type { Hono } from 'hono'
import { normalizeTag, type OwnerBulkRow, type SavedClanInput } from '@coc/shared'
import { currentUser, type AuthContext, type AuthEnv } from '../auth/middleware.ts'
import { errorBody } from '../http.ts'
import type { SharedDataStore } from './store.ts'

/**
 * `/api/saved/*`, `/api/owners/*` and `/api/import`.
 *
 * Authentication is not re-checked here: `/api/*` is deny-by-default in
 * `createApp` and none of these paths is on the public list. Every route is
 * therefore reachable only with a session, and `currentUser(c)` cannot be null.
 *
 * There is no per-user filter in any handler, and that is the design: the rows are
 * shared, so every signed-in caller sees and edits the same ones. `InvalidTagError`
 * from `normalizeTag` is left to fall through to the app's error handler, which
 * already turns it into a 400 with the tag rule as a hint.
 */

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

  app.delete('/api/owners/:tag', (c) => {
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
  app.post('/api/owners/bulk', async (c) => {
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

  app.post('/api/import', async (c) => {
    const body = await readJson(c)

    const owners = asRecordArray(body['owners'])
      .map((entry) => ({ tag: asString(entry['tag']), owner: asString(entry['owner']) }))
      .filter((entry) => entry.tag !== '')

    const clans = asRecordArray(body['clans'])
      .map(asSavedClanInput)
      .filter((entry): entry is SavedClanInput => entry !== undefined)

    return c.json(store.importFromBrowser({ owners, clans }, currentUser(c).id))
  })
}
