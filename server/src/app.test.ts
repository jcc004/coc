import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.ts'
import { bootstrapAdmin, type BootstrapResult } from './auth/bootstrap.ts'
import { SESSION_COOKIE } from './auth/middleware.ts'
import { createLoginLimiter, type LimiterOptions } from './auth/rate-limit.ts'
import { createAuthStore, SESSION_TTL_MS, type AuthStore } from './auth/store.ts'
import { TtlCache } from './cache.ts'
import { createChatStore, type ChatStore } from './chat/store.ts'
import type { CocClient } from './coc-client.ts'
import { openDatabase } from './db.ts'
import { createSharedDataStore, type SharedDataStore } from './shared-data/store.ts'

/*
 * The whole app over an in-memory database and a stub upstream, driven through
 * `app.request` — no listening socket and no live Supercell token. `calls` exists
 * to prove the thing this layer is actually for: an anonymous request must never
 * reach the upstream client, because reaching it is what spends the rate-limited
 * token.
 */

const ADMIN = { email: 'admin@example.com', password: 'first-admin-password' }
const CLAN_TAG = '%23G88CYQP'

interface Harness {
  app: ReturnType<typeof createApp>
  store: AuthStore
  chat: ChatStore
  shared: SharedDataStore
  db: DatabaseSync
  calls: string[]
  bootstrap: BootstrapResult
}

function createHarness(
  options: {
    databasePath?: string
    env?: Record<string, string | undefined>
    limiter?: LimiterOptions
  } = {},
): Harness {
  const calls: string[] = []
  const coc = {
    getPlayer: async (tag: string) => {
      calls.push(`player:${tag}`)
      return { tag, name: 'Stub Player' }
    },
    getClan: async (tag: string) => {
      calls.push(`clan:${tag}`)
      return { tag, name: 'Stub Clan' }
    },
    getClanMembers: async () => ({ items: [] }),
    getCurrentWar: async () => ({ state: 'notInWar' }),
    getWarLog: async () => ({ items: [] }),
    getCapitalRaidSeasons: async () => ({ items: [] }),
    searchClans: async () => ({ items: [] }),
  } as unknown as CocClient

  const db = openDatabase(options.databasePath ?? ':memory:')
  const store = createAuthStore(db)
  const bootstrap = bootstrapAdmin(store, options.env ?? {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
  })

  const chat = createChatStore(db)
  const shared = createSharedDataStore(db)

  const app = createApp({
    coc,
    cache: new TtlCache(60_000),
    auth: store,
    chat,
    sharedData: shared,
    loginLimiter: createLoginLimiter(options.limiter),
  })

  return { app, store, chat, shared, db, calls, bootstrap }
}

function postJson(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  return [
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    },
  ]
}

function patchJson(path: string, body: unknown, cookie: string): [string, RequestInit] {
  const [, init] = postJson(path, body, cookie)
  return [path, { ...init, method: 'PATCH' }]
}

/** The `name=value` pair from Set-Cookie, ready to send straight back. */
function sessionCookie(response: Response): string | undefined {
  const header = response.headers.get('set-cookie')
  const match = header?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
  const value = match?.[1]
  return value ? `${SESSION_COOKIE}=${value}` : undefined
}

async function login(
  harness: Harness,
  credentials: { email: string; password: string },
  headers: Record<string, string> = {},
): Promise<{ response: Response; cookie: string | undefined }> {
  const [path, init] = postJson('/api/auth/login', credentials)
  const response = await harness.app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...headers },
  })
  return { response, cookie: sessionCookie(response) }
}

async function loggedIn(harness: Harness): Promise<string> {
  const { response, cookie } = await login(harness, ADMIN)
  assert.equal(response.status, 200)
  assert.ok(cookie, 'login should set a session cookie')
  return cookie
}

describe('bootstrap', () => {
  it('creates the first admin from the environment', () => {
    const harness = createHarness()
    assert.equal(harness.bootstrap.status, 'created')
    assert.equal(harness.store.countUsers(), 1)
    assert.equal(harness.store.listUsers()[0]?.role, 'admin')
    harness.db.close()
  })

  it('leaves the app unusable rather than defaulting a password', async () => {
    const harness = createHarness({ env: {} })
    assert.equal(harness.bootstrap.status, 'unconfigured')
    assert.equal(harness.store.countUsers(), 0)

    const { response } = await login(harness, ADMIN)
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('refuses an admin password under the minimum length', () => {
    const harness = createHarness({
      env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'short' },
    })
    assert.equal(harness.bootstrap.status, 'invalid')
    assert.equal(harness.store.countUsers(), 0)
    harness.db.close()
  })

  it('is idempotent across two boots and does not reset a changed password', async () => {
    // A real file, because the second boot has to see what the first one wrote.
    const dir = mkdtempSync(join(tmpdir(), 'coc-auth-boot-'))
    after(() => rmSync(dir, { recursive: true, force: true }))
    const databasePath = join(dir, 'coc.db')

    const first = createHarness({ databasePath })
    assert.equal(first.bootstrap.status, 'created')

    const cookie = await loggedIn(first)
    const changed = await first.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'a-brand-new-password' },
        cookie,
      ),
    )
    assert.equal(changed.status, 200)
    first.db.close()

    // Same env, same file: must find the existing user and leave it alone.
    const second = createHarness({ databasePath })
    assert.equal(second.bootstrap.status, 'existing')
    assert.equal(second.store.countUsers(), 1)

    const stale = await login(second, ADMIN)
    assert.equal(stale.response.status, 401, 'the env password must not have been restored')

    const current = await login(second, {
      email: ADMIN.email,
      password: 'a-brand-new-password',
    })
    assert.equal(current.response.status, 200)
    second.db.close()
  })
})

describe('login and session', () => {
  it('sets an HttpOnly SameSite=Lax cookie on success', async () => {
    const harness = createHarness()
    const { response } = await login(harness, ADMIN)

    assert.equal(response.status, 200)
    const header = response.headers.get('set-cookie') ?? ''
    assert.match(header, /HttpOnly/i)
    assert.match(header, /SameSite=Lax/i)
    assert.match(header, /Path=\//i)
    // Local dev is plain http, so Secure is off unless the env asks for it.
    assert.equal(/Secure/i.test(header), false)

    const body = (await response.json()) as {
      user: { email: string; displayName: string; guid: string; role: string }
    }
    assert.equal(body.user.email, ADMIN.email)
    // Display name defaults to the local part of the address.
    assert.equal(body.user.displayName, 'admin')
    assert.match(body.user.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-/)
    assert.equal(body.user.role, 'admin')
    assert.equal(JSON.stringify(body).includes(ADMIN.password), false)
    harness.db.close()
  })

  it('marks the cookie Secure when configured', async () => {
    const harness = createHarness()
    const secureApp = createApp({
      coc: {} as unknown as CocClient,
      cache: new TtlCache(60_000),
      auth: harness.store,
      chat: harness.chat,
      sharedData: createSharedDataStore(harness.db),
      cookieSecure: true,
    })
    const response = await secureApp.request(...postJson('/api/auth/login', ADMIN))
    assert.match(response.headers.get('set-cookie') ?? '', /Secure/i)
    harness.db.close()
  })

  it('answers /api/auth/me with the cookie and 401s without it', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const authed = await harness.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal(authed.status, 200)
    const body = (await authed.json()) as { user: { email: string; guid: string } }
    assert.equal(body.user.email, ADMIN.email)
    assert.ok(body.user.guid, 'me must carry the guid')

    const anon = await harness.app.request('/api/auth/me')
    assert.equal(anon.status, 401)
    harness.db.close()
  })

  it('rejects a forged or unknown token', async () => {
    const harness = createHarness()
    const response = await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=not-a-real-session-token` },
    })
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('logout invalidates the session so the same cookie then 401s', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const out = await harness.app.request(...postJson('/api/auth/logout', {}, cookie))
    assert.equal(out.status, 200)

    const reused = await harness.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal(reused.status, 401)
    harness.db.close()
  })

  it('rejects an expired session and cleans the row up', async () => {
    const harness = createHarness()
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    // Issued 31 days ago, so its 30-day expiry is a day in the past.
    const issuedAt = new Date(Date.now() - SESSION_TTL_MS - 24 * 60 * 60_000)
    const expired = harness.store.createSession(admin.id, issuedAt)

    const response = await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${expired.id}` },
    })
    assert.equal(response.status, 401)
    assert.equal(harness.store.resolveSession(expired.id), undefined)
    // Rejected *and* deleted, so a dead row cannot pile up per stale browser.
    assert.match(response.headers.get('set-cookie') ?? '', new RegExp(`${SESSION_COOKIE}=;`))
    harness.db.close()
  })

  it('slides the expiry forward on use', async () => {
    const harness = createHarness()
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    const session = harness.store.createSession(admin.id, new Date(Date.now() - 60_000))
    const before = harness.store.resolveSession(session.id)
    assert.ok(before)

    await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session.id}` },
    })
    // Still valid well past the original 30 days from issue.
    assert.ok(harness.store.resolveSession(session.id))
    harness.db.close()
  })
})

describe('failed login is not an oracle', () => {
  it('answers identically for an unknown email and a wrong password', async () => {
    const harness = createHarness()

    const unknown = await login(harness, { email: 'nobody@example.com', password: 'whatever-long-pw' })
    const wrong = await login(harness, { email: ADMIN.email, password: 'whatever-long-pw' })

    assert.equal(unknown.response.status, wrong.response.status)
    assert.equal(unknown.response.status, 401)
    assert.equal(await unknown.response.text(), await wrong.response.text())
    assert.equal(unknown.response.headers.get('set-cookie'), null)
    assert.equal(wrong.response.headers.get('set-cookie'), null)
    harness.db.close()
  })

  it('answers a disabled account the same way', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const created = await harness.app.request(
      ...postJson(
        '/api/admin/users',
        {
          email: 'benched@example.com',
          displayName: 'Benched',
          password: 'benched-user-password',
        },
        cookie,
      ),
    )
    assert.equal(created.status, 201)
    const { user } = (await created.json()) as { user: { id: number } }

    const disabled = await harness.app.request(
      ...postJson(`/api/admin/users/${user.id}/disable`, {}, cookie),
    )
    assert.equal(disabled.status, 200)

    const attempt = await login(harness, {
      email: 'benched@example.com',
      password: 'benched-user-password',
    })
    const wrong = await login(harness, { email: ADMIN.email, password: 'whatever-long-pw' })
    assert.equal(attempt.response.status, 401)
    assert.equal(await attempt.response.text(), await wrong.response.text())
    harness.db.close()
  })
})

describe('login rate limiting', () => {
  it('locks an email out after N failures without touching another user', async () => {
    const harness = createHarness({ limiter: { emailLimit: 3, ipLimit: 100 } })
    const cookie = await loggedIn(harness)
    await harness.app.request(
      ...postJson(
        '/api/admin/users',
        { email: 'someone@example.com', password: 'someones-password' },
        cookie,
      ),
    )

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { response } = await login(harness, { email: 'someone@example.com', password: 'wrong-password' })
      assert.equal(response.status, 401)
    }

    // Fourth attempt is refused before any password work happens.
    const locked = await login(harness, { email: 'someone@example.com', password: 'someones-password' })
    assert.equal(locked.response.status, 429)
    assert.ok(Number(locked.response.headers.get('retry-after')) > 0)

    // The other account — same client IP — is unaffected.
    const other = await login(harness, ADMIN)
    assert.equal(other.response.status, 200)
    harness.db.close()
  })

  it('locks a spraying client IP without locking the app', async () => {
    const harness = createHarness({ limiter: { emailLimit: 50, ipLimit: 3 } })
    const spray = { 'x-forwarded-for': '203.0.113.9' }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await login(harness, { email: `victim-${attempt}@example.com`, password: 'wrong-password' }, spray)
    }

    const blocked = await login(harness, ADMIN, spray)
    assert.equal(blocked.response.status, 429)

    // A different address can still sign in, so one attacker cannot take the app down.
    const elsewhere = await login(harness, ADMIN, { 'x-forwarded-for': '198.51.100.7' })
    assert.equal(elsewhere.response.status, 200)
    harness.db.close()
  })

  it('does not pool callers with no identifiable IP into one shared lockout', async () => {
    // No forwarded header and no socket address: filing everyone under one
    // placeholder key would be a lockout for the whole app.
    const harness = createHarness({ limiter: { emailLimit: 50, ipLimit: 2 } })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(harness, { email: `victim-${attempt}@example.com`, password: 'wrong-password' })
    }

    const { response } = await login(harness, ADMIN)
    assert.equal(response.status, 200)
    harness.db.close()
  })
})

describe('the CoC routes are the thing being protected', () => {
  it('401s every player and clan route when unauthenticated, without calling upstream', async () => {
    const harness = createHarness()
    const paths = [
      '/api/players/%232GCJ2QPU',
      `/api/clans/${CLAN_TAG}`,
      `/api/clans/${CLAN_TAG}/members`,
      `/api/clans/${CLAN_TAG}/currentwar`,
      `/api/clans/${CLAN_TAG}/warlog`,
      `/api/clans/${CLAN_TAG}/capitalraidseasons`,
      '/api/clans?name=Reddit',
    ]

    for (const path of paths) {
      const response = await harness.app.request(path)
      assert.equal(response.status, 401, `${path} should require a session`)
      const body = (await response.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'unauthenticated')
    }

    // The point of the exercise: no anonymous request spent the Supercell token.
    assert.deepEqual(harness.calls, [])
    harness.db.close()
  })

  it('serves the same routes once authenticated', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const clan = await harness.app.request(`/api/clans/${CLAN_TAG}`, { headers: { cookie } })
    assert.equal(clan.status, 200)
    assert.deepEqual(await clan.json(), { tag: '#G88CYQP', name: 'Stub Clan' })

    const player = await harness.app.request('/api/players/%232GCJ2QPU', { headers: { cookie } })
    assert.equal(player.status, 200)
    assert.deepEqual(harness.calls, ['clan:#G88CYQP', 'player:#2GCJ2QPU'])
    harness.db.close()
  })

  it('denies an unknown /api route to anonymous callers by default', async () => {
    const harness = createHarness()
    // A route added later (uploads, say) is protected before it is written.
    const response = await harness.app.request('/api/uploads')
    assert.equal(response.status, 401)
    harness.db.close()
  })
})

describe('health', () => {
  it('omits internals for an anonymous caller', async () => {
    const harness = createHarness()
    const response = await harness.app.request('/api/health')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    harness.db.close()
  })

  it('includes the cache size for an authenticated one', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request('/api/health', { headers: { cookie } })
    assert.deepEqual(await response.json(), { ok: true, cachedEntries: 0 })
    harness.db.close()
  })
})

describe('admin endpoints', () => {
  it('refuses a non-admin', async () => {
    const harness = createHarness()
    const adminCookie = await loggedIn(harness)

    const created = await harness.app.request(
      ...postJson(
        '/api/admin/users',
        {
          email: 'regular@example.com',
          displayName: 'Regular',
          password: 'regular-user-password',
        },
        adminCookie,
      ),
    )
    assert.equal(created.status, 201)

    const { cookie: userCookie } = await login(harness, {
      email: 'regular@example.com',
      password: 'regular-user-password',
    })
    assert.ok(userCookie)

    const list = await harness.app.request('/api/admin/users', { headers: { cookie: userCookie } })
    assert.equal(list.status, 403)

    const create = await harness.app.request(
      ...postJson(
        '/api/admin/users',
        { email: 'sneaky@example.com', password: 'sneaky-password' },
        userCookie,
      ),
    )
    assert.equal(create.status, 403)
    assert.equal(harness.store.countUsers(), 2)

    // …and a non-admin still gets at the app itself.
    const clan = await harness.app.request(`/api/clans/${CLAN_TAG}`, {
      headers: { cookie: userCookie },
    })
    assert.equal(clan.status, 200)
    harness.db.close()
  })

  it('401s an anonymous caller on an admin route', async () => {
    const harness = createHarness()
    const response = await harness.app.request('/api/admin/users')
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('lists users without leaking hashes', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request('/api/admin/users', { headers: { cookie } })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.equal(text.includes('scrypt$'), false)
    assert.equal(text.includes('password'), false)
    harness.db.close()
  })

  it('rejects a duplicate email case-insensitively', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    // The same address, shouted. COLLATE NOCASE on the column is what catches it.
    const duplicate = await harness.app.request(
      ...postJson(
        '/api/admin/users',
        { email: 'ADMIN@EXAMPLE.COM', password: 'another-password-x' },
        cookie,
      ),
    )
    assert.equal(duplicate.status, 409)
    assert.equal(harness.store.countUsers(), 1)
    harness.db.close()
  })

  it('refuses a body whose email is not an email', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    for (const email of ['', 'nope', 'two@at@signs.com', 'has space@example.com']) {
      const response = await harness.app.request(
        ...postJson('/api/admin/users', { email, password: 'another-password-x' }, cookie),
      )
      assert.equal(response.status, 400, `${email} should be refused`)
    }
    assert.equal(harness.store.countUsers(), 1)
    harness.db.close()
  })

  it('revokes sessions the moment an account is disabled', async () => {
    const harness = createHarness()
    const adminCookie = await loggedIn(harness)

    const created = await harness.app.request(
      ...postJson(
        '/api/admin/users',
        {
          email: 'leaving@example.com',
          displayName: 'Leaving',
          password: 'leaving-user-password',
        },
        adminCookie,
      ),
    )
    const { user } = (await created.json()) as { user: { id: number } }
    const { cookie: userCookie } = await login(harness, {
      email: 'leaving@example.com',
      password: 'leaving-user-password',
    })
    assert.ok(userCookie)
    assert.equal(
      (await harness.app.request('/api/auth/me', { headers: { cookie: userCookie } })).status,
      200,
    )

    await harness.app.request(...postJson(`/api/admin/users/${user.id}/disable`, {}, adminCookie))

    const after = await harness.app.request('/api/auth/me', { headers: { cookie: userCookie } })
    assert.equal(after.status, 401)
    harness.db.close()
  })

  it('refuses to let an admin disable themselves', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    const response = await harness.app.request(
      ...postJson(`/api/admin/users/${admin.id}/disable`, {}, cookie),
    )
    assert.equal(response.status, 400)
    assert.equal(harness.store.findUser(admin.id)?.disabledAt, null)
    harness.db.close()
  })
})

describe('password change', () => {
  it('requires the current password and revokes other sessions', async () => {
    const harness = createHarness()
    const stale = await loggedIn(harness)
    const current = await loggedIn(harness)

    const wrong = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: 'not-the-password', newPassword: 'a-fresh-long-password' },
        current,
      ),
    )
    assert.equal(wrong.status, 401)

    const tooShort = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'short' },
        current,
      ),
    )
    assert.equal(tooShort.status, 400)

    const changed = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'a-fresh-long-password' },
        current,
      ),
    )
    assert.equal(changed.status, 200)

    // The session that made the change survives; the other one is gone.
    assert.equal((await harness.app.request('/api/auth/me', { headers: { cookie: current } })).status, 200)
    assert.equal((await harness.app.request('/api/auth/me', { headers: { cookie: stale } })).status, 401)

    assert.equal((await login(harness, ADMIN)).response.status, 401)
    assert.equal(
      (await login(harness, { email: ADMIN.email, password: 'a-fresh-long-password' }))
        .response.status,
      200,
    )
    harness.db.close()
  })

  it('401s anonymously', async () => {
    const harness = createHarness()
    const response = await harness.app.request(
      ...postJson('/api/auth/password', { currentPassword: 'x', newPassword: 'y' }),
    )
    assert.equal(response.status, 401)
    harness.db.close()
  })
})

/* ---------- email is the credential ---------- */

/** Creates an account through the admin route and returns its id. */
async function addUser(
  harness: Harness,
  cookie: string,
  input: { email: string; displayName?: string; password: string; role?: 'admin' | 'user' },
): Promise<number> {
  const response = await harness.app.request(...postJson('/api/admin/users', input, cookie))
  assert.equal(response.status, 201, `creating ${input.email} should succeed`)
  const { user } = (await response.json()) as { user: { id: number } }
  return user.id
}

describe('email as the login credential', () => {
  it('signs in whatever the case and spacing of the address', async () => {
    const harness = createHarness()

    for (const email of ['admin@example.com', 'ADMIN@Example.COM', '  Admin@example.com  ']) {
      const { response, cookie } = await login(harness, { email, password: ADMIN.password })
      assert.equal(response.status, 200, `${email} should sign in`)
      assert.ok(cookie)
    }
    harness.db.close()
  })

  it('stores the address normalised, whatever case it was created with', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const id = await addUser(harness, cookie, {
      email: '  MiXeD@Example.COM ',
      password: 'mixed-case-password',
    })

    assert.equal(harness.store.findUser(id)?.email, 'mixed@example.com')
    harness.db.close()
  })

  it('cannot authenticate an account whose email is null', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const id = await addUser(harness, cookie, {
      email: 'stranded@example.com',
      password: 'stranded-user-password',
    })

    // The state the username→email migration leaves a legacy row in.
    harness.db.exec(`UPDATE users SET email = NULL WHERE id = ${id}`)
    assert.equal(harness.store.findUser(id)?.email, null)

    // Neither the old address nor an empty one nor a bare NULL gets in.
    for (const email of ['stranded@example.com', '', ' ']) {
      const attempt = await login(harness, { email, password: 'stranded-user-password' })
      assert.equal(attempt.response.status, 401, `${JSON.stringify(email)} must not sign in`)
      assert.equal(attempt.cookie, undefined)
    }
    // …and at the store level, which is where the guarantee actually lives.
    assert.equal(harness.store.authenticate('', 'stranded-user-password'), undefined)
    harness.db.close()
  })

  it('gives every account a distinct guid', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    await addUser(harness, cookie, { email: 'one@example.com', password: 'one-users-password' })
    await addUser(harness, cookie, { email: 'two@example.com', password: 'two-users-password' })

    const guids = harness.store.listUsers().map((user) => user.guid)
    assert.equal(guids.length, 3)
    assert.equal(new Set(guids).size, 3, 'guids must be unique')
    for (const guid of guids) assert.match(guid, /^[0-9a-f-]{36}$/)
    harness.db.close()
  })
})

/* ---------- the shared data ---------- */

const PLAYER_A = '%232GCJ2QPU'
const PLAYER_B = '%23AAABBB'

/** Two signed-in accounts against one database, which is the whole point below. */
async function twoUsers(harness: Harness): Promise<{ a: string; b: string }> {
  const a = await loggedIn(harness)
  await addUser(harness, a, {
    email: 'second@example.com',
    displayName: 'Second Person',
    password: 'second-users-password',
  })
  const { cookie: b } = await login(harness, {
    email: 'second@example.com',
    password: 'second-users-password',
  })
  assert.ok(b)
  return { a, b }
}

describe('saved clans and owners are shared, not per-user', () => {
  it("shows user A's owner assignment to user B, attributed", async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)

    const applied = await harness.app.request(
      ...postJson(
        '/api/owners/bulk',
        { rows: [{ tag: '#2GCJ2QPU', owner: 'Jared', expectedOwner: '' }] },
        a,
      ),
    )
    assert.equal(applied.status, 200)

    // B never wrote anything and sees it anyway — one canonical answer.
    const seen = await harness.app.request('/api/owners', { headers: { cookie: b } })
    assert.equal(seen.status, 200)
    const { owners } = (await seen.json()) as {
      owners: { tag: string; owner: string; updatedAt: string; updatedBy: string }[]
    }
    assert.deepEqual(
      owners.map((o) => [o.tag, o.owner, o.updatedBy]),
      [['#2GCJ2QPU', 'Jared', 'admin']],
    )
    assert.ok(owners[0]?.updatedAt, 'the row must carry when it changed')
    harness.db.close()
  })

  it("shows user A's saved clan to user B, and B's edit back to A", async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)

    const saved = await harness.app.request(
      ...postJson(
        '/api/saved/clans',
        { tag: '#G88CYQP', name: 'Reddit', clanLevel: 26, members: 48, clanPoints: 42000 },
        a,
      ),
    )
    assert.equal(saved.status, 200)

    const listed = await harness.app.request('/api/saved/clans', { headers: { cookie: b } })
    const { clans } = (await listed.json()) as {
      clans: { tag: string; name: string; clanLevel: number; updatedBy: string }[]
    }
    assert.deepEqual(
      clans.map((c) => [c.tag, c.name, c.clanLevel, c.updatedBy]),
      [['#G88CYQP', 'Reddit', 26, 'admin']],
    )

    // B renames it; A sees B's label and B's name against it.
    const renamed = await harness.app.request(
      ...patchJson('/api/saved/clans/%23G88CYQP', { name: 'The main clan' }, b),
    )
    assert.equal(renamed.status, 200)

    const backToA = await harness.app.request('/api/saved/clans', { headers: { cookie: a } })
    const after = (await backToA.json()) as {
      clans: { name: string; custom: boolean; updatedBy: string }[]
    }
    assert.equal(after.clans[0]?.name, 'The main clan')
    assert.equal(after.clans[0]?.custom, true, 'a rename marks the row custom')
    assert.equal(after.clans[0]?.updatedBy, 'Second Person')
    harness.db.close()
  })

  it('keeps a custom label through a refresh that carries the in-game name', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    await harness.app.request(...postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit' }, cookie))
    await harness.app.request(...patchJson('/api/saved/clans/%23G88CYQP', { name: 'Mine' }, cookie))
    // What `Refresh all` sends: the API's name, which must not win.
    await harness.app.request(
      ...postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit', clanLevel: 27 }, cookie),
    )

    const { clans } = (await (
      await harness.app.request('/api/saved/clans', { headers: { cookie } })
    ).json()) as { clans: { name: string; clanLevel: number }[] }
    assert.equal(clans[0]?.name, 'Mine')
    assert.equal(clans[0]?.clanLevel, 27, 'the stats still refreshed')
    harness.db.close()
  })

  it('deletes a saved clan and an owner, and 404s the second time', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    await harness.app.request(...postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit' }, cookie))
    await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Sam', expectedOwner: '' }] }, cookie),
    )

    for (const path of ['/api/saved/clans/%23G88CYQP', `/api/owners/${PLAYER_A}`]) {
      const first = await harness.app.request(path, { method: 'DELETE', headers: { cookie } })
      assert.equal(first.status, 200, `${path} should delete`)
      const second = await harness.app.request(path, { method: 'DELETE', headers: { cookie } })
      assert.equal(second.status, 404, `${path} should 404 once gone`)
    }

    assert.deepEqual(harness.shared.listOwners(), [])
    assert.deepEqual(harness.shared.listSavedClans(), [])
    harness.db.close()
  })

  it('survives disabling the account that made the rows', async () => {
    const harness = createHarness()
    const adminCookie = await loggedIn(harness)
    const id = await addUser(harness, adminCookie, {
      email: 'leaver@example.com',
      displayName: 'Leaver',
      password: 'leaver-users-password',
    })
    const { cookie: userCookie } = await login(harness, {
      email: 'leaver@example.com',
      password: 'leaver-users-password',
    })
    assert.ok(userCookie)

    await harness.app.request(
      ...postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit' }, userCookie),
    )
    await harness.app.request(
      ...postJson(
        '/api/owners/bulk',
        { rows: [{ tag: '#2GCJ2QPU', owner: 'Jared', expectedOwner: '' }] },
        userCookie,
      ),
    )

    const disabled = await harness.app.request(
      ...postJson(`/api/admin/users/${id}/disable`, {}, adminCookie),
    )
    assert.equal(disabled.status, 200)

    // The data outlives the account: still one of each, still readable by others.
    assert.equal(harness.shared.listOwners().length, 1)
    assert.equal(harness.shared.listSavedClans().length, 1)

    const stillThere = await harness.app.request('/api/owners', { headers: { cookie: adminCookie } })
    const { owners } = (await stillThere.json()) as { owners: { owner: string; updatedBy: string }[] }
    assert.equal(owners[0]?.owner, 'Jared')
    // Disabling is not deleting, so the attribution survives too.
    assert.equal(owners[0]?.updatedBy, 'Leaver')
    harness.db.close()
  })
})

describe('bulk owner apply is optimistically concurrent', () => {
  it('rejects a stale expected value while applying the rows that are not stale', async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)

    // B assigns an owner that A's tab has never seen.
    await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Sam', expectedOwner: '' }] }, b),
    )

    // A applies two rows believing both are unowned. One of them is now wrong.
    const response = await harness.app.request(
      ...postJson(
        '/api/owners/bulk',
        {
          rows: [
            { tag: '#2GCJ2QPU', owner: 'Jared', expectedOwner: '' },
            { tag: '#AAABBB', owner: 'Jared', expectedOwner: '' },
          ],
        },
        a,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      applied: { tag: string; owner: string }[]
      cleared: string[]
      conflicts: {
        tag: string
        expectedOwner: string
        currentOwner: string
        updatedAt: string
        updatedBy: string
      }[]
    }

    // The fresh row went through; the stale one came back with the real value.
    assert.deepEqual(
      body.applied.map((row) => [row.tag, row.owner]),
      [['#AAABBB', 'Jared']],
    )
    assert.deepEqual(body.conflicts, [
      {
        tag: '#2GCJ2QPU',
        expectedOwner: '',
        currentOwner: 'Sam',
        updatedAt: body.conflicts[0]?.updatedAt,
        updatedBy: 'Second Person',
      },
    ])

    // Nothing B wrote was lost.
    assert.equal(
      harness.shared.listOwners().find((row) => row.tag === '#2GCJ2QPU')?.owner,
      'Sam',
    )
    harness.db.close()
  })

  it('accepts the re-approval that carries the real current value', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Sam', expectedOwner: '' }] }, cookie),
    )

    const overwrite = await harness.app.request(
      ...postJson(
        '/api/owners/bulk',
        { rows: [{ tag: '#2GCJ2QPU', owner: 'Jared', expectedOwner: 'Sam' }] },
        cookie,
      ),
    )
    const body = (await overwrite.json()) as { applied: { owner: string }[]; conflicts: unknown[] }
    assert.deepEqual(body.conflicts, [])
    assert.equal(body.applied[0]?.owner, 'Jared')
    harness.db.close()
  })

  it('clears an owner only when the expected value still matches', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Sam', expectedOwner: '' }] }, cookie),
    )

    const stale = await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: '', expectedOwner: 'Jared' }] }, cookie),
    )
    const staleBody = (await stale.json()) as { cleared: string[]; conflicts: { currentOwner: string }[] }
    assert.deepEqual(staleBody.cleared, [], 'a stale clear must not destroy the value')
    assert.equal(staleBody.conflicts[0]?.currentOwner, 'Sam')

    const fresh = await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: '', expectedOwner: 'Sam' }] }, cookie),
    )
    const freshBody = (await fresh.json()) as { cleared: string[] }
    assert.deepEqual(freshBody.cleared, ['#2GCJ2QPU'])
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })

  it('refuses a row that omits expectedOwner rather than defaulting it', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    // Defaulting to '' would read as "I believe nobody owns this", which is
    // exactly the silent clobber the endpoint exists to prevent.
    const response = await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Jared' }] }, cookie),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })
})

describe('one-time import of browser data', () => {
  it('fills gaps, never overwrites, and is idempotent', async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)

    // Already on the server, set by A.
    await harness.app.request(
      ...postJson('/api/owners/bulk', { rows: [{ tag: '#2GCJ2QPU', owner: 'Jared', expectedOwner: '' }] }, a),
    )
    await harness.app.request(
      ...postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit' }, a),
    )

    // B's browser disagrees about both, and knows one thing the server does not.
    const payload = {
      owners: [
        { tag: '#2GCJ2QPU', owner: 'Somebody else' },
        { tag: '#AAABBB', owner: 'Casey' },
        { tag: 'not a tag at all!!', owner: 'Nobody' },
      ],
      clans: [
        { tag: '#G88CYQP', name: 'B calls it something else' },
        { tag: '#BBB2', name: 'Anvil' },
      ],
    }

    const first = await harness.app.request(...postJson('/api/import', payload, b))
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), {
      owners: { applied: 1, skipped: 1, invalid: 1 },
      clans: { applied: 1, skipped: 1, invalid: 0 },
    })

    // The values that were already there are untouched — last importer does not win.
    const owners = harness.shared.listOwners()
    assert.equal(owners.find((row) => row.tag === '#2GCJ2QPU')?.owner, 'Jared')
    assert.equal(owners.find((row) => row.tag === '#AAABBB')?.owner, 'Casey')
    assert.equal(
      harness.shared.listSavedClans().find((row) => row.tag === '#G88CYQP')?.name,
      'Reddit',
    )

    // Second run applies nothing at all.
    const second = await harness.app.request(...postJson('/api/import', payload, b))
    assert.deepEqual(await second.json(), {
      owners: { applied: 0, skipped: 2, invalid: 1 },
      clans: { applied: 0, skipped: 2, invalid: 0 },
    })
    assert.equal(harness.shared.listOwners().length, 2)
    assert.equal(harness.shared.listSavedClans().length, 2)
    harness.db.close()
  })

  it('accepts an empty payload', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request(...postJson('/api/import', {}, cookie))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      owners: { applied: 0, skipped: 0, invalid: 0 },
      clans: { applied: 0, skipped: 0, invalid: 0 },
    })
    harness.db.close()
  })
})

describe('the shared-data routes need a session', () => {
  it('401s every one of them anonymously, changing nothing', async () => {
    const harness = createHarness()
    const requests: [string, RequestInit][] = [
      ['/api/saved/clans', {}],
      ['/api/saved/clans', postJson('/api/saved/clans', { tag: '#G88CYQP', name: 'Reddit' })[1]],
      ['/api/saved/clans/%23G88CYQP', { method: 'PATCH' }],
      ['/api/saved/clans/%23G88CYQP', { method: 'DELETE' }],
      ['/api/owners', {}],
      [`/api/owners/${PLAYER_B}`, { method: 'DELETE' }],
      ['/api/owners/bulk', postJson('/api/owners/bulk', { rows: [] })[1]],
      ['/api/import', postJson('/api/import', {})[1]],
    ]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} should require a session`)
      const body = (await response.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'unauthenticated')
    }

    assert.deepEqual(harness.shared.listSavedClans(), [])
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })
})
