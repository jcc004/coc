import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  CARD_SEASON,
  MAX_CARD_COUNT,
  type BaseInventory,
  type CardCount,
  type TradeRecord,
} from '@coc/shared'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { SESSION_COOKIE } from '../auth/middleware.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { createBaseOrderStore } from '../base-order/store.ts'
import { TtlCache } from '../cache.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createProgressStore } from '../progress/store.ts'
import { createSharedDataStore, type SharedDataStore } from '../shared-data/store.ts'
import { createCardInventoryStore, type CardInventoryStore } from './store.ts'
import { createTradeStore, type TradeStore } from './trades-store.ts'

/*
 * The Trade Tracker over the whole app, driven through `app.request` — the same
 * shape as `cards.test.ts`, but with **four** accounts, because that is the
 * smallest cast the rules need:
 *
 * - an admin, who may propose and resolve anything;
 * - two members owning one base each, who are the two parties to every trade
 *   below and can each resolve it;
 * - an outsider owning nothing, who is the one the rules must refuse.
 *
 * The counts are seeded through the real inventory route, so nothing here depends
 * on state the API would not have produced.
 */

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const ADMIN_NAME = 'Admin One'
const MEMBER_A = { email: 'a@example.test', password: 'member-a-password-1' }
const MEMBER_A_NAME = 'Ada'
const MEMBER_B = { email: 'b@example.test', password: 'member-b-password-1' }
const MEMBER_B_NAME = 'Bo'
const OUTSIDER = { email: 'c@example.test', password: 'outsider-password-1' }
const OUTSIDER_NAME = 'Cass'

/** `BASE_A < BASE_B`, which is the orientation every stored trade is in. */
const BASE_A = '#AAABBB'
const BASE_B = '#CCCDDD'

/** The two cards that change hands: A gives 1, B gives 2. */
const CARD_A = 1
const CARD_B = 2

interface Harness {
  app: ReturnType<typeof createApp>
  cards: CardInventoryStore
  trades: TradeStore
  auth: ReturnType<typeof createAuthStore>
  shared: SharedDataStore
  db: ReturnType<typeof openDatabase>
}

// Async because seeding hashes four passwords, and scrypt is async now — see
// `auth/passwords.ts` for why a synchronous derivation was a denial of service.
async function createHarness(databasePath = ':memory:'): Promise<Harness> {
  const db = openDatabase(databasePath)
  const auth = createAuthStore(db)
  await bootstrapAdmin(auth, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: ADMIN_NAME,
  })

  for (const [credentials, displayName] of [
    [MEMBER_A, MEMBER_A_NAME],
    [MEMBER_B, MEMBER_B_NAME],
    [OUTSIDER, OUTSIDER_NAME],
  ] as const) {
    try {
      await auth.createUser({
        email: credentials.email,
        displayName,
        password: credentials.password,
        role: 'user',
      })
    } catch {
      /* a second boot of the same file already has them */
    }
  }

  const cards = createCardInventoryStore(db)
  const trades = createTradeStore(db, cards)
  const shared = createSharedDataStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth,
    sharedData: shared,
    cards,
    trades,
    progress: createProgressStore(db),
    baseOrder: createBaseOrderStore(db),
    loginLimiter: createLoginLimiter(),
  })

  return { app, cards, trades, auth, shared, db }
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

function idOf(harness: Harness, email: string): number {
  const user = harness.auth.listUsers().find((row) => row.email === email)
  assert.ok(user, `${email} should exist`)
  return user.id
}

/** Hands a base to an account the way an admin really does — through the route. */
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

async function saveCounts(
  harness: Harness,
  cookie: string,
  tag: string,
  counts: CardCount[],
): Promise<void> {
  const response = await harness.app.request(
    `/api/cards/inventory/${encodeURIComponent(tag)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ counts }),
    },
  )
  assert.equal(response.status, 200, `saving ${tag} should succeed`)
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

const PROPOSAL = {
  baseA: BASE_A,
  baseB: BASE_B,
  cardFromA: CARD_A,
  cardFromB: CARD_B,
  category: 'Elixir' as const,
}

async function propose(
  harness: Harness,
  cookie: string,
  body: unknown = PROPOSAL,
): Promise<Response> {
  return harness.app.request(...post('/api/cards/trades', body, cookie))
}

async function listTrades(harness: Harness, cookie: string): Promise<TradeRecord[]> {
  const response = await harness.app.request('/api/cards/trades', { headers: { cookie } })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { season: string; trades: TradeRecord[] }
  assert.equal(body.season, CARD_SEASON)
  return body.trades
}

const resolvePath = (id: number, action: 'complete' | 'decline') =>
  `/api/cards/trades/${id}/${action}`

async function resolve(
  harness: Harness,
  cookie: string | undefined,
  id: number,
  action: 'complete' | 'decline',
): Promise<Response> {
  return harness.app.request(...post(resolvePath(id, action), {}, cookie))
}

/** One base's counts as a plain map, so a test can assert one card at a time. */
function countsOf(harness: Harness, tag: string): Map<number, number> {
  const base = harness.cards.getInventory(CARD_SEASON, tag)
  return new Map(base.counts.map((entry) => [entry.cardId, entry.count]))
}

/** Every card held by every base, which a swap must leave unchanged. */
function totalCards(harness: Harness): number {
  return harness.cards
    .listInventory(CARD_SEASON)
    .reduce((sum, base) => sum + base.counts.reduce((n, entry) => n + entry.count, 0), 0)
}

/**
 * The whole cast, both bases assigned, and two tradeable spares each: A holds two
 * of card 1, B holds two of card 2, and neither holds what the other is giving —
 * which is exactly the state the suggester draws a trade from.
 */
async function seeded(harness: Harness): Promise<{
  admin: string
  a: string
  b: string
  outsider: string
}> {
  const admin = await signIn(harness, ADMIN)
  const a = await signIn(harness, MEMBER_A)
  const b = await signIn(harness, MEMBER_B)
  const outsider = await signIn(harness, OUTSIDER)

  await assignBase(harness, admin, BASE_A, idOf(harness, MEMBER_A.email))
  await assignBase(harness, admin, BASE_B, idOf(harness, MEMBER_B.email))

  await saveCounts(harness, a, BASE_A, [{ cardId: CARD_A, count: 2 }])
  await saveCounts(harness, b, BASE_B, [{ cardId: CARD_B, count: 2 }])

  return { admin, a, b, outsider }
}

/** Proposes the standard trade and returns its id. */
async function proposed(harness: Harness, cookie: string): Promise<number> {
  const response = await propose(harness, cookie)
  assert.equal(response.status, 201, 'the proposal should be recorded')
  const body = (await response.json()) as { trade: TradeRecord }
  return body.trade.id
}

describe('proposing a trade', () => {
  it('records the swap, pending, attributed and timestamped', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)

    const response = await propose(harness, a)
    assert.equal(response.status, 201)
    const body = (await response.json()) as { season: string; trade: TradeRecord }
    assert.equal(body.season, CARD_SEASON)

    const trade = body.trade
    assert.equal(trade.season, CARD_SEASON)
    assert.equal(trade.baseA, BASE_A)
    assert.equal(trade.baseB, BASE_B)
    assert.equal(trade.cardFromA, CARD_A)
    assert.equal(trade.cardFromB, CARD_B)
    assert.equal(trade.category, 'Elixir')
    assert.equal(trade.status, 'pending')
    assert.equal(trade.proposedBy, MEMBER_A_NAME)
    assert.equal(trade.proposedByUserId, idOf(harness, MEMBER_A.email))
    assert.ok(trade.proposedAt, 'a proposal has to say when it was made')
    // The audit half is empty exactly while it is pending, which the schema checks.
    assert.equal(trade.resolvedAt, null)
    assert.equal(trade.resolvedBy, null)
    assert.equal(trade.resolvedByUserId, null)

    // Proposing moves nothing: the counts are untouched until completion.
    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 2]])
    assert.deepEqual([...countsOf(harness, BASE_B)], [[CARD_B, 2]])
    harness.db.close()
  })

  it('stores the same swap one way round however it is sent', async () => {
    const harness = await createHarness()
    const { b } = await seeded(harness)

    // B describes the trade from its own side: itself first, its own card first.
    const response = await propose(harness, b, {
      baseA: BASE_B,
      baseB: BASE_A,
      cardFromA: CARD_B,
      cardFromB: CARD_A,
      category: 'Elixir',
    })
    assert.equal(response.status, 201)
    const { trade } = (await response.json()) as { trade: TradeRecord }

    // One agreement is one row, in the canonical orientation, with each card still
    // traveling from the base that gives it.
    assert.equal(trade.baseA, BASE_A)
    assert.equal(trade.cardFromA, CARD_A)
    assert.equal(trade.baseB, BASE_B)
    assert.equal(trade.cardFromB, CARD_B)
    harness.db.close()
  })

  it('answers a duplicate pending proposal with the trade that already exists', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)

    // The other side proposes the same swap, from its own side, before anyone has
    // resolved the first one. That is one agreement, not two.
    const again = await propose(harness, b, {
      baseA: BASE_B,
      baseB: BASE_A,
      cardFromA: CARD_B,
      cardFromB: CARD_A,
      category: 'Elixir',
    })
    assert.equal(again.status, 409)
    const body = (await again.json()) as { error: { reason: string }; trade: TradeRecord }
    assert.equal(body.error.reason, 'alreadyProposed')
    assert.equal(body.trade.id, id, 'the response has to point at the existing trade')
    assert.equal((await listTrades(harness, a)).length, 1)
    harness.db.close()
  })

  it('lets the same swap be proposed again once the first one is resolved', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const first = await proposed(harness, a)
    assert.equal((await resolve(harness, b, first, 'decline')).status, 200)

    // A declined attempt must not block a second try: people change their minds.
    const second = await propose(harness, a)
    assert.equal(second.status, 201)
    assert.equal((await listTrades(harness, a)).length, 2)
    harness.db.close()
  })

  it('refuses a member who owns neither base, naming who can', async () => {
    const harness = await createHarness()
    const { a, outsider } = await seeded(harness)

    const response = await propose(harness, outsider)
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'forbidden')
    assert.match(body.error.message, /Ada/)
    assert.match(body.error.message, /Bo/)
    assert.match(body.error.message, /admin/)

    assert.deepEqual(await listTrades(harness, a), [], 'nothing may have been stored')
    harness.db.close()
  })

  it('lets an admin propose a trade between two other people’s bases', async () => {
    const harness = await createHarness()
    const { admin, a } = await seeded(harness)

    assert.equal((await propose(harness, admin)).status, 201)
    const trades = await listTrades(harness, a)
    assert.equal(trades[0]?.proposedBy, ADMIN_NAME)
    harness.db.close()
  })

  it('refuses a trade whose bases nobody’s account owns, except to an admin', async () => {
    const harness = await createHarness()
    const admin = await signIn(harness, ADMIN)
    const a = await signIn(harness, MEMBER_A)
    // No assignments at all: a label-free base grants nobody anything.
    assert.equal((await propose(harness, a)).status, 403)
    assert.equal((await propose(harness, admin)).status, 201)
    harness.db.close()
  })

  it('rejects a proposal that is not a swap between two bases', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)

    const bad: [unknown, RegExp][] = [
      [{ ...PROPOSAL, baseB: BASE_A }, /cannot trade with itself/],
      [{ ...PROPOSAL, cardFromB: CARD_A }, /would move nothing/],
      [{ ...PROPOSAL, cardFromA: 0 }, /outside 1–60/],
      [{ ...PROPOSAL, cardFromB: 61 }, /outside 1–60/],
      [{ ...PROPOSAL, cardFromA: 1.5 }, /whole number/],
      [{ ...PROPOSAL, cardFromA: '1' }, /whole number/],
      [{ ...PROPOSAL, category: 'Gold' }, /category must be one of/],
      [{ ...PROPOSAL, category: undefined }, /category must be one of/],
      [{ cardFromA: 1, cardFromB: 2, category: 'Elixir' }, /needs baseA and baseB/],
      ['not an object', /needs baseA and baseB/],
    ]

    for (const [body, expected] of bad) {
      const response = await propose(harness, a, body)
      assert.equal(response.status, 400, `${JSON.stringify(body)} should be refused`)
      const parsed = (await response.json()) as { error: { reason: string; message: string } }
      assert.equal(parsed.error.reason, 'badRequest')
      assert.match(parsed.error.message, expected)
    }

    assert.deepEqual(await listTrades(harness, a), [])
    harness.db.close()
  })

  it('rejects a tag that could never be a tag', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)

    const response = await propose(harness, a, { ...PROPOSAL, baseB: '#!!' })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { error: { reason: string } }
    assert.equal(body.error.reason, 'invalidTag')
    harness.db.close()
  })

  it('canonicalizes the tags, so a lowercase proposal is the same trade', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)
    await proposed(harness, a)

    const again = await propose(harness, a, { ...PROPOSAL, baseA: 'aaabbb', baseB: 'cccddd' })
    assert.equal(again.status, 409, 'the same two bases spelled differently are the same trade')
    harness.db.close()
  })
})

describe('listing trades', () => {
  it('is readable by every signed-in member, pending first', async () => {
    const harness = await createHarness()
    const { a, b, outsider } = await seeded(harness)

    const first = await proposed(harness, a)
    // A second, different swap so there are two rows to order.
    await saveCounts(harness, a, BASE_A, [
      { cardId: CARD_A, count: 2 },
      { cardId: 5, count: 2 },
    ])
    const second = (await (
      await propose(harness, a, { ...PROPOSAL, cardFromA: 5 })
    ).json()) as { trade: TradeRecord }
    assert.equal((await resolve(harness, b, first, 'decline')).status, 200)

    // The outsider owns nothing and can still read everything: a trade is shared
    // data, which is what stops two people agreeing the same swap twice.
    const trades = await listTrades(harness, outsider)
    assert.deepEqual(
      trades.map((trade) => [trade.id, trade.status]),
      [
        [second.trade.id, 'pending'],
        [first, 'declined'],
      ],
      'pending trades come first — they are the ones anybody can still act on',
    )
    harness.db.close()
  })

  it('lists nothing at all before anyone has proposed', async () => {
    const harness = await createHarness()
    const { outsider } = await seeded(harness)
    assert.deepEqual(await listTrades(harness, outsider), [])
    harness.db.close()
  })
})

describe('completing a trade moves the cards', () => {
  it('moves one card each way, and the totals reconcile', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    const before = totalCards(harness)

    // The *other* party completes it — the one who did not propose it.
    const response = await resolve(harness, b, id, 'complete')
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      season: string
      trade: TradeRecord
      bases: BaseInventory[]
    }
    assert.equal(body.season, CARD_SEASON)
    assert.equal(body.trade.status, 'complete')
    assert.equal(body.trade.resolvedBy, MEMBER_B_NAME)
    assert.equal(body.trade.resolvedByUserId, idOf(harness, MEMBER_B.email))
    assert.ok(body.trade.resolvedAt, 'a completion has to carry when it happened')

    // Exactly one each way: A is down to one of its own card and holds one of B's.
    assert.deepEqual(
      [...countsOf(harness, BASE_A)].sort(),
      [
        [CARD_A, 1],
        [CARD_B, 1],
      ],
    )
    assert.deepEqual(
      [...countsOf(harness, BASE_B)].sort(),
      [
        [CARD_A, 1],
        [CARD_B, 1],
      ],
    )
    // A swap conserves cards: two moved, none created or destroyed.
    assert.equal(totalCards(harness), before)

    // Both bases come back in the response, so the client refreshes two bases
    // from one request rather than re-reading the whole inventory.
    assert.deepEqual(
      body.bases.map((base) => base.tag),
      [BASE_A, BASE_B],
    )
    assert.deepEqual(body.bases[0]?.counts, [
      { cardId: CARD_A, count: 1 },
      { cardId: CARD_B, count: 1 },
    ])
    // A completion really edits both bases, so both edit stamps move with it and
    // name the resolver — otherwise "when was this base last checked" would lie.
    assert.equal(body.bases[0]?.updatedBy, MEMBER_B_NAME)
    assert.equal(body.bases[1]?.updatedBy, MEMBER_B_NAME)
    harness.db.close()
  })

  it('lets either party complete it, and an admin too', async () => {
    for (const who of ['a', 'b', 'admin'] as const) {
      const harness = await createHarness()
      const cookies = await seeded(harness)
      const id = await proposed(harness, cookies.a)

      const response = await resolve(harness, cookies[who], id, 'complete')
      assert.equal(response.status, 200, `${who} should be able to complete it`)
      assert.equal(countsOf(harness, BASE_A).get(CARD_B), 1)
      harness.db.close()
    }
  })

  it('refuses a second completion rather than moving the cards twice', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    assert.equal((await resolve(harness, b, id, 'complete')).status, 200)
    const afterFirst = [...countsOf(harness, BASE_A)]

    for (const [cookie, action] of [
      [a, 'complete'],
      [b, 'decline'],
    ] as const) {
      const response = await resolve(harness, cookie, id, action)
      assert.equal(response.status, 409, `a resolved trade must not be ${action}d again`)
      const body = (await response.json()) as { error: { reason: string; message: string } }
      assert.equal(body.error.reason, 'alreadyResolved')
      assert.match(body.error.message, /complete/)
    }

    assert.deepEqual([...countsOf(harness, BASE_A)], afterFirst, 'the cards moved exactly once')
    assert.equal((await listTrades(harness, a))[0]?.status, 'complete')
    harness.db.close()
  })

  it('refuses a member who owns neither base, and changes nothing', async () => {
    const harness = await createHarness()
    const { a, outsider } = await seeded(harness)
    const id = await proposed(harness, a)

    for (const action of ['complete', 'decline'] as const) {
      const response = await resolve(harness, outsider, id, action)
      assert.equal(response.status, 403)
      const body = (await response.json()) as { error: { reason: string; message: string } }
      assert.equal(body.error.reason, 'forbidden')
      // The refusal names both owners, which is what makes it actionable.
      assert.match(body.error.message, /Ada/)
      assert.match(body.error.message, /Bo/)
      assert.match(body.error.message, /admin/)
    }

    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 2]])
    assert.equal((await listTrades(harness, a))[0]?.status, 'pending', 'it is still open')
    harness.db.close()
  })

  it('refuses a trade whose giver no longer holds two, leaving everything alone', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)

    // The count that made the trade possible has since been re-entered: A really
    // only has one. Honoring the trade would take away a card A still needs.
    await saveCounts(harness, a, BASE_A, [{ cardId: CARD_A, count: 1 }])
    const before = totalCards(harness)

    const response = await resolve(harness, b, id, 'complete')
    assert.equal(response.status, 409)
    const body = (await response.json()) as {
      error: { reason: string; message: string; hint?: string }
      trade: TradeRecord
    }
    assert.equal(body.error.reason, 'countsChanged')
    // What changed, in the message — "the counts changed" alone leaves someone
    // staring at a button that does nothing.
    assert.match(body.error.message, /#AAABBB now holds 1 copy of card 1/)
    assert.match(body.error.message, /Nothing was moved/)

    // Nothing moved, and — the point of the transaction — the status change rolled
    // back with it, so the trade is still there to be resolved when it makes sense.
    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 1]])
    assert.deepEqual([...countsOf(harness, BASE_B)], [[CARD_B, 2]])
    assert.equal(totalCards(harness), before)

    const trade = (await listTrades(harness, a))[0]
    assert.equal(trade?.status, 'pending')
    assert.equal(trade?.resolvedAt, null)
    assert.equal(trade?.resolvedBy, null)

    // And once the count comes back, the same trade completes.
    await saveCounts(harness, a, BASE_A, [{ cardId: CARD_A, count: 2 }])
    assert.equal((await resolve(harness, b, id, 'complete')).status, 200)
    harness.db.close()
  })

  it('refuses when the *other* giver has dropped to one, naming that base', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    await saveCounts(harness, b, BASE_B, [{ cardId: CARD_B, count: 1 }])

    const response = await resolve(harness, a, id, 'complete')
    assert.equal(response.status, 409)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /#CCCDDD now holds 1 copy of card 2/)
    harness.db.close()
  })

  it('refuses when a giver has since dropped to none at all', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    // Emptied entirely — the row is gone, not zeroed, since storage is sparse.
    await saveCounts(harness, a, BASE_A, [])

    const response = await resolve(harness, b, id, 'complete')
    assert.equal(response.status, 409)
    const body = (await response.json()) as { error: { message: string } }
    assert.match(body.error.message, /#AAABBB now holds 0 copies of card 1/)
    assert.deepEqual([...countsOf(harness, BASE_A)], [])
    harness.db.close()
  })

  it('completes anyway when the receiver has since acquired the card', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)

    /*
     * The suggester only ever offers a card you do not hold, so the *premise of
     * the suggestion* has gone: B has picked up one of card 1 since. The premise
     * of the *agreement* has not. Each side still hands over one card and receives
     * one, nothing is destroyed, and B's copy simply becomes a tradeable pair.
     * Refusing would break a swap two people had agreed to, for a reason they may
     * already know about, and leave them no way to re-propose it.
     */
    await saveCounts(harness, b, BASE_B, [
      { cardId: CARD_B, count: 2 },
      { cardId: CARD_A, count: 1 },
    ])
    const before = totalCards(harness)

    assert.equal((await resolve(harness, b, id, 'complete')).status, 200)
    assert.equal(countsOf(harness, BASE_B).get(CARD_A), 2, 'the receiver goes from one to two')
    assert.equal(countsOf(harness, BASE_A).get(CARD_A), 1)
    assert.equal(countsOf(harness, BASE_A).get(CARD_B), 1)
    assert.equal(totalCards(harness), before, 'still a swap: nothing created or destroyed')
    harness.db.close()
  })

  it('refuses when a receiver is already at the count ceiling', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)

    // The one case where the receiving side does block a trade: there is nowhere
    // to put the card, and storing eleven would break the schema's CHECK.
    await saveCounts(harness, b, BASE_B, [
      { cardId: CARD_B, count: 2 },
      { cardId: CARD_A, count: MAX_CARD_COUNT },
    ])

    const response = await resolve(harness, b, id, 'complete')
    assert.equal(response.status, 409)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'countsChanged')
    assert.match(body.error.message, /already holds the maximum 10 of card 1/)
    assert.equal(countsOf(harness, BASE_B).get(CARD_A), MAX_CARD_COUNT, 'untouched')
    assert.equal((await listTrades(harness, a))[0]?.status, 'pending')
    harness.db.close()
  })

  it('leaves the giver holding one, never a stored zero', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    assert.equal((await resolve(harness, b, id, 'complete')).status, 200)

    // The floor is zero and the storage is sparse, so a count of 1 is a row and a
    // count of 0 is no row. Two rows per base here, both at 1.
    const rows = harness.db
      .prepare('SELECT COUNT(*) AS n FROM card_inventory WHERE count <= 0')
      .get()
    assert.equal(Number(rows?.['n']), 0, 'a trade must never store a zero')
    assert.equal(countsOf(harness, BASE_A).get(CARD_A), 1)
    harness.db.close()
  })

  it('does not touch a base that is not part of the trade', async () => {
    const harness = await createHarness()
    const { admin, a, b } = await seeded(harness)
    await saveCounts(harness, admin, '#EEEFFF', [{ cardId: CARD_A, count: 3 }])
    const id = await proposed(harness, a)
    assert.equal((await resolve(harness, b, id, 'complete')).status, 200)

    assert.deepEqual([...countsOf(harness, '#EEEFFF')], [[CARD_A, 3]])
    harness.db.close()
  })
})

describe('declining a trade', () => {
  it('records who declined it and when, and moves nothing', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    const before = totalCards(harness)

    const response = await resolve(harness, b, id, 'decline')
    assert.equal(response.status, 200)
    const body = (await response.json()) as { trade: TradeRecord; bases: BaseInventory[] }
    assert.equal(body.trade.status, 'declined')
    assert.equal(body.trade.resolvedBy, MEMBER_B_NAME)
    assert.ok(body.trade.resolvedAt)

    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 2]])
    assert.deepEqual([...countsOf(harness, BASE_B)], [[CARD_B, 2]])
    assert.equal(totalCards(harness), before)
    // Both bases still come back, unchanged, so one response shape serves both
    // outcomes.
    assert.deepEqual(
      body.bases.map((base) => base.tag),
      [BASE_A, BASE_B],
    )
    harness.db.close()
  })

  it('can be declined by the member who proposed it', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)
    const id = await proposed(harness, a)

    // "I have changed my mind" and "no thanks" are the same event with the same
    // consequence, so there is no separate cancel.
    assert.equal((await resolve(harness, a, id, 'decline')).status, 200)
    assert.equal((await listTrades(harness, a))[0]?.resolvedBy, MEMBER_A_NAME)
    harness.db.close()
  })

  it('refuses to complete a trade that was declined', async () => {
    const harness = await createHarness()
    const { a, b } = await seeded(harness)
    const id = await proposed(harness, a)
    assert.equal((await resolve(harness, a, id, 'decline')).status, 200)

    const response = await resolve(harness, b, id, 'complete')
    assert.equal(response.status, 409)
    const body = (await response.json()) as { error: { reason: string; message: string } }
    assert.equal(body.error.reason, 'alreadyResolved')
    assert.match(body.error.message, /declined/)
    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 2]])
    harness.db.close()
  })
})

describe('resolving something that is not there', () => {
  it('404s an unknown id and 400s an id that is not one', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)

    const missing = await resolve(harness, a, 4242, 'complete')
    assert.equal(missing.status, 404)
    assert.equal(
      ((await missing.json()) as { error: { reason: string } }).error.reason,
      'notFound',
    )

    for (const raw of ['abc', '0', '-1', '1.5']) {
      const response = await harness.app.request(
        ...post(`/api/cards/trades/${raw}/complete`, {}, a),
      )
      assert.equal(response.status, 400, `${raw} is not a trade id`)
    }
    harness.db.close()
  })
})

describe('the trade routes need a session', () => {
  it('401s every one of them anonymously, changing nothing', async () => {
    const harness = await createHarness()
    const { a } = await seeded(harness)
    const id = await proposed(harness, a)

    const requests: [string, RequestInit][] = [
      ['/api/cards/trades', {}],
      post('/api/cards/trades', PROPOSAL),
      post(resolvePath(id, 'complete'), {}),
      post(resolvePath(id, 'decline'), {}),
    ]

    for (const [path, init] of requests) {
      const response = await harness.app.request(path, init)
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path} should need a session`)
      const body = (await response.json()) as { error: { reason: string } }
      assert.equal(body.error.reason, 'unauthenticated')
    }

    assert.equal(harness.trades.list(CARD_SEASON).length, 1, 'nothing was proposed anonymously')
    assert.equal((await listTrades(harness, a))[0]?.status, 'pending')
    assert.deepEqual([...countsOf(harness, BASE_A)], [[CARD_A, 2]])
    harness.db.close()
  })
})

describe('trades are on disk, not in memory', () => {
  it('survives a restart, resolved status and moved counts and all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coc-trades-'))
    after(() => rmSync(dir, { recursive: true, force: true }))
    const databasePath = join(dir, 'coc.db')

    const first = await createHarness(databasePath)
    const { a, b } = await seeded(first)
    const completed = await proposed(first, a)
    assert.equal((await resolve(first, b, completed, 'complete')).status, 200)
    const stillOpen = (await (
      await propose(first, a, { ...PROPOSAL, cardFromA: CARD_B, cardFromB: CARD_A })
    ).json()) as { trade: TradeRecord }
    first.db.close()

    // A second boot runs the migrations again and must find both trades as they
    // were, with the counts the completed one moved.
    const second = await createHarness(databasePath)
    const trades = second.trades.list(CARD_SEASON)
    assert.deepEqual(
      trades.map((trade) => [trade.id, trade.status]),
      [
        [stillOpen.trade.id, 'pending'],
        [completed, 'complete'],
      ],
    )
    assert.equal(trades.find((trade) => trade.id === completed)?.resolvedBy, MEMBER_B_NAME)
    assert.equal(countsOf(second, BASE_A).get(CARD_B), 1)
    second.db.close()
  })
})
