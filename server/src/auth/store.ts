import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeEmail, type AdminUser, type SessionUser, type UserRole } from '@coc/shared'
import { burnPasswordWork, hashPassword, verifyPassword } from './passwords.ts'

/**
 * Everything that touches the two auth tables. The rest of the server sees this
 * interface and never the database, which is what lets `createApp` be handed a
 * store over a temp file in tests and a real file in production.
 */

/** 30 days, slid forward on every authenticated request. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 32 bytes of CSPRNG output, base64url — 256 bits, unguessable. */
const SESSION_TOKEN_BYTES = 32

/** Long enough for a real name, short enough not to wreck a table cell. */
export const DISPLAY_NAME_MAX = 64

export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is already in use.`)
    this.name = 'EmailTakenError'
  }
}

export function isValidDisplayName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= DISPLAY_NAME_MAX
}

/* node:sqlite hands back `Record<string, null | number | bigint | string | Uint8Array>`,
   so every column needs narrowing on the way out. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInt(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'user'
}

function toAdminUser(row: Record<string, unknown>): AdminUser {
  return {
    id: asInt(row['id']),
    guid: asText(row['guid']),
    displayName: asText(row['display_name']),
    email: asTextOrNull(row['email']),
    role: asRole(row['role']),
    createdAt: asText(row['created_at']),
    disabledAt: asTextOrNull(row['disabled_at']),
    mustChangePassword: asInt(row['must_change_password']) !== 0,
  }
}

function toSessionUser(row: Record<string, unknown>): SessionUser {
  const { id, guid, displayName, email, role, createdAt, mustChangePassword } = toAdminUser(row)
  return { id, guid, displayName, email, role, createdAt, mustChangePassword }
}

export interface ResolvedSession {
  user: SessionUser
  sessionId: string
}

export interface CreatedSession {
  id: string
  expiresAt: string
}

export interface CreateUserInput {
  email: string
  displayName: string
  password: string
  role: UserRole
}

export interface AuthStore {
  countUsers(): number
  /** How many accounts hold an email, i.e. how many can sign in at all. */
  countUsersWithEmail(): number
  /**
   * Admins who are not disabled. The one number behind "do not lock everybody
   * out": an install with zero of these has nobody who can create or re-enable an
   * account, and no route can undo that.
   */
  countActiveAdmins(): number
  listUsers(): AdminUser[]
  findUser(id: number): AdminUser | undefined
  createUser(input: CreateUserInput): AdminUser
  setDisabled(id: number, disabled: boolean): AdminUser | undefined
  /**
   * Replaces the password. `mustChangePassword` is the flag an admin-issued
   * temporary password sets and a self-chosen one clears, so it is a parameter of
   * the same write rather than a second statement that could be forgotten.
   * `undefined` for an unknown id — nothing was written.
   */
  setPassword(id: number, password: string, mustChangePassword?: boolean): AdminUser | undefined
  /** Fills in a missing (or corrects an existing) email. Never touches the password. */
  setEmail(id: number, email: string): AdminUser | undefined
  setDisplayName(id: number, displayName: string): AdminUser | undefined
  /**
   * Promote or demote. Sessions are deliberately left alone: `resolveSession`
   * reads the role from `users` on every request, so a change takes effect on the
   * target's next call without signing them out.
   */
  setRole(id: number, role: UserRole): AdminUser | undefined
  /** The lowest-id admin with no email — the account the escape hatch targets. */
  findOldestAdminWithoutEmail(): AdminUser | undefined
  /**
   * Verifies a password against an **email**. Constant work whether or not the
   * address exists — see the comment on the implementation. An account whose
   * email is null can never match, which is what makes it unable to authenticate.
   */
  authenticate(email: string, password: string): AdminUser | undefined
  /** Re-checks a signed-in user's own password, by id, for the change-password route. */
  verifyUserPassword(id: number, password: string): boolean
  createSession(userId: number, now?: Date): CreatedSession
  /** Validates, slides, and returns the session behind `token`; cleans up an
   *  expired one. `undefined` means "not authenticated" for every reason. */
  resolveSession(token: string, now?: Date): ResolvedSession | undefined
  deleteSession(token: string): void
  /** Revokes every session for a user, optionally sparing the one in hand. */
  deleteUserSessions(userId: number, exceptSessionId?: string): number
  pruneSessions(now?: Date): number
}

const USER_COLUMNS =
  'id, guid, display_name, email, role, created_at, disabled_at, must_change_password'

export function createAuthStore(db: DatabaseSync): AuthStore {
  const statements = {
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countUsersWithEmail: db.prepare('SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL'),
    countActiveAdmins: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL",
    ),
    listUsers: db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`),
    findUser: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`),
    // COLLATE NOCASE on the column makes this comparison case-insensitive.
    findByEmail: db.prepare(
      `SELECT ${USER_COLUMNS}, password_hash, password_salt FROM users WHERE email = ?`,
    ),
    findCredentials: db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?'),
    oldestAdminWithoutEmail: db.prepare(
      `SELECT ${USER_COLUMNS} FROM users
        WHERE email IS NULL AND role = 'admin' ORDER BY id LIMIT 1`,
    ),
    insertUser: db.prepare(
      `INSERT INTO users (guid, display_name, email, password_hash, password_salt, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    setDisabled: db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?'),
    setPassword: db.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = ?
        WHERE id = ?`,
    ),
    setEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),

    insertSession: db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    ),
    // ISO-8601 UTC strings sort lexicographically, so a plain string comparison
    // is a valid expiry check and the rows stay readable in a sqlite3 shell.
    selectSession: db.prepare(
      `SELECT s.id AS session_id, s.expires_at AS expires_at,
              u.id AS id, u.guid AS guid, u.display_name AS display_name, u.email AS email,
              u.role AS role, u.created_at AS created_at, u.disabled_at AS disabled_at,
              u.must_change_password AS must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    ),
    touchSession: db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteUserSessionsExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  }

  function findUser(id: number): AdminUser | undefined {
    const row = statements.findUser.get(id)
    return row ? toAdminUser(row) : undefined
  }

  return {
    countUsers() {
      return asInt(statements.countUsers.get()?.['n'])
    },

    countUsersWithEmail() {
      return asInt(statements.countUsersWithEmail.get()?.['n'])
    },

    countActiveAdmins() {
      return asInt(statements.countActiveAdmins.get()?.['n'])
    },

    listUsers() {
      return statements.listUsers.all().map(toAdminUser)
    },

    findUser,

    createUser({ email, displayName, password, role }) {
      const normalized = normalizeEmail(email)
      const { hash, salt } = hashPassword(password)
      try {
        const result = statements.insertUser.run(
          randomUUID(),
          displayName.trim(),
          normalized,
          hash,
          salt,
          role,
          new Date().toISOString(),
        )
        const created = findUser(Number(result.lastInsertRowid))
        if (!created) throw new Error('User vanished immediately after insert')
        return created
      } catch (cause) {
        if (cause instanceof Error && /UNIQUE constraint failed/.test(cause.message)) {
          throw new EmailTakenError(normalized)
        }
        throw cause
      }
    },

    setDisabled(id, disabled) {
      const user = findUser(id)
      if (!user) return undefined

      statements.setDisabled.run(disabled ? new Date().toISOString() : null, id)
      // Disabling has to take effect now, not at session expiry, so the sessions go
      // too. It deliberately touches nothing in saved_clans / owner_assignments:
      // that data belongs to the group, not to whoever happened to enter it.
      if (disabled) statements.deleteUserSessions.run(id)
      return findUser(id)
    },

    setPassword(id, password, mustChangePassword = false) {
      const { hash, salt } = hashPassword(password)
      // The flag rides along with the hash: a password the account holder chose
      // clears it, and one an admin issued sets it, in a single write. Splitting
      // the two would allow a state where the password moved and the flag did not.
      statements.setPassword.run(hash, salt, mustChangePassword ? 1 : 0, id)
      return findUser(id)
    },

    setDisplayName(id, displayName) {
      if (!findUser(id)) return undefined
      statements.setDisplayName.run(displayName.trim(), id)
      return findUser(id)
    },

    setRole(id, role) {
      if (!findUser(id)) return undefined
      statements.setRole.run(role, id)
      return findUser(id)
    },

    setEmail(id, email) {
      if (!findUser(id)) return undefined
      const normalized = normalizeEmail(email)
      try {
        statements.setEmail.run(normalized, id)
      } catch (cause) {
        if (cause instanceof Error && /UNIQUE constraint failed/.test(cause.message)) {
          throw new EmailTakenError(normalized)
        }
        throw cause
      }
      return findUser(id)
    },

    findOldestAdminWithoutEmail() {
      const row = statements.oldestAdminWithoutEmail.get()
      return row ? toAdminUser(row) : undefined
    },

    /**
     * The decoy hash in the miss branch is the point: without it, an unknown
     * address would answer in microseconds while a known one paid ~40 ms of
     * scrypt, which is an account oracle you can measure over the network.
     */
    authenticate(email, password) {
      const normalized = normalizeEmail(email)
      /*
       * A blank credential must not be allowed to reach the query, and a row whose
       * email is NULL cannot be matched by *any* value — which is precisely how
       * "no email means no login" is enforced rather than merely documented.
       */
      const row = normalized ? statements.findByEmail.get(normalized) : undefined
      if (!row) {
        burnPasswordWork(password)
        return undefined
      }

      const ok = verifyPassword(password, {
        hash: asText(row['password_hash']),
        salt: asText(row['password_salt']),
      })
      if (!ok) return undefined

      const user = toAdminUser(row)
      // A disabled account fails identically to a wrong password, after the same work.
      return user.disabledAt === null ? user : undefined
    },

    /*
     * By id, not by email: the change-password route already knows who is asking
     * from their session, and going back through the credential would lock a
     * null-email account out of a form it is otherwise entitled to use.
     */
    verifyUserPassword(id, password) {
      const row = statements.findCredentials.get(id)
      if (!row) {
        burnPasswordWork(password)
        return false
      }
      return verifyPassword(password, {
        hash: asText(row['password_hash']),
        salt: asText(row['password_salt']),
      })
    },

    createSession(userId, now = new Date()) {
      const id = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
      statements.insertSession.run(id, userId, now.toISOString(), expiresAt, now.toISOString())
      return { id, expiresAt }
    },

    resolveSession(token, now = new Date()) {
      if (!token) return undefined

      const row = statements.selectSession.get(token)
      if (!row) return undefined

      const nowIso = now.toISOString()
      if (asText(row['expires_at']) <= nowIso) {
        statements.deleteSession.run(token)
        return undefined
      }

      // A disabled account should not be able to ride an existing cookie.
      if (asTextOrNull(row['disabled_at']) !== null) {
        statements.deleteSession.run(token)
        return undefined
      }

      // Sliding expiry: one small UPDATE per authenticated request. At ten users
      // against a local file that is cheaper than the round trip that caused it.
      const slid = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
      statements.touchSession.run(slid, nowIso, token)

      return { user: toSessionUser(row), sessionId: asText(row['session_id']) }
    },

    deleteSession(token) {
      statements.deleteSession.run(token)
    },

    deleteUserSessions(userId, exceptSessionId) {
      const result = exceptSessionId
        ? statements.deleteUserSessionsExcept.run(userId, exceptSessionId)
        : statements.deleteUserSessions.run(userId)
      return Number(result.changes)
    },

    pruneSessions(now = new Date()) {
      return Number(statements.pruneSessions.run(now.toISOString()).changes)
    },
  }
}
