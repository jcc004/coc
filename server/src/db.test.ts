import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { bootstrapAdmin } from './auth/bootstrap.ts'
import { hashPassword } from './auth/passwords.ts'
import { createAuthStore } from './auth/store.ts'
import { migrate, openDatabase, SCHEMA_VERSION, summarizeOwnerAssignments } from './db.ts'

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
 *
 * `chat_messages` is here because v1 really creates it. Leaving it out was harmless
 * while nothing removed it; v9 drops it, and a fixture claiming to be v1 without it
 * would be a database no install has ever been in.
 */
async function createV1Database(
  path: string,
  users: { username: string; role?: 'admin' | 'user'; password?: string }[],
): Promise<void> {
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

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`)

  const insert = db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const user of users) {
    const { hash, salt } = await hashPassword(user.password ?? LEGACY_PASSWORD)
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
  it('backfills a guid and a display name, and leaves the password working', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

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
    assert.equal(await store.authenticate('jcc', LEGACY_PASSWORD), undefined)
    // …but the password itself survived untouched, which is what the escape
    // hatch below then relies on.
    assert.equal(await store.verifyUserPassword(user.id, LEGACY_PASSWORD), true)

    db.close()
  })

  it('adopts an @-containing username as the email', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'Someone@Example.COM' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const [user] = store.listUsers()
    assert.ok(user)
    // Normalized on the way in, and the display name still keeps the raw label.
    assert.equal(user.email, 'someone@example.com')
    assert.equal(user.displayName, 'Someone@Example.COM')

    // That account can sign in immediately, with no operator action at all.
    assert.ok(await store.authenticate('SOMEONE@example.com', LEGACY_PASSWORD))
    db.close()
  })

  it('leaves the second of two usernames that collide as one email without one', async () => {
    const path = join(tempDir(), 'coc.db')
    // COLLATE NOCASE made these two distinct usernames; they normalize to one email.
    await createV1Database(path, [{ username: 'dup@example.com' }, { username: 'DUP@example.com  ' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const emails = store.listUsers().map((user) => user.email)
    assert.deepEqual(emails, ['dup@example.com', null], 'the UNIQUE index must not be violated')
    db.close()
  })

  it('creates the shared tables and the new columns', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])
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
      // v6. The `owner` text stays beside it: a name that matches no account is
      // still the only record of who a base belongs to in real life.
      'owner_user_id',
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

  /**
   * This test used to assert the opposite — that a session issued by the old build
   * still resolved after migrating, because dropping and rebuilding `users` in v2
   * must not cascade its sessions away. v8 changed the answer on purpose: the row it
   * was resolving *was* the bearer token in plaintext, and v8 deletes every one of
   * them precisely so that a token already sitting in a backup stops working. The
   * property v2 needs is still checked, one row down — the account survives with its
   * password intact, which is what a cascade would have destroyed.
   */
  it('deletes a plaintext session from an old build rather than carrying it over', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

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

    assert.equal(
      store.resolveSession('a-pre-migration-session'),
      undefined,
      'a token that has been sitting in a backup must not still work',
    )
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.['n']),
      0,
      'and the row is gone, not merely unresolvable',
    )

    // The account itself came through v2's rebuild whole, which is the property the
    // session row was standing in for: signing in once more is the intended cost.
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    db.close()
  })
})

describe('migration bookkeeping', () => {
  it('reports the head version and does nothing on a second boot', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

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

  it('takes a fresh database straight to the head in one pass', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = new DatabaseSync(path)
    assert.deepEqual(
      migrate(db),
      Array.from({ length: SCHEMA_VERSION }, (_, index) => index + 1),
    )
    assert.deepEqual(migrate(db), [], 'immediately idempotent')
    db.close()
  })

  it('applies only the outstanding steps to a half-migrated database', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

    // Mark it as already at v1 — which it effectively is — so v2 onwards run.
    const marked = new DatabaseSync(path)
    marked.exec('PRAGMA user_version = 1')
    assert.deepEqual(
      migrate(marked),
      Array.from({ length: SCHEMA_VERSION - 1 }, (_, index) => index + 2),
    )
    marked.close()
  })
})

describe('migration v3 — must_change_password', () => {
  it('adds the column, defaults it off, and preserves the existing rows', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }, { username: 'other@example.com' }])

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
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    db.close()

    assert.ok(columnsOf(path, 'users').includes('must_change_password'))
  })

  it('is idempotent across two boots, flag values and all', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const first = openDatabase(path)
    const store = createAuthStore(first)
    const [user] = store.listUsers()
    assert.ok(user)
    // Set the flag, so the second boot has something it could destroy.
    await store.setPassword(user.id, 'an-admin-issued-one', true)
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
      await reopened.authenticate('jcc@example.com', 'an-admin-issued-one'),
      'the temporary password survives a restart',
    )
    second.close()
    assert.equal(userVersion(path), SCHEMA_VERSION)
  })
})

describe('migration v4 — card_inventory', () => {
  it('creates the table with the shape the card routes rely on', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

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

  it('leaves the accounts and the other shared rows untouched', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)
    assert.equal(store.countUsers(), 1)
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    // v4 adds a table; it must not have disturbed the ones v2 made.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_assignments').get()?.['n'], 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM saved_clans').get()?.['n'], 0)
    db.close()
  })

  it('is idempotent across two boots, rows and all', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

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

  it('keeps a base’s counts when the account that entered them is deleted', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

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

describe('migration v5 — card_base_updates', () => {
  it('creates the stamp table, keyed one row per base', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    assert.deepEqual(columnsOf(path, 'card_base_updates'), [
      'season',
      'player_tag',
      'updated_at',
      'updated_by_user_id',
    ])

    const keyColumns = db
      .prepare('PRAGMA table_info(card_base_updates)')
      .all()
      .filter((row) => Number(row['pk']) > 0)
      .sort((a, b) => Number(a['pk']) - Number(b['pk']))
      .map((row) => String(row['name']))
    assert.deepEqual(keyColumns, ['season', 'player_tag'])
    db.close()
  })

  /*
   * The upgrade case that matters: an install already at v4 has stamps living on
   * its count rows. v5 must lift them across rather than resetting every base to
   * "never edited".
   */
  it('backfills each base from the newest count row it has', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    // Wind back to a realistic v4-shaped database for the backfill to read: the
    // stamp table gone, v6's column with it, v7's, v10's, v11's and v12's tables
    // too, and v9's back in place, so every step after v4 really re-runs.
    const staged = new DatabaseSync(path)
    migrate(staged)
    staged.exec('DROP TABLE card_base_updates')
    staged.exec('ALTER TABLE owner_assignments DROP COLUMN owner_user_id')
    staged.exec('DROP TABLE trades')
    staged.exec('DROP TABLE auth_events')
    staged.exec('DROP TABLE base_progress')
    staged.exec('DROP TABLE max_level_reference')
    staged.exec('DROP TABLE wall_reference')
    staged.exec('DROP TABLE base_order')
    staged.exec(`
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);`)
    staged.exec('PRAGMA user_version = 4')

    const userId = Number(staged.prepare('SELECT id FROM users LIMIT 1').get()?.['id'])
    const insert = staged.prepare(
      `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insert.run('2026-08', '#AAABBB', 1, 2, '2026-08-01T10:00:00.000Z', userId)
    insert.run('2026-08', '#AAABBB', 2, 3, '2026-08-02T10:00:00.000Z', userId)
    insert.run('2026-08', '#CCCDDD', 5, 1, '2026-08-03T10:00:00.000Z', null)
    // A second season must get its own stamp, not be folded into the first.
    insert.run('2027-08', '#AAABBB', 9, 4, '2027-08-01T10:00:00.000Z', userId)

    assert.deepEqual(
      migrate(staged),
      Array.from({ length: SCHEMA_VERSION - 4 }, (_, index) => index + 5),
      'v4 leaves v5 onwards outstanding',
    )

    const stamps = staged
      .prepare(
        `SELECT season, player_tag, updated_at, updated_by_user_id
           FROM card_base_updates ORDER BY season, player_tag`,
      )
      .all()
      .map((row) => [
        row['season'],
        row['player_tag'],
        row['updated_at'],
        row['updated_by_user_id'],
      ])

    assert.deepEqual(stamps, [
      // The newer of A's two rows, and that row's updater.
      ['2026-08', '#AAABBB', '2026-08-02T10:00:00.000Z', userId],
      ['2026-08', '#CCCDDD', '2026-08-03T10:00:00.000Z', null],
      ['2027-08', '#AAABBB', '2027-08-01T10:00:00.000Z', userId],
    ])
    staged.close()
  })

  it('backfills nothing when there were no counts to lift', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM card_base_updates').get()?.['n']), 0)
    db.close()
  })

  it('is idempotent across two boots, stamps and all', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const first = openDatabase(path)
    first
      .prepare('INSERT INTO card_base_updates (season, player_tag, updated_at) VALUES (?, ?, ?)')
      .run('2026-08', '#AAABBB', '2026-08-02T10:00:00.000Z')
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    const second = openDatabase(path)
    assert.deepEqual(migrate(second), [], 'nothing left to apply')
    assert.equal(
      second.prepare('SELECT updated_at FROM card_base_updates').get()?.['updated_at'],
      '2026-08-02T10:00:00.000Z',
      'a second boot must not re-run the backfill over a live stamp',
    )
    second.close()
  })

  it('keeps a stamp when the account that wrote it is deleted', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const userId = createAuthStore(db).listUsers()[0]?.id
    assert.ok(userId)
    db.prepare(
      `INSERT INTO card_base_updates (season, player_tag, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run('2026-08', '#AAABBB', '2026-08-02T10:00:00.000Z', userId)

    db.exec(`DELETE FROM users WHERE id = ${userId}`)
    const row = db.prepare('SELECT updated_at, updated_by_user_id FROM card_base_updates').get()
    assert.equal(row?.['updated_at'], '2026-08-02T10:00:00.000Z', 'the time must survive')
    assert.equal(row?.['updated_by_user_id'], null, 'only the attribution is lost')
    db.close()
  })
})

describe('migration v6 — owner_user_id', () => {
  const NOW = '2026-08-01T10:00:00.000Z'

  /**
   * A database shaped the way the shipped build left it: at `user_version = 5`,
   * `owner_assignments` still free text only. Built by migrating to the head and
   * dropping v6's column back off, which keeps the rest of the schema honest
   * rather than re-typing an old copy of it that could drift.
   *
   * The owner texts are the three cases that matter, and they are the shapes the
   * live database actually holds: a name that matches an account but not its
   * case, one padded with whitespace, and one belonging to a clan member who has
   * no account at all.
   */
  async function createV5Database(
    path: string,
    owners: { tag: string; owner: string }[],
    users: { username: string; role?: 'admin' | 'user' }[],
  ): Promise<void> {
    await createV1Database(path, users)

    const db = new DatabaseSync(path)
    migrate(db)
    db.exec('ALTER TABLE owner_assignments DROP COLUMN owner_user_id')
    // Everything v6 onwards created goes too, and what v9 removed comes back, so a
    // v5-shaped fixture really is one and each later step re-runs against it.
    db.exec('DROP TABLE trades')
    db.exec('DROP TABLE auth_events')
    db.exec('DROP TABLE base_progress')
    db.exec('DROP TABLE max_level_reference')
    db.exec('DROP TABLE wall_reference')
    db.exec('DROP TABLE base_order')
    db.exec(`
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);`)
    db.exec('PRAGMA user_version = 5')

    const insert = db.prepare(
      `INSERT INTO owner_assignments (player_tag, owner, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)`,
    )
    for (const row of owners) insert.run(row.tag, row.owner, NOW, 1)

    assert.equal(columnsOf(path, 'owner_assignments').includes('owner_user_id'), false)
    db.close()
  }

  function ownerRows(db: DatabaseSync): [string, string, unknown][] {
    return db
      .prepare('SELECT player_tag, owner, owner_user_id FROM owner_assignments ORDER BY player_tag')
      .all()
      .map((row) => [String(row['player_tag']), String(row['owner']), row['owner_user_id']])
  }

  it('links the names that match an account and leaves the rest as labels', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV5Database(
      path,
      [
        // Matches 'Jared' but not its case.
        { tag: '#AAA1', owner: 'jared' },
        // Matches 'Sam', padded — the sort of thing free text collects.
        { tag: '#BBB2', owner: '  Sam  ' },
        // A real clan member with no account. Most of the live rows look like this.
        { tag: '#CCC3', owner: 'Casey' },
      ],
      [{ username: 'Jared' }, { username: 'Sam', role: 'user' }],
    )

    const db = openDatabase(path)
    const store = createAuthStore(db)
    const jared = store.listUsers().find((user) => user.displayName === 'Jared')?.id
    const sam = store.listUsers().find((user) => user.displayName === 'Sam')?.id
    assert.ok(jared)
    assert.ok(sam)

    assert.deepEqual(ownerRows(db), [
      ['#AAA1', 'jared', jared],
      ['#BBB2', '  Sam  ', sam],
      // Nothing resolved it, and nothing deleted it either: the text is the only
      // record of whose base this is, and it now simply owns nothing.
      ['#CCC3', 'Casey', null],
    ])

    // No row was lost, whatever resolved.
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM owner_assignments').get()?.['n']), 3)
    assert.deepEqual(summarizeOwnerAssignments(db), { total: 3, resolved: 2, unresolved: 1 })
    db.close()
  })

  it('reports the split, which is what the boot log says out loud', async () => {
    const path = join(tempDir(), 'coc.db')
    // The live shape: many assignments, one account, so most do not resolve.
    await createV5Database(
      path,
      [
        { tag: '#AAA1', owner: 'jcc' },
        { tag: '#BBB2', owner: 'Jared' },
        { tag: '#CCC3', owner: 'Sam' },
        { tag: '#DDD4', owner: 'Casey' },
      ],
      [{ username: 'jcc' }],
    )

    const db = openDatabase(path)
    assert.deepEqual(summarizeOwnerAssignments(db), { total: 4, resolved: 1, unresolved: 3 })
    db.close()
  })

  it('resolves a duplicate display name to the lowest id, not at random', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV5Database(
      path,
      [{ tag: '#AAA1', owner: 'Sam' }],
      // display_name has no UNIQUE constraint, so two accounts really can answer
      // to one name once it is trimmed and case-folded.
      [{ username: 'Sam' }, { username: 'Sam ', role: 'user' }],
    )

    const db = openDatabase(path)
    assert.deepEqual(ownerRows(db), [['#AAA1', 'Sam', 1]])
    db.close()
  })

  it('does not re-run the backfill over an assignment an admin has since changed', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV5Database(
      path,
      [
        { tag: '#AAA1', owner: 'Jared' },
        { tag: '#CCC3', owner: 'Casey' },
      ],
      [{ username: 'Jared' }, { username: 'Sam', role: 'user' }],
    )

    const first = openDatabase(path)
    const store = createAuthStore(first)
    const sam = store.listUsers().find((user) => user.displayName === 'Sam')?.id
    assert.ok(sam)
    assert.deepEqual(ownerRows(first), [
      ['#AAA1', 'Jared', 1],
      ['#CCC3', 'Casey', null],
    ])

    /*
     * What an admin does after the upgrade: hand #AAA1 to Sam instead, and resolve
     * the label on #CCC3 by pointing it at Sam too. A backfill that ran again would
     * read the stale text on #AAA1 and put Jared back — which is exactly the kind of
     * silent reversal `user_version` exists to make impossible.
     */
    first
      .prepare('UPDATE owner_assignments SET owner = ?, owner_user_id = ? WHERE player_tag = ?')
      .run('Sam', sam, '#AAA1')
    first
      .prepare('UPDATE owner_assignments SET owner = ?, owner_user_id = ? WHERE player_tag = ?')
      .run('Sam', sam, '#CCC3')
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    const second = openDatabase(path)
    assert.deepEqual(migrate(second), [], 'nothing left to apply')
    assert.deepEqual(ownerRows(second), [
      ['#AAA1', 'Sam', sam],
      ['#CCC3', 'Sam', sam],
    ])
    assert.deepEqual(summarizeOwnerAssignments(second), { total: 2, resolved: 2, unresolved: 0 })
    second.close()
  })

  it('takes a fresh database to a linked owner column with nothing in it', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)
    assert.deepEqual(summarizeOwnerAssignments(db), { total: 0, resolved: 0, unresolved: 0 })
    db.close()
    assert.ok(columnsOf(path, 'owner_assignments').includes('owner_user_id'))
  })

  it('keeps the assignment when the owning account is deleted', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV5Database(path, [{ tag: '#AAA1', owner: 'Jared' }], [{ username: 'Jared' }])

    const db = openDatabase(path)
    assert.deepEqual(ownerRows(db), [['#AAA1', 'Jared', 1]])

    // ON DELETE SET NULL, like every other user reference here: the assignment
    // outlives the account, dropping back to a label rather than vanishing.
    db.exec('DELETE FROM users WHERE id = 1')
    assert.deepEqual(ownerRows(db), [['#AAA1', 'Jared', null]])
    db.close()
  })
})

describe('migration v7 — trades', () => {
  const NOW = '2026-08-01T10:00:00.000Z'

  /**
   * A database shaped the way the v6 build left it: no `trades` table, no
   * `auth_events`, and `chat_messages` still present. Built by migrating to the head
   * and undoing everything from v7 on — which keeps the rest of the schema honest
   * rather than re-typing an old copy of it that could drift — then filling it with
   * the kinds of row a live install holds, so "did the outstanding steps disturb
   * anything" has something to answer with.
   *
   * Rewinding has to undo each later step, not just set the marker back: a plain
   * CREATE and a plain DROP both throw on a second run, which is the whole reason
   * `user_version` guards them, and a rewind that lied about the shape would be
   * testing a database no install ever had.
   */
  async function createV6Database(path: string): Promise<{ userId: number }> {
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = new DatabaseSync(path)
    migrate(db)
    db.exec('DROP TABLE trades')
    db.exec('DROP TABLE auth_events')
    db.exec('DROP TABLE base_progress')
    db.exec('DROP TABLE max_level_reference')
    db.exec('DROP TABLE wall_reference')
    db.exec('DROP TABLE base_order')
    db.exec(`
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_messages_user_id ON chat_messages (user_id);
`)
    db.exec('PRAGMA user_version = 6')

    const userId = Number(db.prepare('SELECT id FROM users LIMIT 1').get()?.['id'])

    db.prepare(
      `INSERT INTO owner_assignments (player_tag, owner, updated_at, updated_by_user_id, owner_user_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('#AAABBB', 'Jared', NOW, userId, userId)
    db.prepare(
      `INSERT INTO card_inventory (season, player_tag, card_id, count, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('2026-08', '#AAABBB', 4, 3, NOW, userId)
    db.prepare(
      `INSERT INTO card_base_updates (season, player_tag, updated_at, updated_by_user_id)
       VALUES (?, ?, ?, ?)`,
    ).run('2026-08', '#AAABBB', NOW, userId)
    // A stored chat message, which v9 is the step that deliberately destroys —
    // see the v9 describe below. It is seeded here so the rewind is a faithful v6.
    db.prepare('INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)').run(
      userId,
      'has anyone got a spare Barbarian',
      NOW,
    )

    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.['user_version']), 6)
    db.close()
    return { userId }
  }

  /** The insert every test below builds on: one pending trade. */
  function insertTrade(
    db: DatabaseSync,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const row = {
      season: '2026-08',
      base_a: '#AAABBB',
      base_b: '#CCCDDD',
      card_from_a: 1,
      card_from_b: 2,
      category: 'Elixir',
      status: 'pending',
      proposed_by_user_id: null,
      proposed_at: NOW,
      resolved_by_user_id: null,
      resolved_at: null,
      ...overrides,
    }

    db.prepare(
      `INSERT INTO trades
         (season, base_a, base_b, card_from_a, card_from_b, category, status,
          proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row['season'],
      row['base_a'],
      row['base_b'],
      row['card_from_a'],
      row['card_from_b'],
      row['category'],
      row['status'],
      row['proposed_by_user_id'] as number | null,
      row['proposed_at'],
      row['resolved_by_user_id'] as number | null,
      row['resolved_at'] as string | null,
    )
  }

  it('creates the table with the shape the trade routes rely on', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV6Database(path)

    const db = openDatabase(path)
    assert.deepEqual(migrate(db), [], 'opening it applied every outstanding step already')
    // `openDatabase` runs every migration to the head, so this is v7's shape *as
    // v14 leaves it* — the undo columns included — not v7 in isolation.
    assert.deepEqual(columnsOf(path, 'trades'), [
      'id',
      'season',
      'base_a',
      'base_b',
      'card_from_a',
      'card_from_b',
      'category',
      'status',
      'proposed_by_user_id',
      'proposed_at',
      'resolved_by_user_id',
      'resolved_at',
      'undone_by_user_id',
      'undone_at',
    ])
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
  })

  it('applies to a v6 database and preserves every row it already had', async () => {
    const path = join(tempDir(), 'coc.db')
    const { userId } = await createV6Database(path)

    const db = new DatabaseSync(path)
    assert.deepEqual(
      migrate(db),
      Array.from({ length: SCHEMA_VERSION - 6 }, (_, index) => index + 7),
      'v6 leaves v7 onwards outstanding',
    )

    // v7 adds a table; it must not have disturbed any of the ones before it.
    const store = createAuthStore(db)
    assert.equal(store.countUsers(), 1)
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD), 'the password still works')
    assert.equal(
      db.prepare('SELECT owner_user_id FROM owner_assignments').get()?.['owner_user_id'],
      userId,
    )
    assert.equal(Number(db.prepare('SELECT count FROM card_inventory').get()?.['count']), 3)
    assert.equal(db.prepare('SELECT updated_at FROM card_base_updates').get()?.['updated_at'], NOW)
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trades').get()?.['n']), 0)
    db.close()
  })

  it('is idempotent across two boots, trades and all', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV6Database(path)

    const first = openDatabase(path)
    insertTrade(first, { status: 'complete', resolved_at: NOW })
    first.close()

    assert.equal(userVersion(path), SCHEMA_VERSION)

    // A plain CREATE TABLE run twice would throw, so opening at all is half the
    // assertion; the row still being there is the other half.
    const second = openDatabase(path)
    assert.deepEqual(migrate(second), [], 'nothing left to apply')
    const row = second.prepare('SELECT base_a, status, resolved_at FROM trades').get()
    assert.equal(row?.['base_a'], '#AAABBB')
    assert.equal(row?.['status'], 'complete')
    assert.equal(row?.['resolved_at'], NOW)
    // Another table nothing in this step touches, to show the second boot was a
    // no-op across the schema rather than only inside `trades`.
    assert.equal(Number(second.prepare('SELECT COUNT(*) AS n FROM card_inventory').get()?.['n']), 1)
    second.close()
  })

  it('keeps a resolved trade when the account that resolved it is deleted', async () => {
    const path = join(tempDir(), 'coc.db')
    const { userId } = await createV6Database(path)

    const db = openDatabase(path)
    insertTrade(db, {
      status: 'complete',
      resolved_at: NOW,
      proposed_by_user_id: userId,
      resolved_by_user_id: userId,
    })

    // ON DELETE SET NULL, like every other user reference here. A completed trade
    // is the record of a swap that really happened: deleting the account must cost
    // the attribution, not the record — and must not leave a row the CHECK now
    // rejects, which is why `resolved_by_user_id` is not part of that constraint.
    db.exec(`DELETE FROM users WHERE id = ${userId}`)
    const row = db.prepare('SELECT status, resolved_at, resolved_by_user_id FROM trades').get()
    assert.equal(row?.['status'], 'complete', 'the trade must survive')
    assert.equal(row?.['resolved_at'], NOW, 'and so must when it happened')
    assert.equal(row?.['resolved_by_user_id'], null, 'only the attribution is lost')
    db.close()
  })

  it('is the last line on a trade that could not be honored', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV6Database(path)
    const db = openDatabase(path)

    // Each of these is validated in the route as well. The schema is the backstop,
    // and the only one a future caller cannot forget.
    const refusals: [string, Record<string, unknown>][] = [
      ['a status nobody defined', { status: 'maybe' }],
      ['a card id below the manifest', { card_from_a: 0 }],
      ['a card id above the manifest', { card_from_b: 61 }],
      ['a base trading with itself', { base_b: '#AAABBB' }],
      ['one card for itself, which moves nothing', { card_from_b: 1 }],
      ['a pending trade that claims to be resolved', { resolved_at: NOW }],
      ['a resolved trade with no timestamp', { status: 'complete' }],
    ]

    for (const [why, overrides] of refusals) {
      assert.throws(() => insertTrade(db, overrides), /CHECK constraint failed/, `${why} must be refused`)
    }

    insertTrade(db)
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trades').get()?.['n']), 1)
    db.close()
  })

  it('allows one pending proposal per swap, and any number of resolved ones', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV6Database(path)
    const db = openDatabase(path)

    insertTrade(db)
    // The same swap, pending twice, is one agreement recorded twice. The route
    // answers 409 before it gets here; the index is what makes that a guarantee.
    assert.throws(() => insertTrade(db), /UNIQUE constraint failed/)

    // History is not constrained: the same two bases can swap the same two cards
    // again next week, and a declined attempt must not block a second try.
    insertTrade(db, { status: 'declined', resolved_at: NOW })
    insertTrade(db, { status: 'complete', resolved_at: NOW })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trades').get()?.['n']), 3)

    // A different swap between the same bases is a different agreement.
    insertTrade(db, { card_from_a: 5 })
    // …and so is the same swap in another season.
    insertTrade(db, { season: '2027-08' })
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trades').get()?.['n']), 5)
    db.close()
  })

  it('takes a fresh database straight to the trades table, empty', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM trades').get()?.['n']), 0)
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
    assert.ok(columnsOf(path, 'trades').includes('resolved_at'))
  })
})

describe('migration v8 — plaintext session tokens are wiped, not rehashed', () => {
  /** A v7-shaped database: fully migrated, then rewound past v8 with rows in place. */
  async function createV7Database(path: string): Promise<{ userId: number }> {
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = new DatabaseSync(path)
    migrate(db)
    // v10's, v11's and v12's tables off and v9's back on, so each outstanding
    // step really is outstanding.
    db.exec('DROP TABLE auth_events')
    db.exec('DROP TABLE base_progress')
    db.exec('DROP TABLE max_level_reference')
    db.exec('DROP TABLE wall_reference')
    db.exec('DROP TABLE base_order')
    db.exec(`
CREATE TABLE chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);`)
    db.exec('PRAGMA user_version = 7')

    const userId = Number(db.prepare('SELECT id FROM users LIMIT 1').get()?.['id'])
    const insert = db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    const now = new Date().toISOString()
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()
    // Three live sessions, i.e. the state a working install is always in.
    for (const token of ['token-one', 'token-two', 'token-three']) {
      insert.run(token, userId, now, expires, now)
    }

    db.close()
    return { userId }
  }

  it('deletes every session row, whatever its expiry', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV7Database(path)

    const db = new DatabaseSync(path)
    assert.deepEqual(
      migrate(db),
      Array.from({ length: SCHEMA_VERSION - 7 }, (_, index) => index + 8),
      'v7 leaves v8 onwards outstanding',
    )
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.['n']), 0)
    db.close()
  })

  it('does not rehash them in place, which is the entire point', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV7Database(path)

    const db = openDatabase(path)
    const store = createAuthStore(db)

    /*
     * A rehash would have been the polite migration and would have defeated the
     * change: the tokens in last week's backup would keep working, which is exactly
     * the exposure v8 exists to close. So the plaintext token must not resolve, and
     * neither must its digest — the row is gone, not relocated.
     */
    assert.equal(store.resolveSession('token-one'), undefined)
    assert.equal(
      store.resolveSession(createHash('sha256').update('token-one').digest('hex')),
      undefined,
      'nor does replaying what the row would have been rehashed to',
    )
    db.close()
  })

  it('leaves the accounts alone, so signing in once more is the whole cost', async () => {
    const path = join(tempDir(), 'coc.db')
    const { userId } = await createV7Database(path)

    const db = openDatabase(path)
    const store = createAuthStore(db)

    assert.equal(store.countUsers(), 1)
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD))

    // And a session minted after the migration works, with the token nowhere in
    // the table — which is the state every install is in from here on.
    const session = store.createSession(userId)
    assert.ok(store.resolveSession(session.token))
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(session.token)?.['n'],
      0,
      'the token itself must not be a row id',
    )
    db.close()
  })
})

describe('migration v9 — the dead chat_messages table', () => {
  it('drops it, and a fresh database never ends up with one', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)

    // v1 still creates it — it is history and has to keep working from zero — and
    // v9 is what takes it away again, in the same boot for a fresh file.
    assert.throws(
      () => db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get(),
      /no such table/,
    )
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
    assert.deepEqual(columnsOf(path, 'chat_messages'), [], 'not merely empty — gone')
  })

  it('drops it from an install that has messages in it, and keeps everything else', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const seed = new DatabaseSync(path)
    // v1's shape, at v1's version, i.e. what the very first build left behind.
    seed.exec('PRAGMA user_version = 1')
    seed.exec(`
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);`)
    seed
      .prepare('INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)')
      .run(1, 'has anyone got a spare Barbarian', new Date().toISOString())
    seed.close()

    const db = openDatabase(path)
    const store = createAuthStore(db)

    assert.throws(() => db.prepare('SELECT body FROM chat_messages').get(), /no such table/)
    // The messages go with the table, deliberately. Nothing has read them since the
    // Trade Tracker replaced the UI, and a table nothing references is not free.
    assert.equal(store.countUsers(), 1, 'the accounts are untouched')
    assert.ok(await store.authenticate('jcc@example.com', LEGACY_PASSWORD))
    db.close()
  })
})

describe('migration v10 — auth_events', () => {
  it('creates the table with the shape the audit trail relies on', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)

    assert.deepEqual(columnsOf(path, 'auth_events'), [
      'id',
      'at',
      'kind',
      'actor_user_id',
      'target_user_id',
      'email',
      'ip',
      'detail',
    ])
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM auth_events').get()?.['n']), 0)
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
  })

  it('keeps an entry when the account it names is deleted, losing only the attribution', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)
    const userId = store.listUsers()[0]?.id
    assert.ok(userId)

    store.recordAuthEvent({
      kind: 'roleChanged',
      actorUserId: userId,
      targetUserId: userId,
      email: 'jcc@example.com',
      detail: 'user → admin',
    })

    db.exec(`DELETE FROM users WHERE id = ${userId}`)

    /*
     * ON DELETE SET NULL, like every other user reference in this schema. The trail
     * is the record of what happened: deleting an account must cost the attribution,
     * not the entry — an audit log that a deletion can erase is not one.
     */
    const [event] = store.authEvents().list()
    assert.ok(event)
    assert.equal(event.kind, 'roleChanged')
    assert.equal(event.detail, 'user → admin')
    assert.equal(event.actorUserId, null, 'only the attribution is lost')
    assert.equal(event.targetUserId, null)
    assert.equal(event.email, 'jcc@example.com', 'the address it was about survives')
    db.close()
  })
})

describe('migration v13 — base_progress.captured_by_user_id', () => {
  /** A v12-shaped database: fully migrated, then v13's column dropped back off. */
  async function createV12Database(path: string): Promise<void> {
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = new DatabaseSync(path)
    migrate(db)
    db.exec('ALTER TABLE base_progress DROP COLUMN captured_by_user_id')
    db.exec('PRAGMA user_version = 12')
    db.close()
  }

  function insertRow(db: DatabaseSync, tag: string, weekStart: string, capturedBy: string): void {
    db.prepare(
      `INSERT INTO base_progress (player_tag, week_start, captured_by, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(tag, weekStart, capturedBy, '2026-08-01T10:00:00.000Z')
  }

  function capturedByRow(db: DatabaseSync, tag: string): [unknown, unknown] {
    const row = db
      .prepare('SELECT captured_by, captured_by_user_id FROM base_progress WHERE player_tag = ?')
      .get(tag)
    return [row?.['captured_by'], row?.['captured_by_user_id']]
  }

  it('moves a digit-string captured_by into the new column and relabels it manual', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV12Database(path)

    const staged = new DatabaseSync(path)
    const userId = Number(staged.prepare('SELECT id FROM users LIMIT 1').get()?.['id'])
    insertRow(staged, '#AAABBB', '2026-08-04', String(userId))
    staged.close()

    const db = openDatabase(path)
    assert.deepEqual(capturedByRow(db, '#AAABBB'), ['manual', userId])
    db.close()
  })

  it('leaves auto and import rows alone', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV12Database(path)

    const staged = new DatabaseSync(path)
    insertRow(staged, '#AAABBB', '2026-08-04', 'auto')
    insertRow(staged, '#CCCDDD', '2026-08-04', 'import')
    staged.close()

    const db = openDatabase(path)
    assert.deepEqual(capturedByRow(db, '#AAABBB'), ['auto', null])
    assert.deepEqual(capturedByRow(db, '#CCCDDD'), ['import', null])
    db.close()
  })

  it('relabels a digit-string row even when the account it named no longer exists', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV12Database(path)

    const staged = new DatabaseSync(path)
    insertRow(staged, '#AAABBB', '2026-08-04', '9999')
    staged.close()

    const db = openDatabase(path)
    // The label still moves to 'manual' — a digit string always meant a person
    // typed it — but the id resolves to nothing rather than a dangling reference.
    assert.deepEqual(capturedByRow(db, '#AAABBB'), ['manual', null])
    db.close()
  })

  it('takes a fresh database straight to the new column', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)
    assert.ok(columnsOf(path, 'base_progress').includes('captured_by_user_id'))
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
  })
})

describe('migration v14 — trades.undone_by_user_id / undone_at', () => {
  const NOW = '2026-08-01T10:00:00.000Z'

  /**
   * A v13-shaped `trades` table: the schema v7 created, before this migration adds
   * the undo columns and widens the status `CHECK`. Built by migrating a fresh
   * database all the way to the head — which now includes v14 — and then
   * rewinding just this one table back to what v7 actually left it as, the same
   * approach the v7 block above uses and for the same reason: retyping an old
   * schema by hand risks drifting from what the real migration produced, where
   * dropping back to it cannot.
   */
  async function createV13Database(path: string): Promise<{ userId: number }> {
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = new DatabaseSync(path)
    migrate(db)
    const userId = Number(db.prepare('SELECT id FROM users LIMIT 1').get()?.['id'])

    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
CREATE TABLE trades_v13 (
  id                  INTEGER PRIMARY KEY,
  season              TEXT NOT NULL,
  base_a              TEXT NOT NULL,
  base_b              TEXT NOT NULL,
  card_from_a         INTEGER NOT NULL CHECK (card_from_a BETWEEN 1 AND 60),
  card_from_b         INTEGER NOT NULL CHECK (card_from_b BETWEEN 1 AND 60),
  category            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'declined')),
  proposed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  proposed_at         TEXT NOT NULL,
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TEXT,
  CHECK (base_a <> base_b),
  CHECK (card_from_a <> card_from_b),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
INSERT INTO trades_v13
  (id, season, base_a, base_b, card_from_a, card_from_b, category, status,
   proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at)
SELECT id, season, base_a, base_b, card_from_a, card_from_b, category, status,
       proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at
  FROM trades;
DROP TABLE trades;
ALTER TABLE trades_v13 RENAME TO trades;
CREATE INDEX trades_season_status ON trades (season, status, id);
CREATE UNIQUE INDEX trades_one_pending_per_swap
  ON trades (season, base_a, base_b, card_from_a, card_from_b)
  WHERE status = 'pending';
`)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA user_version = 13')

    db.prepare(
      `INSERT INTO trades
         (season, base_a, base_b, card_from_a, card_from_b, category, status,
          proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?)`,
    ).run('2026-08', '#AAABBB', '#CCCDDD', 1, 2, 'Elixir', userId, NOW, userId, NOW)

    assert.equal(Number(db.prepare('PRAGMA user_version').get()?.['user_version']), 13)
    db.close()
    return { userId }
  }

  it('adds the undo columns as NULL and leaves the existing row intact', async () => {
    const path = join(tempDir(), 'coc.db')
    const { userId } = await createV13Database(path)

    const db = openDatabase(path)
    const row = db.prepare('SELECT * FROM trades').get()
    assert.equal(row?.['status'], 'complete')
    assert.equal(row?.['resolved_by_user_id'], userId)
    assert.equal(row?.['resolved_at'], NOW)
    assert.equal(row?.['undone_by_user_id'], null)
    assert.equal(row?.['undone_at'], null)
    assert.deepEqual(
      columnsOf(path, 'trades').filter((name) => name.startsWith('undone')),
      ['undone_by_user_id', 'undone_at'],
    )
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
  })

  it('lets a row move to undone, which the old CHECK would have refused', async () => {
    const path = join(tempDir(), 'coc.db')
    const { userId } = await createV13Database(path)
    const db = openDatabase(path)

    const id = Number(db.prepare('SELECT id FROM trades').get()?.['id'])
    assert.doesNotThrow(() =>
      db
        .prepare(
          `UPDATE trades SET status = 'undone', undone_by_user_id = ?, undone_at = ? WHERE id = ?`,
        )
        .run(userId, NOW, id),
    )
    assert.equal(
      db.prepare('SELECT status FROM trades WHERE id = ?').get(id)?.['status'],
      'undone',
    )
    db.close()
  })

  it('refuses an undone_at that disagrees with the status', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV13Database(path)
    const db = openDatabase(path)

    const id = Number(db.prepare('SELECT id FROM trades').get()?.['id'])
    assert.throws(
      () => db.prepare(`UPDATE trades SET undone_at = ? WHERE id = ?`).run(NOW, id),
      /CHECK constraint failed/,
      'a complete row cannot carry an undo timestamp without the status to match',
    )
    db.close()
  })

  it('still refuses a second pending proposal of the same swap', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV13Database(path)
    const db = openDatabase(path)

    const insertPending = () =>
      db
        .prepare(
          `INSERT INTO trades
             (season, base_a, base_b, card_from_a, card_from_b, category, status, proposed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run('2026-08', '#EEEFFF', '#GGGHHH', 5, 6, 'Elixir', NOW)

    insertPending()
    assert.throws(
      insertPending,
      /UNIQUE constraint failed/,
      'the recreated index must still guard one pending swap per pair',
    )
    db.close()
  })

  it('takes a fresh database straight to the widened status check', async () => {
    const path = join(tempDir(), 'coc.db')
    const db = openDatabase(path)
    assert.ok(columnsOf(path, 'trades').includes('undone_by_user_id'))
    assert.equal(userVersion(path), SCHEMA_VERSION)
    db.close()
  })
})

describe('the ADMIN_EMAIL escape hatch', () => {
  it('fills a missing email without touching the password, then stops', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    // Before: a real account nobody can sign in to.
    assert.equal(store.countUsersWithEmail(), 0)

    const first = await bootstrapAdmin(store, { ADMIN_EMAIL: '  John@Crighton.net  ' })
    assert.equal(first.status, 'emailBackfilled')
    assert.match(first.message, /john@crighton\.net/)

    const [user] = store.listUsers()
    assert.equal(user?.email, 'john@crighton.net')
    assert.equal(user?.displayName, 'jcc', 'the display name is not overwritten')

    // The password is the one they already had — the whole point of this path.
    assert.ok(await store.authenticate('john@crighton.net', LEGACY_PASSWORD))
    assert.equal(await store.authenticate('john@crighton.net', 'some-other-password'), undefined)

    // Idempotent: a restart with the var still set finds nothing to do.
    const second = await bootstrapAdmin(store, { ADMIN_EMAIL: 'john@crighton.net' })
    assert.equal(second.status, 'existing')

    // And it cannot be used to *move* an address that is already set.
    const third = await bootstrapAdmin(store, { ADMIN_EMAIL: 'someone-else@example.com' })
    assert.equal(third.status, 'existing')
    assert.equal(store.listUsers()[0]?.email, 'john@crighton.net')

    db.close()
  })

  it('never creates an account, and never sets a password', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)
    await bootstrapAdmin(store, { ADMIN_EMAIL: 'john@crighton.net', ADMIN_PASSWORD: 'a-brand-new-one!!' })

    assert.equal(store.countUsers(), 1, 'the existing account is adopted, not duplicated')
    // ADMIN_PASSWORD is ignored on this path: it must not be able to reset a
    // password that has since been changed.
    assert.equal(await store.authenticate('john@crighton.net', 'a-brand-new-one!!'), undefined)
    assert.ok(await store.authenticate('john@crighton.net', LEGACY_PASSWORD))
    db.close()
  })

  it('says exactly what to set when nothing is configured', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = await bootstrapAdmin(store, {})
    assert.equal(result.status, 'noUsableEmail')
    assert.match(result.message, /ADMIN_EMAIL/)
    assert.match(result.message, /"jcc"/, 'it must name the account that is stranded')
    // Never invents a credential.
    assert.equal(store.countUsersWithEmail(), 0)
    db.close()
  })

  it('refuses a malformed ADMIN_EMAIL rather than storing it', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = await bootstrapAdmin(store, { ADMIN_EMAIL: 'not-an-address' })
    assert.equal(result.status, 'invalid')
    assert.equal(store.listUsers()[0]?.email, null)
    db.close()
  })

  it('refuses an ADMIN_EMAIL that belongs to somebody else', async () => {
    const path = join(tempDir(), 'coc.db')
    // The second row already holds the address; the first is the stranded admin.
    await createV1Database(path, [
      { username: 'jcc', role: 'admin' },
      { username: 'taken@example.com', role: 'user' },
    ])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    const result = await bootstrapAdmin(store, { ADMIN_EMAIL: 'taken@example.com' })
    assert.equal(result.status, 'invalid')
    assert.match(result.message, /already belongs/)
    assert.equal(store.listUsers()[0]?.email, null)
    // The other account keeps its address.
    assert.equal(store.listUsers()[1]?.email, 'taken@example.com')
    db.close()
  })

  it('leaves an already-usable install alone', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'jcc@example.com' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    assert.equal(
      (await bootstrapAdmin(store, { ADMIN_EMAIL: 'someone@else.com' })).status,
      'existing',
    )
    assert.equal(store.listUsers()[0]?.email, 'jcc@example.com')
    db.close()
  })

  it('does not adopt a non-admin account automatically', async () => {
    const path = join(tempDir(), 'coc.db')
    await createV1Database(path, [{ username: 'regular', role: 'user' }])

    const db = openDatabase(path)
    const store = createAuthStore(db)

    // Handing an admin's configured address to a plain user would be a quiet
    // privilege muddle, so it stays a loud message instead.
    const result = await bootstrapAdmin(store, { ADMIN_EMAIL: 'john@crighton.net' })
    assert.equal(result.status, 'noUsableEmail')
    assert.equal(store.listUsers()[0]?.email, null)
    db.close()
  })
})
