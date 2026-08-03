import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { openDatabase } from '../db.ts'
import { AUTH_EVENT_PAGE_DEFAULT, AUTH_EVENT_PAGE_MAX, createAuthEventLog } from './events.ts'
import { createAuthStore } from './store.ts'

/*
 * The trail at the store level. The routes that write it are covered in
 * `app.test.ts`; what is here is the reading contract — which is where an unbounded
 * query over a table that grows with every login attempt would hide.
 */

async function seeded(rows: number): Promise<{
  log: ReturnType<typeof createAuthEventLog>
  db: ReturnType<typeof openDatabase>
  userId: number
}> {
  const db = openDatabase(':memory:')
  const store = createAuthStore(db)
  const user = await store.createUser({
    email: 'jcc@example.com',
    displayName: 'Original Name',
    password: 'a-perfectly-fine-password',
    role: 'admin',
  })

  const log = createAuthEventLog(db)
  for (let index = 0; index < rows; index += 1) {
    log.record({ kind: 'loginFailed', email: `attempt-${index}@example.com`, ip: '203.0.113.9' })
  }
  return { log, db, userId: user.id }
}

describe('reading the audit trail', () => {
  it('returns the newest first', async () => {
    const { log, db } = await seeded(5)
    const emails = log.list().map((event) => event.email)
    assert.deepEqual(emails, [
      'attempt-4@example.com',
      'attempt-3@example.com',
      'attempt-2@example.com',
      'attempt-1@example.com',
      'attempt-0@example.com',
    ])
    db.close()
  })

  it('clamps the page size at both ends rather than trusting it', async () => {
    const { log, db } = await seeded(AUTH_EVENT_PAGE_MAX + 20)

    assert.equal(log.list({ limit: 999_999 }).length, AUTH_EVENT_PAGE_MAX, 'never the whole table')
    assert.equal(log.list({ limit: 0 }).length, 1, 'and never an empty page for a zero')
    assert.equal(log.list({ limit: -5 }).length, 1)
    assert.equal(log.list({ limit: 1.5 }).length, AUTH_EVENT_PAGE_DEFAULT, 'nonsense falls back')
    assert.equal(log.list().length, AUTH_EVENT_PAGE_DEFAULT)
    assert.equal(log.count(), AUTH_EVENT_PAGE_MAX + 20, 'the count is the whole table, though')
    db.close()
  })

  it('walks backwards with a cursor, without overlap or gaps', async () => {
    const { log, db } = await seeded(9)

    const first = log.list({ limit: 4 })
    const oldestOnPage = first[3]?.id
    assert.ok(oldestOnPage)
    const second = log.list({ limit: 4, beforeId: oldestOnPage })

    assert.equal(second.length, 4)
    // An id cursor rather than an offset, so a row arriving mid-walk cannot shift
    // the page under the reader.
    assert.ok(Number(second[0]?.id) < oldestOnPage)
    assert.equal(new Set([...first, ...second].map((event) => event.id)).size, 8)
    db.close()
  })

  it('joins the display name at read time, so a rename is reflected', async () => {
    const { log, db, userId } = await seeded(0)
    const store = createAuthStore(db)
    log.record({ kind: 'loginSucceeded', actorUserId: userId, email: 'jcc@example.com' })

    assert.equal(log.list()[0]?.actorDisplayName, 'Original Name')
    store.setDisplayName(userId, 'Renamed Since')
    // Joined rather than copied into the row: a person shows up as they are known
    // now. The trade is that a deleted account loses its name and keeps its id,
    // which is still a distinct actor — see the v10 tests in `db.test.ts`.
    assert.equal(log.list()[0]?.actorDisplayName, 'Renamed Since')
    db.close()
  })

  it('stores a blank email or ip as null rather than as an empty string', async () => {
    const { log, db } = await seeded(0)
    log.record({ kind: 'loginFailed', email: '   ', ip: '' })

    const [event] = log.list()
    // "No address was supplied" and "the empty address" are the same thing here,
    // and NULL says so once — which matters because `ip` is genuinely absent
    // whenever `clientIp` could not determine one.
    assert.equal(event?.email, null)
    assert.equal(event?.ip, null)
    assert.equal(event?.detail, null)
    db.close()
  })

  it('is empty on a fresh install rather than absent', async () => {
    const { log, db } = await seeded(0)
    assert.deepEqual(log.list(), [])
    assert.equal(log.count(), 0)
    db.close()
  })
})
