import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeTagForPath } from '@coc/shared'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { TtlCache } from '../cache.ts'
import { createCardInventoryStore } from '../cards/store.ts'
import { createTradeStore } from '../cards/trades-store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createSharedDataStore } from './store.ts'

/*
 * A malformed percent-escape in a tag path segment must be a 400, on every route
 * that takes a tag.
 *
 * The regression: Hono decodes a path parameter before a handler sees it, so
 * `/%25ZZ` arrives as the literal `%ZZ`, and `normalizeTag` called
 * `decodeURIComponent` on it a second time. The resulting `URIError` is not an
 * `InvalidTagError`, so it missed the branch in `createApp`'s `onError` that answers
 * 400 and fell through to the generic 500 — plus a stack trace on stderr for any
 * signed-in caller who cared to repeat the request.
 *
 * `shared/src/tags.test.ts` proves the fix at the unit level. This file proves the
 * status code, which is the part the unit test cannot see.
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }

/** Three spellings that used to 500. `%25` is a percent by the time a handler sees it. */
const MALFORMED = ['%25', '%25ZZ', '%25E0%25A4%25A'] as const

interface Harness {
  app: ReturnType<typeof createApp>
  db: ReturnType<typeof openDatabase>
}

/*
 * `async` and awaiting the bootstrap even though it may not need it: the auth store
 * is moving its password work off the event loop, which makes account creation
 * asynchronous. Awaiting a plain value is a no-op, so this reads correctly either
 * way and does not have to be revisited when that lands.
 */
async function createHarness(): Promise<Harness> {
  /*
   * The stub calls `encodeTagForPath` exactly as the real client does — it is the
   * first thing every method in `coc-client.ts` does, and it is where the throw came
   * from on the player and clan routes. A stub that skipped it would make this test
   * pass for the wrong reason.
   */
  const coc = {
    getPlayer: async (tag: string) => ({ tag: encodeTagForPath(tag), name: 'Stub Player' }),
    getClan: async (tag: string) => ({ tag: encodeTagForPath(tag), name: 'Stub Clan' }),
    getClanMembers: async (tag: string) => ({ tag: encodeTagForPath(tag), items: [] }),
    getCurrentWar: async (tag: string) => ({ tag: encodeTagForPath(tag), state: 'notInWar' }),
    getWarLog: async (tag: string) => ({ tag: encodeTagForPath(tag), items: [] }),
    getCapitalRaidSeasons: async (tag: string) => ({ tag: encodeTagForPath(tag), items: [] }),
    searchClans: async () => ({ items: [] }),
  } as unknown as CocClient

  const db = openDatabase(':memory:')
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: 'Admin One',
  })

  const cards = createCardInventoryStore(db)
  const app = createApp({
    coc,
    cache: new TtlCache(60_000),
    auth,
    sharedData: createSharedDataStore(db),
    cards,
    trades: createTradeStore(db, cards),
    loginLimiter: createLoginLimiter(),
  })

  return { app, db }
}

async function signIn(harness: Harness): Promise<string> {
  const response = await harness.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  })
  assert.equal(response.status, 200, 'the bootstrapped admin should sign in')
  const value = response.headers
    .get('set-cookie')
    ?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
  assert.ok(value, 'login should set a session cookie')
  return `${SESSION_COOKIE}=${value}`
}

/** Asserts the app answered 400 `invalidTag` with the rule as a hint, not a 500. */
async function assertInvalidTag(
  harness: Harness,
  path: string,
  init: RequestInit,
  cookie: string,
): Promise<void> {
  const response = await harness.app.request(path, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie },
  })
  assert.equal(response.status, 400, `${init.method ?? 'GET'} ${path} must be a 400, not a 500`)

  const body = (await response.json()) as { error: { reason: string; hint?: string } }
  assert.equal(body.error.reason, 'invalidTag')
  assert.match(body.error.hint ?? '', /3–12 alphanumeric/, 'and must carry the tag rule')
}

describe('a malformed percent-escape in a tag is a 400, not a 500', () => {
  it('refuses it on the player lookup', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness)
    for (const tag of MALFORMED) {
      await assertInvalidTag(harness, `/api/players/${tag}`, {}, cookie)
    }
    harness.db.close()
  })

  it('refuses it on every clan route that takes a tag', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness)
    for (const suffix of ['', '/currentwar', '/warlog', '/capitalraidseasons', '/members']) {
      await assertInvalidTag(harness, `/api/clans/%25ZZ${suffix}`, {}, cookie)
    }
    harness.db.close()
  })

  it('refuses it on the card inventory, reading and writing', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness)

    for (const tag of MALFORMED) {
      await assertInvalidTag(harness, `/api/cards/inventory/${tag}`, {}, cookie)
    }
    // The write reaches `normalizeTag` through the ownership lookup, before the
    // body is parsed — so a bad tag is a 400 whatever the payload says.
    await assertInvalidTag(
      harness,
      '/api/cards/inventory/%25ZZ',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ counts: [] }),
      },
      cookie,
    )
    harness.db.close()
  })

  it('refuses it on the saved-clan and owner writes', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness)

    const requests: [string, RequestInit][] = [
      ['/api/saved/clans/%25ZZ', { method: 'DELETE' }],
      [
        '/api/saved/clans/%25ZZ',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Anything' }),
        },
      ],
      ['/api/owners/%25ZZ', { method: 'DELETE' }],
    ]

    for (const [path, init] of requests) await assertInvalidTag(harness, path, init, cookie)
    harness.db.close()
  })

  it('answers a well-formed tag normally, so the fix refuses nothing it should not', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness)

    // The control. `%23ABC` and a bare `ABC` are the same base, and both still work —
    // the decode was kept for exactly this, it just stopped being allowed to throw.
    for (const tag of ['ABC', '%23ABC', 'abc123', '2GCJ2QPU']) {
      const response = await harness.app.request(`/api/players/${tag}`, { headers: { cookie } })
      assert.equal(response.status, 200, `${tag} is a usable tag and must still be looked up`)
    }

    const inventory = await harness.app.request('/api/cards/inventory/%23ABC', {
      headers: { cookie },
    })
    assert.equal(inventory.status, 200)
    harness.db.close()
  })
})
