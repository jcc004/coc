import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ImportResponse, OwnerBulkResponse, SavedClanRecord } from '@coc/shared'
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
import { MAX_BULK_ROWS, SAVED_CLAN_NAME_MAX } from './routes.ts'
import { createSharedDataStore, type SharedDataStore } from './store.ts'

/*
 * What the shared-data routes will and will not accept into the database.
 *
 * Two properties, both about a guarantee the code claimed and did not keep:
 *
 *  - the optional clan stats go through a function called `asPositiveIntOrUndefined`,
 *    which used to accept any finite number — so `members: -5` and `clanLevel: 0.5`
 *    both stored and both rendered in the table;
 *  - the bulk and import endpoints iterated as many rows as fit inside nginx's 10 MB
 *    body, and a saved clan's name had no maximum length at all.
 *
 * Asserted through the routes rather than against the helpers directly, because the
 * question is what ends up stored, and the store is where a bad value would live.
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const MEMBER = { email: 'teammate@example.test', password: 'second-user-password' }

const CLAN_TAG = '#G88CYQP'

interface Harness {
  app: ReturnType<typeof createApp>
  shared: SharedDataStore
  db: ReturnType<typeof openDatabase>
}

/*
 * `async` and awaiting the account creation even though it may not need it: the auth
 * store is moving its password work off the event loop, which makes creating an
 * account asynchronous. Awaiting a plain value is a no-op, so this reads correctly
 * either way.
 */
async function createHarness(): Promise<Harness> {
  const db = openDatabase(':memory:')
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: 'Admin One',
  })
  await auth.createUser({
    email: MEMBER.email,
    displayName: 'Teammate',
    password: MEMBER.password,
    role: 'user',
  })

  const shared = createSharedDataStore(db)
  const cards = createCardInventoryStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: shared,
    cards,
    trades: createTradeStore(db, cards),
    progress: createProgressStore(db),
    baseOrder: createBaseOrderStore(db),
    loginLimiter: createLoginLimiter(),
  })

  return { app, shared, db }
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
  const value = response.headers
    .get('set-cookie')
    ?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1]
  assert.ok(value, 'login should set a session cookie')
  return `${SESSION_COOKIE}=${value}`
}

function send(
  method: string,
  path: string,
  body: unknown,
  cookie: string,
): [string, RequestInit] {
  return [
    path,
    {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    },
  ]
}

/** The 400 body, asserted to be a `badRequest` whose message mentions `expected`. */
async function assertRejected(response: Response, expected: RegExp): Promise<void> {
  assert.equal(response.status, 400)
  const body = (await response.json()) as { error: { reason: string; message: string } }
  assert.equal(body.error.reason, 'badRequest')
  assert.match(body.error.message, expected)
}

describe('a saved clan’s optional stats are whole numbers above zero, or absent', () => {
  /** Saves a clan with `extra` merged in and returns the row the server stored. */
  async function saveWith(
    harness: Harness,
    cookie: string,
    extra: Record<string, unknown>,
  ): Promise<SavedClanRecord> {
    const response = await harness.app.request(
      ...send('POST', '/api/saved/clans', { tag: CLAN_TAG, name: 'Reddit', ...extra }, cookie),
    )
    assert.equal(response.status, 200)
    return ((await response.json()) as { clan: SavedClanRecord }).clan
  }

  it('keeps a positive whole number', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const clan = await saveWith(harness, cookie, { clanLevel: 27, members: 48, clanPoints: 41_234 })
    assert.equal(clan.clanLevel, 27)
    assert.equal(clan.members, 48)
    assert.equal(clan.clanPoints, 41_234)
    harness.db.close()
  })

  it('drops a negative member count instead of storing it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    // `members: -5` used to store and render. Dropping the stat rather than
    // refusing the request is deliberate: the tag and the name are what the user
    // asked to keep, and an absent stat renders as a dash.
    const clan = await saveWith(harness, cookie, { members: -5 })
    assert.equal(clan.members, undefined)
    assert.equal(clan.name, 'Reddit', 'the clan itself is still saved')
    harness.db.close()
  })

  it('drops a fractional clan level instead of storing it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    assert.equal((await saveWith(harness, cookie, { clanLevel: 0.5 })).clanLevel, undefined)
    harness.db.close()
  })

  it('drops a zero, because no clan is level zero', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const clan = await saveWith(harness, cookie, { clanLevel: 0, members: 0, clanPoints: 0 })
    assert.deepEqual(
      [clan.clanLevel, clan.members, clan.clanPoints],
      [undefined, undefined, undefined],
    )
    harness.db.close()
  })

  it('drops anything that is not a number at all', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    for (const value of ['27', null, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const clan = await saveWith(harness, cookie, { clanLevel: value })
      assert.equal(clan.clanLevel, undefined, `${JSON.stringify(value)} is not a clan level`)
    }
    harness.db.close()
  })

  it('drops a bad stat per field, keeping the good ones beside it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const clan = await saveWith(harness, cookie, { clanLevel: 27, members: -5, clanPoints: 1.5 })
    assert.equal(clan.clanLevel, 27)
    assert.equal(clan.members, undefined)
    assert.equal(clan.clanPoints, undefined)
    harness.db.close()
  })
})

describe('a saved clan’s name has a maximum length', () => {
  const name = (length: number) => 'x'.repeat(length)

  it('accepts a name right at the limit', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send('POST', '/api/saved/clans', { tag: CLAN_TAG, name: name(SAVED_CLAN_NAME_MAX) }, cookie),
    )
    assert.equal(response.status, 200)
    harness.db.close()
  })

  it('refuses one character past the limit, and stores nothing', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send(
        'POST',
        '/api/saved/clans',
        { tag: CLAN_TAG, name: name(SAVED_CLAN_NAME_MAX + 1) },
        cookie,
      ),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string; hint?: string } }
    assert.equal(body.error.reason, 'badRequest')
    assert.match(body.error.hint ?? '', new RegExp(String(SAVED_CLAN_NAME_MAX)), 'name the limit')
    assert.deepEqual(harness.shared.listSavedClans(), [])
    harness.db.close()
  })

  it('refuses an over-long rename, naming the limit and the length sent', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    await harness.app.request(
      ...send('POST', '/api/saved/clans', { tag: CLAN_TAG, name: 'Reddit' }, cookie),
    )

    const response = await harness.app.request(
      ...send('PATCH', `/api/saved/clans/${encodeURIComponent(CLAN_TAG)}`, { name: name(200) }, cookie),
    )
    await assertRejected(response, new RegExp(`${SAVED_CLAN_NAME_MAX}.*200`))
    assert.equal(harness.shared.listSavedClans()[0]?.name, 'Reddit', 'the label is unchanged')
    harness.db.close()
  })

  it('drops an over-long name from an import rather than refusing the whole upload', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send(
        'POST',
        '/api/import',
        {
          clans: [
            { tag: CLAN_TAG, name: name(SAVED_CLAN_NAME_MAX + 1) },
            { tag: '#2GCJ2QPU', name: 'Fine' },
          ],
        },
        cookie,
      ),
    )
    assert.equal(response.status, 200)

    // One bad row in a browser's whole localStorage must not cost the user the other
    // rows, so the upload succeeds and the good row lands.
    //
    // The dropped row IS counted, in `invalid`. It used not to be: rows the route's
    // own parsing rejected never reached the store that does the counting, so they
    // fell out of the summary altogether and a two-row import reported one.
    // `ImportCounts.invalid` now reads "rows the server could make no use of" rather
    // than "not a usable tag", so that this row has somewhere to be counted.
    const body = (await response.json()) as ImportResponse
    assert.equal(body.clans.applied, 1)
    assert.equal(body.clans.invalid, 1)
    assert.deepEqual(
      harness.shared.listSavedClans().map((clan) => clan.name),
      ['Fine'],
    )
    harness.db.close()
  })
})

describe('the bulk owner apply has a maximum row count', () => {
  /** `count` distinct, valid rows — what an honest oversized request looks like. */
  const rows = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      tag: `#TAG${index}`,
      owner: 'Sam',
      expectedOwner: '',
    }))

  it('accepts a request right at the cap', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send('POST', '/api/owners/bulk', { rows: rows(MAX_BULK_ROWS) }, cookie),
    )
    assert.equal(response.status, 200)
    assert.equal(((await response.json()) as OwnerBulkResponse).applied.length, MAX_BULK_ROWS)
    harness.db.close()
  })

  it('refuses one row past the cap, names the limit, and writes nothing', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send('POST', '/api/owners/bulk', { rows: rows(MAX_BULK_ROWS + 1) }, cookie),
    )
    await assertRejected(response, new RegExp(`${MAX_BULK_ROWS + 1}.*${MAX_BULK_ROWS}`))
    assert.deepEqual(harness.shared.listOwners(), [], 'all-or-nothing, like the rest of this route')
    harness.db.close()
  })

  it('counts the raw array, so padding with junk cannot hide the size', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    // `asRecordArray` would drop every one of these, but parsing and walking them
    // is the cost being bounded, and it is paid before the filter runs.
    const junk = Array.from({ length: MAX_BULK_ROWS + 1 }, () => null)
    const response = await harness.app.request(
      ...send('POST', '/api/owners/bulk', { rows: junk }, cookie),
    )
    await assertRejected(response, new RegExp(String(MAX_BULK_ROWS)))
    harness.db.close()
  })

  it('leaves a non-array body to the existing behavior rather than 400ing on size', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    // No rows is a no-op, not an error — the cap must not change that.
    for (const body of [{ rows: [] }, { rows: 'nope' }, {}]) {
      const response = await harness.app.request(...send('POST', '/api/owners/bulk', body, cookie))
      assert.equal(response.status, 200)
    }
    harness.db.close()
  })

  it('is still admin-only — the cap is checked behind the permission, not in front of it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, MEMBER)

    // A member gets the 403 they always got, and never learns the limit; an
    // oversized body from an unauthorized caller is not a validation problem.
    const response = await harness.app.request(
      ...send('POST', '/api/owners/bulk', { rows: rows(MAX_BULK_ROWS + 1) }, cookie),
    )
    assert.equal(response.status, 403)
    harness.db.close()
  })
})

describe('the import has a maximum row count on each half', () => {
  const owners = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({ tag: `#TAG${index}`, owner: 'Sam' }))
  const clans = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({ tag: `#TAG${index}`, name: `Clan ${index}` }))

  it('accepts both halves right at the cap', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send(
        'POST',
        '/api/import',
        { owners: owners(MAX_BULK_ROWS), clans: clans(MAX_BULK_ROWS) },
        cookie,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as ImportResponse
    assert.equal(body.owners.applied, MAX_BULK_ROWS)
    assert.equal(body.clans.applied, MAX_BULK_ROWS)
    harness.db.close()
  })

  it('refuses an oversized owners array and imports neither half', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send(
        'POST',
        '/api/import',
        { owners: owners(MAX_BULK_ROWS + 1), clans: clans(1) },
        cookie,
      ),
    )
    await assertRejected(response, /owners carries 201 rows/)
    assert.deepEqual(harness.shared.listSavedClans(), [], 'the good half is not applied either')
    assert.deepEqual(harness.shared.listOwners(), [])
    harness.db.close()
  })

  it('refuses an oversized clans array the same way', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...send('POST', '/api/import', { clans: clans(MAX_BULK_ROWS + 1) }, cookie),
    )
    await assertRejected(response, /clans carries 201 rows/)
    assert.deepEqual(harness.shared.listSavedClans(), [])
    harness.db.close()
  })

  it('refuses a non-admin’s oversized owners array before refusing their owner rows', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, MEMBER)

    // The import route itself is open to members — only its owner half is refused —
    // so the size check has to apply to them too, or the cap is optional.
    const response = await harness.app.request(
      ...send('POST', '/api/import', { owners: owners(MAX_BULK_ROWS + 1) }, cookie),
    )
    await assertRejected(response, new RegExp(String(MAX_BULK_ROWS)))
    harness.db.close()
  })

  it('still accepts an empty or absent import', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    for (const body of [{}, { owners: [], clans: [] }]) {
      const response = await harness.app.request(...send('POST', '/api/import', body, cookie))
      assert.equal(response.status, 200)
    }
    harness.db.close()
  })
})

/*
 * The import summary has to account for every row the client sent.
 *
 * `applied + skipped + invalid + refused` is shown to the user as the story of what
 * became of their browser data, and it used to come up short: rows the route's own
 * parsing rejected — no tag, no name, a name past the cap — were filtered out before
 * the store could count them, so they vanished from the arithmetic entirely. An
 * import of forty clans reporting thirty-nine is a summary nobody can check, and the
 * row it loses is the one worth asking about.
 */
describe('every imported row is accounted for', () => {
  const total = (counts: { applied: number; skipped: number; invalid: number; refused?: number }) =>
    counts.applied + counts.skipped + counts.invalid + (counts.refused ?? 0)

  it('counts a clan the route drops, rather than losing it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const sent = [
      { tag: CLAN_TAG, name: 'Perfectly Fine' },
      { tag: '#G88CYQQ', name: '' }, // no name
      { tag: '', name: 'No tag' }, // no tag
      { tag: '#G88CYQR', name: 'x'.repeat(SAVED_CLAN_NAME_MAX + 1) }, // name too long
      { tag: '#G88CYQS' }, // no name at all
    ]

    const response = await harness.app.request(...send('POST', '/api/import', { clans: sent }, cookie))
    assert.equal(response.status, 200)
    const body = (await response.json()) as ImportResponse

    assert.equal(body.clans.applied, 1)
    assert.equal(body.clans.invalid, 4)
    assert.equal(total(body.clans), sent.length, 'the counts must add up to what was sent')
    // And only the good one was stored.
    assert.deepEqual(
      harness.shared.listSavedClans().map((clan) => clan.tag),
      [CLAN_TAG],
    )
    harness.db.close()
  })

  it('counts an owner row the route drops', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const sent = [
      { tag: '#PLAYER1', owner: 'Someone' },
      { tag: '', owner: 'Nobody' }, // no tag: dropped by the route
      { tag: '#PLAYER2', owner: '' }, // no owner: rejected by the store
    ]

    const response = await harness.app.request(...send('POST', '/api/import', { owners: sent }, cookie))
    const body = (await response.json()) as ImportResponse

    assert.equal(body.owners.applied, 1)
    assert.equal(body.owners.invalid, 2)
    assert.equal(total(body.owners), sent.length)
    harness.db.close()
  })

  it('counts a non-admin’s dropped owner rows as refused, and not twice', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, MEMBER)

    // A member's owner rows are refused unexamined. A dropped row must be reported
    // once — as refused — or the total would overshoot what was sent.
    const sent = [{ tag: '#PLAYER1', owner: 'Someone' }, { tag: '', owner: 'Nobody' }]

    const response = await harness.app.request(...send('POST', '/api/import', { owners: sent }, cookie))
    const body = (await response.json()) as ImportResponse

    assert.equal(body.owners.refused, sent.length)
    assert.equal(body.owners.invalid, 0)
    assert.equal(total(body.owners), sent.length)
    harness.db.close()
  })
})
