import { Hono } from 'hono'
import { InvalidTagError, type ApiErrorResponse } from '@coc/shared'
import { TtlCache } from './cache.ts'
import { CocApiError, type CocClient } from './coc-client.ts'

export interface AppDeps {
  coc: CocClient
  cache: TtlCache
}

function errorBody(status: number, reason: string, message: string, hint?: string): ApiErrorResponse {
  return { error: { status, reason, message, ...(hint ? { hint } : {}) } }
}

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function createApp({ coc, cache }: AppDeps) {
  const app = new Hono()

  app.get('/api/health', (c) => c.json({ ok: true, cachedEntries: cache.size }))

  app.get('/api/players/:tag', async (c) => {
    const tag = c.req.param('tag')
    const player = await cache.wrap(`player:${tag}`, () => coc.getPlayer(tag))
    return c.json(player)
  })

  // Registered before /clans/:tag so a bare /api/clans?name=… is treated as a
  // search rather than a lookup of a clan literally tagged "".
  app.get('/api/clans', async (c) => {
    const name = c.req.query('name')?.trim()
    if (!name || name.length < 3) {
      return c.json(
        errorBody(400, 'badRequest', 'Provide a ?name= of at least 3 characters to search clans.'),
        400,
      )
    }

    const params = {
      name,
      minMembers: positiveInt(c.req.query('minMembers')),
      maxMembers: positiveInt(c.req.query('maxMembers')),
      minClanLevel: positiveInt(c.req.query('minClanLevel')),
      limit: positiveInt(c.req.query('limit')) ?? 20,
    }

    const results = await cache.wrap(`clanSearch:${JSON.stringify(params)}`, () =>
      coc.searchClans(params),
    )
    return c.json(results)
  })

  app.get('/api/clans/:tag', async (c) => {
    const tag = c.req.param('tag')
    const clan = await cache.wrap(`clan:${tag}`, () => coc.getClan(tag))
    return c.json(clan)
  })

  // Attacks land continuously during a war, so this gets a much shorter TTL
  // than the rest — stale war data is the one thing you would actually notice.
  const WAR_TTL_MS = 20_000

  app.get('/api/clans/:tag/currentwar', async (c) => {
    const tag = c.req.param('tag')
    const war = await cache.wrap(`currentWar:${tag}`, () => coc.getCurrentWar(tag), WAR_TTL_MS)
    return c.json(war)
  })

  app.get('/api/clans/:tag/warlog', async (c) => {
    const tag = c.req.param('tag')
    const limit = positiveInt(c.req.query('limit'))
    const log = await cache.wrap(`warLog:${tag}:${limit ?? 20}`, () => coc.getWarLog(tag, limit))
    return c.json(log)
  })

  app.get('/api/clans/:tag/members', async (c) => {
    const tag = c.req.param('tag')
    const limit = positiveInt(c.req.query('limit'))
    const members = await cache.wrap(`clanMembers:${tag}:${limit ?? 'all'}`, () =>
      coc.getClanMembers(tag, limit),
    )
    return c.json(members)
  })

  app.notFound((c) => c.json(errorBody(404, 'notFound', `No route for ${c.req.path}`), 404))

  app.onError((err, c) => {
    if (err instanceof InvalidTagError) {
      return c.json(
        errorBody(
          400,
          'invalidTag',
          err.message,
          'Tags are 3–12 alphanumeric characters, e.g. #2PP0JCCLV.',
        ),
        400,
      )
    }

    if (err instanceof CocApiError) {
      // 5xx from upstream is not this server failing, but the client still needs
      // a status it can branch on, so pass it through as-is.
      return c.json(errorBody(err.status, err.reason, err.message, err.hint), err.status as 400)
    }

    console.error('Unhandled error:', err)
    return c.json(errorBody(500, 'internalError', 'Something went wrong on the server.'), 500)
  })

  return app
}
