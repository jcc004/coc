import {
  normalizeTag,
  type AdminUser,
  type ApiErrorResponse,
  type BaseInventoryResponse,
  type BaseOrderResponse,
  type CapitalRaidSeasonsResponse,
  type CardCount,
  type CardInventoryResponse,
  type Clan,
  type ClanMembersResponse,
  type ClanSearchResponse,
  type CurrentWar,
  type EmailChangeResponse,
  type HandEnteredReferenceCategory,
  type ImportRequest,
  type ImportResponse,
  type ManualCaptureRequest,
  type MaxLevelReferenceRow,
  type MeResponse,
  type OwnerAssignResponse,
  type OwnerBulkResponse,
  type OwnerBulkRow,
  type OwnersResponse,
  type Player,
  type ProgressSnapshot,
  type SavedClanInput,
  type SavedClanRecord,
  type SavedClansResponse,
  type ProposeTradeRequest,
  type ResolveTradeResponse,
  type SessionUser,
  type TempPasswordResponse,
  type TradeResponse,
  type TradesResponse,
  type UserRole,
  type UsersResponse,
  type WallReferenceRow,
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
 * A thrown cause as a sentence to show somebody.
 *
 * An `ApiError` already carries a message written for a person, so it is used
 * verbatim; anything else reaching a catch block here is a fetch that never got an
 * answer, and "could not reach the server" is both what happened and what to do
 * about it. Here rather than in a component because three of them need it, and two
 * were importing it out of `AccountView`.
 */
export function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : 'Could not reach the server.'
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

  /**
   * Hands one base to one account. **Admin only, server-side** — the 403 it answers
   * a member with carries the reason ("An admin assigns ownership of a base…"),
   * which is what `owners.ts` surfaces rather than replacing with wording of its own.
   *
   * A `userId` and nothing else: a name cannot be compared against the session of
   * whoever is trying to write that base's card counts, which is why ownership moved
   * onto accounts in the first place. Clearing is `removeOwner`, not an empty name.
   */
  assignOwner: (tag: string, userId: number) =>
    request<OwnerAssignResponse>('PUT', `/api/owners/${tagPath(tag)}`, { body: { userId } }),

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

  /* ---------- shared data: the card inventory ---------- */

  /** Every base with cards recorded this season. The season is the server's. */
  cardInventory: (signal?: AbortSignal) =>
    get<CardInventoryResponse>('/api/cards/inventory', signal),

  cardInventoryFor: (tag: string, signal?: AbortSignal) =>
    get<BaseInventoryResponse>(`/api/cards/inventory/${tagPath(tag)}`, signal),

  /**
   * One base's whole set of counts in one request — never one request per card.
   * The body replaces everything stored for that base, and a count of 0 deletes
   * the row, so the sparse storage needs no separate delete endpoint.
   */
  saveCardInventory: (tag: string, counts: CardCount[]) =>
    request<BaseInventoryResponse>('PUT', `/api/cards/inventory/${tagPath(tag)}`, {
      body: { counts },
    }),

  /* ---------- shared data: the Trade Tracker ---------- */

  /**
   * Every trade this season, pending and resolved, for everybody. Shared like the
   * inventory it moves: two people looking at one agreed swap have to see the same
   * thing, or "did you do that trade?" has two answers.
   */
  trades: (signal?: AbortSignal) => get<TradesResponse>('/api/cards/trades', signal),

  /**
   * Record an agreed swap. The tags may be sent in either order — the server
   * orients them — and the season is the server's, never ours.
   *
   * A duplicate proposal answers 409 `alreadyProposed` **with the existing trade in
   * the body**, which is why `proposeTrade` in `trades.ts` treats that status as a
   * success rather than an error.
   */
  proposeTrade: (proposal: ProposeTradeRequest) =>
    request<TradeResponse>('POST', '/api/cards/trades', { body: proposal }),

  /**
   * Complete or decline. Both answer with the trade in its new state *and* both
   * bases' current counts, so one response is enough to refresh two bases rather
   * than re-reading the whole inventory.
   */
  completeTrade: (id: number) =>
    request<ResolveTradeResponse>('POST', `/api/cards/trades/${id}/complete`, { body: {} }),

  declineTrade: (id: number) =>
    request<ResolveTradeResponse>('POST', `/api/cards/trades/${id}/decline`, { body: {} }),

  /**
   * Reverses a completed trade, moving the two cards back. Admin only — the server
   * refuses anyone else with `forbidden`, not `notComplete`, so a caller can tell
   * "you may not" from "there is nothing to undo" the same way `completeTrade`'s
   * caller tells `alreadyResolved` from a genuine failure.
   */
  undoTrade: (id: number) =>
    request<ResolveTradeResponse>('POST', `/api/cards/trades/${id}/undo`, { body: {} }),

  /* ---------- shared data: weekly base progress ---------- */

  /** One base's captured weeks, newest first — the server's own order. */
  progressHistory: (tag: string, signal?: AbortSignal) =>
    get<{ history: ProgressSnapshot[] }>(`/api/progress/${tagPath(tag)}`, signal),

  /** Every base's latest week — the clan-wide progress board. */
  progressLatest: (signal?: AbortSignal) =>
    get<{ bases: ProgressSnapshot[] }>('/api/progress', signal),

  /**
   * The two reference tables `percentToMax` and `wallProgress` score a capture
   * against — refreshed weekly by a scheduled job, so this is worth caching
   * rather than fetching per component; see `useProgressReference` in `progress.ts`.
   */
  progressReference: (signal?: AbortSignal) =>
    get<{ maxLevels: MaxLevelReferenceRow[]; walls: WallReferenceRow[] }>(
      '/api/progress/reference',
      signal,
    ),

  /**
   * The hand-entered fields, merged into whatever the target week already holds.
   * Never the auto-captured fields (TH, heroes, equipment, pets, troops, spells) —
   * those come from the scheduled job, not this route. `payload.weekStart` omitted
   * targets the caller's current week (the server's own clock decides that); given,
   * it corrects an already-captured week instead — see `ManualCaptureRequest`'s own
   * doc comment and `server/src/progress/routes.ts`'s `resolveTargetWeek`.
   */
  saveProgressManual: (tag: string, payload: ManualCaptureRequest) =>
    request<{ snapshot: ProgressSnapshot }>('PUT', `/api/progress/${tagPath(tag)}/manual`, {
      body: payload,
    }),

  /**
   * Admin-only. Writes the wiki scrape cannot reach — see `HandEnteredReferenceCategory`
   * — so `category` is typed to only the two it covers rather than every
   * `UnitCategory`, the same restriction the server enforces.
   */
  saveProgressReference: (
    category: HandEnteredReferenceCategory,
    rows: { name: string; thLevel: number; maxLevel: number }[],
  ) =>
    request<{ ok: true; written: number }>('PUT', `/api/admin/progress/reference/${category}`, {
      body: rows,
    }),

  /* ---------- per-user base order ---------- */

  /** The caller's own saved order — never anyone else's; there is no `:userId`. */
  getBaseOrder: (signal?: AbortSignal) => get<BaseOrderResponse>('/api/base-order', signal),

  /**
   * Replaces the caller's whole saved order. The body is the bare array, not
   * `{ tags }` — see `BaseOrderResponse` in `@coc/shared` for why the request and
   * response shapes differ. The server accepts a partial list; it does not have
   * to name every base the caller owns.
   */
  saveBaseOrder: (tags: string[]) =>
    request<BaseOrderResponse>('PUT', '/api/base-order', { body: tags }),
}
