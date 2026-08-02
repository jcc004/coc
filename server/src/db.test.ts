import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapAdmin } from './auth/bootstrap.ts'
import { hashPassword } from './auth/passwords.ts'
import { createAuthStore } from './auth/store.ts'
import { migrate, openDatabase, SCHEMA_VERSION } from './db.ts'

/*
 * The migration, against a database shaped the way the *previous* build left it:
 * `user_version = 0`, a `username` column, no guid / display_name / email, and one
 * real account already in it. That last part is the whole reason this file exists —
 * getting it wrong locks somebody out of their own app.
 */

const LEGACY_PASSWORD = 'the-password-they-already-have'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coc-migrate-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Writes a v1-shaped database by hand — the old `CREATE TABLE IF NOT EXISTS`
 * schema verbatim, `user_version` left at 0 — and inserts real password records so
 * the "did the migration keep the password working" question can be answered.
 */
function createV1Database(
  path: string,
  users: { username: string; role?: 'admin' | 'user'; password?: string }[],
): void {
  const db = new DatabaseSync(path)
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
`)

  const insert = db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const user of users) {
    const { hash, salt } = hashPassword(user.password ?? LEGACY_PASSWORD)
    insert.run(user.username, hash, salt, user.role ?? 'admin', new Date().toISOString())
  }

  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 0)
  db.close()
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path)
  const value = db.prepare('PRAGMA user_version').get()?.['user_version']
  db.close()
  return Number(value)
}

function columnsOf(path: string, table: string): string[] {
  const db = new DatabaseSync(path)
  const names = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row['name']))
  db.close()
  return names
}

describe('migration from a v1 database', () => {
  it('backfills a guid and a display name, and leaves the password working', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const [user] = store.listUsers()
    assert.ok(user)
    assert.equal(user.id, 1, 'the id must not change — other rows FK to it')
    assert.equal(user.displayName, 'jcc', 'display name comes from the old username')
    assert.match(user.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(user.role, 'admin')

    // A username with no @ cannot become an email, so this row cannot sign in yet.
    assert.equal(user.email, null)
    assert.equal(store.authenticate('jcc', LEGACY_PASSWORD), undefined)
    // …but the password itself survived untouched, which is what the escape
    // hatch below then relies on.
    assert.equal(store.verifyUserPassword(user.id, LEGACY_PASSWORD), true)

    db.close()
  })

  it('adopts an @-containing username as the email', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'Someone@Example.COM' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const [user] = store.listUsers()
    assert.ok(user)
    // Normalised on the way in, and the display name still keeps the raw label.
    assert.equal(user.email, 'someone@example.com')
    assert.equal(user.displayName, 'Someone@Example.COM')

    // That account can sign in immediately, with no operator action at all.
    assert.ok(store.authenticate('SOMEONE@example.com', LEGACY_PASSWORD))
    db.close()
  })

  it('leaves the second of two usernames that collide as one email without one', () => {
    const path = join(tempDir(), 'coc.db')
    // COLLATE NOCASE made these two distinct usernames; they normalise to one email.
    createV1Database(path, [{ username: 'dup@example.com' }, { username: 'DUP@example.com  ' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const emails = store.listUsers().map((user) => user.email)
    assert.deepEqual(emails, ['dup@example.com', null], 'the UNIQUE index must not be violated')
    db.close()
  })

  it('creates the shared tables and the new columns', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])
    const db = openDatabase(path)
    db.close()

    assert.deepEqual(columnsOf(path, 'users'), [
      'id',
      'guid',
      'display_name',
      'email',
      'password_hash',
      'password_salt',
      'role',
      'created_at',
      'disabled_at',
      'must_change_password',
    ])
    assert.deepEqual(columnsOf(path, 'owner_assignments'), [
      'player_tag',
      'owner',
      'updated_at',
      'updated_by_user_id',
    ])
    assert.deepEqual(columnsOf(path, 'saved_clans'), [
      'clan_tag',
      'name',
      'custom',
      'clan_level',
      'members',
      'clan_points',
      'war_league',
      'updated_at',
      'updated_by_user_id',
    ])
    // The old credential column is gone, not merely ignored.
    assert.equal(columnsOf(path, 'users').includes('username'), false)
  })

  it('keeps the sessions of an account it rebuilt', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    // A session issued by the old build, which dropping `users` must not cascade away.
    const seed = new DatabaseSync(path)
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    seed
      .prepare(
        'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('a-pre-migration-session', 1, new Date().toISOString(), expiresAt, new Date().toISOString())
    seed.close()

    const db = openDatabase(path)
    const store = createAuthStore(db)
    assert.ok(
      store.resolveSession('a-pre-migration-session'),
      'a migration must not sign everybody out',
    )
    db.close()
  })
})

describe('migration bookkeeping', () => {
  it('reports the head version and does nothing on a second boot', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const first = openDatabase(path)
    const guidAfterFirst = createAuthStore(first).listUsers()[0]?.guid
    assert.ok(guidAfterFirst)
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    const second = openDatabase(path)
    const store = createAuthStore(second)
    // A re-run would mint a new guid, so a stable one proves the step was skipped.
    assert.equal(store.listUsers()[0]?.guid, guidAfterFirst)
    assert.equal(store.countUsers(), 1)

    // And explicitly: nothing left to apply.
    assert.deepEqual(migrate(second), [])
    second.close()
    assert.equal(userVersion(path), SCHEMA_VERSION)
  })

  it('takes a fresh database straight to the head in one pass', () => {
    const path = join(tempDir(), 'coc.db')
    const db = new DatabaseSync(path)
    assert.deepEqual(
      migrate(db),
      Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1),
    )
    assert.deepEqual(migrate(db), [], 'immediately idempotent')
    db.close()
  })

  it('applies only the outstanding steps to a half-migrated database', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    // Mark it as already at v1 — which it effectively is — so v2 onwards run.
    const marked = new DatabaseSync(path)
    marked.exec('PRAGMA user_version = 1')
    assert.deepEqual(migrate(marked), [2, 3, 4])
    marked.close()
  })
})

describe('migration v3 — must_change_password', () => {
  it('adds the column, defaults it off, and preserves the existing rows', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }, { username: 'other@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const users = store.listUsers()
    assert.equal(users.length, 2, 'both rows survived the column being added')
    // Nobody who already knows their own password gets a change-it-now screen
    // because the schema moved under them.
    assert.deepEqual(
      users.map((user) => user.mustChangePassword),
      [false, false],
    )
    // …and the passwords still verify, i.e. v3 did not rebuild the table.
    assert.ok(store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    db.close()

    assert.ok(columnsOf(path, 'users').includes('must_change_password'))
  })

  it('is idempotent across two boots, flag values and all', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const first = openDatabase(path)
    const store = createAuthStore(first)
    const [user] = store.listUsers()
    assert.ok(user)
    // Set the flag, so the second boot has something it could destroy.
    store.setPassword(user.id, 'an-admin-issued-one', true)
    assert.equal(store.findUser(user.id)?.mustChangePassword, true)
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    /*
     * `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS`, so a v3 that ran twice
     * would throw rather than quietly duplicate — opening at all is half the
     * assertion, and the flag still reading true is the other half.
     */
    const second = openDatabase(path)
    const reopened = createAuthStore(second)
    assert.deepEqual(migrate(second), [], 'nothing left to apply')
    assert.equal(reopened.findUser(user.id)?.mustChangePassword, true)
    assert.equal(reopened.countUsers(), 1)
    assert.ok(
      reopened.authenticate('jcc@example.com', 'an-admin-issued-one'),
      'the temporary password survives a restart',
    )
    second.close()
    assert.equal(userVersion(path), SCHEMA_VERSION)
  })
})

describe('migration v4 — card_inventory', () => {
  it('creates the table with the shape the card routes rely on', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    assert.deepEqual(columnsOf(path, 'card_inventory'), [
      'season',
      'player_tag',
      'card_id',
      'count',
      'updated_at',
      'updated_by_user_id',
    ])

    // (season, player_tag, card_id) is the primary key, in that order.
    const keyColumns = db
      .prepare('PRAGMA table_info(card_inventory)')
      .all()
      .filter((row) => Number(row['pk']) > 0)
      .sort((a, b) => Number(a['pk']) - Number(b['pk']))
      .map((row) => String(row['name']))
    assert.deepEqual(keyColumns, ['season', 'player_tag', 'card_id'])
    db.close()
  })

  it('leaves the accounts and the other shared rows untouched', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)
    assert.equal(store.countUsers(), 1)
    assert.ok(store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    // v4 adds a table; it must not have disturbed the ones v2 made.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_assignments').get()?.['n'], 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_clans').get()?.['n'], 0)
    db.close()
  })

  it('is idempotent across two boots, rows and all', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const first = openDatabase(path)
    const userId = createAuthStore(first).listUsers()[0]?.id
    assert.ok(userId)
    first
      .prepare(
        `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('2026-08', '#AAABBB', 4, 3, new Date().toISOString(), userId)
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    // A plain CREATE TABLE run twice would throw, so opening at all is half the
    // assertion; the row still being there is the other half.
    const second = openDatabase(path)
    assert.deepEqual(migrate(second), [], 'nothing left to apply')
    const row = second.prepare('SELECT player_tag, card_id, count FROM card_inventory').get()
    assert.equal(row?.['player_tag'], '#AAABBB')
    assert.equal(Number(row?.['count']), 3)
    second.close()
  })

  it('keeps a base’s counts when the account that entered them is deleted', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const userId = createAuthStore(db).listUsers()[0]?.id
    assert.ok(userId)
    db.prepare(
      `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('2026-08', '#AAABBB', 4, 3, new Date().toISOString(), userId)

    // ON DELETE SET NULL, not CASCADE: the counts outlive the account. (Accounts
    // are disabled rather than deleted in practice, which touches nothing here.)
    db.exec(`DELETE FROM users WHERE id = ${userId}`)
    const row = db.prepare('SELECT count, updated_by_user_id FROM card_inventory').get()
    assert.equal(Number(row?.['count']), 3, 'the count must survive')
    assert.equal(row?.['updated_by_user_id'], null, 'only the attribution is lost')
    db.close()
  })
})

describe('the ADMIN_EMAIL escape hatch', () => {
  it('fills a missing email without touching the password, then stops', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    // Before: a real account nobody can sign in to.
    assert.equal(store.countUsersWithEmail(), 0)

    const first = bootstrapAdmin(store, { ADMIN_EMAIL: '  JCC@OnEngine.ai  ' })
    assert.equal(first.status, 'emailBackfilled')
    assert.match(first.message, /jcc@onengine\.ai/)

    const [user] = store.listUsers()
    assert.equal(user?.email, 'jcc@onengine.ai')
    assert.equal(user?.displayName, 'jcc', 'the display name is not overwritten')

    // The password is the one they already had — the whole point of this path.
    assert.ok(store.authenticate('jcc@onengine.ai', LEGACY_PASSWORD))
    assert.equal(store.authenticate('jcc@onengine.ai', 'some-other-password'), undefined)

    // Idempotent: a restart with the var still set finds nothing to do.
    const second = bootstrapAdmin(store, { ADMIN_EMAIL: 'jcc@onengine.ai' })
    assert.equal(second.status, 'existing')

    // And it cannot be used to *move* an address that is already set.
    const third = bootstrapAdmin(store, { ADMIN_EMAIL: 'someone-else@example.com' })
    assert.equal(third.status, 'existing')
    assert.equal(store.listUsers()[0]?.email, 'jcc@onengine.ai')

    db.close()
  })

  it('never creates an account, and never sets a password', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)
    bootstrapAdmin(store, { ADMIN_EMAIL: 'jcc@onengine.ai', ADMIN_PASSWORD: 'a-brand-new-one!!' })

    assert.equal(store.countUsers(), 1, 'the existing account is adopted, not duplicated')
    // ADMIN_PASSWORD is ignored on this path: it must not be able to reset a
    // password that has since been changed.
    assert.equal(store.authenticate('jcc@onengine.ai', 'a-brand-new-one!!'), undefined)
    assert.ok(store.authenticate('jcc@onengine.ai', LEGACY_PASSWORD))
    db.close()
  })

  it('says exactly what to set when nothing is configured', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = bootstrapAdmin(store, {})
    assert.equal(result.status, 'noUsableEmail')
    assert.match(result.message, /ADMIN_EMAIL/)
    assert.match(result.message, /"jcc"/, 'it must name the account that is stranded')
    // Never invents a credential.
    assert.equal(store.countUsersWithEmail(), 0)
    db.close()
  })

  it('refuses a malformed ADMIN_EMAIL rather than storing it', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = bootstrapAdmin(store, { ADMIN_EMAIL: 'not-an-address' })
    assert.equal(result.status, 'invalid')
    assert.equal(store.listUsers()[0]?.email, null)
    db.close()
  })

  it('refuses an ADMIN_EMAIL that belongs to somebody else', () => {
    const path = join(tempDir(), 'coc.db')
    // The second row already holds the address; the first is the stranded admin.
    createV1Database(path, [
      { username: 'jcc', role: 'admin' },
      { username: 'taken@example.com', role: 'user' },
    ])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = bootstrapAdmin(store, { ADMIN_EMAIL: 'taken@example.com' })
    assert.equal(result.status, 'invalid')
    assert.match(result.message, /already belongs/)
    assert.equal(store.listUsers()[0]?.email, null)
    // The other account keeps its address.
    assert.equal(store.listUsers()[1]?.email, 'taken@example.com')
    db.close()
  })

  it('leaves an already-usable install alone', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    assert.equal(bootstrapAdmin(store, { ADMIN_EMAIL: 'someone@else.com' }).status, 'existing')
    assert.equal(store.listUsers()[0]?.email, 'jcc@example.com')
    db.close()
  })

  it('does not adopt a non-admin account automatically', () => {
    const path = join(tempDir(), 'coc.db')
    createV1Database(path, [{ username: 'regular', role: 'user' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    // Handing an admin's configured address to a plain user would be a quiet
    // privilege muddle, so it stays a loud message instead.
    const result = bootstrapAdmin(store, { ADMIN_EMAIL: 'jcc@onengine.ai' })
    assert.equal(result.status, 'noUsableEmail')
    assert.equal(store.listUsers()[0]?.email, null)
    db.close()
  })
})
