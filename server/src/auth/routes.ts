import type { Hono } from 'hono'
import { isValidEmail, MIN_PASSWORD_LENGTH, normalizeEmail, type UserRole } from '@coc/shared'
import { errorBody } from '../http.ts'
import { AUTH_EVENT_PAGE_DEFAULT, AUTH_EVENT_PAGE_MAX } from './events.ts'
import {
  clearSessionCookie,
  clientIp,
  currentUser,
  sessionTokenFromCookie,
  setSessionCookie,
  type AuthContext,
  type AuthEnv,
} from './middleware.ts'
import type { LoginLimiter } from './rate-limit.ts'
import { DISPLAY_NAME_MAX, EmailTakenError, isValidDisplayName, type AuthStore } from './store.ts'
import { generateTemporaryPassword } from './temp-password.ts'

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

/** The `:id` path segment, or `undefined` when it is not a whole number. */
function userIdParam(c: AuthContext): number | undefined {
  const id = Number(c.req.param('id'))
  return Number.isInteger(id) ? id : undefined
}

function badUserId(c: AuthContext) {
  return c.json(errorBody(400, 'badRequest', 'User id must be an integer.'), 400)
}

function noSuchUser(c: AuthContext, id: number) {
  return c.json(errorBody(404, 'notFound', `No user with id ${id}.`), 404)
}

export interface AuthRouteOptions {
  limiter: LoginLimiter
  cookieSecure: boolean
  /** Whether the forwarded headers may be believed — see `clientIp`. */
  trustProxy: boolean
}

export function mountAuthRoutes(
  app: Hono<AuthEnv>,
  store: AuthStore,
  { limiter, cookieSecure, trustProxy }: AuthRouteOptions,
): void {
  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c)
    // Normalized before it reaches the limiter as well as the store, so `A@B.com`
    // and `a@b.com` share one failure bucket instead of getting five tries each.
    const email = normalizeEmail(asString(body['email']))
    const password = asString(body['password'])
    const ip = clientIp(c, trustProxy)
    const keys = { email, ip }

    const verdict = limiter.check(keys)
    if (!verdict.allowed) {
      // Recorded because a run of these is the brake holding, which is a different
      // story from a run of failures and is the one you want to see afterwards.
      store.recordAuthEvent({
        kind: 'loginBlocked',
        email,
        ip,
        detail: `locked for another ${verdict.retryAfterSeconds}s`,
      })
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
    const user = email && password ? await store.authenticate(email, password) : undefined
    if (!user) {
      if (email) limiter.recordFailure(keys)
      /*
       * The trail records the *attempt*, with the address that was tried and
       * nothing else — never the password, and not whether the address exists.
       * Storing which failures were for a real account would turn the log into
       * the account oracle the 401 body goes to such lengths to avoid, for anyone
       * who later gets to read it.
       */
      store.recordAuthEvent({ kind: 'loginFailed', email, ip })
      // A request with no email at all is a malformed client, not an attempt.
      return c.json(errorBody(401, 'invalidCredentials', LOGIN_FAILED), 401)
    }

    limiter.recordSuccess(keys)
    const session = store.createSession(user.id)
    setSessionCookie(c, session.token, cookieSecure)
    store.recordAuthEvent({
      kind: 'loginSucceeded',
      actorUserId: user.id,
      email: user.email,
      ip,
    })

    return c.json({
      user: {
        id: user.id,
        guid: user.guid,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        // The client needs this in the login answer as well as from /me, or the
        // first render after signing in with a temporary password would be the
        // app shell rather than the change-password screen.
        mustChangePassword: user.mustChangePassword,
      },
    })
  })

  // Public and idempotent: signing out with a dead cookie should still clear it
  // rather than answer 401 and leave the browser holding a stale token.
  app.post('/api/auth/logout', (c) => {
    // The raw cookie, not `sessionId`: the id is the token's digest, and
    // `deleteSession` hashes what it is given, so passing the id would look for
    // sha256(sha256(token)) and delete nothing.
    const user = c.get('user')
    store.deleteSession(sessionTokenFromCookie(c))
    clearSessionCookie(c)
    // Only a real session is worth a row. An anonymous POST here is a browser
    // tidying up after itself, not an account action.
    if (user) {
      store.recordAuthEvent({
        kind: 'logout',
        actorUserId: user.id,
        email: user.email,
        ip: clientIp(c, trustProxy),
      })
    }
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
    if (!(await store.verifyUserPassword(user.id, currentPassword))) {
      return c.json(errorBody(401, 'invalidCredentials', 'Current password is incorrect.'), 401)
    }

    // Third argument defaults to false, which is what clears
    // `must_change_password`: this is the account holder choosing a password, so
    // the reason the flag was set no longer holds. It is the only way it clears.
    await store.setPassword(user.id, newPassword)
    // Changing a password is also how you get rid of someone who has your old
    // one, so every other session for this user goes with it.
    const revoked = store.deleteUserSessions(user.id, c.get('sessionId') ?? undefined)
    store.recordAuthEvent({
      kind: 'passwordChanged',
      actorUserId: user.id,
      email: user.email,
      ip: clientIp(c, trustProxy),
      // The count, never the password. A revocation of several is the interesting
      // part of this event: it is what a session hijack looks like from the log.
      detail: `${revoked} other session(s) revoked`,
    })
    return c.json({ ok: true, revokedSessions: revoked })
  })

  app.get('/api/admin/users', (c) => c.json({ users: store.listUsers() }))

  /*
   * The trail, read-only, newest first. There is no route that writes it from
   * outside and none that edits or deletes it — see `events.ts` for why an audit
   * log an admin can amend answers a much weaker question than one they cannot.
   *
   * Capped rather than complete: `limit` is clamped and a `before` cursor walks
   * backwards, because a table that grows with every login attempt must not be
   * returnable in one response. The cap is the server's, not a suggestion to the
   * client — an absent or nonsense `limit` gets the default, and an enormous one
   * gets the maximum.
   */
  app.get('/api/admin/auth-events', (c) => {
    const events = store.authEvents()
    const requested = Number(c.req.query('limit'))
    const limit = Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), AUTH_EVENT_PAGE_MAX)
      : AUTH_EVENT_PAGE_DEFAULT

    const cursor = Number(c.req.query('before'))
    const beforeId = Number.isInteger(cursor) && cursor > 0 ? cursor : undefined

    const page = events.list({ limit, beforeId })
    return c.json({
      events: page,
      total: events.count(),
      /*
       * The oldest id on this page, or null when the page came back short — a short
       * page is the end of the table, so offering a cursor would be inviting one
       * more round trip to learn nothing. Derived from the rows rather than from
       * the requested limit, so it stays right if a row is ever filtered out.
       */
      nextBefore: page.length === limit ? (page[page.length - 1]?.id ?? null) : null,
    })
  })

  /*
   * The invite path. The `password` in the body is the one the admin will read out
   * to the new person, and it is *required* — there is no mail delivery, so the
   * admin is the channel and something has to travel down it.
   *
   * It is also, unavoidably, a password somebody else chose. The temp-password route
   * below argues that case at length and then mints its own value to avoid it; this
   * route cannot, because the admin has to be able to say the password out loud.
   * What it can do is make the admin's choice **temporary**, which is what
   * `mustChangePassword` is for: the account is gated to /me, /password and /logout
   * until the person who will actually be using it has picked their own. The gate is
   * `requirePasswordUpToDate`, already mounted in `createApp` — the same one a
   * temporary password goes through, because it is the same problem.
   *
   * Until this, an invited account kept the admin's string for as long as it existed,
   * which meant every account had a second person who knew its password and no
   * moment at which that stopped being true.
   */
  app.post('/api/admin/users', async (c) => {
    const admin = currentUser(c)
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
      const user = await store.createUser({
        email,
        displayName,
        password,
        role,
        mustChangePassword: true,
      })
      store.recordAuthEvent({
        kind: 'userCreated',
        actorUserId: admin.id,
        targetUserId: user.id,
        email: user.email,
        ip: clientIp(c, trustProxy),
        detail: `role ${user.role}, must change password`,
      })
      return c.json({ user }, 201)
    } catch (cause) {
      if (cause instanceof EmailTakenError) {
        return c.json(errorBody(409, 'conflict', cause.message), 409)
      }
      throw cause
    }
  })

  app.post('/api/admin/users/:id/disable', async (c) => {
    const admin = currentUser(c)
    const id = userIdParam(c)
    if (id === undefined) return badUserId(c)

    // `disabled: false` re-enables, so this one route covers both directions.
    const body = await readJson(c)
    const disabled = body['disabled'] !== false

    /*
     * Nobody may empty the set of accounts that can administer this install:
     * there is no route back from zero active admins, only hand-editing SQLite.
     *
     * Stated as "the last active admin" rather than only as "not yourself"
     * because the two are different rules that happen to coincide today. The
     * self-check below cannot be the whole guard — it would stop protecting the
     * install the moment a route existed that could demote an admin's role.
     */
    const target = disabled ? store.findUser(id) : undefined
    if (target && target.role === 'admin' && !target.disabledAt && store.countActiveAdmins() <= 1) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          `"${target.displayName}" is the only active admin, so disabling that account would leave nobody able to manage users.`,
          'Make somebody else an admin first.',
        ),
        400,
      )
    }

    // Still worth its own message: with other admins around, this is a nudge to
    // ask one of them rather than a warning about locking the whole app.
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
    if (!user) return noSuchUser(c, id)
    store.recordAuthEvent({
      kind: disabled ? 'userDisabled' : 'userEnabled',
      actorUserId: admin.id,
      targetUserId: user.id,
      email: user.email,
      ip: clientIp(c, trustProxy),
    })
    return c.json({ user })
  })

  /*
   * Correcting somebody's login address. Until this existed the only way to fix a
   * typo in an email was editing the SQLite file by hand, which had already had
   * to be done twice on the live database.
   */
  app.patch('/api/admin/users/:id/email', async (c) => {
    const admin = currentUser(c)
    const id = userIdParam(c)
    if (id === undefined) return badUserId(c)

    const body = await readJson(c)
    const email = normalizeEmail(asString(body['email']))
    if (!isValidEmail(email)) {
      return c.json(errorBody(400, 'badRequest', EMAIL_PROBLEM), 400)
    }

    const before = store.findUser(id)
    let user
    try {
      user = store.setEmail(id, email)
    } catch (cause) {
      // A collision is the UNIQUE index doing its job, and the column is
      // COLLATE NOCASE, so `A@B.com` conflicts with `a@b.com`. Caught and turned
      // into a 409 rather than escaping as an unhandled 500.
      if (cause instanceof EmailTakenError) {
        return c.json(errorBody(409, 'conflict', cause.message), 409)
      }
      throw cause
    }
    if (!user) return noSuchUser(c, id)

    /*
     * The login identifier is a credential, so changing it revokes the target's
     * sessions — except the caller's own. That exception is what stops an admin
     * fixing their *own* address from signing themselves out half way through the
     * job. It cannot spare anything it should not: when the target is somebody
     * else the caller's session row has a different `user_id`, so it is not in
     * the set being deleted in the first place.
     */
    const revokedSessions = store.deleteUserSessions(id, c.get('sessionId') ?? undefined)
    store.recordAuthEvent({
      kind: 'emailChanged',
      actorUserId: admin.id,
      targetUserId: user.id,
      // The new address, since that is the credential from now on; the old one goes
      // in `detail` so the change is legible without joining two rows together.
      email: user.email,
      ip: clientIp(c, trustProxy),
      detail: `was ${before?.email ?? 'unset'}, ${revokedSessions} session(s) revoked`,
    })
    return c.json({ user, revokedSessions })
  })

  /*
   * Correcting a display name. Purely cosmetic — it is not a credential, so
   * unlike the email route this revokes nothing.
   */
  app.patch('/api/admin/users/:id/display-name', async (c) => {
    const id = userIdParam(c)
    if (id === undefined) return badUserId(c)

    const body = await readJson(c)
    const displayName = asString(body['displayName']).trim()
    if (!isValidDisplayName(displayName)) {
      return c.json(
        errorBody(400, 'badRequest', `Display name must be 1–${DISPLAY_NAME_MAX} characters.`),
        400,
      )
    }

    const user = store.setDisplayName(id, displayName)
    if (!user) return noSuchUser(c, id)
    return c.json({ user })
  })

  /*
   * Promotion and demotion. The last-active-admin guard here is the case the
   * disable route's comment anticipated: without it, demoting the only admin
   * would leave nobody able to manage users, with no route back but hand-editing
   * SQLite.
   */
  app.patch('/api/admin/users/:id/role', async (c) => {
    const admin = currentUser(c)
    const id = userIdParam(c)
    if (id === undefined) return badUserId(c)

    const body = await readJson(c)
    const role: UserRole = asString(body['role']) === 'admin' ? 'admin' : 'user'

    const target = store.findUser(id)
    if (!target) return noSuchUser(c, id)

    const losingAdmin = target.role === 'admin' && role === 'user' && !target.disabledAt
    if (losingAdmin && store.countActiveAdmins() <= 1) {
      return c.json(
        errorBody(
          400,
          'badRequest',
          `"${target.displayName}" is the only active admin, so demoting that account would leave nobody able to manage users.`,
          'Make somebody else an admin first.',
        ),
        400,
      )
    }

    /*
     * Demoting yourself is allowed when another admin exists — it is how you hand
     * the role over — but it is one-way from your side, so it is worth being an
     * explicit choice rather than a silent side effect of a dropdown.
     */
    if (losingAdmin && id === admin.id && asString(body['confirm']) !== 'yes') {
      return c.json(
        errorBody(
          400,
          'badRequest',
          'Removing your own admin role means you cannot restore it yourself.',
          'Re-send with confirm: "yes" if that is what you intend.',
        ),
        400,
      )
    }

    const user = store.setRole(id, role)
    if (!user) return noSuchUser(c, id)
    store.recordAuthEvent({
      kind: 'roleChanged',
      actorUserId: admin.id,
      targetUserId: user.id,
      email: user.email,
      ip: clientIp(c, trustProxy),
      detail: `${target.role} → ${user.role}`,
    })
    return c.json({ user })
  })

  /*
   * The whole password-recovery story, given there is no mail infrastructure: an
   * admin issues a temporary password out of band. See `docs/authentication.md` —
   * "Password recovery is admin-mediated, and there is deliberately no email reset"
   * — for why a reset-by-email link is absent. (That lived in the README until it
   * was split into `docs/`.)
   */
  app.post('/api/admin/users/:id/temp-password', async (c) => {
    const admin = currentUser(c)
    const id = userIdParam(c)
    if (id === undefined) return badUserId(c)

    /*
     * The body is ignored on purpose — the server picks the password and neither
     * the client nor the admin gets a say. An admin-chosen string would be
     * human-memorable by construction, and it would exist in whatever they typed
     * it into; a client-supplied one would also mean this route could set a known
     * password on any account, which is a far worse primitive than it looks.
     */
    const password = generateTemporaryPassword()
    const user = await store.setPassword(id, password, true)
    if (!user) return noSuchUser(c, id)

    /*
     * Every session of the target goes, or the old password would keep one alive
     * and the forced change would never be reached. The caller's own is spared
     * for the self-issue case: without that, an admin resetting themselves would
     * be signed out by the very response carrying the password, and it is shown
     * exactly once. The spared session is not a way around the change — it is
     * gated to /me, /password and /logout like any other flagged session.
     */
    const revokedSessions = store.deleteUserSessions(id, c.get('sessionId') ?? undefined)

    /*
     * That an issue *happened* is exactly what an audit trail is for — it is how a
     * password reset somebody did not ask for gets noticed. What was issued is not:
     * `password` never reaches this row, and the trail has no column that could
     * hold it even by accident.
     */
    store.recordAuthEvent({
      kind: 'tempPasswordIssued',
      actorUserId: admin.id,
      targetUserId: user.id,
      email: user.email,
      ip: clientIp(c, trustProxy),
      detail: `${revokedSessions} session(s) revoked`,
    })

    // Returned once, in this body, and nowhere else. Never logged, never stored
    // in plaintext, never in a URL — the URL has no room for it and a log line
    // would outlive the one-time channel this is supposed to be.
    return c.json({ user, password, revokedSessions })
  })
}
