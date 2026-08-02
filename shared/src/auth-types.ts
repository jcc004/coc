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

/**
 * Minimum password length the server enforces. Exported so the login and
 * password-change forms can say the rule up front instead of round-tripping to
 * discover it.
 */
export const MIN_PASSWORD_LENGTH = 12
