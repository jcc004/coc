import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { createBaseOrderStore } from '../base-order/store.ts'
import { TtlCache } from '../cache.ts'
import { createCardInventoryStore, type CardInventoryStore } from '../cards/store.ts'
import { createTradeStore } from '../cards/trades-store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createSharedDataStore, type SharedDataStore } from '../shared-data/store.ts'
import { currentWeekStart } from './routes.ts'
import { createProgressStore, type ProgressStore } from './store.ts'

/*
 * The progress routes over the whole app, driven through `app.request` — the
 * same shape `cards/cards.test.ts` uses. Two accounts, because the property
 * that matters is the same as cards': reads are shared, writes are the
 * owner's (or an admin's).
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const ADMIN_NAME = 'Admin One'
const SECOND = { email: 'teammate@example.test', password: 'second-user-password' }
const SECOND_NAME = 'Teammate'

const BASE_A = '#2GCJ2QPU'
const BASE_B = '#AAABBB'

interface Harness {
  app: ReturnType<typeof createApp>
  progress: ProgressStore
  cards: CardInventoryStore
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
  const progress = createProgressStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: shared,
    cards,
    trades: createTradeStore(db, cards),
    progress,
    baseOrder: createBaseOrderStore(db),
    loginLimiter: createLoginLimiter(),
  })

  return { app, progress, cards, auth, shared, db }
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

function putManual(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  return [
    path,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

const manualPath = (tag: string) => `/api/progress/${encodeURIComponent(tag)}/manual`
const historyPath = (tag: string) => `/api/progress/${encodeURIComponent(tag)}`

function putReference(category: string, body: unknown, cookie?: string): [string, RequestInit] {
  return [
    `/api/admin/progress/reference/${category}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

describe('currentWeekStart', () => {
  it('names itself on a Tuesday', () => {
    // 2026-08-04 is a Tuesday.
    assert.equal(currentWeekStart(new Date('2026-08-04T15:00:00Z')), '2026-08-04')
  })

  it('rolls a Monday back to the previous Tuesday', () => {
    // 2026-08-03 is a Monday, one day short of the next Tuesday.
    assert.equal(currentWeekStart(new Date('2026-08-03T15:00:00Z')), '2026-07-28')
  })

  it('rolls a Sunday back to the Tuesday five days earlier', () => {
    // 2026-08-09 is a Sunday.
    assert.equal(currentWeekStart(new Date('2026-08-09T15:00:00Z')), '2026-08-04')
  })
})

describe('reading progress is shared, not per-user', () => {
  it("shows one base's history to a member who never wrote it", async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const saved = await harness.app.request(
      ...putManual(manualPath(BASE_A), { buildingsLeft: '3', notes: 'almost there' }, admin),
    )
    assert.equal(saved.status, 200)

    const response = await harness.app.request(historyPath(BASE_A), { headers: { cookie: member } })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { history: { buildingsLeft: string | null }[] }
    assert.equal(body.history.length, 1)
    assert.equal(body.history[0]?.buildingsLeft, '3')
    harness.db.close()
  })

  it('answers an empty history for a base nobody has entered', async () => {
    const harness = await createHarness()
    const cookie = await signIn(harness, ADMIN)

    const response = await harness.app.request(historyPath(BASE_B), { headers: { cookie } })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { history: unknown[] }
    assert.deepEqual(body.history, [])
    harness.db.close()
  })

  it('lists the latest week for every known base, and omits one with no rows', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    // BASE_B is a known base (it has an owner) but nobody has captured progress for it.
    await assignBase(harness, admin, BASE_B, idOf(harness, SECOND.email))

    await harness.app.request(...putManual(manualPath(BASE_A), { buildingsLeft: 'DONE!' }, admin))

    const response = await harness.app.request('/api/progress', { headers: { cookie: admin } })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { bases: { playerTag: string }[] }
    assert.deepEqual(
      body.bases.map((b) => b.playerTag),
      [BASE_A],
      'BASE_B has an owner but no progress row, so it must be absent, not a placeholder',
    )
    harness.db.close()
  })

  it('also lists a base that has a captured row but no owner assignment', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    // No letter 'O': normalizeTag folds it into '0', which would make this tag
    // silently disagree with the literal string this test asserts against.
    const NO_OWNER_BASE = '#UNCLAIMD1'

    // Nobody has claimed NO_OWNER_BASE — no assignBase call for it — but the
    // scheduled job has captured a week for it anyway (the clan-roster union this
    // route now reads through getAllTrackedTags).
    harness.progress.upsertSnapshot(
      NO_OWNER_BASE,
      '2026-08-04',
      { auto: { thLevel: 12 } },
      { source: 'auto' },
    )

    const response = await harness.app.request('/api/progress', { headers: { cookie: admin } })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { bases: { playerTag: string }[] }
    assert.deepEqual(
      body.bases.map((b) => b.playerTag),
      [NO_OWNER_BASE],
      'a captured base with no owner must still appear, since progress needs no ownership to read',
    )
    harness.db.close()
  })
})

describe('the reference tables are open to any member', () => {
  it('serves both reference tables, and the static path wins over /:tag', async () => {
    const harness = await createHarness()
    const member = await signIn(harness, SECOND)

    harness.progress.upsertMaxLevelReference([
      { category: 'hero', name: 'Barbarian King', thLevel: 17, maxLevel: 95 },
    ])
    harness.progress.upsertWallReference([{ thLevel: 17, maxWallLevel: 17, totalWallCount: 40 }])

    const response = await harness.app.request('/api/progress/reference', {
      headers: { cookie: member },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      maxLevels: { category: string; name: string; thLevel: number; maxLevel: number }[]
      walls: { thLevel: number; maxWallLevel: number; totalWallCount: number }[]
    }
    assert.deepEqual(
      body.maxLevels.map(({ category, name, thLevel, maxLevel }) => ({
        category,
        name,
        thLevel,
        maxLevel,
      })),
      [{ category: 'hero', name: 'Barbarian King', thLevel: 17, maxLevel: 95 }],
    )
    assert.deepEqual(
      body.walls.map(({ thLevel, maxWallLevel, totalWallCount }) => ({
        thLevel,
        maxWallLevel,
        totalWallCount,
      })),
      [{ thLevel: 17, maxWallLevel: 17, totalWallCount: 40 }],
    )
    harness.db.close()
  })
})

describe('only the base’s owner writes its manual progress', () => {
  it('lets the owner save walls, buildingsLeft and notes', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    const response = await harness.app.request(
      ...putManual(
        manualPath(BASE_A),
        { walls: { '17': 4, '16': 250 }, buildingsLeft: 'LOTS', notes: 'working on walls' },
        member,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      snapshot: {
        playerTag: string
        walls: Record<string, number> | null
        buildingsLeft: string | null
        notes: string | null
        capturedBy: 'auto' | 'import' | { userId: number; displayName: string | null }
      }
    }
    assert.equal(body.snapshot.playerTag, BASE_A)
    assert.deepEqual(body.snapshot.walls, { '17': 4, '16': 250 })
    assert.equal(body.snapshot.buildingsLeft, 'LOTS')
    assert.equal(body.snapshot.notes, 'working on walls')
    assert.deepEqual(body.snapshot.capturedBy, {
      userId: idOf(harness, SECOND.email),
      displayName: SECOND_NAME,
    })
    harness.db.close()
  })

  it('lets an admin write a base somebody else owns', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, SECOND.email))

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { buildingsLeft: '0' }, admin),
    )
    assert.equal(response.status, 200)
    harness.db.close()
  })

  it('refuses a member on somebody else’s base, and names the owner', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const member = await signIn(harness, SECOND)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { buildingsLeft: '1' }, member),
    )
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'forbidden')
    assert.match(body.error.message, /Admin One/)

    assert.deepEqual(harness.progress.getHistory(BASE_A), [])
    harness.db.close()
  })
})

describe('a manual capture rejects a bad value rather than store it', () => {
  it('refuses a buildingsLeft that is not a digit string, LOTS, or DONE!', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { buildingsLeft: 'kinda a lot' }, admin),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'badRequest')
    assert.match(body.error.message, /buildingsLeft/)

    assert.deepEqual(harness.progress.getHistory(BASE_A), [])
    harness.db.close()
  })

  it('refuses a walls value that is not a non-negative integer', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { walls: { '17': -1 } }, admin),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /walls/)
    harness.db.close()
  })
})

describe("manual walls are checked against the base's known Town Hall", () => {
  it('rejects a wall level above the max for the TH18 reference row', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    harness.progress.upsertSnapshot(
      BASE_A,
      currentWeekStart(new Date()),
      { auto: { thLevel: 18 } },
      { source: 'auto' },
    )
    harness.progress.upsertWallReference([{ thLevel: 18, maxWallLevel: 18, totalWallCount: 250 }])

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { walls: { '20': 1 } }, admin),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /walls\['20'\] is above the max wall level \(18\) for TH18\./)
    assert.deepEqual(
      harness.progress.getHistory(BASE_A).filter((snapshot) => snapshot.walls !== null),
      [],
    )
    harness.db.close()
  })

  it('rejects a wall total above the total the TH18 reference row allows', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    harness.progress.upsertSnapshot(
      BASE_A,
      currentWeekStart(new Date()),
      { auto: { thLevel: 18 } },
      { source: 'auto' },
    )
    harness.progress.upsertWallReference([{ thLevel: 18, maxWallLevel: 18, totalWallCount: 250 }])

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { walls: { '18': 200, '17': 100 } }, admin),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /walls add up to 300, above the 250 wall segments TH18 has\./)
    harness.db.close()
  })

  it("accepts a submission within the TH's known caps", async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    harness.progress.upsertSnapshot(
      BASE_A,
      currentWeekStart(new Date()),
      { auto: { thLevel: 18 } },
      { source: 'auto' },
    )
    harness.progress.upsertWallReference([{ thLevel: 18, maxWallLevel: 18, totalWallCount: 250 }])

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { walls: { '18': 200, '17': 50 } }, admin),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { snapshot: { walls: Record<string, number> | null } }
    assert.deepEqual(body.snapshot.walls, { '18': 200, '17': 50 })
    harness.db.close()
  })

  it('falls back to the basic non-negative check when this base has never been auto-captured', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    await assignBase(harness, admin, BASE_A, idOf(harness, ADMIN.email))
    // A wall reference row exists for TH18, but nothing ties this base to a TH
    // level yet, so there is no cap the server can attribute to it — the write
    // must not be blocked by a bound it cannot actually check.
    harness.progress.upsertWallReference([{ thLevel: 18, maxWallLevel: 18, totalWallCount: 250 }])

    const response = await harness.app.request(
      ...putManual(manualPath(BASE_A), { walls: { '99': 9999 } }, admin),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { snapshot: { walls: Record<string, number> | null } }
    assert.deepEqual(body.snapshot.walls, { '99': 9999 })
    harness.db.close()
  })
})

describe('the hand-entered reference categories (pet, equipment) are admin-only', () => {
  it('lets an admin write rows, and they show up in the shared reference table', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...putReference(
        'pet',
        [
          { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 },
          { name: 'Mighty Yak', thLevel: 9, maxLevel: 10 },
        ],
        admin,
      ),
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { ok: true; written: number }
    assert.equal(body.written, 2)

    const reference = await harness.app.request('/api/progress/reference', {
      headers: { cookie: admin },
    })
    const referenceBody = (await reference.json()) as {
      maxLevels: { category: string; name: string; thLevel: number; maxLevel: number }[]
    }
    assert.deepEqual(
      referenceBody.maxLevels
        .filter((row) => row.category === 'pet')
        .map(({ name, thLevel, maxLevel }) => ({ name, thLevel, maxLevel })),
      [
        { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 },
        { name: 'Mighty Yak', thLevel: 9, maxLevel: 10 },
      ],
    )
    harness.db.close()
  })

  it('refuses a non-admin, and writes nothing', async () => {
    const harness = await createHarness()
    const member = await signIn(harness, SECOND)

    const response = await harness.app.request(
      ...putReference('pet', [{ name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 }], member),
    )
    assert.equal(response.status, 403)
    assert.deepEqual(
      harness.progress.getAllMaxLevelReference().filter((row) => row.category === 'pet'),
      [],
    )
    harness.db.close()
  })

  it('rejects a category the wiki scrape already owns, so a manual edit cannot race it', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...putReference('hero', [{ name: 'Barbarian King', thLevel: 7, maxLevel: 5 }], admin),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'badRequest')
    assert.match(body.error.message, /hero/)
    assert.deepEqual(harness.progress.getAllMaxLevelReference(), [])
    harness.db.close()
  })

  it('rejects an unknown category outright', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...putReference('troop', [{ name: 'Barbarian', thLevel: 3, maxLevel: 3 }], admin),
    )
    assert.equal(response.status, 400)
    harness.db.close()
  })

  it('rejects the whole batch when one row is invalid, and writes none of it', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...putReference(
        'equipment',
        [
          { name: 'Giant Gauntlet', thLevel: 14, maxLevel: 18 },
          { name: 'Frozen Arrow', thLevel: 0, maxLevel: 18 },
        ],
        admin,
      ),
    )
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /thLevel/)
    assert.deepEqual(
      harness.progress.getAllMaxLevelReference().filter((row) => row.category === 'equipment'),
      [],
    )
    harness.db.close()
  })

  it('rejects a non-array body', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)

    const response = await harness.app.request(
      ...putReference('pet', { name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 }, admin),
    )
    assert.equal(response.status, 400)
    harness.db.close()
  })

  it('401s anonymously, changing nothing', async () => {
    const harness = await createHarness()
    const response = await harness.app.request(
      ...putReference('pet', [{ name: 'L.A.S.S.I', thLevel: 7, maxLevel: 5 }]),
    )
    assert.equal(response.status, 401)
    assert.deepEqual(harness.progress.getAllMaxLevelReference(), [])
    harness.db.close()
  })
})

describe('the progress routes need a session', () => {
  it('401s every one of them anonymously, changing nothing', async () => {
    const harness = await createHarness()
    const requests: [string, RequestInit][] = [
      [historyPath(BASE_A), {}],
      ['/api/progress', {}],
      putManual(manualPath(BASE_A), { buildingsLeft: '1' }),
    ]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} should need a session`)
    }

    assert.deepEqual(harness.progress.getHistory(BASE_A), [])
    harness.db.close()
  })
})
