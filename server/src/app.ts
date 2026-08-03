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
import type { TtlCache } from './cache.ts'
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
  /**
   * Whether `X-Real-IP` / `X-Forwarded-For` may be believed. Derive it with
   * `trustProxyFromEnv`. Defaults to **false**, the safe value: a forwarded header
   * is only trustworthy because a known proxy overwrites it, and with nothing in
   * front of the app there is nobody doing that. See `clientIp`.
   */
  trustProxy?: boolean
}

/**
 * The ceiling on every numeric query parameter, before it is handed to Supercell and
 * used as part of a cache key.
 *
 * `positiveInt` used to accept any positive integer, so `?limit=999999999` went
 * upstream verbatim *and* earned its own cache entry. Two costs, and the second is
 * the larger one: with the value unbounded, the key space is unbounded too, so a
 * caller could mint a fresh entry per request for one dataset and spend the
 * rate-limited Supercell token on answers nothing can use. That applies to
 * `minMembers`, `maxMembers` and `minClanLevel` exactly as much as to `limit`, which
 * is why the bound is on the parser rather than on one call site.
 *
 * 100 is chosen because it clears every real caller with room to spare — a clan
 * holds at most 50 members, the client asks for 20 war-log entries and 6 raid
 * seasons, and no clan is level 100 — while being small enough that a bounded value
 * is still a *bound*. Every parameter here is a filter or a page size where a number
 * past this point selects nothing that a clamped one would not have selected too, so
 * clamping changes no real answer.
 *
 * Out of range is clamped rather than rejected, which keeps the existing contract: a
 * malformed value has always been ignored in favour of the route's default, and a
 * caller asking for more than exists has always got everything there was.
 */
const MAX_QUERY_INT = 100

/**
 * The largest request body any `/api/` route will read, enforced before a handler
 * parses one.
 *
 * `nginx-coc.conf` caps bodies at 10 MB and its comment says to "raise the
 * server-side limit to match rather than this alone" — there was no server-side
 * limit to raise. This is it, and it is deliberately far below nginx's number
 * because nginx is protecting itself from buffering while this is protecting the
 * app from parsing.
 *
 * Sized against the two largest real payloads:
 *
 * - a whole-base card save (`PUT /api/cards/inventory/:tag`) — 60 card counts, a
 *   few hundred bytes;
 * - a browser import (`POST /api/import`) — every owner assignment and saved clan a
 *   client has ever held. At ~60 bytes per row that is tens of kilobytes for the
 *   real dataset, and 256 KiB leaves room for an install an order of magnitude
 *   bigger than this one before anybody has to think about it again.
 *
 * Under nginx a body over 10 MB is refused before it arrives, so this fires for the
 * band between the two limits and for a request that reached the app directly.
 */
const MAX_API_BODY_BYTES = 256 * 1024

/**
 * The interface to bind, defaulting to loopback.
 *
 * `serve({ fetch, port })` with no hostname binds `0.0.0.0` **and** `::`, so the
 * process sat on every interface the box had. On the deployment that meant :8787 was
 * reachable directly, and everything nginx does for a request — TLS, HSTS, the
 * `client_max_body_size` ceiling, setting the forwarded headers the rate limiter
 * reads — could be skipped by addressing the app instead of the site. Only the host
 * firewall stood in the way, which is a second system having to be right about
 * something this one can simply decline to offer.
 *
 * `nginx-coc.conf` proxies to `127.0.0.1:8787`, so loopback is what the deployment
 * actually needs. `HOST` is the override for the case where direct exposure is the
 * intent — a container that must publish a port, say — and having to set it is the
 * point: that decision should be typed out somewhere rather than inherited from a
 * default. It lives here rather than in `index.ts` so it can be tested without
 * starting a listener.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1'

export function bindHostFromEnv(env: Record<string, string | undefined>): string {
  return env.HOST?.trim() || DEFAULT_BIND_HOST
}

/** Whether `host` puts the app on every interface, i.e. in front of nginx. */
export function bindsEveryInterface(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/**
 * Routes that answer without a session. Everything else under `/api/` is denied
 * to anonymous callers by default — deny-by-default because the whole point of
 * this layer is that an unauthenticated `/api/*` is a free proxy onto a
 * rate-limited Supercell token, and a route added later must not be able to
 * become a hole by omission.
 */
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/logout'])

/**
 * A positive integer from the query string, bounded by {@link MAX_QUERY_INT}.
 * `undefined` for anything that is not one, so the caller falls back to the route's
 * own default — that part is unchanged, and is why a malformed value is still
 * ignored rather than answered with a 400.
 */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, MAX_QUERY_INT)
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
  trustProxy = false,
}: AppDeps) {
  const app = new Hono<AuthEnv>()

  /*
   * The body cap goes on first, ahead of even the session lookup: a request too
   * large to be legitimate should be refused before the server does any work on its
   * behalf, and that includes a database read.
   *
   * `Content-Length` is what is checked, because it is the one thing available
   * *before* reading a byte. It is also client-supplied, so this is not a limit on
   * what a body can actually be — a chunked request carries no length at all and
   * passes straight through. That is not a hole this middleware can close: bounding
   * a stream means reading it, and the layer that already does that is nginx's
   * `client_max_body_size`. What this catches is the case that matters at the app
   * layer — an honest-but-enormous payload, and any request that reached :8787
   * without going through nginx at all.
   *
   * 413 with the limit in the message, rather than a bare refusal, because the one
   * caller who will ever hit this is a browser import of a genuinely large dataset
   * and the useful answer tells them what the number is.
   */
  app.use('/api/*', async (c, next) => {
    const declared = Number(c.req.header('content-length'))
    if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) {
      return c.json(
        errorBody(
          413,
          'payloadTooLarge',
          `Request body is too large (${declared} bytes; the limit is ${MAX_API_BODY_BYTES}).`,
          'Split the upload into smaller batches.',
        ),
        413,
      )
    }
    await next()
  })

  // Order matters: middleware only runs ahead of a handler if it was registered
  // first, so both gates go on before any route.
  app.use('/api/*', withSession(auth))
  app.use('/api/*', async (c, next) =>
    // The `any` is Hono's own: a path-scoped `app.use` gives the handler a
    // `Context<AuthEnv, '/api/*', any>`, and `requireAuth` is typed against the
    // unscoped `Context<AuthEnv>`. Nothing untyped is being passed — it is the same
    // context object either way — so this is the library's generic, not ours.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    PUBLIC_API_PATHS.has(c.req.path) ? next() : requireAuth(c, next),
  )
  // Ahead of requireAdmin, so a flagged *admin* is gated too — the role does not
  // exempt anyone from replacing a password somebody else picked for them.
  app.use('/api/*', requirePasswordUpToDate)
  app.use('/api/admin/*', requireAdmin)

  mountAuthRoutes(app, auth, {
    limiter: loginLimiter ?? createLoginLimiter(),
    cookieSecure,
    trustProxy,
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
