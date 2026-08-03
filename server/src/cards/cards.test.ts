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
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createSharedDataStore, type SharedDataStore } from '../shared-data/store.ts'
import { createCardInventoryStore, type CardInventoryStore } from './store.ts'
import { createTradeStore } from './trades-store.ts'

/*
 * The card routes over the whole app, driven through `app.request` against an
 * in-memory database — the same shape as the auth suite. Two accounts
 * throughout, because the two properties that matter cannot be shown with one:
 * counts are **read** by everybody, and **written** only by whoever owns the base.
 *
 * The admin does most of the writing below because an admin may write any base.
 * Where a plain member writes, the base is assigned to them first, through the
 * same route an admin would really use.
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
  /** Exposed so a test can look up account ids and assert the owner column. */
  auth: ReturnType<typeof createAuthStore>
  shared: SharedDataStore
  db: ReturnType<typeof openDatabase>
}

// Async because seeding hashes two passwords, and scrypt is async now — see
// `auth/passwords.ts` for why a synchronous derivation was a denial of service.
async function createHarness(databasePath = ':memory:'): Promise<Harness> {
  const db = openDatabase(databasePath)
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: ADMIN_NAME,
  })
  // Tolerated rather than asserted, because the restart test boots the same file
  // twice and the second boot finds the account the first one made.
  try {
    await auth.createUser({
      email: SECOND.email,
      displayName: SECOND_NAME,
      password: SECOND.password,
      role: 'user',
    })
  } catch {
    /* already there */
  }

  const cards = createCardInventoryStore(db)
  const shared = createSharedDataStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: shared,
    cards,
    trades: createTradeStore(db, cards),
    loginLimiter: createLoginLimiter(),
  })

  return { app, cards, auth, shared, db }
}

/** The id of an account, by the email it was created with. */
function idOf(harness: Harness, email: string): number {
  const user = harness.auth.listUsers().find((row) => row.email === email)
  assert.ok(user, `${email} should exist`)
  return user.id
}

/**
 * Hands a base to an account the way an admin really does — through the route, so
 * these tests cannot pass on ownership the API would not have granted.
 */
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    const a = await signIn(harness, ADMIN)
    const b = await signIn(harness, SECOND)
    // B owns the base; the admin writes it anyway, which admins may.
    await assignBase(harness, a, BASE_A, idOf(harness, SECOND.email))

    await save(harness, a, BASE_A, [{ cardId: 1, count: 2 }])
    await save(harness, b, BASE_A, [{ cardId: 1, count: 3 }])

    // Last-write-wins, which is fine here — but who won has to be visible.
    const base = await readOne(harness, a, BASE_A)
    assert.deepEqual(base.counts, [{ cardId: 1, count: 3 }])
    assert.equal(base.updatedBy, SECOND_NAME)
    harness.db.close()
  })

  it('canonicalises the tag, so #abc and %23ABC are one base', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const base = await readOne(harness, cookie, BASE_C)
    assert.equal(base.tag, BASE_C)
    assert.deepEqual(base.counts, [])
    assert.equal(base.updatedAt, undefined, 'nothing entered means no stamp to show')
    harness.db.close()
  })

  it('lists nothing at all before anyone has entered a count', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    assert.deepEqual(await readAll(harness, cookie), [])
    harness.db.close()
  })

  it('survives disabling the account that entered the counts', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))
    assert.equal((await save(harness, member, BASE_A, [{ cardId: 4, count: 2 }])).status, 200)

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

describe('only the base’s owner writes its counts', () => {
  /** A 403 that changed nothing, and said something useful about why. */
  async function assertRefused(
    harness: Harness,
    cookie: string,
    tag: string,
    expectations: RegExp[],
  ): Promise<void> {
    const before = harness.cards.getInventory(CARD_SEASON, tag)
    const response = await save(harness, cookie, tag, [{ cardId: 1, count: 5 }])
    assert.equal(response.status, 403, `${tag} must not be writable by this caller`)

    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'forbidden')
    for (const pattern of expectations) assert.match(body.error.message, pattern)

    assert.deepEqual(
      harness.cards.getInventory(CARD_SEASON, tag).counts,
      before.counts,
      'a refused write must leave the base exactly as it was',
    )
  }

  it('lets the owner write the base assigned to them', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    assert.equal((await save(harness, member, BASE_A, [{ cardId: 1, count: 2 }])).status, 200)
    assert.deepEqual((await readOne(harness, member, BASE_A)).counts, [{ cardId: 1, count: 2 }])
    harness.db.close()
  })

  it('refuses a member on somebody else’s base, and names the owner', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    // The admin owns A; the member tries to write it.
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    await save(harness, admin, BASE_A, [{ cardId: 1, count: 2 }])

    // Naming the owner is what makes the refusal actionable rather than a wall.
    await assertRefused(harness, member, BASE_A, [/Admin One/, /#2GCJ2QPU/])
    harness.db.close()
  })

  it('lets an admin write a base somebody else owns', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    // Deliberate: an admin could reassign the base to themselves in one request,
    // so refusing this would only remove their way to fix somebody's mistake.
    const response = await save(harness, admin, BASE_A, [{ cardId: 3, count: 4 }])
    assert.equal(response.status, 200)
    assert.equal((await readOne(harness, admin, BASE_A)).updatedBy, ADMIN_NAME)
    harness.db.close()
  })

  it('lets an admin write a base nobody owns, and refuses a member the same base', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)

    assert.equal((await save(harness, admin, BASE_C, [{ cardId: 2, count: 1 }])).status, 200)
    // Nobody else has a claim to an unowned base.
    await assertRefused(harness, member, BASE_C, [/no owner/, /#CCCDDD/])
    harness.db.close()
  })

  it('grants nobody but admins the write when the owner is an unlinked name', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)

    // The state migration v6 leaves most of the live assignments in: a clan
    // member's name against a base, matching no account at all.
    await harness.app.request('/api/owners/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin },
      body: JSON.stringify({ rows: [{ tag: BASE_A, owner: 'Casey', expectedOwner: '' }] }),
    })
    assert.equal(harness.shared.getOwner(BASE_A)?.ownerUserId, null)

    await assertRefused(harness, member, BASE_A, [/Casey/, /not linked to an account/])
    // The admin is the way out of that state, in both senses.
    assert.equal((await save(harness, admin, BASE_A, [{ cardId: 1, count: 1 }])).status, 200)
    harness.db.close()
  })

  it('follows a reassignment: the new owner writes, the old one stops', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))
    assert.equal((await save(harness, member, BASE_A, [{ cardId: 1, count: 2 }])).status, 200)

    // Handed to the admin instead. Nothing is cached, so the next request obeys.
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    await assertRefused(harness, member, BASE_A, [/Admin One/])

    // …and clearing the assignment does not hand it back to them either.
    await harness.app.request(`/api/owners/${encodeURIComponent(BASE_A)}`, {
      method: 'DELETE',
      headers: { cookie: admin },
    })
    await assertRefused(harness, member, BASE_A, [/no owner/])
    harness.db.close()
  })

  it('refuses before it reads the body, so a bad payload is still a 403', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    // Whether a caller may write a base has nothing to do with whether their
    // payload parses, and a 403 that depended on the body would be a strange
    // thing to reason about — or to leak validation detail through.
    const response = await harness.app.request(
      ...put(inventoryPath(BASE_A), { counts: 'not a list' }, member),
    )
    assert.equal(response.status, 403)
    harness.db.close()
  })

  it('scopes ownership to the base, not to the member', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    // Owning one base is not a licence for the next one along.
    assert.equal((await save(harness, member, BASE_A, [{ cardId: 1, count: 2 }])).status, 200)
    await assertRefused(harness, member, BASE_B, [/no owner/])
    harness.db.close()
  })
})

describe('a whole base is written in one request', () => {
  it('replaces the base rather than merging into it', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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

  it('empties a base to zero cards but keeps its stamp', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])
    assert.equal((await save(harness, cookie, BASE_A, [{ cardId: 1, count: 0 }])).status, 200)

    // The counts really are gone — storage stays sparse …
    assert.equal(
      Number(harness.db.prepare('SELECT COUNT(*) AS n FROM card_inventory').get()?.['n']),
      0,
    )

    // … but "when was this last checked" must still answer, which is the whole
    // reason the stamp is its own table rather than a MAX() over the counts.
    const emptied = await readOne(harness, cookie, BASE_A)
    assert.deepEqual(emptied.counts, [])
    assert.ok(emptied.updatedAt, 'an emptied base keeps the time it was emptied')
    assert.equal(emptied.updatedBy, ADMIN_NAME)

    assert.deepEqual(
      (await readAll(harness, cookie)).map((b) => [b.tag, b.counts.length]),
      [[BASE_A, 0]],
      'and stays listed, rather than being silently forgotten',
    )
    harness.db.close()
  })

  it('records the stamp even when the very first save is empty', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    // Someone opened the base, found nothing worth recording, and saved. That is
    // a real check, and has to be logged as one or the base looks unvisited.
    assert.equal((await save(harness, cookie, BASE_A, [])).status, 200)

    const base = await readOne(harness, cookie, BASE_A)
    assert.deepEqual(base.counts, [])
    assert.ok(base.updatedAt)
    assert.equal(base.updatedBy, ADMIN_NAME)
    harness.db.close()
  })

  it('moves the stamp forward on every save, naming the latest editor', async () => {
    const harness = await createHarness()
    const a = await signIn(harness, ADMIN)
    const b = await signIn(harness, SECOND)
    await assignBase(harness, a, BASE_A, idOf(harness, SECOND.email))

    await save(harness, a, BASE_A, [{ cardId: 1, count: 2 }])
    const first = await readOne(harness, a, BASE_A)
    assert.ok(first.updatedAt)

    await save(harness, b, BASE_A, [{ cardId: 1, count: 3 }])
    const second = await readOne(harness, a, BASE_A)
    assert.ok(second.updatedAt)
    // Two saves can land in the same millisecond, so assert it never goes
    // backwards rather than that it strictly increased.
    assert.ok(second.updatedAt >= first.updatedAt, 'the stamp must not go backwards')
    assert.equal(second.updatedBy, SECOND_NAME, 'and must name whoever wrote last')
    harness.db.close()
  })

  it('keeps one stamp row per base, never one per card', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [
      { cardId: 1, count: 2 },
      { cardId: 2, count: 3 },
      { cardId: 3, count: 4 },
    ])
    await save(harness, cookie, BASE_B, [{ cardId: 1, count: 2 }])

    assert.equal(
      Number(harness.db.prepare('SELECT COUNT(*) AS n FROM card_base_updates').get()?.['n']),
      2,
      'two bases, two stamps — against four count rows',
    )
    harness.db.close()
  })

  it('accepts an empty list, and keeps the bases either side of it', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    await save(harness, cookie, BASE_A, [{ cardId: 1, count: 2 }])
    await save(harness, cookie, BASE_B, [{ cardId: 2, count: 2 }])
    assert.equal((await save(harness, cookie, BASE_A, [])).status, 200)

    const bases = await readAll(harness, cookie)
    assert.deepEqual(
      bases.map((b) => [b.tag, b.counts.length]),
      [
        [BASE_A, 0],
        [BASE_B, 1],
      ],
      "emptying A must not disturb B's counts",
    )
    harness.db.close()
  })

  it('returns the base it just wrote, so the client need not re-read', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, [{ cardId: 1, count: -1 }], 'negative is out of range')
    harness.db.close()
  })

  it('refuses a card id outside 1–60', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    for (const cardId of [0, -5, CARD_ID_MAX + 1, 999]) {
      await assertRejected(harness, cookie, [{ cardId, count: 1 }], `${cardId} is not a card`)
    }
    harness.db.close()
  })

  it('refuses a non-integer id or count', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, [{ cardId: 1.5, count: 1 }], 'fractional id')
    await assertRejected(harness, cookie, [{ cardId: 1, count: 2.5 }], 'fractional count')
    await assertRejected(harness, cookie, [{ cardId: '1', count: 1 }], 'id as a string')
    await assertRejected(harness, cookie, [{ cardId: 1, count: '2' }], 'count as a string')
    harness.db.close()
  })

  it('refuses a duplicated card id rather than letting the last one win', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)
    await assertRejected(harness, cookie, undefined, 'no counts at all')
    await assertRejected(harness, cookie, 'nope', 'a string')
    await assertRejected(harness, cookie, [null], 'a null entry')
    await assertRejected(harness, cookie, [3], 'a bare number')
    harness.db.close()
  })

  it('leaves an already-good base exactly as it was', async () => {
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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
    const harness = await createHarness()
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

    const first = await createHarness(databasePath)
    const cookie = await signIn(first, ADMIN)
    await save(first, cookie, BASE_A, [{ cardId: 3, count: 6 }])
    first.db.close()

    // A second boot runs the migrations again and must find the same rows.
    const second = await createHarness(databasePath)
    assert.deepEqual(second.cards.listInventory(CARD_SEASON)[0]?.counts, [{ cardId: 3, count: 6 }])
    second.db.close()
  })
})

describe('the card routes need a session', () => {
  it('401s every one of them anonymously, changing nothing', async () => {
    const harness = await createHarness()
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

  it('is not an admin-only area — a member reads everything and writes their own', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    assert.equal((await save(harness, member, BASE_A, [{ cardId: 1, count: 2 }])).status, 200)
    // Somebody else's base, read by the member: still 200, still the shared answer.
    assert.equal((await save(harness, admin, BASE_B, [{ cardId: 2, count: 1 }])).status, 200)
    assert.equal((await readAll(harness, member)).length, 2)
    harness.db.close()
  })
})
