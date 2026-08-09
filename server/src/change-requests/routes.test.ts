import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangeRequest } from '@coc/shared'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { createBaseOrderStore } from '../base-order/store.ts'
import { TtlCache } from '../cache.ts'
import { createCardInventoryStore } from '../cards/store.ts'
import { createTradeStore } from '../cards/trades-store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createProgressStore } from '../progress/store.ts'
import { createSharedDataStore } from '../shared-data/store.ts'
import { createChangeRequestStore } from './store.ts'

/*
 * `/api/change-requests/*` and `/api/admin/change-requests/*`, driven through
 * `app.request` — the same shape `trades.test.ts` uses over the trade routes.
 * Three accounts: an admin, and two ordinary members who are never party to
 * each other's requests, which is the smallest cast the "author only" rules
 * need to be tested against a genuine stranger rather than just "not signed in".
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const MEMBER_A = { email: 'a@example.test', password: 'member-a-password-1' }
const MEMBER_B = { email: 'b@example.test', password: 'member-b-password-1' }

interface Harness {
  app: ReturnType<typeof createApp>
  db: ReturnType<typeof openDatabase>
}

async function createHarness(): Promise<Harness> {
  const db = openDatabase(':memory:')
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: 'Admin One',
  })
  for (const [credentials, displayName] of [
    [MEMBER_A, 'Ada'],
    [MEMBER_B, 'Bo'],
  ] as const) {
    await auth.createUser({
      email: credentials.email,
      displayName,
      password: credentials.password,
      role: 'user',
    })
  }

  const cards = createCardInventoryStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: createSharedDataStore(db),
    cards,
    trades: createTradeStore(db, cards),
    progress: createProgressStore(db),
    baseOrder: createBaseOrderStore(db),
    changeRequests: createChangeRequestStore(db),
    loginLimiter: createLoginLimiter(),
  })

  return { app, db }
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

function post(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  return [
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

async function submit(
  harness: Harness,
  cookie: string,
  subject = 'Add dark mode',
  body = 'The app is too bright at night.',
): Promise<ChangeRequest> {
  const response = await harness.app.request(...post('/api/change-requests', { subject, body }, cookie))
  assert.equal(response.status, 201)
  return ((await response.json()) as { request: ChangeRequest }).request
}

async function mine(harness: Harness, cookie: string): Promise<ChangeRequest[]> {
  const response = await harness.app.request('/api/change-requests', { headers: { cookie } })
  assert.equal(response.status, 200)
  return ((await response.json()) as { requests: ChangeRequest[] }).requests
}

async function all(harness: Harness, cookie: string): Promise<Response> {
  return harness.app.request('/api/admin/change-requests', { headers: { cookie } })
}

describe('POST /api/change-requests', () => {
  it('lets any signed-in user submit, and lists it back under their own requests', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)

    const request = await submit(harness, cookieA)
    assert.equal(request.subject, 'Add dark mode')
    assert.equal(request.requestedBy, 'Ada')
    assert.equal(request.canceledAt, null)
    assert.equal(request.resolution, null)
    assert.deepEqual(request.amendments, [])

    const own = await mine(harness, cookieA)
    assert.equal(own.length, 1)
    assert.equal(own[0]?.id, request.id)
  })

  it('refuses an anonymous caller — deny-by-default', async () => {
    const harness = await createHarness()
    const response = await harness.app.request(
      ...post('/api/change-requests', { subject: 'x', body: 'y' }),
    )
    assert.equal(response.status, 401)
  })

  it('rejects a subject over 255 characters', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const response = await harness.app.request(
      ...post('/api/change-requests', { subject: 'x'.repeat(256), body: 'y' }, cookieA),
    )
    assert.equal(response.status, 400)
  })

  it('rejects a body over the server-enforced max', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const response = await harness.app.request(
      ...post('/api/change-requests', { subject: 'x', body: 'y'.repeat(4001) }, cookieA),
    )
    assert.equal(response.status, 400)
  })

  it('rejects a blank subject or body even if whitespace-only', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const blankSubject = await harness.app.request(
      ...post('/api/change-requests', { subject: '   ', body: 'y' }, cookieA),
    )
    assert.equal(blankSubject.status, 400)
    const blankBody = await harness.app.request(
      ...post('/api/change-requests', { subject: 'x', body: '  ' }, cookieA),
    )
    assert.equal(blankBody.status, 400)
  })

  it('never shows one account’s requests to another', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieB = await signIn(harness, MEMBER_B)
    await submit(harness, cookieA)
    assert.equal((await mine(harness, cookieB)).length, 0)
  })
})

describe('amend', () => {
  it('lets the author append an amendment, in order, dated', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const request = await submit(harness, cookieA)

    const response = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/amend`, { body: 'One more thing' }, cookieA),
    )
    assert.equal(response.status, 200)
    const { request: amended } = (await response.json()) as { request: ChangeRequest }
    assert.equal(amended.amendments.length, 1)
    assert.equal(amended.amendments[0]?.body, 'One more thing')
    assert.equal(amended.amendments[0]?.createdBy, 'Ada')
    assert.ok(amended.amendments[0]?.createdAt)
    // The original text is untouched.
    assert.equal(amended.subject, request.subject)
    assert.equal(amended.body, request.body)
  })

  it('refuses a stranger, admin included', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieB = await signIn(harness, MEMBER_B)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    for (const cookie of [cookieB, cookieAdmin]) {
      const response = await harness.app.request(
        ...post(`/api/change-requests/${request.id}/amend`, { body: 'not yours' }, cookie),
      )
      assert.equal(response.status, 403)
    }
  })

  it('refuses once the request is canceled', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const request = await submit(harness, cookieA)
    await harness.app.request(...post(`/api/change-requests/${request.id}/cancel`, {}, cookieA))

    const response = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/amend`, { body: 'too late' }, cookieA),
    )
    assert.equal(response.status, 409)
  })

  it('refuses once the request is resolved', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)
    await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'asDesigned' }, cookieAdmin),
    )

    const response = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/amend`, { body: 'too late' }, cookieA),
    )
    assert.equal(response.status, 409)
  })
})

describe('cancel', () => {
  it('lets the author cancel their own request, and it is idempotent', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const request = await submit(harness, cookieA)

    const first = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/cancel`, {}, cookieA),
    )
    assert.equal(first.status, 200)
    const firstBody = (await first.json()) as { request: ChangeRequest }
    assert.ok(firstBody.request.canceledAt)

    const second = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/cancel`, {}, cookieA),
    )
    assert.equal(second.status, 200)
    const secondBody = (await second.json()) as { request: ChangeRequest }
    // Idempotent: the second call does not overwrite the first timestamp.
    assert.equal(secondBody.request.canceledAt, firstBody.request.canceledAt)
  })

  it('refuses anyone but the author, admin included', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    const response = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/cancel`, {}, cookieAdmin),
    )
    assert.equal(response.status, 403)
  })

  it('does not remove the row — it stays visible, canceled, to both the requester and admins', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)
    await harness.app.request(...post(`/api/change-requests/${request.id}/cancel`, {}, cookieA))

    const own = await mine(harness, cookieA)
    assert.equal(own.length, 1)
    assert.ok(own[0]?.canceledAt)

    const adminList = await all(harness, cookieAdmin)
    assert.equal(adminList.status, 200)
    const { requests } = (await adminList.json()) as { requests: ChangeRequest[] }
    assert.equal(requests.length, 1)
    assert.ok(requests[0]?.canceledAt)
  })
})

describe('hide', () => {
  it('is a reversible toggle on the requester’s own list, invisible to admins as a filter', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    const hidden = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/hide`, { hidden: true }, cookieA),
    )
    assert.equal(hidden.status, 200)
    const hiddenBody = (await hidden.json()) as { request: ChangeRequest }
    assert.ok(hiddenBody.request.hiddenAt)

    // The admin table always shows every request regardless of hidden state.
    const adminList = await all(harness, cookieAdmin)
    const { requests } = (await adminList.json()) as { requests: ChangeRequest[] }
    assert.equal(requests.length, 1)

    const shown = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/hide`, { hidden: false }, cookieA),
    )
    const shownBody = (await shown.json()) as { request: ChangeRequest }
    assert.equal(shownBody.request.hiddenAt, null)
  })

  it('refuses anyone but the author', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieB = await signIn(harness, MEMBER_B)
    const request = await submit(harness, cookieA)

    const response = await harness.app.request(
      ...post(`/api/change-requests/${request.id}/hide`, { hidden: true }, cookieB),
    )
    assert.equal(response.status, 403)
  })
})

describe('GET /api/admin/change-requests', () => {
  it('is admin-only', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const response = await all(harness, cookieA)
    assert.equal(response.status, 403)
  })

  it('lists every account’s requests', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieB = await signIn(harness, MEMBER_B)
    const cookieAdmin = await signIn(harness, ADMIN)
    await submit(harness, cookieA, 'From A')
    await submit(harness, cookieB, 'From B')

    const response = await all(harness, cookieAdmin)
    assert.equal(response.status, 200)
    const { requests } = (await response.json()) as { requests: ChangeRequest[] }
    assert.equal(requests.length, 2)
  })
})

describe('resolve', () => {
  it('is admin-only, the request’s own author included', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const request = await submit(harness, cookieA)
    const response = await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'asDesigned' }, cookieA),
    )
    assert.equal(response.status, 403)
  })

  it('accepts asDesigned and outOfScope, with an optional note', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    const response = await harness.app.request(
      ...post(
        `/api/admin/change-requests/${request.id}/resolve`,
        { type: 'outOfScope', note: 'Not planned' },
        cookieAdmin,
      ),
    )
    assert.equal(response.status, 200)
    const { request: resolved } = (await response.json()) as { request: ChangeRequest }
    assert.equal(resolved.resolution?.type, 'outOfScope')
    assert.equal(resolved.resolution?.note, 'Not planned')
    assert.equal(resolved.resolution?.resolvedBy, 'Admin One')
    assert.equal(resolved.resolution?.commitHash, null)
  })

  it('requires commitHash and commitSubject for a commit resolution', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    const missing = await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'commit' }, cookieAdmin),
    )
    assert.equal(missing.status, 400)

    const response = await harness.app.request(
      ...post(
        `/api/admin/change-requests/${request.id}/resolve`,
        { type: 'commit', commitHash: 'abc1234', commitSubject: 'Fix the thing' },
        cookieAdmin,
      ),
    )
    assert.equal(response.status, 200)
    const { request: resolved } = (await response.json()) as { request: ChangeRequest }
    assert.equal(resolved.resolution?.commitHash, 'abc1234')
    assert.equal(resolved.resolution?.commitSubject, 'Fix the thing')
  })

  it('may resolve an already-canceled request — cancel and resolve are orthogonal', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)
    await harness.app.request(...post(`/api/change-requests/${request.id}/cancel`, {}, cookieA))

    const response = await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'outOfScope' }, cookieAdmin),
    )
    assert.equal(response.status, 200)
    const { request: resolved } = (await response.json()) as { request: ChangeRequest }
    assert.ok(resolved.canceledAt)
    assert.equal(resolved.resolution?.type, 'outOfScope')
  })

  it('may be called again to correct a prior resolution — not single-shot like a trade', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)

    await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'outOfScope' }, cookieAdmin),
    )
    const second = await harness.app.request(
      ...post(
        `/api/admin/change-requests/${request.id}/resolve`,
        { type: 'commit', commitHash: 'deadbee', commitSubject: 'Actually fixed' },
        cookieAdmin,
      ),
    )
    assert.equal(second.status, 200)
    const { request: resolved } = (await second.json()) as { request: ChangeRequest }
    assert.equal(resolved.resolution?.type, 'commit')
    assert.equal(resolved.resolution?.commitHash, 'deadbee')
  })

  it('rejects an unknown resolution type', async () => {
    const harness = await createHarness()
    const cookieA = await signIn(harness, MEMBER_A)
    const cookieAdmin = await signIn(harness, ADMIN)
    const request = await submit(harness, cookieA)
    const response = await harness.app.request(
      ...post(`/api/admin/change-requests/${request.id}/resolve`, { type: 'nonsense' }, cookieAdmin),
    )
    assert.equal(response.status, 400)
  })
})

