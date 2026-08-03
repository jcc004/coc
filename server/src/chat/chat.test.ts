import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_CHAT_LENGTH, type ChatMessage } from '@coc/shared'
import { createApp } from '../app.ts'
import { bootstrapAdmin } from '../auth/bootstrap.ts'
import { createLoginLimiter } from '../auth/rate-limit.ts'
import { createAuthStore } from '../auth/store.ts'
import { TtlCache } from '../cache.ts'
import { createCardInventoryStore } from '../cards/store.ts'
import { createTradeStore } from '../cards/trades-store.ts'
import type { CocClient } from '../coc-client.ts'
import { openDatabase } from '../db.ts'
import { createSharedDataStore } from '../shared-data/store.ts'
import { createChatStore, CHAT_COOLDOWN_MS } from './store.ts'

const ADMIN = { email: 'admin@example.test', password: 'first-admin-password' }
const ADMIN_NAME = 'Admin One'
const SECOND = { email: 'teammate@example.test', password: 'second-user-password' }
const SECOND_NAME = 'Teammate'

function createHarness() {
  const db = openDatabase(':memory:')
  const store = createAuthStore(db)
  bootstrapAdmin(store, {
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    ADMIN_DISPLAY_NAME: ADMIN_NAME,
  })
  store.createUser({
    email: SECOND.email,
    displayName: SECOND_NAME,
    password: SECOND.password,
    role: 'user',
  })

  const chat = createChatStore(db)
  const cards = createCardInventoryStore(db)
  const app = createApp({
    coc: {} as unknown as CocClient,
    cache: new TtlCache(60_000),
    auth: store,
    chat,
    sharedData: createSharedDataStore(db),
    cards,
    trades: createTradeStore(db, cards),
    loginLimiter: createLoginLimiter(),
  })

  return { app, store, chat, db }
}

function postJson(path: string, body: unknown, cookie?: string): [string, RequestInit] {
  return [
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    },
  ]
}

async function signIn(
  app: ReturnType<typeof createApp>,
  credentials: { email: string; password: string },
): Promise<string> {
  const response = await app.request(...postJson('/api/auth/login', credentials))
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'login should set a session cookie')
  return cookie
}

const messagesFrom = async (response: Response): Promise<ChatMessage[]> =>
  ((await response.json()) as { messages: ChatMessage[] }).messages

describe('chat', () => {
  it('refuses anonymous callers on both read and write', async () => {
    const { app, db } = createHarness()

    assert.equal((await app.request('/api/chat')).status, 401)
    assert.equal((await app.request(...postJson('/api/chat', { body: 'hello' }))).status, 401)

    db.close()
  })

  it('stores a message and returns it with the author resolved server-side', async () => {
    const { app, db } = createHarness()
    const cookie = await signIn(app, ADMIN)

    // A forged author must be ignored: the name comes from the session.
    const posted = await app.request(
      ...postJson('/api/chat', { body: 'first post', author: 'somebody-else' }, cookie),
    )
    assert.equal(posted.status, 201)

    const messages = await messagesFrom(await app.request('/api/chat', { headers: { cookie } }))
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.body, 'first post')
    assert.equal(messages[0]?.author, ADMIN_NAME)

    db.close()
  })

  it('is visible to every signed-in account, not just the author', async () => {
    const { app, db } = createHarness()
    const adminCookie = await signIn(app, ADMIN)
    await app.request(...postJson('/api/chat', { body: 'shared with the group' }, adminCookie))

    const otherCookie = await signIn(app, SECOND)
    const messages = await messagesFrom(
      await app.request('/api/chat', { headers: { cookie: otherCookie } }),
    )

    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.body, 'shared with the group')
    assert.equal(messages[0]?.author, ADMIN_NAME)

    db.close()
  })

  it('rejects an empty or whitespace-only message', async () => {
    const { app, db } = createHarness()
    const cookie = await signIn(app, ADMIN)

    for (const body of ['', '   ', '\n\t']) {
      const response = await app.request(...postJson('/api/chat', { body }, cookie))
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`)
    }
    // A missing field is the same class of malformed request.
    assert.equal((await app.request(...postJson('/api/chat', {}, cookie))).status, 400)

    assert.equal((await messagesFrom(await app.request('/api/chat', { headers: { cookie } }))).length, 0)
    db.close()
  })

  it('trims a message before storing it', async () => {
    const { app, db } = createHarness()
    const cookie = await signIn(app, ADMIN)

    await app.request(...postJson('/api/chat', { body: '  padded  ' }, cookie))
    const messages = await messagesFrom(await app.request('/api/chat', { headers: { cookie } }))
    assert.equal(messages[0]?.body, 'padded')

    db.close()
  })

  it('accepts a message at the length cap and refuses one over it', async () => {
    const { app, db } = createHarness()
    const cookie = await signIn(app, ADMIN)

    const tooLong = 'x'.repeat(MAX_CHAT_LENGTH + 1)
    assert.equal((await app.request(...postJson('/api/chat', { body: tooLong }, cookie))).status, 400)

    // Exactly at the cap is allowed — the boundary belongs on the valid side.
    const atCap = 'y'.repeat(MAX_CHAT_LENGTH)
    const response = await app.request(...postJson('/api/chat', { body: atCap }, cookie))
    assert.equal(response.status, 201)

    db.close()
  })

  it('returns only newer messages when given an after cursor', async () => {
    const { app, chat, db } = createHarness()
    const cookie = await signIn(app, ADMIN)
    const user = chat.post(1, 'one')
    const second = chat.post(1, 'two')

    const newer = await messagesFrom(
      await app.request(`/api/chat?after=${user.id}`, { headers: { cookie } }),
    )
    assert.deepEqual(
      newer.map((m) => m.body),
      ['two'],
    )

    // Nothing newer than the newest is an empty list, not an error.
    const none = await messagesFrom(
      await app.request(`/api/chat?after=${second.id}`, { headers: { cookie } }),
    )
    assert.deepEqual(none, [])

    // after=0 means "everything", so it must not be treated as absent-or-invalid.
    const all = await messagesFrom(await app.request('/api/chat?after=0', { headers: { cookie } }))
    assert.equal(all.length, 2)

    db.close()
  })

  it('returns messages oldest-first', async () => {
    const { app, chat, db } = createHarness()
    const cookie = await signIn(app, ADMIN)
    for (const body of ['a', 'b', 'c']) chat.post(1, body)

    const messages = await messagesFrom(await app.request('/api/chat', { headers: { cookie } }))
    assert.deepEqual(
      messages.map((m) => m.body),
      ['a', 'b', 'c'],
    )

    db.close()
  })

  it('throttles a burst from one account without touching another', async () => {
    const { app, db } = createHarness()
    const adminCookie = await signIn(app, ADMIN)

    assert.equal((await app.request(...postJson('/api/chat', { body: 'one' }, adminCookie))).status, 201)
    const burst = await app.request(...postJson('/api/chat', { body: 'two' }, adminCookie))
    assert.equal(burst.status, 429)
    assert.equal(burst.headers.get('retry-after'), '1')

    // The cooldown is per account, so a teammate is unaffected.
    const otherCookie = await signIn(app, SECOND)
    assert.equal((await app.request(...postJson('/api/chat', { body: 'mine' }, otherCookie))).status, 201)

    db.close()
  })

  it('measures the cooldown from the stored row, so a restart cannot reset it', () => {
    const db = openDatabase(':memory:')
    const store = createAuthStore(db)
    bootstrapAdmin(store, { ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password })

    const chat = createChatStore(db)
    assert.equal(chat.msSinceLastMessage(1), undefined, 'no messages yet')

    const at = new Date('2026-08-02T12:00:00.000Z')
    chat.post(1, 'hello', at)

    const soon = new Date(at.getTime() + 200)
    assert.equal(chat.msSinceLastMessage(1, soon), 200)
    assert.ok((chat.msSinceLastMessage(1, soon) ?? 0) < CHAT_COOLDOWN_MS)

    const later = new Date(at.getTime() + CHAT_COOLDOWN_MS + 1)
    assert.ok((chat.msSinceLastMessage(1, later) ?? 0) > CHAT_COOLDOWN_MS)

    // A fresh store over the same file sees the same history.
    assert.equal(createChatStore(db).msSinceLastMessage(1, soon), 200)

    db.close()
  })

  it('caps how many messages one read returns', async () => {
    const { app, chat, db } = createHarness()
    const cookie = await signIn(app, ADMIN)
    for (let index = 0; index < 5; index += 1) chat.post(1, `m${index}`)

    const messages = await messagesFrom(
      await app.request('/api/chat?limit=2', { headers: { cookie } }),
    )
    // The most recent two, still in reading order.
    assert.deepEqual(
      messages.map((m) => m.body),
      ['m3', 'm4'],
    )

    db.close()
  })
})
