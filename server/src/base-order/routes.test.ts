import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { TtlCache } from '../cache.ts'
import { createCardInventoryStore } from '../cards/store.ts'
import { createTradeStore } from '../cards/trades-store.ts'
import { createChangeRequestStore } from '../change-requests/store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createProgressStore } from '../progress/store.ts'
import { createSharedDataStore, type SharedDataStore } from '../shared-data/store.ts'
import { createBaseOrderStore, type BaseOrderStore } from './store.ts'

/*
 * The base-order routes over the whole app, driven through `app.request` — the
 * same shape `progress/routes.test.ts` and `cards/cards.test.ts` use. Own-data
 * only: there is no admin-on-behalf-of case here, so every test is one account
 * reading or writing its own order.
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const ADMIN_NAME = 'Admin One'
const SECOND = { email: 'teammate@example.test', password: 'second-user-password' }
const SECOND_NAME = 'Teammate'

const BASE_A = '#2GCJ2QPU'
const BASE_B = '#AAABBB'

interface Harness {
  app: ReturnType<typeof createApp>
  baseOrder: BaseOrderStore
  auth: ReturnType<typeof createAuthStore>
  shared: SharedDataStore
  db: ReturnType<typeof openDatabase>
}

async function createHarness(): Promise<Harness> {
  const db = openDatabase(':memory:')
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: ADMIN_NAME,
  })
  await auth.createUser({
    email: SECOND.email,
    displayName: SECOND_NAME,
    password: SECOND.password,
    role: 'user',
  })

  const cards = createCardInventoryStore(db)
  const shared = createSharedDataStore(db)
  const baseOrder = createBaseOrderStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: shared,
    cards,
    trades: createTradeStore(db, cards),
    progress: createProgressStore(db),
    baseOrder,
    changeRequests: createChangeRequestStore(db),
    loginLimiter: createLoginLimiter(),
  })

  return { app, baseOrder, auth, shared, db }
}

function idOf(harness: Harness, email: string): number {
  const user = harness.auth.listUsers().find((row) => row.email === email)
  assert.ok(user, `${email} should exist`)
  return user.id
}

async function assignBase(
  harness: Harness,
  adminCookie: string,
  tag: string,
  userId: number,
): Promise<void> {
  const response = await harness.app.request(`/api/owners/${encodeURIComponent(tag)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ userId }),
  })
  assert.equal(response.status, 200, `assigning ${tag} should succeed`)
}

function sessionCookie(response: Response): string | undefined {
  const match = response.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
  const value = match?.[1]
  return value ? `${SESSION_COOKIE}=${value}` : undefined
}

async function signIn(
  harness: Harness,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await harness.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  assert.equal(response.status, 200, `${credentials.email} should sign in`)
  const cookie = sessionCookie(response)
  assert.ok(cookie, 'login should set a session cookie')
  return cookie
}

function putOrder(body: unknown, cookie?: string): [string, RequestInit] {
  return [
    '/api/base-order',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

function getOrder(cookie?: string): [string, RequestInit] {
  return ['/api/base-order', { headers: cookie ? { cookie } : {} }]
}

describe('reading your own base order', () => {
  it('answers an empty list for a user who has never saved one', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(...getOrder(cookie))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { tags: string[] }
    assert.deepEqual(body.tags, [])
    harness.db.close()
  })

  it('reads back exactly what was saved, and only for the calling user', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    await assignBase(harness, admin, BASE_B, idOf(harness, ADMIN.email))

    const saved = await harness.app.request(...putOrder([BASE_B, BASE_A], admin))
    assert.equal(saved.status, 200)

    const adminRead = await harness.app.request(...getOrder(admin))
    const adminBody = (await adminRead.json()) as { tags: string[] }
    assert.deepEqual(adminBody.tags, [BASE_B, BASE_A])

    // The second account never saved an order of its own, and must not see the
    // admin's — an order is nobody's business but the account that reads it.
    const memberRead = await harness.app.request(...getOrder(member))
    const memberBody = (await memberRead.json()) as { tags: string[] }
    assert.deepEqual(memberBody.tags, [])
    harness.db.close()
  })
})

describe('saving your own base order', () => {
  it('accepts a partial list — not every owned base has to be named', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    await assignBase(harness, admin, BASE_B, idOf(harness, ADMIN.email))

    const response = await harness.app.request(...putOrder([BASE_A], admin))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { tags: string[] }
    assert.deepEqual(body.tags, [BASE_A])
    assert.deepEqual(harness.baseOrder.getOrder(idOf(harness, ADMIN.email)), [BASE_A])
    harness.db.close()
  })

  it('a later save replaces the order rather than merging with the earlier one', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    await assignBase(harness, admin, BASE_B, idOf(harness, ADMIN.email))

    await harness.app.request(...putOrder([BASE_A, BASE_B], admin))
    const response = await harness.app.request(...putOrder([BASE_B], admin))
    assert.equal(response.status, 200)
    assert.deepEqual(harness.baseOrder.getOrder(idOf(harness, ADMIN.email)), [BASE_B])
    harness.db.close()
  })

  it('rejects a tag the caller does not own, and writes nothing', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    // BASE_A belongs to the admin, not the member submitting this order.
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const response = await harness.app.request(...putOrder([BASE_A], member))
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'badRequest')
    assert.match(body.error.message, /not one of your bases/)
    assert.deepEqual(harness.baseOrder.getOrder(idOf(harness, SECOND.email)), [])
    harness.db.close()
  })

  it('rejects a tag with no owner at all, the same as one owned by somebody else', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    // BASE_B is never assigned to anyone.

    const response = await harness.app.request(...putOrder([BASE_B], admin))
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /not one of your bases/)
    harness.db.close()
  })

  it('rejects a duplicate tag, and writes nothing', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const response = await harness.app.request(...putOrder([BASE_A, BASE_A], admin))
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /duplicate/)
    assert.deepEqual(harness.baseOrder.getOrder(idOf(harness, ADMIN.email)), [])
    harness.db.close()
  })

  it('rejects a body that is not an array of strings', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const notAnArray = await harness.app.request(...putOrder({ tags: [BASE_A] }, admin))
    assert.equal(notAnArray.status, 400)

    const notStrings = await harness.app.request(...putOrder([123], admin))
    assert.equal(notStrings.status, 400)
    const body = (await notStrings.json()) as { error: { message: string } }
    assert.match(body.error.message, /must be a string/)

    assert.deepEqual(harness.baseOrder.getOrder(idOf(harness, ADMIN.email)), [])
    harness.db.close()
  })
})

describe('the base-order routes need a session', () => {
  it('401s both routes anonymously, changing nothing', async () => {
    const harness = await createHarness()
    const requests: [string, RequestInit][] = [getOrder(), putOrder([BASE_A])]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} should need a session`)
    }
    harness.db.close()
  })
})
