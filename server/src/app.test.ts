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
import { createCardInventoryStore } from './cards/store.ts'
import { createTradeStore } from './cards/trades-store.ts'
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

  const shared = createSharedDataStore(db)
  const cards = createCardInventoryStore(db)

  const app = createApp({
    coc,
    cache: new TtlCache(60_000),
    auth: store,
    sharedData: shared,
    cards,
    trades: createTradeStore(db, cards),
    loginLimiter: createLoginLimiter(options.limiter),
  })

  return { app, store, shared, db, calls, bootstrap }
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

function patchJson(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  const [, init] = postJson(path, body, cookie)
  return [path, { ...init, method: 'PATCH' }]
}

function putJson(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  const [, init] = postJson(path, body, cookie)
  return [path, { ...init, method: 'PUT' }]
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
    const secureCards = createCardInventoryStore(harness.db)
    const secureApp = createApp({
      coc: {} as unknown as CocClient,
      cache: new TtlCache(60_000),
      auth: harness.store,
      sharedData: createSharedDataStore(harness.db),
      cards: secureCards,
      trades: createTradeStore(harness.db, secureCards),
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

/**
 * Two signed-in accounts against one database, which is the whole point below.
 * `a` is the bootstrap admin; `role` is the second account's, because writing the
 * owner column is admin-only now and several of these tests need B to be able to.
 */
async function twoUsers(
  harness: Harness,
  role: 'admin' | 'user' = 'user',
): Promise<{ a: string; b: string }> {
  const a = await loggedIn(harness)
  await addUser(harness, a, {
    email: 'second@example.com',
    displayName: 'Second Person',
    password: 'second-users-password',
    role,
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
    // An admin, because the rows this test is about include an owner assignment
    // and only an admin can write one.
    const id = await addUser(harness, adminCookie, {
      email: 'leaver@example.com',
      displayName: 'Leaver',
      password: 'leaver-users-password',
      role: 'admin',
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
    // Two admins: the race this endpoint exists for is between two people who are
    // both entitled to write the column.
    const { a, b } = await twoUsers(harness, 'admin')

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

describe('the owner column is an admin decision', () => {
  /** The id of the second, ordinary account — the one a base gets assigned to. */
  async function memberId(harness: Harness): Promise<number> {
    const user = harness.store.listUsers().find((row) => row.email === 'second@example.com')
    assert.ok(user, 'twoUsers should have created the second account')
    return user.id
  }

  it('assigns a base to an account, by id, and reports the link', async () => {
    const harness = createHarness()
    const { a } = await twoUsers(harness)
    const id = await memberId(harness)

    const response = await harness.app.request(
      ...putJson(`/api/owners/${PLAYER_A}`, { userId: id }, a),
    )
    assert.equal(response.status, 200)
    const { owner } = (await response.json()) as {
      owner: { tag: string; owner: string; ownerUserId: number; updatedBy: string }
    }
    // The label is the account's display name, not something re-typed, so a
    // rename cannot leave the two disagreeing.
    assert.deepEqual(
      [owner.tag, owner.owner, owner.ownerUserId, owner.updatedBy],
      ['#2GCJ2QPU', 'Second Person', id, 'admin'],
    )
    harness.db.close()
  })

  it('refuses a member every way of writing the owner column', async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)
    const id = await memberId(harness)

    // Something for the clear and the bulk overwrite to try to destroy.
    assert.equal(
      (await harness.app.request(...putJson(`/api/owners/${PLAYER_A}`, { userId: id }, a))).status,
      200,
    )

    const attempts: [string, RequestInit][] = [
      putJson(`/api/owners/${PLAYER_A}`, { userId: id }, b),
      putJson(`/api/owners/${PLAYER_B}`, { userId: id }, b),
      [`/api/owners/${PLAYER_A}`, { method: 'DELETE', headers: { cookie: b } }],
      postJson(
        '/api/owners/bulk',
        { rows: [{ tag: '#2GCJ2QPU', owner: 'Second Person', expectedOwner: 'Second Person' }] },
        b,
      ),
    ]

    for (const [path, init] of attempts) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 403, `${init.method ?? 'POST'} ${path} must be refused`)
      const body = (await response.json()) as { error: { reason: string; message: string } }
      assert.equal(body.error.reason, 'forbidden')
      // Not a bare denial: it has to say an admin is the one who assigns ownership.
      assert.match(body.error.message, /admin assigns ownership/i)
    }

    // And nothing moved: one assignment, still pointing at the same account.
    const owners = harness.shared.listOwners()
    assert.deepEqual(
      owners.map((row) => [row.tag, row.ownerUserId]),
      [['#2GCJ2QPU', id]],
    )
    harness.db.close()
  })

  it('lets a member read every owner, which is not what changed', async () => {
    const harness = createHarness()
    const { a, b } = await twoUsers(harness)
    const id = await memberId(harness)
    await harness.app.request(...putJson(`/api/owners/${PLAYER_A}`, { userId: id }, a))

    const response = await harness.app.request('/api/owners', { headers: { cookie: b } })
    assert.equal(response.status, 200)
    const { owners } = (await response.json()) as {
      owners: { tag: string; owner: string; ownerUserId: number }[]
    }
    assert.deepEqual(
      owners.map((row) => [row.tag, row.owner, row.ownerUserId]),
      [['#2GCJ2QPU', 'Second Person', id]],
    )
    harness.db.close()
  })

  it('refuses an id that belongs to no account, writing nothing', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)

    for (const body of [{ userId: 9999 }, { userId: 'admin' }, { userId: null }, {}]) {
      const response = await harness.app.request(
        ...putJson(`/api/owners/${PLAYER_A}`, body, cookie),
      )
      assert.ok(
        response.status === 400 || response.status === 404,
        `${JSON.stringify(body)} must not be accepted (got ${response.status})`,
      )
    }
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })

  it('links a bulk row whose text matches a display name, however it is typed', async () => {
    const harness = createHarness()
    const { a } = await twoUsers(harness)
    const id = await memberId(harness)

    const response = await harness.app.request(
      ...postJson(
        '/api/owners/bulk',
        {
          rows: [
            // Case and padding are noise: this is a name somebody typed.
            { tag: '#2GCJ2QPU', owner: '  second person  ', expectedOwner: '' },
            // Nobody by this name has an account, so it stays a label.
            { tag: '#AAABBB', owner: 'Casey', expectedOwner: '' },
          ],
        },
        a,
      ),
    )
    assert.equal(response.status, 200)

    const owners = harness.shared.listOwners()
    assert.deepEqual(
      owners.map((row) => [row.tag, row.owner, row.ownerUserId]),
      [
        // Stored as the account's own display name, so the label and the link agree.
        ['#2GCJ2QPU', 'Second Person', id],
        ['#AAABBB', 'Casey', null],
      ],
    )
    harness.db.close()
  })

  it('drops the link when the owner is cleared', async () => {
    const harness = createHarness()
    const { a } = await twoUsers(harness)
    const id = await memberId(harness)
    await harness.app.request(...putJson(`/api/owners/${PLAYER_A}`, { userId: id }, a))

    const cleared = await harness.app.request(`/api/owners/${PLAYER_A}`, {
      method: 'DELETE',
      headers: { cookie: a },
    })
    assert.equal(cleared.status, 200)
    // Removing the row is how "no owner" is represented — there is no assignment
    // left holding a dangling id.
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })
})

describe('one-time import of browser data', () => {
  it('fills gaps, never overwrites, and is idempotent', async () => {
    const harness = createHarness()
    // B is an admin here so the owner half of their upload is examined at all;
    // a member's owner rows are refused, which the test below covers.
    const { a, b } = await twoUsers(harness, 'admin')

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

  it("refuses a member's owner rows but still takes their saved clans", async () => {
    const harness = createHarness()
    const { b } = await twoUsers(harness)

    // The upload would otherwise be a way straight around the admin gate on
    // /api/owners — while a member's own clan list grants nobody anything.
    const response = await harness.app.request(
      ...postJson(
        '/api/import',
        {
          owners: [{ tag: '#2GCJ2QPU', owner: 'Second Person' }],
          clans: [{ tag: '#G88CYQP', name: 'Reddit' }],
        },
        b,
      ),
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      // Refused unexamined, and counted rather than silently dropped.
      owners: { applied: 0, skipped: 0, invalid: 0, refused: 1 },
      clans: { applied: 1, skipped: 0, invalid: 0 },
    })

    assert.deepEqual(harness.shared.listOwners(), [])
    assert.equal(harness.shared.listSavedClans().length, 1)
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
      // The admin gate must not be the *first* thing an anonymous caller meets:
      // 401 before 403, so a signed-out request is never told a route is admin-only.
      [`/api/owners/${PLAYER_B}`, putJson(`/api/owners/${PLAYER_B}`, { userId: 1 })[1]],
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

/* ---------- admin-mediated recovery: there is no email, so an admin is the channel ---------- */

const MEMBER = { email: 'member@example.com', password: 'the-members-own-password' }

/** Admin cookie, a plain member's id, and that member's own signed-in cookie. */
async function withMember(
  harness: Harness,
): Promise<{ admin: string; memberId: number; member: string }> {
  const admin = await loggedIn(harness)
  const memberId = await addUser(harness, admin, {
    email: MEMBER.email,
    displayName: 'A Member',
    password: MEMBER.password,
  })
  const { cookie: member } = await login(harness, MEMBER)
  assert.ok(member)
  return { admin, memberId, member }
}

async function meStatus(harness: Harness, cookie: string): Promise<number> {
  return (await harness.app.request('/api/auth/me', { headers: { cookie } })).status
}

describe('an admin can change a user’s email', () => {
  it('normalises the new address and reports the updated row', async () => {
    const harness = createHarness()
    const { admin, memberId } = await withMember(harness)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: '  Fixed@Example.COM ' }, admin),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { user: { email: string; id: number } }
    assert.equal(body.user.id, memberId)
    assert.equal(body.user.email, 'fixed@example.com')
    assert.equal(harness.store.findUser(memberId)?.email, 'fixed@example.com')

    // The corrected address is the credential now, and the old one is not.
    assert.equal((await login(harness, MEMBER)).response.status, 401)
    assert.equal(
      (await login(harness, { email: 'FIXED@example.com', password: MEMBER.password })).response
        .status,
      200,
    )
    harness.db.close()
  })

  it('refuses a body whose email is not an email, changing nothing', async () => {
    const harness = createHarness()
    const { admin, memberId } = await withMember(harness)

    for (const email of ['', 'nope', 'two@at@signs.com', 'has space@example.com', '   ']) {
      const response = await harness.app.request(
        ...patchJson(`/api/admin/users/${memberId}/email`, { email }, admin),
      )
      assert.equal(response.status, 400, `${JSON.stringify(email)} should be refused`)
    }
    assert.equal(harness.store.findUser(memberId)?.email, MEMBER.email)
    harness.db.close()
  })

  it('answers 409 on a collision, case-insensitively, not a 500 from the index', async () => {
    const harness = createHarness()
    const { admin, memberId } = await withMember(harness)

    // The admin's own address, shouted. COLLATE NOCASE is what catches it, and
    // the point of the test is that it surfaces as a clean conflict.
    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'ADMIN@EXAMPLE.COM' }, admin),
    )
    assert.equal(response.status, 409)
    const body = (await response.json()) as { error: { reason: string } }
    assert.equal(body.error.reason, 'conflict')
    assert.equal(harness.store.findUser(memberId)?.email, MEMBER.email)
    harness.db.close()
  })

  it('404s an unknown id and 400s a non-numeric one', async () => {
    const harness = createHarness()
    const admin = await loggedIn(harness)

    const missing = await harness.app.request(
      ...patchJson('/api/admin/users/9999/email', { email: 'nobody@example.com' }, admin),
    )
    assert.equal(missing.status, 404)

    const nonsense = await harness.app.request(
      ...patchJson('/api/admin/users/abc/email', { email: 'nobody@example.com' }, admin),
    )
    assert.equal(nonsense.status, 400)
    harness.db.close()
  })

  it('refuses a non-admin and an anonymous caller', async () => {
    const harness = createHarness()
    const { admin, memberId, member } = await withMember(harness)

    const asMember = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'self@example.com' }, member),
    )
    assert.equal(asMember.status, 403)

    const anonymous = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'anon@example.com' }),
    )
    assert.equal(anonymous.status, 401)

    // Neither attempt moved the address; the admin's own call still does.
    assert.equal(harness.store.findUser(memberId)?.email, MEMBER.email)
    assert.equal(
      (
        await harness.app.request(
          ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'ok@example.com' }, admin),
        )
      ).status,
      200,
    )
    harness.db.close()
  })

  it('revokes the target’s sessions', async () => {
    const harness = createHarness()
    const { admin, memberId, member } = await withMember(harness)
    // A second tab for the same member, to prove it is every session and not one.
    const { cookie: secondTab } = await login(harness, MEMBER)
    assert.ok(secondTab)
    assert.equal(await meStatus(harness, member), 200)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'moved@example.com' }, admin),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { revokedSessions: number }
    assert.equal(body.revokedSessions, 2)

    // Changing the login identifier is a credential change, so both are gone.
    assert.equal(await meStatus(harness, member), 401)
    assert.equal(await meStatus(harness, secondTab), 401)
    harness.db.close()
  })

  it('never revokes the calling admin’s own session, even fixing their own address', async () => {
    const harness = createHarness()
    const stale = await loggedIn(harness)
    const current = await loggedIn(harness)
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${admin.id}/email`, { email: 'admin@corrected.com' }, current),
    )
    assert.equal(response.status, 200)

    // The session that made the change is still usable — otherwise an admin
    // correcting their own typo signs themselves out mid-task.
    assert.equal(await meStatus(harness, current), 200)
    // …while their other sessions go, exactly as for any other account.
    assert.equal(await meStatus(harness, stale), 401)
    assert.equal((await response.json() as { revokedSessions: number }).revokedSessions, 1)

    // And the admin can carry straight on with admin work.
    const list = await harness.app.request('/api/admin/users', { headers: { cookie: current } })
    assert.equal(list.status, 200)
    harness.db.close()
  })
})

describe('an admin can issue a temporary password', () => {
  it('returns one that works, kills the old one, revokes sessions, and sets the flag', async () => {
    const harness = createHarness()
    const { admin, memberId, member } = await withMember(harness)
    assert.equal(await meStatus(harness, member), 200)

    const response = await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, admin),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      password: string
      revokedSessions: number
      user: { id: number; mustChangePassword: boolean }
    }

    // Long, and drawn from an alphabet with no glyph you could misread aloud.
    assert.ok(body.password.length >= 16, 'at least 16 characters')
    assert.match(body.password, /^[A-HJ-NP-Za-km-z2-9]+$/)
    assert.equal(body.user.id, memberId)
    assert.equal(body.user.mustChangePassword, true)
    assert.equal(harness.store.findUser(memberId)?.mustChangePassword, true)

    // The member's session is gone, so the old password cannot ride one out.
    assert.equal(body.revokedSessions, 1)
    assert.equal(await meStatus(harness, member), 401)

    // The old password no longer authenticates; the issued one does.
    assert.equal((await login(harness, MEMBER)).response.status, 401)
    const fresh = await login(harness, { email: MEMBER.email, password: body.password })
    assert.equal(fresh.response.status, 200)
    const signedIn = (await fresh.response.json()) as { user: { mustChangePassword: boolean } }
    // The login answer carries the flag, so the first render is the change screen.
    assert.equal(signedIn.user.mustChangePassword, true)
    harness.db.close()
  })

  it('ignores a password supplied by the client and mints its own', async () => {
    const harness = createHarness()
    const { admin, memberId } = await withMember(harness)

    const response = await harness.app.request(
      ...postJson(
        `/api/admin/users/${memberId}/temp-password`,
        { password: 'chosen-by-the-admin' },
        admin,
      ),
    )
    assert.equal(response.status, 200)
    const { password } = (await response.json()) as { password: string }
    assert.notEqual(password, 'chosen-by-the-admin')

    // The attacker-friendly reading of this route — "set a known password on any
    // account" — must not be available at all.
    assert.equal(
      (await login(harness, { email: MEMBER.email, password: 'chosen-by-the-admin' })).response
        .status,
      401,
    )
    assert.equal(
      (await login(harness, { email: MEMBER.email, password })).response.status,
      200,
    )
    harness.db.close()
  })

  it('gives a different password every time', async () => {
    const harness = createHarness()
    const { admin, memberId } = await withMember(harness)

    const issued = new Set<string>()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await harness.app.request(
        ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, admin),
      )
      const { password } = (await response.json()) as { password: string }
      issued.add(password)
    }
    assert.equal(issued.size, 5)
    harness.db.close()
  })

  it('works on yourself and leaves you the session you need to use it', async () => {
    const harness = createHarness()
    const admin = await loggedIn(harness)
    const adminId = harness.store.listUsers()[0]?.id
    assert.ok(adminId)

    const response = await harness.app.request(
      ...postJson(`/api/admin/users/${adminId}/temp-password`, {}, admin),
    )
    assert.equal(response.status, 200)
    const { password } = (await response.json()) as { password: string }

    /*
     * The calling session survives on purpose: the password is shown exactly once,
     * so revoking the session that is reading it would throw the value away. It is
     * not a way around the change — the gate below refuses everything else.
     */
    assert.equal(await meStatus(harness, admin), 200)
    const gated = await harness.app.request('/api/admin/users', { headers: { cookie: admin } })
    assert.equal(gated.status, 403)

    const changed = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: password, newPassword: 'the-admins-new-password' },
        admin,
      ),
    )
    assert.equal(changed.status, 200)
    assert.equal(
      (await harness.app.request('/api/admin/users', { headers: { cookie: admin } })).status,
      200,
    )
    harness.db.close()
  })

  it('404s an unknown id, 400s a non-numeric one, and refuses non-admins', async () => {
    const harness = createHarness()
    const { admin, memberId, member } = await withMember(harness)

    assert.equal(
      (await harness.app.request(...postJson('/api/admin/users/9999/temp-password', {}, admin)))
        .status,
      404,
    )
    assert.equal(
      (await harness.app.request(...postJson('/api/admin/users/abc/temp-password', {}, admin)))
        .status,
      400,
    )
    // A user must not be able to reset anyone — including themselves, which would
    // be a way to bypass knowing the current password.
    assert.equal(
      (
        await harness.app.request(
          ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, member),
        )
      ).status,
      403,
    )
    assert.equal(harness.store.findUser(memberId)?.mustChangePassword, false)
    harness.db.close()
  })
})

describe('the forced password change is a server gate, not a screen', () => {
  /** A member whose password an admin has just reset, signed in on the temp one. */
  async function flagged(
    harness: Harness,
  ): Promise<{ admin: string; memberId: number; cookie: string; password: string }> {
    const { admin, memberId } = await withMember(harness)
    const issued = await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, admin),
    )
    const { password } = (await issued.json()) as { password: string }
    const { cookie } = await login(harness, { email: MEMBER.email, password })
    assert.ok(cookie)
    return { admin, memberId, cookie, password }
  }

  it('refuses every ordinary route while the flag is set', async () => {
    const harness = createHarness()
    const { cookie } = await flagged(harness)

    const blocked: [string, RequestInit][] = [
      [`/api/clans/${CLAN_TAG}`, {}],
      ['/api/players/%232GCJ2QPU', {}],
      ['/api/owners', {}],
      ['/api/saved/clans', {}],
      ['/api/cards/inventory', {}],
      ['/api/cards/trades', {}],
      ['/api/owners/bulk', postJson('/api/owners/bulk', { rows: [] }, cookie)[1]],
      ['/api/admin/users', {}],
    ]

    for (const [path, init] of blocked) {
      const response = await harness.app.request(path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), cookie },
      })
      assert.equal(response.status, 403, `${path} must be refused`)
      const body = (await response.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'passwordChangeRequired')
    }

    // 403 rather than 401 matters: a 401 would trip the client's global
    // signed-out handler and bounce them to a login screen they cannot pass,
    // because the change form lives behind the session they already hold.
    assert.deepEqual(harness.calls, [], 'and no upstream call was spent')
    harness.db.close()
  })

  it('still serves /api/auth/me — reporting the flag — plus password and logout', async () => {
    const harness = createHarness()
    const { memberId, cookie, password } = await flagged(harness)

    const me = await harness.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal(me.status, 200)
    const body = (await me.json()) as { user: { mustChangePassword: boolean; email: string } }
    assert.equal(body.user.mustChangePassword, true, 'the client needs this to show the screen')
    assert.equal(body.user.email, MEMBER.email)

    // A wrong current password is still refused — the flag is not a free pass.
    const wrong = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: 'not-the-temp-one', newPassword: 'a-chosen-long-password' },
        cookie,
      ),
    )
    assert.equal(wrong.status, 401)
    assert.equal(harness.store.findUser(memberId)?.mustChangePassword, true)

    // …and too-short is still refused, so the flag cannot be cleared by a weak one.
    const short = await harness.app.request(
      ...postJson('/api/auth/password', { currentPassword: password, newPassword: 'short' }, cookie),
    )
    assert.equal(short.status, 400)

    const out = await harness.app.request(...postJson('/api/auth/logout', {}, cookie))
    assert.equal(out.status, 200)
    harness.db.close()
  })

  it('clears the flag on a successful change and lets the app through again', async () => {
    const harness = createHarness()
    const { memberId, cookie, password } = await flagged(harness)

    const changed = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: password, newPassword: 'a-password-they-chose' },
        cookie,
      ),
    )
    assert.equal(changed.status, 200)
    assert.equal(harness.store.findUser(memberId)?.mustChangePassword, false)

    const me = await harness.app.request('/api/auth/me', { headers: { cookie } })
    const body = (await me.json()) as { user: { mustChangePassword: boolean } }
    assert.equal(body.user.mustChangePassword, false)

    // The same session that was gated a moment ago now reaches the real routes.
    for (const path of [`/api/clans/${CLAN_TAG}`, '/api/owners', '/api/saved/clans']) {
      assert.equal(
        (await harness.app.request(path, { headers: { cookie } })).status,
        200,
        `${path} should be served once the password has been changed`,
      )
    }

    // And the temporary password is spent: only the chosen one signs in now.
    assert.equal((await login(harness, { email: MEMBER.email, password })).response.status, 401)
    assert.equal(
      (await login(harness, { email: MEMBER.email, password: 'a-password-they-chose' })).response
        .status,
      200,
    )
    harness.db.close()
  })

  it('does not gate anyone else', async () => {
    const harness = createHarness()
    const { admin } = await flagged(harness)
    // The admin who issued it is unaffected, which is the whole point of keying
    // the gate on the account rather than on some global state.
    assert.equal(
      (await harness.app.request(`/api/clans/${CLAN_TAG}`, { headers: { cookie: admin } })).status,
      200,
    )
    harness.db.close()
  })
})

describe('the recovery routes open no anonymous hole', () => {
  it('refuses every one of them without a session, changing nothing', async () => {
    const harness = createHarness()
    const { memberId } = await withMember(harness)
    const before = harness.store.findUser(memberId)
    assert.ok(before)

    const requests: [string, RequestInit][] = [
      [
        `/api/admin/users/${memberId}/email`,
        patchJson(`/api/admin/users/${memberId}/email`, { email: 'anon@example.com' })[1],
      ],
      [
        `/api/admin/users/${memberId}/temp-password`,
        postJson(`/api/admin/users/${memberId}/temp-password`, {})[1],
      ],
      // The shapes an attacker would try if a public reset route existed at all.
      ['/api/auth/reset', postJson('/api/auth/reset', { email: MEMBER.email })[1]],
      ['/api/auth/forgot-password', postJson('/api/auth/forgot-password', { email: MEMBER.email })[1]],
      ['/api/auth/reset-password', postJson('/api/auth/reset-password', { token: 'x' })[1]],
    ]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} must not be public`)
      const body = (await response.json()) as { error: { reason: string } }
      // Deny-by-default answers 401 even for a route that does not exist, so an
      // anonymous caller cannot even map which recovery endpoints are real.
      assert.equal(body.error.reason, 'unauthenticated')
    }

    assert.deepEqual(harness.store.findUser(memberId), before, 'nothing was changed')
    harness.db.close()
  })
})

describe('the last active admin cannot be disabled', () => {
  it('refuses when the target is the only one left', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)
    assert.equal(harness.store.countActiveAdmins(), 1)

    const response = await harness.app.request(
      ...postJson(`/api/admin/users/${admin.id}/disable`, {}, cookie),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /only active admin/)
    assert.equal(harness.store.findUser(admin.id)?.disabledAt, null)
    assert.equal(harness.store.countActiveAdmins(), 1)
    harness.db.close()
  })

  it('allows it once there is a second admin, and never leaves zero', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const first = harness.store.listUsers()[0]
    assert.ok(first)

    const secondId = await addUser(harness, cookie, {
      email: 'deputy@example.com',
      displayName: 'Deputy',
      password: 'the-deputys-password',
      role: 'admin',
    })
    assert.equal(harness.store.countActiveAdmins(), 2)

    const disabled = await harness.app.request(
      ...postJson(`/api/admin/users/${secondId}/disable`, {}, cookie),
    )
    assert.equal(disabled.status, 200)
    assert.equal(harness.store.countActiveAdmins(), 1)

    // Now the first admin is the last one, and is refused again.
    const cornered = await harness.app.request(
      ...postJson(`/api/admin/users/${first.id}/disable`, {}, cookie),
    )
    assert.equal(cornered.status, 400)
    assert.equal(harness.store.countActiveAdmins(), 1)

    // Re-enabling is never blocked — the guard is one-directional.
    const restored = await harness.app.request(
      ...postJson(`/api/admin/users/${secondId}/disable`, { disabled: false }, cookie),
    )
    assert.equal(restored.status, 200)
    assert.equal(harness.store.countActiveAdmins(), 2)
    harness.db.close()
  })

  it('does not get in the way of disabling a plain user', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'ordinary@example.com',
      password: 'an-ordinary-password',
    })

    // One active admin, but the target is not an admin, so nothing is at stake.
    const response = await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/disable`, {}, cookie),
    )
    assert.equal(response.status, 200)
    assert.ok(harness.store.findUser(memberId)?.disabledAt)
    harness.db.close()
  })
})

describe('PATCH /api/admin/users/:id/display-name', () => {
  it('renames a user without touching their sessions', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'renamed@example.com',
      displayName: 'Old Name',
      password: 'a-perfectly-fine-password',
    })

    const { cookie: theirs } = await login(harness, {
      email: 'renamed@example.com',
      password: 'a-perfectly-fine-password',
    })
    assert.ok(theirs)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/display-name`, { displayName: 'New Name' }, cookie),
    )
    assert.equal(response.status, 200)
    assert.equal(harness.store.findUser(memberId)?.displayName, 'New Name')

    // A display name is not a credential, so unlike the email route this must
    // leave the renamed user signed in.
    const stillSignedIn = await harness.app.request('/api/auth/me', { headers: { cookie: theirs } })
    assert.equal(stillSignedIn.status, 200)
    harness.db.close()
  })

  it('trims, and rejects a blank or absent name', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'trimmed@example.com',
      password: 'another-fine-password',
    })

    const trimmed = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/display-name`, { displayName: '  Spaced  ' }, cookie),
    )
    assert.equal(trimmed.status, 200)
    assert.equal(harness.store.findUser(memberId)?.displayName, 'Spaced')

    for (const displayName of ['', '   ', undefined]) {
      const response = await harness.app.request(
        ...patchJson(`/api/admin/users/${memberId}/display-name`, { displayName }, cookie),
      )
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(displayName)}`)
    }
    // The rejected writes left the last good value alone.
    assert.equal(harness.store.findUser(memberId)?.displayName, 'Spaced')
    harness.db.close()
  })

  it('is refused anonymously and to non-admins, and 404s for an unknown id', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'plain@example.com',
      password: 'yet-another-password',
    })
    const { cookie: theirs } = await login(harness, {
      email: 'plain@example.com',
      password: 'yet-another-password',
    })
    assert.ok(theirs)

    const anonymous = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/display-name`, { displayName: 'Nope' }),
    )
    assert.equal(anonymous.status, 401)

    const nonAdmin = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/display-name`, { displayName: 'Nope' }, theirs),
    )
    assert.equal(nonAdmin.status, 403)

    const missing = await harness.app.request(
      ...patchJson('/api/admin/users/9999/display-name', { displayName: 'Nope' }, cookie),
    )
    assert.equal(missing.status, 404)

    assert.equal(harness.store.findUser(memberId)?.displayName, 'plain')
    harness.db.close()
  })
})

describe('PATCH /api/admin/users/:id/role', () => {
  it('promotes a user to admin, who can then use an admin route', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'promoted@example.com',
      password: 'the-promotion-password',
    })
    const { cookie: theirs } = await login(harness, {
      email: 'promoted@example.com',
      password: 'the-promotion-password',
    })
    assert.ok(theirs)

    const before = await harness.app.request('/api/admin/users', { headers: { cookie: theirs } })
    assert.equal(before.status, 403)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/role`, { role: 'admin' }, cookie),
    )
    assert.equal(response.status, 200)
    assert.equal(harness.store.findUser(memberId)?.role, 'admin')
    assert.equal(harness.store.countActiveAdmins(), 2)

    // The role is read from `users` on every request, so the existing session
    // picks it up without re-authenticating.
    const after = await harness.app.request('/api/admin/users', { headers: { cookie: theirs } })
    assert.equal(after.status, 200)
    harness.db.close()
  })

  it('refuses to demote the only active admin', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    const response = await harness.app.request(
      ...patchJson(`/api/admin/users/${admin.id}/role`, { role: 'user', confirm: 'yes' }, cookie),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /only active admin/)
    assert.equal(harness.store.findUser(admin.id)?.role, 'admin')
    assert.equal(harness.store.countActiveAdmins(), 1)
    harness.db.close()
  })

  it('needs explicit confirmation to drop your own admin role', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)
    // A second admin, so the last-admin guard is not what is being tested.
    await addUser(harness, cookie, {
      email: 'deputy@example.com',
      password: 'the-deputy-password',
      role: 'admin',
    })

    const unconfirmed = await harness.app.request(
      ...patchJson(`/api/admin/users/${admin.id}/role`, { role: 'user' }, cookie),
    )
    assert.equal(unconfirmed.status, 400)
    assert.equal(harness.store.findUser(admin.id)?.role, 'admin')

    const confirmed = await harness.app.request(
      ...patchJson(`/api/admin/users/${admin.id}/role`, { role: 'user', confirm: 'yes' }, cookie),
    )
    assert.equal(confirmed.status, 200)
    assert.equal(harness.store.findUser(admin.id)?.role, 'user')

    // And having given it up, they can no longer reach an admin route.
    const locked = await harness.app.request('/api/admin/users', { headers: { cookie } })
    assert.equal(locked.status, 403)
    harness.db.close()
  })

  it('demotes another admin without confirmation, and never needs it to promote', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const deputyId = await addUser(harness, cookie, {
      email: 'deputy2@example.com',
      password: 'the-other-deputy-pw',
      role: 'admin',
    })
    assert.equal(harness.store.countActiveAdmins(), 2)

    const demoted = await harness.app.request(
      ...patchJson(`/api/admin/users/${deputyId}/role`, { role: 'user' }, cookie),
    )
    assert.equal(demoted.status, 200)
    assert.equal(harness.store.findUser(deputyId)?.role, 'user')

    const repromoted = await harness.app.request(
      ...patchJson(`/api/admin/users/${deputyId}/role`, { role: 'admin' }, cookie),
    )
    assert.equal(repromoted.status, 200)
    assert.equal(harness.store.findUser(deputyId)?.role, 'admin')
    harness.db.close()
  })

  it('is refused anonymously and to non-admins, and 404s for an unknown id', async () => {
    const harness = createHarness()
    const cookie = await loggedIn(harness)
    const memberId = await addUser(harness, cookie, {
      email: 'nobody@example.com',
      password: 'the-nobody-password',
    })
    const { cookie: theirs } = await login(harness, {
      email: 'nobody@example.com',
      password: 'the-nobody-password',
    })
    assert.ok(theirs)

    const anonymous = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/role`, { role: 'admin' }),
    )
    assert.equal(anonymous.status, 401)

    // The obvious privilege escalation: promoting yourself.
    const selfPromotion = await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/role`, { role: 'admin' }, theirs),
    )
    assert.equal(selfPromotion.status, 403)
    assert.equal(harness.store.findUser(memberId)?.role, 'user')

    const missing = await harness.app.request(
      ...patchJson('/api/admin/users/9999/role', { role: 'admin' }, cookie),
    )
    assert.equal(missing.status, 404)
    harness.db.close()
  })
})
