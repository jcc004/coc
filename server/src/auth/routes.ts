import type { Hono } from 'hono'
import { isValidEmail, MIN_PASSWORD_LENGTH, normalizeEmail, type UserRole } from '@coc/shared'
import { errorBody } from '../http.ts'
import {
  clearSessionCookie,
  clientIp,
  currentUser,
  setSessionCookie,
  type AuthContext,
  type AuthEnv,
} from './middleware.ts'
import type { LoginLimiter } from './rate-limit.ts'
import { DISPLAY_NAME_MAX, EmailTakenError, isValidDisplayName, type AuthStore } from './store.ts'

/**
 * `/api/auth/*` and `/api/admin/*`.
 *
 * The gates live in `createApp`: `/api/*` is deny-by-default, with login and
 * logout named as the only public exceptions, and `/api/admin/*` additionally
 * requires the admin role. So nothing below re-checks authentication.
 */

/** One message for every way a login can fail. See the login handler. */
const LOGIN_FAILED = 'Email or password is incorrect.'

const EMAIL_PROBLEM = 'Enter an email address — one @, no spaces.'

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

function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return undefined
}

export interface AuthRouteOptions {
  limiter: LoginLimiter
  cookieSecure: boolean
}

export function mountAuthRoutes(
  app: Hono<AuthEnv>,
  store: AuthStore,
  { limiter, cookieSecure }: AuthRouteOptions,
): void {
  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c)
    // Normalised before it reaches the limiter as well as the store, so `A@B.com`
    // and `a@b.com` share one failure bucket instead of getting five tries each.
    const email = normalizeEmail(asString(body['email']))
    const password = asString(body['password'])
    const keys = { email, ip: clientIp(c) }

    const verdict = limiter.check(keys)
    if (!verdict.allowed) {
      c.header('Retry-After', String(verdict.retryAfterSeconds))
      return c.json(
        errorBody(
          429,
          'tooManyAttempts',
          'Too many failed sign-in attempts. Try again later.',
          `Locked for another ${verdict.retryAfterSeconds}s.`,
        ),
        429,
      )
    }

    /*
     * Every failure answers 401 with the same body: unknown address, wrong
     * password, disabled account, and an account whose email is null are all
     * indistinguishable from outside. The equal-work half of that promise lives in
     * `store.authenticate`, which hashes against a decoy when there is no match.
     */
    const user = email && password ? store.authenticate(email, password) : undefined
    if (!user) {
      if (email) limiter.recordFailure(keys)
      // A request with no email at all is a malformed client, not an attempt.
      return c.json(errorBody(401, 'invalidCredentials', LOGIN_FAILED), 401)
    }

    limiter.recordSuccess(keys)
    const session = store.createSession(user.id)
    setSessionCookie(c, session.id, cookieSecure)

    return c.json({
      user: {
        id: user.id,
        guid: user.guid,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
    })
  })

  // Public and idempotent: signing out with a dead cookie should still clear it
  // rather than answer 401 and leave the browser holding a stale token.
  app.post('/api/auth/logout', (c) => {
    const sessionId = c.get('sessionId')
    if (sessionId) store.deleteSession(sessionId)
    clearSessionCookie(c)
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', (c) => c.json({ user: currentUser(c) }))

  app.post('/api/auth/password', async (c) => {
    const user = currentUser(c)
    const body = await readJson(c)
    const currentPassword = asString(body['currentPassword'])
    const newPassword = asString(body['newPassword'])

    const problem = passwordProblem(newPassword)
    if (problem) return c.json(errorBody(400, 'badRequest', problem), 400)
    if (newPassword === currentPassword) {
      return c.json(errorBody(400, 'badRequest', 'The new password matches the old one.'), 400)
    }

    // Re-authenticating here is what stops a hijacked session from locking the
    // real owner out of their own account. By id rather than by email, because the
    // session already establishes who is asking — and because an account whose
    // email is null is still entitled to change its own password.
    if (!store.verifyUserPassword(user.id, currentPassword)) {
      return c.json(errorBody(401, 'invalidCredentials', 'Current password is incorrect.'), 401)
    }

    store.setPassword(user.id, newPassword)
    // Changing a password is also how you get rid of someone who has your old
    // one, so every other session for this user goes with it.
    const revoked = store.deleteUserSessions(user.id, c.get('sessionId') ?? undefined)
    return c.json({ ok: true, revokedSessions: revoked })
  })

  app.get('/api/admin/users', (c) => c.json({ users: store.listUsers() }))

  app.post('/api/admin/users', async (c) => {
    const body = await readJson(c)
    const email = normalizeEmail(asString(body['email']))
    const password = asString(body['password'])
    const role: UserRole = body['role'] === 'admin' ? 'admin' : 'user'
    // A blank display name is not an error: the local part of the address is a
    // better default than making an admin invent a label at invite time.
    const displayName = asString(body['displayName']).trim() || email.split('@')[0] || ''

    if (!isValidEmail(email)) {
      return c.json(errorBody(400, 'badRequest', EMAIL_PROBLEM), 400)
    }

    if (!isValidDisplayName(displayName)) {
      return c.json(
        errorBody(400, 'badRequest', `Display name must be 1–${DISPLAY_NAME_MAX} characters.`),
        400,
      )
    }

    const problem = passwordProblem(password)
    if (problem) return c.json(errorBody(400, 'badRequest', problem), 400)

    try {
      return c.json({ user: store.createUser({ email, displayName, password, role }) }, 201)
    } catch (cause) {
      if (cause instanceof EmailTakenError) {
        return c.json(errorBody(409, 'conflict', cause.message), 409)
      }
      throw cause
    }
  })

  app.post('/api/admin/users/:id/disable', async (c) => {
    const admin = currentUser(c)
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) {
      return c.json(errorBody(400, 'badRequest', 'User id must be an integer.'), 400)
    }

    // `disabled: false` re-enables, so this one route covers both directions.
    const body = await readJson(c)
    const disabled = body['disabled'] !== false

    // The only admin disabling themselves would leave nobody who can undo it.
    if (disabled && id === admin.id) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          'You cannot disable your own account.',
          'Ask another admin to do it.',
        ),
        400,
      )
    }

    const user = store.setDisabled(id, disabled)
    if (!user) return c.json(errorBody(404, 'notFound', `No user with id ${id}.`), 404)
    return c.json({ user })
  })
}
