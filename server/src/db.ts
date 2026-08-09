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
 *
 * `chat_messages` is dropped again by v9, and this step still has to create it: a
 * fresh database passes through both, and a DROP of something never created is the
 * one failure the version marker cannot prevent. v9 says the rest.
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
 *   it is what everyone in the app already recognizes each other by.
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
    // so a second row that normalizes to the same address keeps a NULL email and
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
   * a person in the clan, who need not have an account in this app. (v6 adds the
   * account link alongside it, and says why the text stays.)
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

/**
 * v6 — `owner_user_id` on `owner_assignments`: a base belongs to an **account**
 * now, not to a name somebody typed.
 *
 * That is what makes "only the owner may edit this base's card counts" a question
 * the server can answer. Free text cannot be compared to a session; a user id can.
 *
 * The old `owner` text column is **kept**, deliberately. This install has 39
 * assignments written before accounts existed, carrying names of clan members who
 * mostly have no account at all, and the honest thing to do with a name that
 * matches nobody is to keep showing it. Dropping the column would delete the only
 * record of who a base belongs to in real life; leaving it makes the row a label
 * that grants no permissions — an unresolved row is writable by admins only, and
 * an admin reassigning it is what turns it into a real owner.
 *
 * The backfill matches `owner` against `users.display_name`, trimmed and
 * case-insensitively, because that text was only ever meant for human eyes and
 * "jared" and "Jared " were the same person to whoever typed them. Notes:
 *
 * - `LOWER` here is ASCII-only, which SQLite's built-in is; a display name that
 *   needs Unicode case folding stays unresolved rather than resolving wrongly.
 * - `display_name` is not unique, so a tie is broken by lowest id — arbitrary but
 *   deterministic, which matters more than which one wins.
 * - **Most rows are expected not to resolve.** That is not a failure: it is what a
 *   free-text column full of clan nicknames looks like. Nothing is deleted, and
 *   `summarizeOwnerAssignments` is what reports the split at boot.
 */
const v6: Migration = (db) => {
  db.exec(
    `ALTER TABLE owner_assignments
       ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`,
  )

  db.exec(`
UPDATE owner_assignments
   SET owner_user_id = (
     SELECT u.id
       FROM users u
      WHERE LOWER(TRIM(u.display_name)) = LOWER(TRIM(owner_assignments.owner))
      ORDER BY u.id
      LIMIT 1
   )
`)
}

/**
 * v7 — `trades`, the Trade Tracker's one table: a swap two bases have agreed to,
 * which either party can then mark complete or declined.
 *
 * Until now a trade was a *suggestion* computed on the client from the shared
 * inventories and thrown away on the next render. Nothing recorded that two
 * people had agreed to one, so "did we do that swap?" had no answer anywhere but
 * in a chat scrollback. A row per agreed trade is that answer, and completing one
 * is what moves the cards (see `trades-store.ts`).
 *
 * Shape notes, each deliberate:
 *
 * - `season` is stored, and is `CARD_SEASON` at the time of the proposal — never
 *   a value from a request, exactly as `card_inventory` is written. Next August
 *   cannot resolve this August's trades.
 * - `base_a` / `base_b` are canonical `#TAG`s with `base_a < base_b`, the same
 *   orientation `suggestTrades` produces, so one swap is one row however the two
 *   sides happened to name themselves. The `CHECK` keeps a base from trading with
 *   itself, which is rule 4 of the suggester restated where it cannot be skipped.
 * - The card `CHECK`s repeat `CARD_ID_MIN`…`CARD_ID_MAX` from the route, for the
 *   reason v4's do: the database is the last line and the only one a future
 *   caller cannot forget. `card_from_a <> card_from_b` is there because a swap of
 *   one card for itself moves nothing and cannot arise from the rules (a giver
 *   needs two while the receiver needs none of the same card).
 * - `category` is **not** constrained to the four decks here. The card id →
 *   category map is generated into `web/`, so neither this file nor the route can
 *   check that the two ids really share a deck; the route validates the value is
 *   one of the four names and the column stores what it was told. A CHECK listing
 *   the four would have to be migrated for a fifth deck while adding nothing the
 *   route does not already do.
 * - Both user columns are `ON DELETE SET NULL`, like every other user reference
 *   in this schema. A resolved trade is the record of a swap that really
 *   happened; deleting the account that resolved it must cost the attribution,
 *   not the record.
 * - The status/`resolved_at` `CHECK` ties the two together in the only place that
 *   cannot be bypassed: pending means no timestamp, resolved means there is one.
 *   `resolved_by_user_id` is left out of it, because a deleted account nulls that
 *   column and must not turn a stored row into an unwritable one.
 *
 * The partial unique index makes a duplicate *pending* proposal impossible while
 * leaving history alone: the same pair can swap the same two cards again next
 * week, and a declined attempt does not block a second try. The route answers 409
 * before it gets here; the index is what makes that guarantee rather than a race.
 *
 * Idempotence is the version pragma's job, as for every step: a plain CREATE
 * throws on a second run, and `user_version` is what guarantees there is none.
 */
const v7: Migration = (db) => {
  db.exec(`
CREATE TABLE trades (
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

-- Every list is one season's, pending first; this index serves that ordering.
CREATE INDEX trades_season_status ON trades (season, status, id);

CREATE UNIQUE INDEX trades_one_pending_per_swap
  ON trades (season, base_a, base_b, card_from_a, card_from_b)
  WHERE status = 'pending';
`)
}

/**
 * v8 — session tokens stop being stored in plaintext. **Everybody signs in again.**
 *
 * `sessions.id` *was* the bearer token: the exact string in the cookie, written to
 * the table verbatim. Anyone who could read `coc.db` — or any of the twenty
 * unencrypted copies `deploy/update.sh` keeps, or the WAL beside it — held a
 * working 30-day session for every signed-in account, no password needed and no
 * trace left behind. The store now hashes the cookie with SHA-256 and stores the
 * digest, so the file holds a verifier rather than a credential.
 *
 * SHA-256 rather than scrypt, deliberately: the token is 256 bits of CSPRNG output,
 * so there is no low-entropy guess for a slow hash to defend against, and this runs
 * on every authenticated request where 40 ms would be unaffordable.
 *
 * The rows are **deleted, not rehashed**. Rehashing in place would be the polite
 * option and would defeat the entire point: the tokens sitting in last week's
 * backups would keep working, which is precisely the exposure being closed. So the
 * cost is real and intended — every signed-in person is logged out once and signs
 * in again. That is cheaper than the alternative on any day, and much cheaper than
 * it looks on a ten-person tool.
 *
 * No schema change is needed; the column already holds an opaque string. What
 * changes is what the application puts in it, and this step is what guarantees no
 * row is left over from when that meant something else.
 */
const v8: Migration = (db) => {
  db.exec('DELETE FROM sessions')
}

/**
 * v9 — drop `chat_messages`.
 *
 * Created by v1 alongside the tables that are still in use, for a chat feature that
 * the Trade Tracker replaced. Nothing in the repo reads it, writes it, or joins to
 * it: no store, no route, no client call. A table nothing references is not free —
 * it is a `user_id` foreign key that constrains what `users` can do, a row that
 * shows up in every backup, and a thing the next reader of this schema has to work
 * out is dead.
 *
 * v1 is left exactly as it is. It is history, and it must still create this table
 * for a database starting from zero, because v9 is the step that removes it and a
 * migration that drops what was never created is the one kind of failure the
 * version marker cannot save. The pair reads oddly and is correct: create at v1,
 * drop at v9, and a fresh file passes through both in one boot.
 *
 * One concern per migration, which is why this is not folded into v8 — the session
 * wipe and a dead table have nothing to do with each other, and a step that does
 * two things is a step you cannot describe in its own header.
 */
const v9: Migration = (db) => {
  db.exec('DROP TABLE chat_messages')
}

/**
 * v10 — `auth_events`, the audit trail for account actions.
 *
 * `updated_by_user_id` on the shared tables records who changed the data. Nothing
 * recorded the actions that grant access to it, so logins, failed attempts,
 * lockouts, disables, role changes and temporary passwords left no trace at all —
 * and the questions that get asked after an incident ("when did that account become
 * an admin", "was there a burst of failures first") had no answer to be wrong
 * about. See `auth/events.ts` for what is written and what is deliberately not.
 *
 * Shape notes, each deliberate:
 *
 * - **Append-only by construction as far as the app is concerned**: nothing outside
 *   this file issues an UPDATE or a DELETE against it, and no route exposes either.
 *   SQLite cannot enforce that without triggers, which would then have to be
 *   migrated around; the guarantee is that there is no code path, and the reason it
 *   matters is that the accounts most worth auditing are the ones that could edit
 *   the log.
 * - `kind` is **not** constrained to a CHECK list. The union lives in
 *   `shared/src/auth-types.ts` where both the writer and the reader see it; a CHECK
 *   here would have to be migrated for every new kind while adding nothing the
 *   type does not already say, and a rejected INSERT would fail the action being
 *   audited rather than just its record.
 * - Both user columns are `ON DELETE SET NULL`, like every other user reference in
 *   this schema. The trail is the record of what happened; deleting an account must
 *   cost the attribution, not the entry. Accounts are disabled rather than deleted
 *   anyway, and disabling touches nothing here.
 * - `email` is stored *as well as* `target_user_id` because a failed login has no
 *   user to point at — the address somebody tried is the only identity the attempt
 *   has, and it is the whole content of "who was being targeted".
 * - `ip` is nullable, matching `clientIp`'s contract that there may be no address
 *   to record rather than a placeholder standing in for one.
 *
 * The index is on `id DESC` in effect (SQLite walks the primary key backwards for
 * free), so the one query this table serves — newest first, capped, optionally
 * before a cursor — needs no index of its own. `at` gets one because "what happened
 * around this time" is the other question anyone asks of an audit log, and it is
 * the one the primary key cannot answer.
 */
const v10: Migration = (db) => {
  db.exec(`
CREATE TABLE auth_events (
  id             INTEGER PRIMARY KEY,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  actor_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email          TEXT,
  ip             TEXT,
  detail         TEXT
);

CREATE INDEX auth_events_at ON auth_events (at);
`)
}

/**
 * v11 — `base_progress`, `max_level_reference`, `wall_reference`: weekly
 * per-base progress tracking, replacing a spreadsheet kept by hand.
 *
 * `base_progress` is written by two callers that must never step on each
 * other: a scheduled job (Town Hall, heroes, equipment, pets, troops, spells —
 * everything the API can answer) and a person (walls, buildings left, free-text
 * notes — everything it cannot). `progress/store.ts`'s `upsertSnapshot` is what
 * merges the two field by field rather than letting either overwrite the
 * other's half of the row. `auto_note` is neither of those: it is computed by
 * the store from the diff against the prior week and overwritten on every call,
 * so it is never accepted from a caller — the same shape as every other
 * server-owned value in this schema (the season, the audit trail's `at`).
 *
 * `player_tag` is stored, not FK'd to anything — a base tracked here need not be
 * one anybody has claimed with `owner_assignments`, the same way
 * `card_inventory` needs no such link.
 *
 * The JSON columns (`heroes_json`, `equipment_json`, `pets_json`,
 * `troops_json`, `spells_json`, `walls_json`) hold a whole array or object
 * rather than a row per unit, unlike `card_inventory`'s one-row-per-card shape.
 * A base's roster of heroes and troops is not sparse the way card counts are —
 * most of it is populated most weeks — so normalizing it into rows would
 * multiply the write count for no query this feature needs: nothing here
 * filters or aggregates across units within a week, only across a base's own
 * weeks.
 *
 * `max_level_reference` and `wall_reference` are reference data a wiki-scraper
 * script (a follow-up to this migration) keeps current. They exist so a later
 * percent-to-max computation can look up caps in bulk — `getAllMaxLevelReference`
 * / `getAllWallReference` — instead of one query per unit per base.
 */
const v11: Migration = (db) => {
  db.exec(`
CREATE TABLE base_progress (
  player_tag     TEXT NOT NULL,
  week_start     TEXT NOT NULL,
  th_level       INTEGER,
  heroes_json    TEXT,
  equipment_json TEXT,
  pets_json      TEXT,
  troops_json    TEXT,
  spells_json    TEXT,
  walls_json     TEXT,
  buildings_left TEXT,
  notes          TEXT,
  auto_note      TEXT,
  captured_by    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (player_tag, week_start)
);

CREATE TABLE max_level_reference (
  category   TEXT NOT NULL,
  name       TEXT NOT NULL,
  th_level   INTEGER NOT NULL,
  max_level  INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (category, name, th_level)
);

CREATE TABLE wall_reference (
  th_level         INTEGER PRIMARY KEY,
  max_wall_level   INTEGER NOT NULL,
  total_wall_count INTEGER NOT NULL,
  updated_at       TEXT NOT NULL
);
`)
}

/**
 * v12 — `base_order`, the first per-user server-side preference in this app.
 *
 * Every other saved preference (color scheme, last-viewed base, row limits) lives
 * in `localStorage` and stays on the one browser that set it. This one is
 * different because the user asked for it to be different: the order a member
 * puts their bases in is something they set up once and expect to see on their
 * phone too, so it has to live where every device can read it.
 *
 * One row per user, `ON DELETE CASCADE` so a removed account's ordering does not
 * linger as an orphan the way nothing else in this schema is allowed to. The
 * whole order is replaced on every save — `tag_order` is a JSON array, not one
 * row per position — the same "whole thing at once" shape `card_inventory`'s
 * base-level saves and `progress`'s manual captures already use. A user has at
 * most a handful of bases, so there is no per-position query this feature needs
 * that normalizing into rows would earn back, and a single UPDATE keeps a
 * reorder atomic without a transaction wrapped around N statements.
 *
 * `tag_order` deliberately does not have to list every base the user owns —
 * `base-order/routes.ts` accepts a partial list and leaves "where does a tag
 * missing from it belong" to the client (append at the end). The server's job is
 * only to remember the sequence it was given and to refuse a tag the caller does
 * not own; it is not the source of truth for which bases exist, `owner_assignments`
 * already is that.
 */
const v12: Migration = (db) => {
  db.exec(`
CREATE TABLE base_order (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tag_order  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`)
}

/**
 * v13 — `base_progress.captured_by_user_id`, and `captured_by` narrowed to a
 * closed label.
 *
 * Every other attribution column in this schema is an `INTEGER REFERENCES
 * users(id)`, joined to `display_name` at read time — `card_inventory
 * .updated_by_user_id`, `trades.proposed_by_user_id`, `auth_events
 * .actor_user_id`, and so on. `base_progress.captured_by` broke that pattern
 * from v11 on: a bare string, `'auto'` for the scheduled job or a user id typed
 * as *text* for a manual save. That meant a manual capture's account could
 * never resolve to a display name the way every other column's can without a
 * second query nothing performs, and would keep showing a stale id forever if
 * `users.display_name` ever changed, unlike every join-based column beside it.
 *
 * `captured_by` itself stays — narrowed to `'auto'`, `'import'` (the one-off
 * historical backfill script), or `'manual'` — so a reader can still tell *how*
 * a row was captured without a join, the job it always did. *Who* captured a
 * manual row now lives in the new `captured_by_user_id`, resolved the normal
 * way. `ON DELETE SET NULL`, like every other user reference here: the row is
 * the record of what was typed, so deleting the account must cost the
 * attribution, not the entry.
 *
 * Existing manual rows — `captured_by` holding a digit string, the pre-v13
 * shape — are backfilled in one pass: the id moves into the new column (`NULL`
 * if that account no longer exists), and the label is rewritten to `'manual'`.
 * Rows already holding `'auto'` or `'import'` are untouched by the `WHERE`.
 */
const v13: Migration = (db) => {
  db.exec(
    'ALTER TABLE base_progress ADD COLUMN captured_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
  )

  db.exec(`
UPDATE base_progress
   SET captured_by_user_id = (
         SELECT u.id FROM users u WHERE u.id = CAST(base_progress.captured_by AS INTEGER)
       ),
       captured_by = 'manual'
 WHERE captured_by NOT GLOB '*[^0-9]*' AND captured_by <> ''
`)
}

/**
 * v14 — `undone_by_user_id` / `undone_at` on `trades`, and `'undone'` joins the
 * status `CHECK`: the Trade Tracker's admin-only Undo.
 *
 * The table is rebuilt rather than ALTERed, the same reason v2 rebuilds `users`:
 * SQLite can add a column with a plain `ALTER TABLE`, but it cannot widen an
 * existing `CHECK`'s list of allowed values, and `'undone'` has to join `'pending'`
 * / `'complete'` / `'declined'` in the one `CHECK` v7 wrote. `foreign_keys` is OFF
 * for every migration step (see `migrate`, below), so the `DROP TABLE` here is as
 * safe as v2's `DROP TABLE users` was — confirmed still true by reading `migrate`
 * rather than assumed.
 *
 * Undo is a **third** audited event, not a rewrite of the second. `resolved_by_user_id`
 * / `resolved_at` are left exactly as completion wrote them — they are the record of
 * who completed the trade and when, and undoing it must not cost that attribution
 * any more than completing a trade costs the record of who proposed it. The new
 * pair records the separate, later fact: who reversed it, and when. Both are `ON
 * DELETE SET NULL`, matching every other user reference in this schema, for the
 * same reason every one of them is: the row is the record of something that really
 * happened, so losing the account must cost the attribution, not the row.
 *
 * `CHECK (undone_at IS NULL OR status = 'undone')` is one-directional, unlike v7's
 * two-way `(status = 'pending') = (resolved_at IS NULL)`. It rules out a row that
 * claims an undo timestamp while its status disagrees, but does not also require
 * `undone_at` for every `'undone'` row — because there is exactly one way to reach
 * that status, the `undo()` transaction in `trades-store.ts`, and it always writes
 * the timestamp in the same guarded `UPDATE` that sets the status. A two-way check
 * would guarantee nothing this file's own code does not already guarantee, at the
 * cost of a reader having to notice the asymmetry is deliberate rather than a typo.
 *
 * Both indexes v7 created live on the table itself and do not survive `DROP TABLE`,
 * so they are recreated verbatim after the rename. Easy to forget — nothing about
 * adding two columns suggests an index went missing with them.
 */
const v14: Migration = (db) => {
  db.exec(`
CREATE TABLE trades_v14 (
  id                  INTEGER PRIMARY KEY,
  season              TEXT NOT NULL,
  base_a              TEXT NOT NULL,
  base_b              TEXT NOT NULL,
  card_from_a         INTEGER NOT NULL CHECK (card_from_a BETWEEN 1 AND 60),
  card_from_b         INTEGER NOT NULL CHECK (card_from_b BETWEEN 1 AND 60),
  category            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'declined', 'undone')),
  proposed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  proposed_at         TEXT NOT NULL,
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TEXT,
  undone_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  undone_at           TEXT,
  CHECK (base_a <> base_b),
  CHECK (card_from_a <> card_from_b),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (undone_at IS NULL OR status = 'undone')
);

INSERT INTO trades_v14
  (id, season, base_a, base_b, card_from_a, card_from_b, category, status,
   proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at)
SELECT id, season, base_a, base_b, card_from_a, card_from_b, category, status,
       proposed_by_user_id, proposed_at, resolved_by_user_id, resolved_at
  FROM trades;

DROP TABLE trades;
ALTER TABLE trades_v14 RENAME TO trades;

-- Both indexes v7 created, recreated on the rebuilt table.
CREATE INDEX trades_season_status ON trades (season, status, id);

CREATE UNIQUE INDEX trades_one_pending_per_swap
  ON trades (season, base_a, base_b, card_from_a, card_from_b)
  WHERE status = 'pending';
`)
}

/**
 * v15 — `change_requests` and `change_request_amendments`: "Propose a change",
 * a member-initiated request that an admin resolves later.
 *
 * Modeled directly on `trades` (v7/v14): a status-bearing row a member starts,
 * an audit trail of who/when, and resolution as a separate later event rather
 * than an edit of the original. Two differences from that shape, both
 * deliberate:
 *
 * - **Cancel and resolve are independent columns, not one `status` enum.** A
 *   trade only ever has one of four mutually exclusive states; a change request
 *   can be canceled *and* resolved, in either order (an admin resolving an
 *   already-canceled request as harmless bookkeeping is the explicit design —
 *   see `server/src/change-requests/access.ts`). Folding that into a single
 *   enum would need a fifth value for "resolved and canceled" and a route that
 *   remembers to check two things whenever it means to check one; two nullable
 *   timestamps say the same thing without the cross-product.
 * - **Amendments are a child table**, not a column on the row. An amendment is a
 *   variable-length, append-only log — more of them can arrive at any time — so
 *   normalizing it the way `card_inventory` and `base_progress` normalize their
 *   own per-row facts is what lets it be queried and tested on its own, the same
 *   reasoning that keeps `auth_events` a table rather than a JSON blob on `users`.
 *
 * Column notes:
 *
 * - `subject` / `body` repeat `CHANGE_REQUEST_SUBJECT_MAX` / `_BODY_MAX`
 *   (`shared/src/change-request-types.ts`) as `CHECK`s, for the reason v4's
 *   card `CHECK`s do: the database is the last line and the only one a future
 *   caller cannot forget. Both also require at least one character — a blank
 *   request is not a request.
 * - `requested_by_user_id` is `ON DELETE SET NULL`, like every user reference in
 *   this schema: the request is the record of something somebody asked for, and
 *   deleting the account must cost the attribution, not the row.
 * - `canceled_at` has no companion "canceled by" column. Only the request's own
 *   author may ever cancel it (`mayCancelChangeRequest`), so the requester
 *   column already says who; a second column would only ever hold the same id.
 * - `hidden_at` is a personal display preference on the requester's own list —
 *   never read by the admin table — and is reversible, unlike `canceled_at`.
 * - The five `resolution_*` columns are all-or-nothing per the two `CHECK`s
 *   below: `resolution_type`/`resolved_at` rise and fall together (mirroring
 *   v7's `(status = 'pending') = (resolved_at IS NULL)`), and the two commit
 *   fields may only be set when `resolution_type = 'commit'`. Nothing enforces
 *   that they *are* set for a commit resolution — that is `resolveRequest`'s job
 *   in `server/src/change-requests/routes.ts`, the same division `trades`
 *   draws between what a `CHECK` guards and what the route validates.
 * - `resolution_commit_hash` / `_commit_subject` are recorded, **not verified**:
 *   the server has no git history at runtime to check a hash against (see
 *   `web/src/changelog.ts`'s own doc comment), so these are exactly as
 *   "recorded for display, not enforced" as `trades.category` is, for the same
 *   reason.
 *
 * `change_request_amendments.request_id` is `ON DELETE CASCADE`: an amendment
 * has no meaning once its request is gone, unlike every `ON DELETE SET NULL`
 * user reference above — the two describe different relationships, a child row
 * to its parent versus an edit to the account that made it. Requests themselves
 * are never deleted by any code path, so this is a guarantee about a case that
 * cannot currently arise rather than a lever anything pulls today.
 */
const v15: Migration = (db) => {
  db.exec(`
CREATE TABLE change_requests (
  id                        INTEGER PRIMARY KEY,
  subject                   TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  body                      TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  requested_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at              TEXT NOT NULL,
  canceled_at               TEXT,
  hidden_at                 TEXT,
  resolution_type           TEXT CHECK (resolution_type IN ('asDesigned', 'outOfScope', 'commit')),
  resolution_note           TEXT,
  resolution_commit_hash    TEXT,
  resolution_commit_subject TEXT,
  resolved_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at               TEXT,
  CHECK ((resolution_type IS NULL) = (resolved_at IS NULL)),
  CHECK (resolution_commit_hash IS NULL OR resolution_type = 'commit'),
  CHECK (resolution_commit_subject IS NULL OR resolution_type = 'commit')
);

-- Serves both "my requests" (author, newest first) and the admin table's need
-- to tell open rows from closed ones without a full scan.
CREATE INDEX change_requests_requester ON change_requests (requested_by_user_id, id);
CREATE INDEX change_requests_open ON change_requests (canceled_at, resolved_at, id);

CREATE TABLE change_request_amendments (
  id                 INTEGER PRIMARY KEY,
  request_id         INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  body               TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at         TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX change_request_amendments_request ON change_request_amendments (request_id, id);
`)
}

const MIGRATIONS: Migration[] = [
  v1,
  v2,
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
  v9,
  v10,
  v11,
  v12,
  v13,
  v14,
  v15,
]

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
  // The API server and the standalone progress/capture-snapshot.ts and
  // refresh-reference.ts scripts are separate OS processes that can each hold
  // this file open at once. WAL lets them all read concurrently, but a writer
  // still has to wait for another writer's transaction to finish. SQLite's
  // default busy timeout is 0 — a losing writer throws SQLITE_BUSY instead of
  // waiting — which turns an ordinary lock wait into an unhandled 500. This
  // gives a losing writer a real window to wait its turn instead.
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export interface OwnerAssignmentSummary {
  total: number
  /** Assignments tied to an account, i.e. ones that grant that user the write. */
  resolved: number
  /** Assignments still carrying only a text label, writable by admins alone. */
  unresolved: number
}

/**
 * The owner column's state, for the one line the server logs at boot.
 *
 * Read from the table rather than returned by the migration on purpose: the split
 * is worth seeing on *every* boot, not only the one that ran v6, and after an
 * admin has reassigned a few rows the stored numbers are the true ones. On the
 * boot that applies v6 they are exactly the backfill's result.
 */
export function summarizeOwnerAssignments(db: DatabaseSync): OwnerAssignmentSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN owner_user_id IS NULL THEN 0 ELSE 1 END) AS resolved
         FROM owner_assignments`,
    )
    .get()

  const total = Number(row?.['total'] ?? 0)
  const resolved = Number(row?.['resolved'] ?? 0)
  return { total, resolved, unresolved: total - resolved }
}

export function databasePathFromEnv(env: Record<string, string | undefined>): string {
  return env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH
}
