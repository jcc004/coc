import {
  normalizeTag,
  type AdminUser,
  type ApiErrorResponse,
  type CapitalRaidSeasonsResponse,
  type ChatMessage,
  type ChatResponse,
  type Clan,
  type ClanMembersResponse,
  type ClanSearchResponse,
  type CurrentWar,
  type EmailChangeResponse,
  type ImportRequest,
  type ImportResponse,
  type MeResponse,
  type OwnerBulkResponse,
  type OwnerBulkRow,
  type OwnersResponse,
  type Player,
  type SavedClanInput,
  type SavedClanRecord,
  type SavedClansResponse,
  type SessionUser,
  type TempPasswordResponse,
  type UserRole,
  type UsersResponse,
  type WarLogResponse,
} from '@coc/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Global 401 handler. Every route but login now needs a session, and a session
 * can expire while a tab sits open — so a 401 has to unwind the whole app to the
 * login screen rather than surface as an error inside whichever data panel
 * happened to ask first. Set once, by the session hook.
 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

/**
 * The same idea for the forced password change. An admin can flag an account
 * while its owner has the app open — or flag their own, from the admin panel —
 * and from that moment the server 403s every route but `/api/auth/{me,password,
 * logout}`. Without this, that shows up as an error inside whichever panel asked
 * first, with no clue that the fix is a password change.
 *
 * It is not the enforcement, only the routing of it: the gate is
 * `requirePasswordUpToDate` on the server, and it holds whatever the client does.
 */
let onPasswordChangeRequired: (() => void) | null = null

export function setPasswordChangeRequiredHandler(handler: (() => void) | null): void {
  onPasswordChangeRequired = handler
}

interface RequestOptions {
  signal?: AbortSignal
  body?: unknown
  /** A 401 that is the *answer* (bad credentials, the boot probe) not a lapse. */
  expectsAuthFailure?: boolean
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  { signal, body, expectsAuthFailure }: RequestOptions = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    // The session cookie is the whole mechanism; nothing is kept in JS or storage.
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) {
    // Parsed before either handler fires, because the forced-change case is
    // identified by the `reason` in the body rather than by the status alone.
    const errorBody = (await response.json().catch(() => undefined)) as ApiErrorResponse | undefined

    if (response.status === 401 && !expectsAuthFailure) onUnauthorized?.()
    if (response.status === 403 && errorBody?.error.reason === 'passwordChangeRequired') {
      onPasswordChangeRequired?.()
    }

    throw new ApiError(
      response.status,
      errorBody?.error.reason ?? 'unknown',
      errorBody?.error.message ?? `Request failed with status ${response.status}`,
      errorBody?.error.hint,
    )
  }

  return (await response.json()) as T
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, { signal })
}

const tagPath = (tag: string) => encodeURIComponent(normalizeTag(tag))

export const api = {
  player: (tag: string, signal?: AbortSignal) => get<Player>(`/api/players/${tagPath(tag)}`, signal),

  clan: (tag: string, signal?: AbortSignal) => get<Clan>(`/api/clans/${tagPath(tag)}`, signal),

  clanMembers: (tag: string, signal?: AbortSignal) =>
    get<ClanMembersResponse>(`/api/clans/${tagPath(tag)}/members`, signal),

  currentWar: (tag: string, signal?: AbortSignal) =>
    get<CurrentWar>(`/api/clans/${tagPath(tag)}/currentwar`, signal),

  warLog: (tag: string, signal?: AbortSignal) =>
    get<WarLogResponse>(`/api/clans/${tagPath(tag)}/warlog?limit=20`, signal),

  capitalRaidSeasons: (tag: string, signal?: AbortSignal) =>
    get<CapitalRaidSeasonsResponse>(
      `/api/clans/${tagPath(tag)}/capitalraidseasons?limit=6`,
      signal,
    ),

  searchClans: (name: string, signal?: AbortSignal) =>
    get<ClanSearchResponse>(`/api/clans?name=${encodeURIComponent(name)}`, signal),

  /* ---------- chat ---------- */

  /** Omit `after` for the most recent page; pass the newest known id to poll. */
  chat: (after?: number, signal?: AbortSignal) =>
    get<ChatResponse>(after === undefined ? '/api/chat' : `/api/chat?after=${after}`, signal),

  sendChat: (body: string) =>
    request<{ message: ChatMessage }>('POST', '/api/chat', { body: { body } }),

  /* ---------- auth ---------- */

  /** The boot probe. A 401 here is the normal "not signed in" answer. */
  me: (signal?: AbortSignal) =>
    request<MeResponse>('GET', '/api/auth/me', { signal, expectsAuthFailure: true }),

  /** Email, not a username: the credential moved, and the form follows. */
  login: (email: string, password: string) =>
    request<{ user: SessionUser }>('POST', '/api/auth/login', {
      body: { email, password },
      expectsAuthFailure: true,
    }),

  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', { body: {} }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; revokedSessions: number }>('POST', '/api/auth/password', {
      body: { currentPassword, newPassword },
      // A wrong current password is this form's own error, not a lapsed session.
      expectsAuthFailure: true,
    }),

  /* ---------- admin ---------- */

  users: (signal?: AbortSignal) => get<UsersResponse>('/api/admin/users', signal),

  createUser: (input: {
    email: string
    displayName: string
    password: string
    role: UserRole
  }) => request<{ user: AdminUser }>('POST', '/api/admin/users', { body: input }),

  setUserDisabled: (id: number, disabled: boolean) =>
    request<{ user: AdminUser }>('POST', `/api/admin/users/${id}/disable`, { body: { disabled } }),

  /** Corrects a login address. Revokes that account's sessions, never the caller's. */
  setUserEmail: (id: number, email: string) =>
    request<EmailChangeResponse>('PATCH', `/api/admin/users/${id}/email`, { body: { email } }),

  /** Cosmetic, so unlike the email it revokes nothing. */
  setUserDisplayName: (id: number, displayName: string) =>
    request<{ user: AdminUser }>('PATCH', `/api/admin/users/${id}/display-name`, {
      body: { displayName },
    }),

  /**
   * Promote or demote. `confirm` is required only to remove your *own* admin
   * role, which you cannot then restore yourself.
   */
  setUserRole: (id: number, role: UserRole, confirm = false) =>
    request<{ user: AdminUser }>('PATCH', `/api/admin/users/${id}/role`, {
      body: confirm ? { role, confirm: 'yes' } : { role },
    }),

  /**
   * Issues a temporary password. The server picks it — there is deliberately no
   * argument for one — and the plaintext in the response is the only copy that
   * will ever exist, since there is no email to send it by. It goes on screen once
   * and is never written to storage, a URL, or a log.
   */
  issueTempPassword: (id: number) =>
    request<TempPasswordResponse>('POST', `/api/admin/users/${id}/temp-password`, { body: {} }),

  /* ---------- shared data: saved clans and owners ---------- */

  savedClans: (signal?: AbortSignal) => get<SavedClansResponse>('/api/saved/clans', signal),

  saveClan: (input: SavedClanInput) =>
    request<{ clan: SavedClanRecord }>('POST', '/api/saved/clans', { body: input }),

  renameClan: (tag: string, name: string) =>
    request<{ clan: SavedClanRecord }>('PATCH', `/api/saved/clans/${tagPath(tag)}`, {
      body: { name },
    }),

  removeClan: (tag: string) =>
    request<{ ok: true }>('DELETE', `/api/saved/clans/${tagPath(tag)}`),

  owners: (signal?: AbortSignal) => get<OwnersResponse>('/api/owners', signal),

  removeOwner: (tag: string) => request<{ ok: true }>('DELETE', `/api/owners/${tagPath(tag)}`),

  /**
   * Bulk owner apply. Every row carries the value the caller believes is stored;
   * the server writes only the rows where that still holds and returns the rest as
   * conflicts, so a stale tab cannot overwrite a change it never saw.
   */
  applyOwners: (rows: OwnerBulkRow[]) =>
    request<OwnerBulkResponse>('POST', '/api/owners/bulk', { body: { rows } }),

  /** The one-time upload of whatever this browser still holds. Fills gaps only. */
  importBrowserData: (payload: ImportRequest) =>
    request<ImportResponse>('POST', '/api/import', { body: payload }),
}
