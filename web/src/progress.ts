import { useSyncExternalStore } from 'react'
import type {
  ManualCapturePayload,
  MaxLevelReferenceRow,
  ProgressSnapshot,
  WallReferenceRow,
} from '@coc/shared'
import { ApiError, api } from './api.ts'
import { type AsyncState, useAsync } from './hooks.ts'
import { createServerStore, type StoreSnapshot, type StoreStatus } from './server-store.ts'

/**
 * Weekly base progress, mirrored client-side. Same mechanism as `card-inventory.ts`
 * and for the same reason: **the clan-wide latest-week list** — `GET /api/progress` —
 * is one shared list everyone looking at the progress board has to agree on, so it is
 * one module-level `createServerStore` over `useSyncExternalStore`, not a fetch per
 * mount. `status` and `error` ride along in the snapshot because this is a cache of
 * something another person can alter, and a failed write must never look like a
 * success — `mutate` rethrows for exactly that reason.
 *
 * **A base's full history is deliberately not part of this store.** `GET
 * /api/progress/:tag` is a different shape (every week, not the latest) and only one
 * panel — the base being viewed — ever wants it at a time, so caching it at module
 * scope would hold every base a session has ever opened in memory for nothing.
 * `useProgressHistory` below fetches it directly through `useAsync`, the same
 * per-param async pattern `hooks.ts` already uses for a player or a clan.
 */

const store = createServerStore<ProgressSnapshot>(async () => (await api.progressLatest()).bases)

/** The clan-wide "everyone's latest week" list. */
export function useProgressLatest(): ProgressSnapshot[] {
  return store.use().entries
}

/** Loading and error state, for the places that have to report it. */
export function useProgressLatestState(): StoreSnapshot<ProgressSnapshot> {
  return store.use()
}

/**
 * Saves this week's hand-entered fields for one base, then refreshes the shared
 * latest-week list so it carries the server's own `updatedAt` / `capturedBy` rather
 * than a guess — the same shape `saveBaseCounts` takes in `card-inventory.ts`.
 * Rethrows on failure so the form can say the write did not happen.
 */
export async function saveProgressManual(
  tag: string,
  payload: ManualCapturePayload,
): Promise<ProgressSnapshot> {
  const { snapshot } = await store.mutate(() => api.saveProgressManual(tag, payload))
  return snapshot
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetProgress(): void {
  store.reset()
}

/**
 * One base's whole captured history, newest first as the server orders it.
 *
 * `reloadToken` exists so a caller can force a refetch after its own write lands —
 * bumping it is a fresh value for `useAsync`'s dependency array, which is what that
 * hook already treats as "load again". It defaults to 0 so a read-only view can call
 * this with just a tag.
 */
export function useProgressHistory(
  tag: string,
  reloadToken = 0,
): AsyncState<ProgressSnapshot[]> {
  return useAsync(
    (signal) => api.progressHistory(tag, signal).then((response) => response.history),
    [tag, reloadToken],
  )
}

/* ---------- the reference tables ---------- */

/**
 * The two caps `percentToMax` and `wallProgress` (`progress-percent.ts`) score a
 * capture against — `GET /api/progress/reference`. Changed only weekly, by the
 * scheduled job that refreshes the wiki scrape, so this is cached at module scope
 * the same way `useProgressLatest` above is, rather than fetched by every panel
 * that wants a percent.
 *
 * Not a second `createServerStore`, because that store's shape is one flat list of
 * one row type and this endpoint answers with two lists in one request — wrapping
 * that in a list of one would be a shape that exists only to satisfy the generic.
 * The mechanics are otherwise identical: a module-level snapshot, a listener set,
 * `useSyncExternalStore`, and concurrent loads sharing one in-flight request.
 */
export interface ProgressReferenceSnapshot {
  status: StoreStatus
  maxLevels: MaxLevelReferenceRow[]
  walls: WallReferenceRow[]
  /** The last failure, load or write. Cleared by the next success. */
  error: ApiError | null
}

let referenceSnapshot: ProgressReferenceSnapshot = {
  status: 'idle',
  maxLevels: [],
  walls: [],
  error: null,
}
const referenceListeners = new Set<() => void>()
let referenceInFlight: Promise<void> | null = null

function commitReference(next: ProgressReferenceSnapshot): void {
  referenceSnapshot = next
  for (const listener of referenceListeners) listener()
}

function loadReference(): Promise<void> {
  if (referenceInFlight) return referenceInFlight

  commitReference({ ...referenceSnapshot, status: 'loading', error: null })

  referenceInFlight = api
    .progressReference()
    .then(({ maxLevels, walls }) =>
      commitReference({ status: 'ready', maxLevels, walls, error: null }),
    )
    .catch((cause: unknown) => {
      const error =
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'network', (cause as Error)?.message || 'Could not reach the server.')
      commitReference({ ...referenceSnapshot, status: 'error', error })
    })
    .finally(() => {
      referenceInFlight = null
    })

  return referenceInFlight
}

function subscribeReference(listener: () => void): () => void {
  referenceListeners.add(listener)
  // Lazily, on first interest, so nothing is fetched before there is a session.
  if (referenceSnapshot.status === 'idle') void loadReference()
  return () => referenceListeners.delete(listener)
}

/** The reference tables, loaded once and shared by every reader. */
export function useProgressReference(): ProgressReferenceSnapshot {
  return useSyncExternalStore(
    subscribeReference,
    () => referenceSnapshot,
    () => referenceSnapshot,
  )
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetProgressReference(): void {
  referenceInFlight = null
  commitReference({ status: 'idle', maxLevels: [], walls: [], error: null })
}

/**
 * Forces a refetch after an admin writes `pet` or `equipment` rows by hand — see
 * `ProgressReferenceCard` in `AdminView.tsx`. Every subscriber shares one cache, so
 * without this the admin who just typed in a value would not see it appear until
 * some other panel happened to remount and re-trigger `loadReference`.
 */
export function refreshProgressReference(): Promise<void> {
  return loadReference()
}
