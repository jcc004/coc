import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { SessionUser } from '@coc/shared'
import { errorBody } from '../http.ts'
import { SESSION_TTL_MS, type AuthStore } from './store.ts'

export const SESSION_COOKIE = 'coc_session'

export interface AuthEnv {
  Variables: {
    user: SessionUser | null
    sessionId: string | null
  }
}

export type AuthContext = Context<AuthEnv>

/**
 * Resolves the session cookie once per request and parks the result on the
 * context. Everything downstream — `requireAuth`, `/api/health`, the route
 * handlers — reads `c.get('user')` and never touches the cookie or the store.
 */
export function withSession(store: AuthStore): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? ''
    const resolved = token ? store.resolveSession(token) : undefined

    c.set('user', resolved?.user ?? null)
    c.set('sessionId', resolved?.sessionId ?? null)

    // A cookie that no longer resolves is dead weight on every future request.
    if (token && !resolved) deleteCookie(c, SESSION_COOKIE, { path: '/' })

    await next()
  }
}

/**
 * Refuses anonymous callers. Exported so any future route can be mounted behind
 * it — `app.post('/api/whatever', requireAuth, handler)` — without repeating the
 * check. It only reads context state, so it composes anywhere `withSession` has
 * already run.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) {
    return c.json(
      errorBody(401, 'unauthenticated', 'Sign in to use this API.', 'POST /api/auth/login'),
      401,
    )
  }
  await next()
}

/**
 * The only paths reachable while `must_change_password` is set. Everything else
 * under `/api/` is refused until the password has actually been replaced.
 *
 * This is the difference between a forced change and a suggestion. Surfacing the
 * flag in the UI alone would leave the whole API open to a client that simply
 * navigated somewhere else, so the gate is here and the screen is the courtesy.
 * `/api/health` and login are on the list because they are public anyway.
 */
const FORCED_CHANGE_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/password',
])

/**
 * 403, deliberately, not 401: the session is perfectly valid, so answering 401
 * would trip the client's global "you have been signed out" handler and bounce
 * someone to the login screen they cannot get past — the credential they have is
 * the temporary one, and the change form is behind the session.
 */
export const requirePasswordUpToDate: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get('user')
  if (user?.mustChangePassword && !FORCED_CHANGE_PATHS.has(c.req.path)) {
    return c.json(
      errorBody(
        403,
        'passwordChangeRequired',
        'Your password was reset by an admin. Change it before using the rest of the app.',
        'POST /api/auth/password',
      ),
      403,
    )
  }
  await next()
}

/**
 * An admin-only gate that says *why* in the caller's terms.
 *
 * A bare "admins only" is a wall: it tells someone their request failed without
 * telling them what to do next. The message is a parameter so each area can name
 * the thing an admin does — for the owner column, that an admin assigns
 * ownership — rather than every route sharing one uninformative sentence.
 */
export function requireAdminFor(message: string, hint?: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get('user')
    if (!user) {
      return c.json(errorBody(401, 'unauthenticated', 'Sign in to use this API.'), 401)
    }
    if (user.role !== 'admin') {
      return c.json(errorBody(403, 'forbidden', message, hint), 403)
    }
    await next()
  }
}

export const requireAdmin = requireAdminFor('This endpoint is for admins only.')

/** Valid only downstream of `requireAuth`, which is what makes the throw unreachable. */
export function currentUser(c: AuthContext): SessionUser {
  const user = c.get('user')
  if (!user) throw new Error('currentUser() called outside requireAuth')
  return user
}

/**
 * `Secure` is conditional so local http development still receives the cookie;
 * anywhere with HTTPS in front of it (i.e. the deployment) sets one of these.
 */
export function cookieSecureFromEnv(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'production' || env.COOKIE_SECURE === 'true'
}

/**
 * `SameSite=Lax` is the CSRF defence: the browser withholds the cookie on
 * cross-site POSTs, which is every state-changing route here. `HttpOnly` keeps
 * the token away from JavaScript, so an XSS bug cannot exfiltrate a session.
 */
export function setSessionCookie(c: AuthContext, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(c: AuthContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

/**
 * Best available client identity for rate limiting, or `''` when there is none.
 *
 * Behind the HTTPS terminator this deployment needs, the socket address is the
 * proxy's, so the forwarded header comes first; the socket is the fallback for an
 * app exposed directly. The header is spoofable by anyone who can reach the app
 * without going through the proxy, which is why the IP bucket is the loose one and
 * the email bucket carries the real protection.
 *
 * Empty matters: the limiter skips the IP bucket rather than filing every caller
 * under one shared key, because a shared key is a lockout for the whole app.
 */
export function clientIp(c: AuthContext): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded

  const real = c.req.header('x-real-ip')?.trim()
  if (real) return real

  try {
    // Only present when served by @hono/node-server; absent under app.request().
    return getConnInfo(c).remote.address ?? ''
  } catch {
    return ''
  }
}
