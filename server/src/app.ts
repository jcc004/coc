import { Hono } from 'hono'
import { InvalidTagError } from '@coc/shared'
import {
  requireAdmin,
  requireAuth,
  requirePasswordUpToDate,
  withSession,
  type AuthEnv,
} from './auth/middleware.ts'
import { mountAuthRoutes } from './auth/routes.ts'
import { createLoginLimiter, type LoginLimiter } from './auth/rate-limit.ts'
import type { AuthStore } from './auth/store.ts'
import { TtlCache } from './cache.ts'
import { mountCardRoutes } from './cards/routes.ts'
import type { CardInventoryStore } from './cards/store.ts'
import { mountTradeRoutes } from './cards/trade-routes.ts'
import type { TradeStore } from './cards/trades-store.ts'
import { CocApiError, type CocClient } from './coc-client.ts'
import { errorBody } from './http.ts'
import { mountSharedDataRoutes } from './shared-data/routes.ts'
import type { SharedDataStore } from './shared-data/store.ts'

export interface AppDeps {
  coc: CocClient
  cache: TtlCache
  auth: AuthStore
  /** Saved clans and owner assignments — shared across every account. */
  sharedData: SharedDataStore
  /** Hand-entered card counts for the event season — shared, like the above. */
  cards: CardInventoryStore
  /**
   * Proposed and resolved trades. Completing one writes `cards`' table too, in one
   * transaction, which is why the trade store is handed the inventory store rather
   * than the two being kept apart.
   */
  trades: TradeStore
  /** Injectable so tests can trip the lockout in a few requests. */
  loginLimiter?: LoginLimiter
  /** `Secure` on the session cookie. Derive it with `cookieSecureFromEnv`. */
  cookieSecure?: boolean
}

/**
 * Routes that answer without a session. Everything else under `/api/` is denied
 * to anonymous callers by default — deny-by-default because the whole point of
 * this layer is that an unauthenticated `/api/*` is a free proxy onto a
 * rate-limited Supercell token, and a route added later must not be able to
 * become a hole by omission.
 */
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/logout'])

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function createApp({
  coc,
  cache,
  auth,
  sharedData,
  cards,
  trades,
  loginLimiter,
  cookieSecure = false,
}: AppDeps) {
  const app = new Hono<AuthEnv>()

  // Order matters: middleware only runs ahead of a handler if it was registered
  // first, so both gates go on before any route.
  app.use('/api/*', withSession(auth))
  app.use('/api/*', async (c, next) =>
    PUBLIC_API_PATHS.has(c.req.path) ? next() : requireAuth(c, next),
  )
  // Ahead of requireAdmin, so a flagged *admin* is gated too — the role does not
  // exempt anyone from replacing a password somebody else picked for them.
  app.use('/api/*', requirePasswordUpToDate)
  app.use('/api/admin/*', requireAdmin)

  mountAuthRoutes(app, auth, {
    limiter: loginLimiter ?? createLoginLimiter(),
    cookieSecure,
  })

  mountSharedDataRoutes(app, sharedData)

  // The card routes need the owner column to answer "may this caller write this
  // base", which is the one place the two shared stores meet.
  mountCardRoutes(app, cards, sharedData)

  // The Trade Tracker reads the same owner column, for a different rule: a trade
  // is mutual, so *either* base's owner may propose and resolve it.
  mountTradeRoutes(app, trades, sharedData)

  // Public so a host's liveness probe can reach it, but the cache size is an
  // internal detail an anonymous caller has no business seeing.
  app.get('/api/health', (c) => {
    const user = c.get('user')
    return c.json(user ? { ok: true, cachedEntries: cache.size } : { ok: true })
  })

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

  app.get('/api/clans/:tag/capitalraidseasons', async (c) => {
    const tag = c.req.param('tag')
    const limit = positiveInt(c.req.query('limit'))
    const seasons = await cache.wrap(`capitalRaidSeasons:${tag}:${limit ?? 10}`, () =>
      coc.getCapitalRaidSeasons(tag, limit),
    )
    return c.json(seasons)
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
