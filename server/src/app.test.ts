import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthEvent } from '@coc/shared'
import {
  bindHostFromEnv,
  bindsEveryInterface,
  createApp,
  DEFAULT_BIND_HOST,
} from './app.ts'
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

async function createHarness(
  options: {
    databasePath?: string
    env?: Record<string, string | undefined>
    limiter?: LimiterOptions
    /**
     * Whether the app believes `X-Real-IP` / `X-Forwarded-For`. Off by default,
     * exactly as `createApp` defaults it, so a test that wants a forwarded header
     * to count has to say so — which is the property, not a nuisance.
     */
    trustProxy?: boolean
  } = {},
): Promise<Harness> {
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
    // These two record the `limit` they were handed, because the bound `positiveInt`
    // puts on it is only observable at the boundary that bound is protecting.
    getWarLog: async (_tag: string, limit?: number) => {
      calls.push(`warLog:limit=${limit}`)
      return { items: [] }
    },
    getCapitalRaidSeasons: async () => ({ items: [] }),
    searchClans: async (params: { limit?: number }) => {
      calls.push(`clanSearch:limit=${params.limit}`)
      return { items: [] }
    },
  } as unknown as CocClient

  const db = openDatabase(options.databasePath ?? ':memory:')
  const store = createAuthStore(db)
  const bootstrap = await bootstrapAdmin(store, options.env ?? {
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
    trustProxy: options.trustProxy ?? false,
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
  it('creates the first admin from the environment', async () => {
    const harness = await createHarness()
    assert.equal(harness.bootstrap.status, 'created')
    assert.equal(harness.store.countUsers(), 1)
    assert.equal(harness.store.listUsers()[0]?.role, 'admin')
    harness.db.close()
  })

  it('leaves the app unusable rather than defaulting a password', async () => {
    const harness = await createHarness({ env: {} })
    assert.equal(harness.bootstrap.status, 'unconfigured')
    assert.equal(harness.store.countUsers(), 0)

    const { response } = await login(harness, ADMIN)
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('refuses an admin password under the minimum length', async () => {
    const harness = await createHarness({
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

    const first = await createHarness({ databasePath })
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
    const second = await createHarness({ databasePath })
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    const response = await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=not-a-real-session-token` },
    })
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('logout invalidates the session so the same cookie then 401s', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    const out = await harness.app.request(...postJson('/api/auth/logout', {}, cookie))
    assert.equal(out.status, 200)

    const reused = await harness.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal(reused.status, 401)
    harness.db.close()
  })

  it('rejects an expired session and cleans the row up', async () => {
    const harness = await createHarness()
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    // Issued 31 days ago, so its 30-day expiry is a day in the past.
    const issuedAt = new Date(Date.now() - SESSION_TTL_MS - 24 * 60 * 60_000)
    const expired = harness.store.createSession(admin.id, issuedAt)

    const response = await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${expired.token}` },
    })
    assert.equal(response.status, 401)
    assert.equal(harness.store.resolveSession(expired.token), undefined)
    // Rejected *and* deleted, so a dead row cannot pile up per stale browser.
    assert.match(response.headers.get('set-cookie') ?? '', new RegExp(`${SESSION_COOKIE}=;`))
    harness.db.close()
  })

  it('slides the expiry forward on use', async () => {
    const harness = await createHarness()
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)

    const session = harness.store.createSession(admin.id, new Date(Date.now() - 60_000))
    const before = harness.store.resolveSession(session.token)
    assert.ok(before)

    await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    })
    // Still valid well past the original 30 days from issue.
    assert.ok(harness.store.resolveSession(session.token))
    harness.db.close()
  })
})

describe('failed login is not an oracle', () => {
  it('answers identically for an unknown email and a wrong password', async () => {
    const harness = await createHarness()

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
    const harness = await createHarness()
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
    const harness = await createHarness({ limiter: { emailLimit: 3, ipLimit: 100 } })
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
    // `trustProxy`, because the forwarded header is only an identity when something
    // is known to be setting it. The two tests below are the ones about that.
    const harness = await createHarness({
      limiter: { emailLimit: 50, ipLimit: 3 },
      trustProxy: true,
    })
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
    const harness = await createHarness({ limiter: { emailLimit: 50, ipLimit: 2 } })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(harness, { email: `victim-${attempt}@example.com`, password: 'wrong-password' })
    }

    const { response } = await login(harness, ADMIN)
    assert.equal(response.status, 200)
    harness.db.close()
  })
})

describe('the IP bucket cannot be chosen by the caller', () => {
  /**
   * The finding, end to end. nginx sets `X-Forwarded-For` from
   * `$proxy_add_x_forwarded_for`, which **appends** the real peer, so the header
   * arrives as `<whatever the client sent>, <real IP>`. The limiter used to key on
   * the first element, so a caller who varied their own prefix got a fresh bucket
   * every request and the IP brake could never fire once.
   */
  it('locks a sprayer who rotates the value they prepend to X-Forwarded-For', async () => {
    const harness = await createHarness({
      limiter: { emailLimit: 50, ipLimit: 3 },
      trustProxy: true,
    })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // A different claimed prefix each time, exactly as an attacker would send it.
      const { response } = await login(
        harness,
        { email: `victim-${attempt}@example.com`, password: 'wrong-password' },
        { 'x-forwarded-for': `10.0.0.${attempt}, 203.0.113.9` },
      )
      assert.equal(response.status, 401)
    }

    const blocked = await login(harness, ADMIN, {
      'x-forwarded-for': '10.9.9.9, 203.0.113.9',
    })
    assert.equal(blocked.response.status, 429, 'the real hop is the bucket, so it locked')

    // …and a genuinely different client is still unaffected, which is the property
    // that keeps one attacker from taking the app down for everybody.
    const elsewhere = await login(harness, ADMIN, {
      'x-forwarded-for': '10.0.0.1, 198.51.100.7',
    })
    assert.equal(elsewhere.response.status, 200)
    harness.db.close()
  })

  it('cannot be evaded through X-Real-IP either, which the proxy overwrites', async () => {
    const harness = await createHarness({
      limiter: { emailLimit: 50, ipLimit: 3 },
      trustProxy: true,
    })

    // X-Real-IP is preferred, so a forged X-Forwarded-For alongside it changes
    // nothing at all: three failures from one real client still lock that client.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await login(
        harness,
        { email: `victim-${attempt}@example.com`, password: 'wrong-password' },
        { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': `10.0.0.${attempt}` },
      )
    }

    const blocked = await login(harness, ADMIN, {
      'x-real-ip': '203.0.113.9',
      'x-forwarded-for': 'anything-at-all',
    })
    assert.equal(blocked.response.status, 429)
    harness.db.close()
  })

  it('ignores the headers entirely when there is no proxy to have set them', async () => {
    /*
     * Without `trustProxy` the headers are just strings the caller typed, so they
     * must buy nothing — neither a fresh bucket to evade with nor an identity to
     * be locked under. Under `app.request()` there is no socket address either, so
     * the IP bucket is skipped and only the email bucket counts. The property is
     * that a header cannot decide either way.
     */
    const harness = await createHarness({ limiter: { emailLimit: 50, ipLimit: 2 } })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(
        harness,
        { email: `victim-${attempt}@example.com`, password: 'wrong-password' },
        { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
      )
    }

    // Not locked, because no IP bucket was ever keyed — the header was ignored.
    const { response } = await login(harness, ADMIN, { 'x-real-ip': '203.0.113.9' })
    assert.equal(response.status, 200)
    harness.db.close()
  })
})

describe('the CoC routes are the thing being protected', () => {
  it('401s every player and clan route when unauthenticated, without calling upstream', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    // A route added later (uploads, say) is protected before it is written.
    const response = await harness.app.request('/api/uploads')
    assert.equal(response.status, 401)
    harness.db.close()
  })
})

describe('health', () => {
  it('omits internals for an anonymous caller', async () => {
    const harness = await createHarness()
    const response = await harness.app.request('/api/health')

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    harness.db.close()
  })

  it('includes the cache size for an authenticated one', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request('/api/health', { headers: { cookie } })
    assert.deepEqual(await response.json(), { ok: true, cachedEntries: 0 })
    harness.db.close()
  })
})

describe('admin endpoints', () => {
  it('refuses a non-admin', async () => {
    const harness = await createHarness()
    const adminCookie = await loggedIn(harness)

    // Through `addUser`, so the account is past its forced password change — the
    // subject here is the *role* gate, and a flagged account is refused by the
    // change gate first, which would make the 403 below prove the wrong thing.
    await addUser(harness, adminCookie, {
      email: 'regular@example.com',
      displayName: 'Regular',
      password: 'regular-user-password',
    })

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
    const harness = await createHarness()
    const response = await harness.app.request('/api/admin/users')
    assert.equal(response.status, 401)
    harness.db.close()
  })

  it('lists users without leaking hashes', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request('/api/admin/users', { headers: { cookie } })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.equal(text.includes('scrypt$'), false)
    assert.equal(text.includes('password'), false)
    harness.db.close()
  })

  it('rejects a duplicate email case-insensitively', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    const response = await harness.app.request(
      ...postJson('/api/auth/password', { currentPassword: 'x', newPassword: 'y' }),
    )
    assert.equal(response.status, 401)
    harness.db.close()
  })
})

/* ---------- email is the credential ---------- */

/**
 * Creates an account through the admin route and returns its id, **already past the
 * forced password change** — so it behaves like an account somebody has actually
 * started using, which is what almost every test below is about.
 *
 * An invited account is created with `must_change_password` set, because the
 * password was chosen by the admin who invited them (see the `POST /api/admin/users`
 * suite, which asserts exactly that and is the reason this helper cannot). Every
 * other test would then be testing the gate instead of its own subject.
 *
 * Cleared through the store rather than through `/api/auth/password`, because that
 * route refuses a new password equal to the current one — and keeping the password
 * the caller passed in is what lets them sign in with it afterwards.
 */
async function addUser(
  harness: Harness,
  cookie: string,
  input: { email: string; displayName?: string; password: string; role?: 'admin' | 'user' },
): Promise<number> {
  const response = await harness.app.request(...postJson('/api/admin/users', input, cookie))
  assert.equal(response.status, 201, `creating ${input.email} should succeed`)
  const { user } = (await response.json()) as { user: { id: number } }

  await harness.store.setPassword(user.id, input.password)
  assert.equal(harness.store.findUser(user.id)?.mustChangePassword, false)
  return user.id
}

describe('email as the login credential', () => {
  it('signs in whatever the case and spacing of the address', async () => {
    const harness = await createHarness()

    for (const email of ['admin@example.com', 'ADMIN@Example.COM', '  Admin@example.com  ']) {
      const { response, cookie } = await login(harness, { email, password: ADMIN.password })
      assert.equal(response.status, 200, `${email} should sign in`)
      assert.ok(cookie)
    }
    harness.db.close()
  })

  it('stores the address normalised, whatever case it was created with', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    const id = await addUser(harness, cookie, {
      email: '  MiXeD@Example.COM ',
      password: 'mixed-case-password',
    })

    assert.equal(harness.store.findUser(id)?.email, 'mixed@example.com')
    harness.db.close()
  })

  it('cannot authenticate an account whose email is null', async () => {
    const harness = await createHarness()
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
    assert.equal(await harness.store.authenticate('', 'stranded-user-password'), undefined)
    harness.db.close()
  })

  it('gives every account a distinct guid', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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

/* ---------- the session cookie is a token; the table holds only its digest ---------- */

describe('session tokens are not stored in plaintext', () => {
  /** Every `sessions.id` in the file, i.e. exactly what reading the backup gives you. */
  function storedIds(harness: Harness): string[] {
    return harness.db
      .prepare('SELECT id FROM sessions')
      .all()
      .map((row) => String(row['id']))
  }

  it('stores sha256(token) as the row id, never the token', async () => {
    const harness = await createHarness()
    const { cookie } = await login(harness, ADMIN)
    assert.ok(cookie)
    const token = cookie.slice(`${SESSION_COOKIE}=`.length)

    const ids = storedIds(harness)
    assert.equal(ids.length, 1)
    assert.equal(
      ids[0],
      createHash('sha256').update(token).digest('hex'),
      'the row id is the digest of the cookie value',
    )
    assert.equal(ids.includes(token), false, 'and never the cookie value itself')
    // 64 hex characters, so nothing that looks like the base64url token got in.
    assert.match(String(ids[0]), /^[0-9a-f]{64}$/)
    harness.db.close()
  })

  it('does not accept a stored id as a bearer token', async () => {
    /*
     * The finding, stated as an attack. `sessions.id` *was* the token, so anybody who
     * could read `coc.db` — or one of the twenty unencrypted backups the deploy
     * script keeps, or the WAL beside it — held a working 30-day session for every
     * signed-in account. Replaying what the file contains must now get nowhere.
     */
    const harness = await createHarness()
    const { cookie } = await login(harness, ADMIN)
    assert.ok(cookie)

    const [stored] = storedIds(harness)
    assert.ok(stored)

    const replayed = await harness.app.request('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${stored}` },
    })
    assert.equal(replayed.status, 401, 'the digest authenticates nobody')

    // The real cookie still does, so this is a stolen-file defence and not a bug.
    assert.equal(
      (await harness.app.request('/api/auth/me', { headers: { cookie } })).status,
      200,
    )
    harness.db.close()
  })

  it('deletes the right row on logout, given the id is a digest now', async () => {
    // The regression this guards: logout used to pass `sessionId` (the row id) to
    // `deleteSession`, which now hashes what it is given — so it would have looked
    // for sha256(sha256(token)) and deleted nothing, leaving the session alive.
    const harness = await createHarness()
    const { cookie } = await login(harness, ADMIN)
    assert.ok(cookie)
    assert.equal(storedIds(harness).length, 1)

    const out = await harness.app.request(...postJson('/api/auth/logout', {}, cookie))
    assert.equal(out.status, 200)
    assert.deepEqual(storedIds(harness), [], 'the row is gone, not merely unreachable')

    const reused = await harness.app.request('/api/auth/me', { headers: { cookie } })
    assert.equal(reused.status, 401)
    harness.db.close()
  })

  it('revokes other sessions by row id while sparing the caller’s own', async () => {
    // `deleteUserSessions(id, exceptSessionId)` compares row ids, and the context
    // carries a digest, so the two have to be the same kind of thing for the
    // exception to spare anything. If they were not, this would revoke everything.
    const harness = await createHarness()
    const stale = await loggedIn(harness)
    const current = await loggedIn(harness)
    assert.equal(storedIds(harness).length, 2)

    const changed = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'a-freshly-chosen-one' },
        current,
      ),
    )
    assert.equal(changed.status, 200)
    assert.equal((await changed.json() as { revokedSessions: number }).revokedSessions, 1)

    assert.equal(await meStatus(harness, current), 200, 'the caller keeps their own')
    assert.equal(await meStatus(harness, stale), 401)
    assert.equal(storedIds(harness).length, 1)
    harness.db.close()
  })

  it('gives every login a different token, and each its own row', async () => {
    const harness = await createHarness()
    const first = await loggedIn(harness)
    const second = await loggedIn(harness)

    assert.notEqual(first, second)
    assert.equal(new Set(storedIds(harness)).size, 2)
    harness.db.close()
  })
})

/* ---------- an admin-created account holds a password only until it is used ---------- */

describe('an admin-created account must replace the password it was given', () => {
  const INVITED = { email: 'invited@example.com', password: 'the-admin-chose-this' }

  it('comes back with mustChangePassword set', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)

    const created = await harness.app.request(...postJson('/api/admin/users', INVITED, admin))
    assert.equal(created.status, 201)
    const { user } = (await created.json()) as {
      user: { id: number; mustChangePassword: boolean; role: string }
    }

    assert.equal(user.mustChangePassword, true, 'the admin knows this password; the owner does not')
    assert.equal(harness.store.findUser(user.id)?.mustChangePassword, true)
    // And the request shape is unchanged — `password` is still admin-supplied.
    assert.equal(user.role, 'user')
    harness.db.close()
  })

  it('cannot reach a normal route until the password has been replaced', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)
    await harness.app.request(...postJson('/api/admin/users', INVITED, admin))

    const { response, cookie } = await login(harness, INVITED)
    assert.equal(response.status, 200, 'the invite password does sign them in')
    assert.ok(cookie)
    const signedIn = (await response.json()) as { user: { mustChangePassword: boolean } }
    assert.equal(signedIn.user.mustChangePassword, true, 'the login answer says so')

    // The gate is `requirePasswordUpToDate`, already mounted — the same one a
    // temporary password goes through, because it is the same problem.
    for (const path of [`/api/clans/${CLAN_TAG}`, '/api/owners', '/api/saved/clans', '/api/cards/inventory']) {
      const blocked = await harness.app.request(path, { headers: { cookie } })
      assert.equal(blocked.status, 403, `${path} must be refused`)
      const body = (await blocked.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'passwordChangeRequired')
    }
    assert.deepEqual(harness.calls, [], 'and no upstream call was spent on the way')
    harness.db.close()
  })

  it('lets them through once they have chosen their own, and kills the admin’s', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)
    await harness.app.request(...postJson('/api/admin/users', INVITED, admin))
    const { cookie } = await login(harness, INVITED)
    assert.ok(cookie)

    const changed = await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: INVITED.password, newPassword: 'one-they-chose-alone' },
        cookie,
      ),
    )
    assert.equal(changed.status, 200)

    assert.equal(
      (await harness.app.request('/api/owners', { headers: { cookie } })).status,
      200,
      'the same session now reaches the app',
    )

    // The password the admin knew is spent, which is the point of the whole thing:
    // there is now no moment at which a second person knows this account's password.
    assert.equal((await login(harness, INVITED)).response.status, 401)
    assert.equal(
      (await login(harness, { email: INVITED.email, password: 'one-they-chose-alone' })).response
        .status,
      200,
    )
    harness.db.close()
  })

  it('applies to an invited admin too — the role is not an exemption', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)

    const created = await harness.app.request(
      ...postJson('/api/admin/users', { ...INVITED, role: 'admin' }, admin),
    )
    assert.equal(created.status, 201)
    const { user } = (await created.json()) as { user: { mustChangePassword: boolean; role: string } }
    assert.equal(user.role, 'admin')
    assert.equal(user.mustChangePassword, true)

    const { cookie } = await login(harness, INVITED)
    assert.ok(cookie)
    const gated = await harness.app.request('/api/admin/users', { headers: { cookie } })
    assert.equal(gated.status, 403, 'an admin does not get to keep somebody else’s password either')
    harness.db.close()
  })

  it('does not flag the first admin, whose password the operator set for themselves', async () => {
    // `ADMIN_PASSWORD` is the one case where the password's author and its owner are
    // the same person, so there is nobody else's choice to be got out of.
    const harness = await createHarness()
    const admin = harness.store.listUsers()[0]
    assert.ok(admin)
    assert.equal(admin.mustChangePassword, false)

    const cookie = await loggedIn(harness)
    assert.equal(
      (await harness.app.request('/api/admin/users', { headers: { cookie } })).status,
      200,
    )
    harness.db.close()
  })
})

/* ---------- the audit trail ---------- */

describe('the audit trail records account actions', () => {
  /** The trail as an admin reads it, newest first. */
  async function readEvents(
    harness: Harness,
    cookie: string,
    query = '',
  ): Promise<{ events: AuthEvent[]; total: number; nextBefore: number | null }> {
    const response = await harness.app.request(`/api/admin/auth-events${query}`, {
      headers: { cookie },
    })
    assert.equal(response.status, 200)
    return (await response.json()) as {
      events: AuthEvent[]
      total: number
      nextBefore: number | null
    }
  }

  const kinds = (events: AuthEvent[]) => events.map((event) => event.kind)

  it('records a successful login, with who and from where', async () => {
    const harness = await createHarness({ trustProxy: true });
    const { cookie } = await login(harness, ADMIN, { 'x-real-ip': '203.0.113.9' })
    assert.ok(cookie)

    const { events } = await readEvents(harness, cookie)
    const [event] = events
    assert.ok(event)
    assert.equal(event.kind, 'loginSucceeded')
    assert.equal(event.email, ADMIN.email)
    assert.equal(event.ip, '203.0.113.9')
    assert.equal(event.actorDisplayName, 'admin', 'the name is joined, not copied')
    assert.ok(event.at, 'and it is timestamped')
    harness.db.close()
  })

  it('records a failure with the address that was tried, and nothing about whether it exists', async () => {
    const harness = await createHarness()
    await login(harness, { email: 'nobody@example.com', password: 'wrong-password-xx' })
    await login(harness, { email: ADMIN.email, password: 'wrong-password-xx' })
    const cookie = await loggedIn(harness)

    const { events } = await readEvents(harness, cookie)
    const failures = events.filter((event) => event.kind === 'loginFailed')
    assert.equal(failures.length, 2)
    assert.deepEqual(
      failures.map((event) => event.email).sort(),
      ['admin@example.com', 'nobody@example.com'],
    )
    /*
     * Neither row says whether the address existed. Recording that would put the
     * account oracle the 401 body avoids into the log instead, for anyone who later
     * gets to read it — so `actorUserId` is null on both, alike.
     */
    assert.deepEqual(
      failures.map((event) => event.actorUserId),
      [null, null],
    )
    harness.db.close()
  })

  it('records a lockout separately from the failures that caused it', async () => {
    const harness = await createHarness({ limiter: { emailLimit: 2, ipLimit: 100 } })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await login(harness, { email: 'target@example.com', password: 'wrong-password-xx' })
    }
    const cookie = await loggedIn(harness)

    const { events } = await readEvents(harness, cookie)
    // A run of blocks is the brake holding; a run of failures is the attack it is
    // holding against. Same route, different stories, so different kinds.
    assert.equal(events.filter((event) => event.kind === 'loginBlocked').length, 1)
    assert.equal(events.filter((event) => event.kind === 'loginFailed').length, 2)
    const blocked = events.find((event) => event.kind === 'loginBlocked')
    assert.match(String(blocked?.detail), /locked for another \d+s/)
    harness.db.close()
  })

  it('records the admin actions that grant or remove access', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)
    const adminId = harness.store.listUsers()[0]?.id
    assert.ok(adminId)

    const memberId = await addUser(harness, admin, {
      email: 'audited@example.com',
      displayName: 'Audited',
      password: 'the-audited-password',
    })
    await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/role`, { role: 'admin' }, admin),
    )
    await harness.app.request(
      ...patchJson(`/api/admin/users/${memberId}/email`, { email: 'moved@example.com' }, admin),
    )
    await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, admin),
    )
    await harness.app.request(...postJson(`/api/admin/users/${memberId}/disable`, {}, admin))
    await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/disable`, { disabled: false }, admin),
    )

    const { events } = await readEvents(harness, admin)
    // Newest first, so this is the sequence backwards.
    assert.deepEqual(kinds(events).slice(0, 6), [
      'userEnabled',
      'userDisabled',
      'tempPasswordIssued',
      'emailChanged',
      'roleChanged',
      'userCreated',
    ])

    // Each one names both sides: who did it and to whom.
    for (const event of events.slice(0, 6)) {
      assert.equal(event.actorUserId, adminId, `${event.kind} must name the actor`)
      assert.equal(event.targetUserId, memberId, `${event.kind} must name the target`)
    }

    const roleChange = events.find((event) => event.kind === 'roleChanged')
    assert.equal(roleChange?.detail, 'user → admin', 'and says what changed')
    harness.db.close()
  })

  it('records a password change and a logout by the account itself', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: ADMIN.password, newPassword: 'a-newly-chosen-one' },
        cookie,
      ),
    )
    await harness.app.request(...postJson('/api/auth/logout', {}, cookie))

    const fresh = await login(harness, { email: ADMIN.email, password: 'a-newly-chosen-one' })
    assert.ok(fresh.cookie)
    const { events } = await readEvents(harness, fresh.cookie)
    assert.deepEqual(kinds(events).slice(0, 3), ['loginSucceeded', 'logout', 'passwordChanged'])
    harness.db.close()
  })

  it('never writes a password, a temporary password, or a session token', async () => {
    /*
     * The property the whole table has to hold. Exercised across every route that
     * handles secret material, then the raw rows are searched for each secret — not
     * the response body, the rows, because the response is filtered by the same code
     * that would be doing the leaking.
     */
    const harness = await createHarness({ trustProxy: true })
    const admin = await loggedIn(harness)
    const adminCookie = admin.slice(`${SESSION_COOKIE}=`.length)

    const memberId = await addUser(harness, admin, {
      email: 'secretive@example.com',
      password: 'the-invite-password-x',
    })
    const issued = await harness.app.request(
      ...postJson(`/api/admin/users/${memberId}/temp-password`, {}, admin),
    )
    const { password: temporary } = (await issued.json()) as { password: string }

    const { cookie: memberCookie } = await login(harness, {
      email: 'secretive@example.com',
      password: temporary,
    })
    assert.ok(memberCookie)
    await harness.app.request(
      ...postJson(
        '/api/auth/password',
        { currentPassword: temporary, newPassword: 'chosen-by-the-owner' },
        memberCookie,
      ),
    )
    // A failed login too, since the attempted password is the obvious thing to log.
    await login(harness, { email: 'secretive@example.com', password: 'a-guess-that-was-wrong' })

    const rows = JSON.stringify(harness.db.prepare('SELECT * FROM auth_events').all())
    assert.ok(rows.length > 100, 'there is something in the table to have leaked')

    for (const secret of [
      ADMIN.password,
      'the-invite-password-x',
      temporary,
      'chosen-by-the-owner',
      'a-guess-that-was-wrong',
      adminCookie,
      memberCookie.slice(`${SESSION_COOKIE}=`.length),
    ]) {
      assert.equal(rows.includes(secret), false, `the trail must not contain ${secret}`)
    }

    // Nor a hash, nor a stored session id — nothing that is a credential or a verifier.
    assert.equal(rows.includes('scrypt$'), false)
    for (const row of harness.db.prepare('SELECT id FROM sessions').all()) {
      assert.equal(rows.includes(String(row['id'])), false)
    }
    harness.db.close()
  })

  it('is append-only: no route updates or deletes it', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    const before = await readEvents(harness, cookie)
    assert.ok(before.total > 0)

    // The shapes somebody would reach for to tidy a log they did not like. An audit
    // log the audited party can amend answers a much weaker question than one they
    // cannot, and the accounts most worth auditing are the ones with admin.
    const attempts: [string, RequestInit][] = [
      ['/api/admin/auth-events', { method: 'DELETE', headers: { cookie } }],
      ['/api/admin/auth-events', { method: 'PATCH', headers: { cookie } }],
      ['/api/admin/auth-events', postJson('/api/admin/auth-events', { kind: 'invented' }, cookie)[1]],
      ['/api/admin/auth-events/1', { method: 'DELETE', headers: { cookie } }],
    ]

    for (const [path, init] of attempts) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 404, `${init.method ?? 'POST'} ${path} must not exist`)
    }

    const after = await readEvents(harness, cookie)
    // Nothing was removed, and nothing was added either — reading the trail is not
    // itself an account action, so the four rejected attempts left no trace but the
    // 404s. What is here is the login that created the only row.
    assert.equal(after.total, before.total)
    assert.deepEqual(kinds(after.events), kinds(before.events))
    harness.db.close()
  })

  it('caps the page and walks the rest with a cursor', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    // Enough rows to page through. Failures are the cheapest event to make.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await login(harness, { email: `noise-${attempt}@example.com`, password: 'wrong-password-xx' })
    }

    const first = await readEvents(harness, cookie, '?limit=5')
    assert.equal(first.events.length, 5)
    assert.ok(first.total >= 13)
    assert.equal(first.nextBefore, first.events[4]?.id)

    const second = await readEvents(harness, cookie, `?limit=5&before=${first.nextBefore}`)
    assert.equal(second.events.length, 5)
    // Strictly older, and no overlap — a cursor rather than an offset, so a row
    // arriving mid-walk cannot shift the page under the reader.
    assert.ok(Number(second.events[0]?.id) < Number(first.events[4]?.id))
    const seen = new Set([...first.events, ...second.events].map((event) => event.id))
    assert.equal(seen.size, 10)

    // Newest first throughout, which is the order the ids are checked in above.
    const ids = first.events.map((event) => event.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a))
    harness.db.close()
  })

  it('never returns the whole table, whatever limit is asked for', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    // The cap is the server's, not a suggestion. Nonsense falls back to the default
    // rather than to "everything", which is the failure mode that matters.
    for (const query of ['?limit=999999999', '?limit=-1', '?limit=abc', '?limit=0', '']) {
      const { events } = await readEvents(harness, cookie, query)
      assert.ok(events.length <= 200, `${query || '(none)'} must stay under the cap`)
    }

    // A cursor that is not a positive integer starts from the newest rather than
    // being passed to SQLite as a NaN that matches nothing.
    for (const query of ['?before=abc', '?before=-4', '?before=0']) {
      const { events } = await readEvents(harness, cookie, query)
      assert.ok(events.length > 0, `${query} should fall back to the newest page`)
    }
    harness.db.close()
  })

  it('is admins-only, and is refused to an anonymous caller before that', async () => {
    const harness = await createHarness()
    const admin = await loggedIn(harness)
    await addUser(harness, admin, {
      email: 'nosy@example.com',
      password: 'the-nosy-password',
    })
    const { cookie: member } = await login(harness, {
      email: 'nosy@example.com',
      password: 'the-nosy-password',
    })
    assert.ok(member)

    const anonymous = await harness.app.request('/api/admin/auth-events')
    assert.equal(anonymous.status, 401)
    assert.equal(
      ((await anonymous.json()) as { error: { reason: string } }).error.reason,
      'unauthenticated',
      '401 before 403, so a signed-out caller is not told the route is admin-only',
    )

    const asMember = await harness.app.request('/api/admin/auth-events', {
      headers: { cookie: member },
    })
    assert.equal(asMember.status, 403)
    harness.db.close()
  })

  it('does not fail the action it was describing', async () => {
    /*
     * A login must not be refused because the log is unwritable — a full disk or a
     * read-only mount would otherwise become a new way to take the app down. The
     * table is dropped from under the store to force exactly that.
     */
    const harness = await createHarness()
    harness.db.exec('DROP TABLE auth_events')

    // Captured rather than allowed through: the failure is deliberate here, and a
    // stack trace in the middle of a passing suite reads like a real fault.
    const complaints: unknown[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => complaints.push(args[0])
    try {
      const { response, cookie } = await login(harness, ADMIN)
      assert.equal(response.status, 200, 'the login still succeeds')
      assert.ok(cookie)
      assert.equal(await meStatus(harness, cookie), 200)
    } finally {
      console.error = realError
    }

    // Losing a row is bad, so it is not lost quietly either.
    assert.deepEqual(complaints, ['Failed to record auth event "loginSucceeded":'])
    harness.db.close()
  })
})

/* ---------- the app's own limits, independent of nginx ---------- */

describe('an upstream limit is bounded before it is forwarded or cached', () => {
  it('clamps an absurd limit rather than passing it on', async () => {
    /*
     * `?limit=999999999` used to go upstream verbatim *and* earn its own cache
     * entry — a way to fill the cache with distinct keys for one dataset, and to
     * spend the rate-limited Supercell token on requests nothing can use.
     */
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    harness.calls.length = 0

    const searched = await harness.app.request('/api/clans?name=Reddit&limit=999999999', {
      headers: { cookie },
    })
    assert.equal(searched.status, 200)

    const log = await harness.app.request(`/api/clans/${CLAN_TAG}/warlog?limit=999999999`, {
      headers: { cookie },
    })
    assert.equal(log.status, 200)

    // Bounded on the way out, so the upstream is never asked for the absurd number.
    assert.deepEqual(harness.calls, ['clanSearch:limit=100', 'warLog:limit=100'])
    harness.db.close()
  })

  it('shares one cache entry across two absurd limits, instead of one each', async () => {
    // The cache key is built from the params the route actually uses, so clamping
    // makes two distinct nonsense values collapse onto one key — which is what stops
    // a caller minting an unbounded number of entries for the same data.
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    harness.calls.length = 0

    for (const limit of ['999999999', '888888888', '101', '100']) {
      const response = await harness.app.request(`/api/clans/${CLAN_TAG}/warlog?limit=${limit}`, {
        headers: { cookie },
      })
      assert.equal(response.status, 200)
    }

    assert.deepEqual(harness.calls, ['warLog:limit=100'], 'four requests, one upstream call')
    harness.db.close()
  })

  it('leaves a limit the upstream really accepts exactly as it was', async () => {
    // The bound has to be a ceiling and not a rewrite: what the client asks for
    // within range is what goes upstream, or the war log page would silently change.
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    harness.calls.length = 0

    await harness.app.request(`/api/clans/${CLAN_TAG}/warlog?limit=20`, { headers: { cookie } })
    await harness.app.request('/api/clans?name=Reddit&limit=6', { headers: { cookie } })
    assert.deepEqual(harness.calls, ['warLog:limit=20', 'clanSearch:limit=6'])
    harness.db.close()
  })

  it('still ignores a malformed limit in favour of the route’s default', async () => {
    // Unchanged behaviour, deliberately: a nonsense value has always been ignored
    // rather than answered with a 400, and bounding it must not change that.
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    for (const limit of ['abc', '-1', '0', '1.5', '']) {
      const response = await harness.app.request(
        `/api/clans/${CLAN_TAG}/warlog?limit=${limit}`,
        { headers: { cookie } },
      )
      assert.equal(response.status, 200, `limit=${limit} should be ignored, not refused`)
    }
    harness.db.close()
  })
})

describe('the app caps request bodies itself, not only in nginx', () => {
  /** A body of `bytes` length, with the declared Content-Length that goes with it. */
  function oversizedPost(path: string, bytes: number, cookie?: string): [string, RequestInit] {
    const body = JSON.stringify({ padding: 'x'.repeat(bytes) })
    return [
      path,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(new TextEncoder().encode(body).length),
          ...(cookie ? { cookie } : {}),
        },
        body,
      },
    ]
  }

  it('answers 413 before any handler parses the body', async () => {
    /*
     * `nginx-coc.conf` caps bodies at 10 MB and its comment says to "raise the
     * server-side limit to match rather than this alone" — there was no server-side
     * limit to raise. This is it, and it is far below nginx's number because nginx is
     * protecting itself from buffering while this protects the app from parsing.
     */
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request(...oversizedPost('/api/import', 400 * 1024, cookie))
    assert.equal(response.status, 413)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'payloadTooLarge')
    // The number is in the message: the one caller who will ever hit this is a
    // genuinely large browser import, and the useful answer says what the limit is.
    assert.match(body.error.message, /limit is \d+/)

    // Nothing was written, so the refusal really did come before the handler.
    assert.deepEqual(harness.shared.listOwners(), [])
    assert.deepEqual(harness.shared.listSavedClans(), [])
    harness.db.close()
  })

  it('refuses before the session is even looked at', async () => {
    // An over-large request should cost the server nothing on the caller's behalf,
    // and that includes a database read — so the cap is registered ahead of
    // `withSession` and answers 413 rather than 401.
    const harness = await createHarness()
    const response = await harness.app.request(...oversizedPost('/api/import', 400 * 1024))
    assert.equal(response.status, 413)
    harness.db.close()
  })

  it('lets a real payload through, which is what it was sized against', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    // The two largest real bodies: a whole-base card save, and a browser import
    // carrying every owner and saved clan a client has ever held.
    const saved = await harness.app.request(
      ...putJson(
        `/api/cards/inventory/${PLAYER_A}`,
        { counts: Array.from({ length: 60 }, (_, index) => ({ cardId: index + 1, count: 1 })) },
        cookie,
      ),
    )
    assert.equal(saved.status, 200)

    const imported = await harness.app.request(
      ...postJson(
        '/api/import',
        {
          owners: Array.from({ length: 200 }, (_, index) => ({
            tag: `#AAA${String(index).padStart(4, '0')}`,
            owner: `Member ${index}`,
          })),
          clans: [],
        },
        cookie,
      ),
    )
    assert.notEqual(imported.status, 413, 'a real import must not be refused by the cap')
    harness.db.close()
  })

  it('is not fooled into refusing a request with no declared length', async () => {
    // `Content-Length` is client-supplied and absent on a chunked request, so this
    // middleware is not a limit on what a body can actually be — bounding a stream
    // means reading it, and `client_max_body_size` is the layer that does. What must
    // not happen is a legitimate request being refused for lacking the header.
    const harness = await createHarness()
    const cookie = await loggedIn(harness)

    const response = await harness.app.request('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 200)
    harness.db.close()
  })
})

describe('the server binds loopback unless told otherwise', () => {
  it('defaults to 127.0.0.1, so :8787 is not reachable around nginx', async () => {
    /*
     * `serve({ fetch, port })` with no hostname binds `0.0.0.0` and `::`. On the
     * deployment that made :8787 reachable directly, so TLS, HSTS, the nginx body
     * cap and the forwarded headers the rate limiter reads could all be skipped by
     * addressing the app instead of the site — with only the host firewall in the
     * way. `nginx-coc.conf` proxies to `127.0.0.1:8787`, which is all it needs.
     */
    assert.equal(bindHostFromEnv({}), DEFAULT_BIND_HOST)
    assert.equal(DEFAULT_BIND_HOST, '127.0.0.1')
    assert.equal(bindHostFromEnv({ HOST: '' }), '127.0.0.1')
    assert.equal(bindHostFromEnv({ HOST: '   ' }), '127.0.0.1')
    // Not implied by anything else, either — production is exactly the case that
    // has nginx in front of it and therefore wants loopback most.
    assert.equal(bindHostFromEnv({ NODE_ENV: 'production' }), '127.0.0.1')
  })

  it('takes HOST when direct exposure is genuinely the intent', async () => {
    assert.equal(bindHostFromEnv({ HOST: '0.0.0.0' }), '0.0.0.0')
    assert.equal(bindHostFromEnv({ HOST: ' 10.0.0.4 ' }), '10.0.0.4')
    assert.equal(bindHostFromEnv({ HOST: '::1' }), '::1')
  })

  it('knows which of those is a wide bind, so the startup line can say so', async () => {
    // The log line names the address it really bound and warns on a wide one. A
    // startup message naming an interface the process is not on is how this went
    // unnoticed in the first place.
    assert.equal(bindsEveryInterface('0.0.0.0'), true)
    assert.equal(bindsEveryInterface('::'), true)
    assert.equal(bindsEveryInterface(''), true)
    assert.equal(bindsEveryInterface('127.0.0.1'), false)
    assert.equal(bindsEveryInterface('::1'), false)
    assert.equal(bindsEveryInterface('10.0.0.4'), false)
  })
})

describe('every numeric query parameter is bounded, not only limit', () => {
  it('collapses absurd filters onto one cache key instead of one each', async () => {
    /*
     * The larger half of the finding. With the value unbounded the *key space* is
     * unbounded too, so a caller could mint a fresh cache entry per request for one
     * dataset — and each miss spends the rate-limited Supercell token. `minMembers`
     * and friends are as exposed to that as `limit`, which is why the bound is on
     * the parser rather than on one call site.
     */
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    harness.calls.length = 0

    for (const min of ['999999999', '888888888', '101', '100']) {
      const response = await harness.app.request(
        `/api/clans?name=Reddit&minMembers=${min}&limit=20`,
        { headers: { cookie } },
      )
      assert.equal(response.status, 200)
    }

    assert.deepEqual(harness.calls, ['clanSearch:limit=20'], 'four requests, one upstream call')
    harness.db.close()
  })

  it('leaves a filter inside the range alone, so it still filters', async () => {
    const harness = await createHarness()
    const cookie = await loggedIn(harness)
    harness.calls.length = 0

    for (const min of ['10', '20']) {
      await harness.app.request(`/api/clans?name=Reddit&minMembers=${min}&limit=20`, {
        headers: { cookie },
      })
    }
    // Two genuinely different searches, so two upstream calls: clamping is a
    // ceiling, not a rewrite of what the caller asked for.
    assert.deepEqual(harness.calls, ['clanSearch:limit=20', 'clanSearch:limit=20'])
    harness.db.close()
  })
})
