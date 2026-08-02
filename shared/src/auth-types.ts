/**
 * Shapes exchanged by `/api/auth/*` and `/api/admin/*`. They live in `shared`
 * for the same reason the CoC types do: the server writes them and the UI reads
 * them, so one declaration keeps the two honest.
 *
 * Nothing here carries a password or a session token — the token only ever
 * exists in the `HttpOnly` cookie, and the hash never leaves the server.
 */

export type UserRole = 'admin' | 'user'

/** The caller's own identity, as returned by `GET /api/auth/me`. */
export interface SessionUser {
  id: number
  /**
   * Stable external identifier. `id` stays the integer that other rows FK to; the
   * guid is the one that can be shown or handed to another system without
   * leaking how many accounts exist or in what order they were created.
   */
  guid: string
  /** Human label. Free text, shown in the topbar and used to attribute edits. */
  displayName: string
  /**
   * The login credential, normalised to lowercase. `null` only for a legacy row
   * the migration could not derive one for — **an account with a null email
   * cannot authenticate at all** until `ADMIN_EMAIL` or an admin fills it in.
   */
  email: string | null
  role: UserRole
  createdAt: string
  /**
   * Set when an admin has issued a temporary password. While it is true the API
   * refuses everything but `/api/auth/me`, `/api/auth/password` and
   * `/api/auth/logout`, so the client's forced-change screen is backed by a
   * server gate rather than being the only thing standing in the way.
   */
  mustChangePassword: boolean
}

/** Adds the one field only an admin has any use for. */
export interface AdminUser extends SessionUser {
  disabledAt: string | null
}

export interface MeResponse {
  user: SessionUser
}

export interface UsersResponse {
  users: AdminUser[]
}

/** `PATCH /api/admin/users/:id/email`. */
export interface EmailChangeResponse {
  user: AdminUser
  /** Sessions of the *target* account that were revoked — never the caller's own. */
  revokedSessions: number
}

/**
 * `POST /api/admin/users/:id/temp-password`.
 *
 * `password` is plaintext and is the **only** time this value exists outside a
 * hash: there is no email delivery, so the response body is the whole channel.
 * Show it once, never persist it, never put it in a URL.
 */
export interface TempPasswordResponse {
  user: AdminUser
  password: string
  revokedSessions: number
}

/**
 * Minimum password length the server enforces. Exported so the login and
 * password-change forms can say the rule up front instead of round-tripping to
 * discover it.
 */
export const MIN_PASSWORD_LENGTH = 12
