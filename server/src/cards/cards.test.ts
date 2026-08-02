import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { CARD_ID_MAX, CARD_SEASON, MAX_CARD_COUNT, type BaseInventory } from '@coc/shared'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { TtlCache } from '../cache.ts'
import { createChatStore } from '../chat/store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createSharedDataStore } from '../shared-data/store.ts'
import { createCardInventoryStore, type CardInventoryStore } from './store.ts'

/*
 * The card routes over the whole app, driven through `app.request` against an
 * in-memory database — the same shape as the auth and chat suites. Two accounts
 * throughout, because "shared, not per-user" is the property that matters and it
 * cannot be shown with one.
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const ADMIN_NAME = 'Admin One'
const SECOND = { email: 'teammate@example.test', password: 'second-user-password' }
const SECOND_NAME = 'Teammate'

const BASE_A = '#2GCJ2QPU'
const BASE_B = '#AAABBB'
const BASE_C = '#CCCDDD'

interface Harness {
  app: ReturnType<typeof createApp>
  cards: CardInventoryStore
  db: ReturnType<typeof openDatabase>
}

function createHarness(databasePath = ':memory:'): Harness {
  const db = openDatabase(databasePath)
  const auth = createAuthStore(db)
  bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: ADMIN_NAME,
  })
  // Tolerated rather than asserted, because the restart test boots the same file
  // twice and the second boot finds the account the first one made.
  try {
    auth.createUser({
      email: SECOND.email,
      displayName: SECOND_NAME,
      password: SECOND.password,
      role: 'user',
    })
  } catch {
    /* already there */
  }

  const cards = createCardInventoryStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    chat: createChatStore(db),
    sharedData: createSharedDataStore(db),
    cards,
    loginLimiter: createLoginLimiter(),
  })

  return { app, cards, db }
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

/** The path a base's counts live at. Tags are percent-encoded, `#` and all. */
const inventoryPath = (tag: string) => `/api/cards/inventory/${encodeURIComponent(tag)}`

function put(
  path: string,
  body: unknown,
  cookie?: string,
): [string, RequestInit] {
  return [
    path,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

async function save(
  harness: Harness,
  cookie: string,
  tag: string,
  counts: { cardId: number; count: number }[],
): Promise<Response> {
  return harness.app.request(...put(inventoryPath(tag), { counts }, cookie))
}

async function readAll(harness: Harness, cookie: string): Promise<BaseInventory[]> {
  const response = await harness.app.request('/api/cards/inventory', { headers: { cookie } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { season: string; bases: BaseInventory[] }
  assert.equal(body.season, CARD_SEASON)
  return body.bases
}

async function readOne(harness: Harness, cookie: string, tag: string): Promise<BaseInventory> {
  const response = await harness.app.request(inventoryPath(tag), { headers: { cookie } })
  assert.equal(response.status, 200)
  return ((await response.json()) as { base: BaseInventory }).base
}

describe('the card inventory is shared, not per-user', () => {
  it("shows user A's counts to user B, attributed and timestamped", async () => {
    const harness = createHarness()
    const a = await signIn(harness, ADMIN)
    const b = await signIn(harness, SECOND)

    const saved = await save(harness, a, BASE_A, [
      { cardId: 1, count: 2 },
      { cardId: 7, count: 1 },
    ])
    assert.equal(saved.status, 200)

    // B never wrote anything and sees it anyway — one canonical answer.
    const bases = await readAll(harness, b)
    assert.equal(bases.length, 1)
    assert.equal(bases[0]?.tag, BASE_A)
    assert.deepEqual(bases[0]?.counts, [
      { cardId: 1, count: 2 },
      { cardId: 7, count: 1 },
    ])
    assert.equal(bases[0]?.updatedBy, ADMIN_NAME)
    assert.ok(bases[0]?.updatedAt, 'the base must carry when it changed')
    harness.db.close()
  })

  it('reports the second writer as the one who last touched it', async () => {
    const harness = createHarness()
    const a = await signIn(harness, ADMIN)
    const b = await signIn(harness, SECOND)

    await save(harness, a, BASE_A, [{ cardId: 1, count: 2 }])
    await save(harness, b, BASE_A, [{ cardId: 1, count: 3 }])

    // Last-write-wins, which is fine here — but who won has to be visible.
    const base = await readOne(harness, a, BASE_A)
    assert.deepEqual(base.counts, [{ cardId: 1, count: 3 }])
    assert.equal(base.updatedBy, SECOND_NAME)
    harness.db.close()
  })

  it('canonicalises the tag, so #abc and %23ABC are one base', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, '2gcj2qpu', [{ cardId: 1, count: 2 }])
    await save(harness, cookie, '#2GCJ2QPU', [{ cardId: 2, count: 3 }])

    const bases = await readAll(harness, cookie)
    assert.equal(bases.length, 1, 'the two spellings must be one row set')
    assert.equal(bases[0]?.tag, BASE_A)
    assert.deepEqual(bases[0]?.counts, [{ cardId: 2, count: 3 }])
    harness.db.close()
  })

  it('answers for a base nobody has entered with an empty inventory, not a 404', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    const base = await readOne(harness, cookie, BASE_C)
    assert.equal(base.tag, BASE_C)
    assert.deepEqual(base.counts, [])
    assert.equal(base.updatedAt, undefined, 'nothing entered means no stamp to show')
    harness.db.close()
  })

  it('lists nothing at all before anyone has entered a count', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    assert.deepEqual(await readAll(harness, cookie), [])
    harness.db.close()
  })

  it('survives disabling the account that entered the counts', async () => {
    const harness = createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await save(harness, member, BASE_A, [{ cardId: 4, count: 2 }])

    const users = (await (
      await harness.app.request('/api/admin/users', { headers: { cookie: admin } })
    ).json()) as { users: { id: number; email: string }[] }
    const target = users.users.find((user) => user.email === SECOND.email)
    assert.ok(target)

    const disabled = await harness.app.request(`/api/admin/users/${target.id}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ disabled: true }),
    })
    assert.equal(disabled.status, 200)

    // Disabling is not deleting, so both the counts and the attribution survive.
    const base = await readOne(harness, admin, BASE_A)
    assert.deepEqual(base.counts, [{ cardId: 4, count: 2 }])
    assert.equal(base.updatedBy, SECOND_NAME)
    harness.db.close()
  })
})

describe('a whole base is written in one request', () => {
  it('replaces the base rather than merging into it', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [
      { cardId: 1, count: 2 },
      { cardId: 2, count: 3 },
    ])
    // Card 2 is simply absent the second time, which must mean "no longer held".
    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 4 }])

    assert.deepEqual((await readOne(harness, cookie, BASE_A)).counts, [{ cardId: 1, count: 4 }])
    harness.db.close()
  })

  it('treats a count of 0 as deleting the row rather than storing a zero', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [
      { cardId: 1, count: 2 },
      { cardId: 2, count: 1 },
    ])
    const zeroed = await save(harness, cookie, BASE_A, [
      { cardId: 1, count: 0 },
      { cardId: 2, count: 1 },
    ])
    assert.equal(zeroed.status, 200)

    assert.deepEqual((await readOne(harness, cookie, BASE_A)).counts, [{ cardId: 2, count: 1 }])

    // Sparse storage, asserted at the table rather than inferred from the API.
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM card_inventory WHERE player_tag = ?')
      .get(BASE_A)
    assert.equal(Number(rows?.['n']), 1, 'only the non-zero card should have a row')
    harness.db.close()
  })

  it('never stores sixty rows for a base', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    // What the entry screen holds: all sixty boxes, most of them empty.
    const everyBox = Array.from({ length: CARD_ID_MAX }, (_, index) => ({
      cardId: index + 1,
      count: index < 3 ? 2 : 0,
    }))
    assert.equal((await save(harness, cookie, BASE_A, everyBox)).status, 200)

    const rows = harness.db.prepare('SELECT COUNT(*) AS n FROM card_inventory').get()
    assert.equal(Number(rows?.['n']), 3)
    harness.db.close()
  })

  it('empties a base when every count is zero', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])
    assert.equal((await save(harness, cookie, BASE_A, [{ cardId: 1, count: 0 }])).status, 200)

    // No rows left, so the base drops out of the list entirely — and with it the
    // stamp, since the stamp is derived from the rows.
    assert.deepEqual(await readAll(harness, cookie), [])
    const emptied = await readOne(harness, cookie, BASE_A)
    assert.deepEqual(emptied.counts, [])
    assert.equal(emptied.updatedAt, undefined)
    harness.db.close()
  })

  it('accepts an empty list, and keeps the bases either side of it', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])
    await save(harness, cookie, BASE_B, [{ cardId: 2, count: 2 }])
    assert.equal((await save(harness, cookie, BASE_A, [])).status, 200)

    const bases = await readAll(harness, cookie)
    assert.deepEqual(
      bases.map((b) => b.tag),
      [BASE_B],
    )
    harness.db.close()
  })

  it('returns the base it just wrote, so the client need not re-read', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await save(harness, cookie, BASE_A, [{ cardId: 9, count: 5 }])
    const body = (await response.json()) as { season: string; base: BaseInventory }
    assert.equal(body.season, CARD_SEASON)
    assert.equal(body.base.tag, BASE_A)
    assert.deepEqual(body.base.counts, [{ cardId: 9, count: 5 }])
    assert.equal(body.base.updatedBy, ADMIN_NAME)
    harness.db.close()
  })

  it('keeps bases independent of one another', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])
    await save(harness, cookie, BASE_B, [{ cardId: 1, count: 3 }])
    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 4 }])

    const bases = await readAll(harness, cookie)
    assert.deepEqual(
      bases.map((b) => [b.tag, b.counts]),
      [
        [BASE_A, [{ cardId: 1, count: 4 }]],
        [BASE_B, [{ cardId: 1, count: 3 }]],
      ],
    )
    harness.db.close()
  })
})

describe('a bad entry rejects the whole request', () => {
  /** Every rejection must be a 400 that changed nothing. */
  async function assertRejected(
    harness: Harness,
    cookie: string,
    counts: unknown,
    why: string,
  ): Promise<void> {
    const response = await harness.app.request(
      ...put(inventoryPath(BASE_A), { counts }, cookie),
    )
    assert.equal(response.status, 400, why)
    const body = (await response.json()) as { error: { reason: string; hint?: string } }
    assert.equal(body.error.reason, 'badRequest')
    assert.match(body.error.hint ?? '', /Nothing was written/)
  }

  it('refuses a count above the maximum', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(
      harness,
      cookie,
      [{ cardId: 1, count: MAX_CARD_COUNT + 1 }],
      'eleven copies is out of range',
    )
    assert.deepEqual(await readAll(harness, cookie), [])
    harness.db.close()
  })

  it('refuses a negative count', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, [{ cardId: 1, count: -1 }], 'negative is out of range')
    harness.db.close()
  })

  it('refuses a card id outside 1–60', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    for (const cardId of [0, -5, CARD_ID_MAX + 1, 999]) {
      await assertRejected(harness, cookie, [{ cardId, count: 1 }], `${cardId} is not a card`)
    }
    harness.db.close()
  })

  it('refuses a non-integer id or count', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, [{ cardId: 1.5, count: 1 }], 'fractional id')
    await assertRejected(harness, cookie, [{ cardId: 1, count: 2.5 }], 'fractional count')
    await assertRejected(harness, cookie, [{ cardId: '1', count: 1 }], 'id as a string')
    await assertRejected(harness, cookie, [{ cardId: 1, count: '2' }], 'count as a string')
    harness.db.close()
  })

  it('refuses a duplicated card id rather than letting the last one win', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(
      harness,
      cookie,
      [
        { cardId: 1, count: 2 },
        { cardId: 1, count: 5 },
      ],
      'one card, two answers',
    )
    harness.db.close()
  })

  it('refuses a body that is not a list of entries', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, undefined, 'no counts at all')
    await assertRejected(harness, cookie, 'nope', 'a string')
    await assertRejected(harness, cookie, [null], 'a null entry')
    await assertRejected(harness, cookie, [3], 'a bare number')
    harness.db.close()
  })

  it('leaves an already-good base exactly as it was', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [
      { cardId: 1, count: 2 },
      { cardId: 2, count: 3 },
    ])
    // One bad entry among four good ones: all four must be refused.
    await assertRejected(
      harness,
      cookie,
      [
        { cardId: 1, count: 5 },
        { cardId: 2, count: 5 },
        { cardId: 3, count: 5 },
        { cardId: 4, count: 99 },
      ],
      'one bad entry poisons the request',
    )

    assert.deepEqual((await readOne(harness, cookie, BASE_A)).counts, [
      { cardId: 1, count: 2 },
      { cardId: 2, count: 3 },
    ])
    harness.db.close()
  })

  it('rejects a tag that could never be a tag', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...put('/api/cards/inventory/%23!!', { counts: [] }, cookie),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string } }
    assert.equal(body.error.reason, 'invalidTag')
    harness.db.close()
  })
})

describe('the database is the last line on the count range', () => {
  it('refuses an out-of-range count even when the route is bypassed', async () => {
    const harness = createHarness()
    const insert = harness.db.prepare(
      `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )

    for (const [cardId, count] of [
      [1, 11],
      [1, -1],
      [0, 1],
      [CARD_ID_MAX + 1, 1],
    ] as const) {
      assert.throws(
        () => insert.run(CARD_SEASON, BASE_A, cardId, count, new Date().toISOString()),
        /CHECK constraint failed/,
        `card ${cardId} count ${count} must be refused by the schema`,
      )
    }
    harness.db.close()
  })

  it('keeps one row per season, base and card', async () => {
    const harness = createHarness()
    const insert = harness.db.prepare(
      `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    insert.run(CARD_SEASON, BASE_A, 1, 2, new Date().toISOString())
    assert.throws(
      () => insert.run(CARD_SEASON, BASE_A, 1, 3, new Date().toISOString()),
      /UNIQUE constraint failed|PRIMARY KEY/,
    )
    harness.db.close()
  })

  it('scopes rows to the season, so another season is a separate set', async () => {
    const harness = createHarness()
    const cookie = await signIn(harness, ADMIN)
    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])

    // A different season's row is invisible to every route, which is the whole
    // point of the constant: next August cannot merge into this August.
    harness.db
      .prepare(
        `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('2027-08', BASE_A, 5, 9, new Date().toISOString())

    assert.deepEqual((await readOne(harness, cookie, BASE_A)).counts, [{ cardId: 1, count: 2 }])
    assert.equal(harness.cards.listInventory('2027-08')[0]?.counts.length, 1)
    harness.db.close()
  })

  it('survives a restart, because the rows are on disk not in memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coc-cards-'))
    after(() => rmSync(dir, { recursive: true, force: true }))
    const databasePath = join(dir, 'coc.db')

    const first = createHarness(databasePath)
    const cookie = await signIn(first, ADMIN)
    await save(first, cookie, BASE_A, [{ cardId: 3, count: 6 }])
    first.db.close()

    // A second boot runs the migrations again and must find the same rows.
    const second = createHarness(databasePath)
    assert.deepEqual(second.cards.listInventory(CARD_SEASON)[0]?.counts, [{ cardId: 3, count: 6 }])
    second.db.close()
  })
})

describe('the card routes need a session', () => {
  it('401s every one of them anonymously, changing nothing', async () => {
    const harness = createHarness()
    const requests: [string, RequestInit][] = [
      ['/api/cards/inventory', {}],
      [inventoryPath(BASE_A), {}],
      put(inventoryPath(BASE_A), { counts: [{ cardId: 1, count: 2 }] }),
    ]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} should need a session`)
      const body = (await response.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'unauthenticated')
    }

    assert.deepEqual(harness.cards.listInventory(CARD_SEASON), [])
    harness.db.close()
  })

  it('is not an admin-only area — an ordinary member reads and writes', async () => {
    const harness = createHarness()
    const member = await signIn(harness, SECOND)

    assert.equal((await save(harness, member, BASE_A, [{ cardId: 1, count: 2 }])).status, 200)
    assert.equal((await readAll(harness, member)).length, 1)
    harness.db.close()
  })
})
