import { useCallback, useEffect, useState } from 'react'
import type {
  ChangeRequest,
  HideChangeRequest,
  ResolveChangeRequest,
  SubmitChangeRequest,
} from '@coc/shared'
import { ApiError, api } from './api.ts'

/**
 * "Propose a change" — `#/change-requests`. Two lists, each fetched by one
 * hook: the caller's own requests (`useMyChangeRequests`, everyone) and, for
 * an admin, every account's (`useAllChangeRequests`). Two more hooks,
 * `usePendingChangeRequestCount` and `useUnseenResolvedChangeRequestCount`,
 * answer narrower questions for a different screen entirely — the two halves
 * of the account-menu badge in `UserMenu.tsx` — and are the exports here that
 * poll rather than fetching once per mount; see `usePolledCount`'s doc comment.
 *
 * **Plain component state, not the `createServerStore` shape** `trades.ts` and
 * `owners.ts` use — the same call `base-order.ts` makes and for the same
 * reason, spelled out in its own doc comment: that shape exists so two
 * *simultaneously mounted* components watching the same shared list stay in
 * sync (the Trade Tracker appears on the card page and on every player page's
 * card panel at once). Both lists here are rendered in exactly one place —
 * this page — so there is only ever one reader to keep in sync with, and it
 * already refetches on every mutation. Nothing here needs resetting on
 * sign-out for the same reason `base-order.ts` needs no `reset*` call: it is
 * per-mount state that a route change already discards, unlike the
 * module-level caches `session.ts`'s `dropSharedCaches` exists to clear.
 */

function toApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, 'network', (cause as Error)?.message || 'Could not reach the server.')
}

export type ChangeRequestsStatus = 'loading' | 'error' | 'ready'

export interface MyChangeRequests {
  status: ChangeRequestsStatus
  requests: ChangeRequest[]
  error: ApiError | null
  submit: (input: SubmitChangeRequest) => Promise<ChangeRequest>
  amend: (id: number, body: string) => Promise<ChangeRequest>
  cancel: (id: number) => Promise<ChangeRequest>
  setHidden: (id: number, hidden: HideChangeRequest['hidden']) => Promise<ChangeRequest>
  /**
   * Patches `request` into this list if its id is already here, otherwise a
   * no-op — the mirror image of `useAllChangeRequests`' `refreshKey`, for the
   * opposite direction of the same gap: an admin resolving a request on the
   * *admin* table only ever patched that table's own state, so if the
   * resolved request happened to be one of the admin's own, "My requests"
   * kept showing it as still open. Reported and reproduced 2026-08-08,
   * straight after the `refreshKey` fix for the submit direction.
   *
   * `replaceRequest` already no-ops correctly when `request.id` is not in
   * `current` — `.map` over a list with no matching id returns every row
   * unchanged — so this is exactly that, exposed for a caller outside this
   * hook to use after *its own* mutation on a *different* list.
   */
  patch: (request: ChangeRequest) => void
}

/**
 * Replaces one request in `list` by id — every mutation here answers with the
 * row in its new state, so the list can be patched in place rather than
 * refetched, the same "the response already has the new state" shortcut
 * `useBaseOrder`'s `reorder` takes for its own list.
 */
function replaceRequest(list: ChangeRequest[], updated: ChangeRequest): ChangeRequest[] {
  return list.map((request) => (request.id === updated.id ? updated : request))
}

export function useMyChangeRequests(): MyChangeRequests {
  const [status, setStatus] = useState<ChangeRequestsStatus>('loading')
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [error, setError] = useState<ApiError | null>(null)

  const reload = useCallback(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    api
      .myChangeRequests()
      .then((response) => {
        if (cancelled) return
        setRequests(response.requests)
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(toApiError(cause))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => reload(), [reload])

  /*
   * Every write below submits, then patches the one row that changed into
   * local state from the response — never a full reload, since a submit
   * changes nothing about the rows already on screen and an amend/cancel/hide
   * only ever changes the one row it targeted. Errors are left to the caller:
   * each returns the promise so a form or a button can show its own message
   * the way `TradeTracker.tsx`'s `ResolveActions` does.
   */

  const submit = useCallback(async (input: SubmitChangeRequest) => {
    const { request } = await api.submitChangeRequest(input)
    setRequests((current) => [request, ...current])
    return request
  }, [])

  const amend = useCallback(async (id: number, body: string) => {
    const { request } = await api.amendChangeRequest(id, { body })
    setRequests((current) => replaceRequest(current, request))
    return request
  }, [])

  const cancel = useCallback(async (id: number) => {
    const { request } = await api.cancelChangeRequest(id)
    setRequests((current) => replaceRequest(current, request))
    return request
  }, [])

  const setHidden = useCallback(async (id: number, hidden: boolean) => {
    const { request } = await api.setChangeRequestHidden(id, { hidden })
    setRequests((current) => replaceRequest(current, request))
    return request
  }, [])

  const patch = useCallback((request: ChangeRequest) => {
    setRequests((current) => replaceRequest(current, request))
  }, [])

  return { status, requests, error, submit, amend, cancel, setHidden, patch }
}

export interface AllChangeRequests {
  status: ChangeRequestsStatus
  requests: ChangeRequest[]
  error: ApiError | null
  resolve: (id: number, input: ResolveChangeRequest) => Promise<ChangeRequest>
}

/**
 * The admin table. Fetched only while an admin actually has the page open —
 * `ChangeRequestsView` calls this hook conditionally on `user.role`, so a
 * member never issues the request `GET /api/admin/change-requests` would 403
 * on anyway.
 *
 * **`refreshKey` is what makes a brand-new submission show up here.** This
 * list and `useMyChangeRequests`' are two independent pieces of state, by
 * design (see the module doc comment) — `resolve` below patches a row this
 * hook already fetched, the same "the response already has the new state"
 * shortcut `submit`/`amend`/`cancel` use on the *other* hook, but nothing
 * about *submitting* a request runs through this hook at all, since
 * submission is always `useMyChangeRequests`' job, even for an admin
 * proposing their own. Without something to say "the other list changed,
 * refetch", an admin's own new request appeared in "My requests" (patched in
 * locally, immediately) but never in the admin table below it (fetched once,
 * on mount, and never again) — reported and reproduced 2026-08-08. The caller
 * bumps `refreshKey` after a successful submit; anything else that only ever
 * changes a row already on the list (`resolve`) keeps using the patch-in-place
 * shortcut, since a full refetch for that would be strictly more work for the
 * same result.
 */
export function useAllChangeRequests(refreshKey?: unknown): AllChangeRequests {
  const [status, setStatus] = useState<ChangeRequestsStatus>('loading')
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    api
      .allChangeRequests()
      .then((response) => {
        if (cancelled) return
        setRequests(response.requests)
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(toApiError(cause))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const resolve = useCallback(async (id: number, input: ResolveChangeRequest) => {
    const { request } = await api.resolveChangeRequest(id, input)
    setRequests((current) => replaceRequest(current, request))
    return request
  }, [])

  return { status, requests, error, resolve }
}

/* ---------- the account-menu badge ---------- */

/**
 * How often the badge polls while a session is open and the tab is visible.
 * Far coarser than `CARD_POLL_INTERVAL_MS` (30s, `card-refresh.ts`): a card
 * count or an incoming trade is time-sensitive to a person mid-trade, a stray
 * change request waiting on attention is not — noticing within a couple of
 * minutes of it landing is the whole point of a badge, not the second it
 * happened.
 */
export const PENDING_CHANGE_REQUEST_POLL_MS = 120_000

/**
 * The polling shape both halves of the account-menu badge share: fetch on
 * mount, every `PENDING_CHANGE_REQUEST_POLL_MS`, on window focus and tab
 * visibility (the same two listeners `use-card-refresh.ts` polls with, for
 * the same reason — a laptop woken from sleep or a tab switched back to
 * should not wait out the full interval), and once more whenever `menuOpen`
 * flips, so acting on one tab and opening the menu in another shows the new
 * count without waiting on the timer.
 *
 * `enabled` gates the whole thing off (returning `null` and asking nothing)
 * for a caller that already knows the answer is not for them —
 * `usePendingChangeRequestCount` uses it for a non-admin, the same restraint
 * `useAllChangeRequests` applies by only being called from a component that
 * itself only mounts for an admin; `useUnseenResolvedChangeRequestCount` has
 * no such gate, since every signed-in account can have a request resolved.
 *
 * There is no `useCardRefresh`-style in-flight guard: nothing here can be
 * clobbered by an overlapping request the way an unsaved edit can, so the
 * extra complexity would buy nothing. A failed poll is silently ignored,
 * leaving the last known count on screen — a stale number is a better badge
 * than one that blinks to nothing because a single request dropped.
 */
function usePolledCount(
  enabled: boolean,
  menuOpen: boolean,
  fetchCount: () => Promise<{ count: number }>,
): number | null {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      setCount(null)
      return
    }

    let cancelled = false
    const refresh = () => {
      fetchCount()
        .then((response) => {
          if (!cancelled) setCount(response.count)
        })
        .catch(() => {
          /* Keep the last known count — see the doc comment above. */
        })
    }

    refresh()
    const ticker = window.setInterval(refresh, PENDING_CHANGE_REQUEST_POLL_MS)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)

    return () => {
      cancelled = true
      window.clearInterval(ticker)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
    // `fetchCount` is always a stable `api.*` reference; adding it here would
    // only churn the effect on every render of a caller that inlines the
    // argument.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, menuOpen])

  return count
}

/**
 * The open (unresolved, uncanceled) change-request count — an admin's half of
 * the account-menu badge. `null` until the first answer lands, and `null` for
 * anyone who is not an admin without this hook ever asking (the endpoint
 * would 403 anyway). Mounted unconditionally from `UserMenu`, which renders
 * for every signed-in account, so the `isAdmin` gate lives in here rather
 * than in the caller.
 */
export function usePendingChangeRequestCount(isAdmin: boolean, menuOpen: boolean): number | null {
  return usePolledCount(isAdmin, menuOpen, api.pendingChangeRequestCount)
}

/**
 * How many of the caller's own requests were resolved since they last visited
 * `#/change-requests` — the other half of the account-menu badge, and the one
 * every signed-in account gets, admin or not (`ChangeRequestsView.tsx` calls
 * `api.markChangeRequestsViewed()` on mount, which is what brings this back to
 * zero). No `enabled` gate: unlike the admin count above, there is no account
 * this could 403 for.
 */
export function useUnseenResolvedChangeRequestCount(menuOpen: boolean): number | null {
  return usePolledCount(true, menuOpen, api.unseenResolvedChangeRequestCount)
}
