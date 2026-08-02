import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isValidEmail, normalizeEmail } from '@coc/shared'

/**
 * The one SQLite file behind accounts and the shared data.
 *
 * `node:sqlite` is chosen over `better-sqlite3` because it is in the Node
 * runtime from 22.5 on: no native module, so no compiler on the host and nothing
 * to rebuild when Node is upgraded. It prints an ExperimentalWarning on import;
 * if that ever becomes a real problem the escape hatch is `better-sqlite3`,
 * whose synchronous API is close enough that only this file changes.
 */

export const DEFAULT_DATABASE_PATH = './data/coc.db'

/**
 * Migrations, indexed by the version they upgrade *from*: `MIGRATIONS[0]` takes a
 * database at `user_version = 0` to 1, and so on. `PRAGMA user_version` is the
 * stored marker, which is what makes this deterministic rather than ad hoc —
 * a step runs exactly once, in order, and a database already at the head does
 * nothing at all on boot.
 *
 * Why not keep the old "CREATE TABLE IF NOT EXISTS every boot" approach: it can
 * create a table but never *change* one, so the moment a column has to be added
 * and backfilled there is nowhere to put that work. `IF NOT EXISTS` also cannot
 * tell a fresh database from an out-of-date one, which is exactly the distinction
 * that matters when a real account is already sitting in the file.
 */
type Migration = (db: DatabaseSync) => void

/**
 * v1 — the original two tables, plus chat. Written with IF NOT EXISTS on purpose:
 * a database created before `user_version` was used already has these and still
 * reports version 0, so v1 has to be a no-op for it and a create for a fresh file.
 */
const v1: Migration = (db) => {
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

CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_messages_user_id ON chat_messages (user_id);
`)
}

/**
 * v2 — `guid` / `display_name` / `email` on users, and the two shared tables.
 *
 * The users table is rebuilt rather than ALTERed because SQLite cannot add a
 * UNIQUE or a NOT NULL column to a populated table, and all three are wanted.
 * The rows are copied in JS rather than with one INSERT…SELECT because each needs
 * its own fresh UUID, which SQL alone cannot produce.
 *
 * Backfill rules, and why each one is what it is:
 *
 * - `guid`: a fresh v4 UUID per row. Nothing derived from the username, so it
 *   carries no information about the account.
 * - `display_name`: the old username. It was the only human label there was, and
 *   it is what everyone in the app already recognises each other by.
 * - `email`: adopted from the username **only if the username contains `@`** —
 *   someone who signed up with their address should not have to re-enter it.
 *   Otherwise left NULL, because inventing an address would either be wrong or
 *   would hand a login credential to whoever guessed the pattern. A NULL email
 *   means that row cannot authenticate; `bootstrapAdmin` is the escape hatch that
 *   fills it from `ADMIN_EMAIL` without touching the password.
 */
const v2: Migration = (db) => {
  db.exec(`
CREATE TABLE users_v2 (
  id            INTEGER PRIMARY KEY,
  guid          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  email         TEXT COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);
`)

  const legacy = db
    .prepare(
      `SELECT id, username, password_hash, password_salt, role, created_at, disabled_at
         FROM users ORDER BY id`,
    )
    .all()

  const insert = db.prepare(
    `INSERT INTO users_v2
       (id, guid, display_name, email, password_hash, password_salt, role, created_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const taken = new Set<string>()
  for (const row of legacy) {
    const username = typeof row['username'] === 'string' ? row['username'] : ''
    const candidate = normalizeEmail(username)
    // A duplicate would violate the UNIQUE index and abort the whole migration,
    // so a second row that normalises to the same address keeps a NULL email and
    // goes through the ADMIN_EMAIL escape hatch instead.
    const email = isValidEmail(candidate) && !taken.has(candidate) ? candidate : null
    if (email) taken.add(email)

    insert.run(
      row['id'] as number,
      randomUUID(),
      username,
      email,
      row['password_hash'] as string,
      row['password_salt'] as string,
      row['role'] as string,
      row['created_at'] as string,
      (row['disabled_at'] ?? null) as string | null,
    )
  }

  // Safe only because migrations run with foreign_keys OFF: with it on, dropping
  // `users` would cascade every session and chat message away.
  db.exec('DROP TABLE users')
  db.exec('ALTER TABLE users_v2 RENAME TO users')

  /*
   * The shared data. One row per tag for the whole install — not per user — so
   * "who owns this base" has a single canonical answer that everybody sees.
   *
   * `updated_by_user_id` is nullable with ON DELETE SET NULL: the data outlives
   * the account that entered it. Losing the attribution is acceptable; losing the
   * assignment because someone left the clan is not. (Accounts are disabled
   * rather than deleted anyway, and disabling touches no row here.)
   *
   * `owner` is free text rather than a FK to users because the owner of a base is
   * a person in the clan, who need not have an account in this app.
   */
  db.exec(`
CREATE TABLE saved_clans (
  clan_tag           TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  custom             INTEGER NOT NULL DEFAULT 0,
  clan_level         INTEGER,
  members            INTEGER,
  clan_points        INTEGER,
  war_league         TEXT,
  updated_at         TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE owner_assignments (
  player_tag         TEXT PRIMARY KEY,
  owner              TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`)
}

/**
 * v3 — `must_change_password` on users: the flag an admin-issued temporary
 * password sets, and the self-service password change clears.
 *
 * A plain `ALTER TABLE ADD COLUMN` is enough where v2 needed a whole rebuild.
 * SQLite refuses to add a `UNIQUE` or a bare `NOT NULL` column to a populated
 * table, but `NOT NULL DEFAULT 0` is fine, and 0 is what every existing row
 * wants: nobody who already knows their own password should be met by a
 * change-it-now screen because the schema moved under them.
 *
 * Idempotence is the version pragma's job, as for every other step — `ADD COLUMN`
 * has no `IF NOT EXISTS`, so a second run would throw rather than no-op, which is
 * exactly why the marker is what guards it.
 */
const v3: Migration = (db) => {
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')
}

/**
 * v4 — `card_inventory`, the hand-entered card counts for the August event.
 *
 * Shared across every account, exactly like `owner_assignments`: a base's card
 * counts are a fact about that base, not a private opinion, and trade
 * suggestions only mean anything if everybody reads the same numbers.
 * `updated_by_user_id` is nullable with ON DELETE SET NULL for the same reason
 * it is there — the counts outlive the account that typed them, and disabling an
 * account is a timestamp on `users`, so it touches nothing here at all.
 *
 * Rows are **sparse**: absent means zero, which the store enforces by deleting
 * rather than storing a 0. Sixty rows per base would be sixty times the writes
 * to say almost nothing.
 *
 * Both CHECKs restate limits the route already validates, on purpose — the
 * database is the last line, and the only one a future caller cannot forget.
 * `card_id` is bounded by the 60-card manifest (`CARD_ID_MAX` in
 * `shared/src/card-types.ts`); a 61st card needs a migration as well as a
 * regenerated card module, and that friction is intended. `count` still allows
 * 0 because 0 is a legal value on the wire, even though no row ever stores one.
 *
 * `season` leads the primary key because every read is scoped to one season, so
 * the PK index alone serves them and a separate index would be dead weight.
 *
 * Idempotence is the version pragma's job, as for every other step: a plain
 * CREATE throws on a second run, and `user_version` is what guarantees there is
 * never a second run.
 */
const v4: Migration = (db) => {
  db.exec(`
CREATE TABLE card_inventory (
  season             TEXT NOT NULL,
  player_tag         TEXT NOT NULL,
  card_id            INTEGER NOT NULL CHECK (card_id BETWEEN 1 AND 60),
  count              INTEGER NOT NULL CHECK (count BETWEEN 0 AND 10),
  updated_at         TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (season, player_tag, card_id)
);
`)
}

/**
 * v5 — `card_base_updates`, one row per base saying when its counts were last
 * edited and by whom.
 *
 * Why this is not just derived from `card_inventory`, which is where it started:
 * the counts are stored **sparsely**, so a base whose every count is set back to
 * zero has no rows left — and with them went the only record that anyone had
 * touched it. "When was this base last checked" then had no answer for exactly
 * the base most likely to prompt the question. The stamp has to outlive the
 * rows, so it needs a row of its own.
 *
 * One row per base rather than per card: a base is saved whole, in one
 * transaction, so a per-card stamp would be sixty copies of one fact.
 *
 * The backfill takes each base's newest surviving `card_inventory` row, so an
 * install already at v4 keeps the attribution it had rather than resetting every
 * base to "never edited". A base already emptied before this migration has
 * nothing to recover and stays absent — that history is genuinely gone.
 */
const v5: Migration = (db) => {
  db.exec(`
CREATE TABLE card_base_updates (
  season             TEXT NOT NULL,
  player_tag         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (season, player_tag)
);

INSERT INTO card_base_updates (season, player_tag, updated_at, updated_by_user_id)
SELECT season, player_tag, MAX(updated_at),
       -- The updater of the newest row, which is the one the stamp describes.
       (SELECT i2.updated_by_user_id
          FROM card_inventory i2
         WHERE i2.season = i1.season AND i2.player_tag = i1.player_tag
         ORDER BY i2.updated_at DESC, i2.card_id ASC
         LIMIT 1)
  FROM card_inventory i1
 GROUP BY season, player_tag;
`)
}

const MIGRATIONS: Migration[] = [v1, v2, v3, v4, v5]

/** The version a fully migrated database reports. */
export const SCHEMA_VERSION = MIGRATIONS.length

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.['user_version']
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/**
 * Brings `db` up to {@link SCHEMA_VERSION}, one step at a time, and returns the
 * versions it actually applied — `[]` on an already-current database, which is
 * what makes a second boot a no-op.
 *
 * Each step is its own transaction, so a failure leaves the database at the last
 * version that completed rather than half-way through one. `foreign_keys` is off
 * for the duration (SQLite's own advice for schema changes) because v2 has to
 * drop and re-create `users`, which a live FK would either refuse or cascade
 * through; the pragma cannot be set inside a transaction, hence the ordering.
 */
export function migrate(db: DatabaseSync): number[] {
  const applied: number[] = []

  for (let version = readUserVersion(db); version < MIGRATIONS.length; version += 1) {
    const step = MIGRATIONS[version]
    if (!step) break

    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN')
    try {
      step(db)
      // Not parameterisable — PRAGMA takes a literal. The value is an array index.
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      db.exec('PRAGMA foreign_keys = ON')
      throw cause
    }
    db.exec('PRAGMA foreign_keys = ON')
    applied.push(version + 1)
  }

  return applied
}

/**
 * Opens (creating if needed) the database at `path` and migrates it to the head.
 * `:memory:` is passed through untouched so tests can use it.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)
  // WAL survives a crash better and lets a read run while a write is in flight.
  // It is a no-op on an in-memory database, which is why it is not conditional.
  db.exec('PRAGMA journal_mode = WAL')
  migrate(db)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export function databasePathFromEnv(env: Record<string, string | undefined>): string {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH
}
