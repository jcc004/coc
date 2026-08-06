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
   * The login credential, normalized to lowercase. `null` only for a legacy row
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

/**
 * The account actions the server keeps an audit trail of.
 *
 * A closed union rather than free text, so the reader of a log line and the writer
 * of it cannot drift apart, and so a new kind is a deliberate addition here rather
 * than a typo that quietly becomes its own category. Named for what happened, not
 * for the route that caused it: `emailChanged` stays true if the address ever
 * becomes editable somewhere else.
 *
 * `loginBlocked` is the rate limiter refusing an attempt before any password work —
 * distinct from `loginFailed`, because a burst of the former is the brake working
 * and a burst of the latter is the attack it was working against.
 */
export type AuthEventKind =
  | 'loginSucceeded'
  | 'loginFailed'
  | 'loginBlocked'
  | 'logout'
  | 'passwordChanged'
  | 'userCreated'
  | 'userDisabled'
  | 'userEnabled'
  | 'roleChanged'
  | 'emailChanged'
  | 'displayNameChanged'
  | 'tempPasswordIssued'

/**
 * One row of the trail, as `GET /api/admin/auth-events` returns it.
 *
 * There is no password, no temporary password and no session token in this shape,
 * and there is nowhere for one to hide: `email` is the address a login attempt
 * used, and `detail` is a short literal written by the server.
 */
export interface AuthEvent {
  id: number
  /** ISO-8601 UTC, as every other timestamp in this app is. */
  at: string
  kind: AuthEventKind
  /** The signed-in account that acted, or `null` for an anonymous login attempt. */
  actorUserId: number | null
  /** Joined at read time, so a rename shows the person as they are known now. */
  actorDisplayName: string | null
  /** The account it was done to, when that is not the actor. */
  targetUserId: number | null
  targetDisplayName: string | null
  /** The login address an attempt used. Recorded because a *failed* attempt has no user. */
  email: string | null
  ip: string | null
  detail: string | null
}

/** `GET /api/admin/auth-events`. Newest first, capped — never the whole table. */
export interface AuthEventsResponse {
  events: AuthEvent[]
  /** Rows in the table altogether, so the client can say "50 of 1,203". */
  total: number
  /** Pass as `?before=` to fetch the next page. `null` when this was the last. */
  nextBefore: number | null
}
