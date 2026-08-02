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
    if (response.status === 401 && !expectsAuthFailure) onUnauthorized?.()

    const errorBody = (await response.json().catch(() => undefined)) as ApiErrorResponse | undefined
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
