import { useSyncExternalStore } from 'react'
import { ApiError } from './api.ts'

/**
 * The module-level external store the two shared lists use.
 *
 * Same shape as the `localStorage` stores it replaces — one snapshot, a listener
 * set, `useSyncExternalStore` — because that is what keeps a Save button on a clan
 * page and the list on the landing page agreeing instantly. What changed is where
 * the data lives: the server, shared by everyone, so the snapshot is a *cache* of
 * something another person can alter.
 *
 * Two consequences the components have to see, and which is why `status` and
 * `error` are part of the snapshot rather than hidden:
 *
 * - reading is now asynchronous, so there is a real loading state;
 * - writing can fail, and a failed write must never look like a success. `mutate`
 *   rethrows for that reason — the caller is expected to catch and say so.
 */

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface StoreSnapshot<T> {
  status: StoreStatus
  entries: T[]
  /** The last failure, load or write. Cleared by the next success. */
  error: ApiError | null
}

export interface ServerStore<T> {
  /** Subscribes, and starts the first load if nothing has asked yet. */
  use(): StoreSnapshot<T>
  /** The current entries, for imperative callers that are not rendering. */
  peek(): T[]
  /** Re-reads from the server. Concurrent calls share one request. */
  load(): Promise<void>
  /**
   * Runs a write and then refreshes, so the snapshot carries the server's
   * `updatedAt` / `updatedBy` rather than a guess. Rethrows on failure.
   */
  mutate<R>(write: () => Promise<R>): Promise<R>
  /** Empties the cache, e.g. on sign-out. The next subscriber reloads. */
  reset(): void
}

function toApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, 'network', (cause as Error)?.message || 'Could not reach the server.')
}

export function createServerStore<T>(fetchAll: () => Promise<T[]>): ServerStore<T> {
  // One object identity per state, because `useSyncExternalStore` compares
  // snapshots by reference and would loop forever on a fresh object each call.
  let snapshot: StoreSnapshot<T> = { status: 'idle', entries: [], error: null }
  const listeners = new Set<() => void>()

  /** Shared so two components mounting together make one request, not two. */
  let inFlight: Promise<void> | null = null

  /**
   * Bumped by every `startLoad`, and checked before a response is allowed to
   * commit. `mutate` needs a load that is guaranteed to reflect its own write,
   * which `load()` alone cannot promise: if a poll's GET was already in flight
   * when the write landed, `load()` would just hand back that same promise, and
   * its response — read *before* the write — would commit over the just-saved
   * data. `startLoad` always issues a fresh request instead, but that leaves two
   * requests in the air at once, and network timing does not guarantee the older
   * one resolves first. Gating every commit on "was this the most recently
   * *started* request" is what stops that stale response from winning the race
   * even when it arrives last. See the trade tracker's own bug writeup,
   * 2026-08-08, for the shape of thing a lost race here looks like to a user.
   */
  let generation = 0

  function commit(next: StoreSnapshot<T>) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  /** Always issues a fresh request, even if one is already in flight. */
  function startLoad(): Promise<void> {
    const gen = ++generation

    // Keep the entries visible while refreshing: blanking the table on every
    // write would make a normal save look like a reload.
    commit({ status: 'loading', entries: snapshot.entries, error: null })

    const request = fetchAll()
      .then((entries) => {
        // A newer request has since started; this one lost the race and its
        // answer is stale by definition, whatever order the responses arrive in.
        if (gen === generation) commit({ status: 'ready', entries, error: null })
      })
      .catch((cause: unknown) => {
        if (gen === generation) {
          commit({ status: 'error', entries: snapshot.entries, error: toApiError(cause) })
        }
      })
      .finally(() => {
        // Only clear the shared slot if nothing newer has already replaced it.
        if (inFlight === request) inFlight = null
      })

    inFlight = request
    return request
  }

  function load(): Promise<void> {
    return inFlight ?? startLoad()
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    // Lazily, on first interest, so nothing is fetched before there is a session.
    if (snapshot.status === 'idle') void load()
    return () => listeners.delete(listener)
  }

  return {
    use() {
      return useSyncExternalStore(
        subscribe,
        () => snapshot,
        () => snapshot,
      )
    },

    peek() {
      return snapshot.entries
    },

    load,

    async mutate(write) {
      try {
        const result = await write()
        // `startLoad`, not `load`: a poll's GET can already be in flight when the
        // write completes, and reusing it would commit an answer read *before*
        // this write — see `generation`'s doc comment above.
        await startLoad()
        return result
      } catch (cause) {
        const error = toApiError(cause)
        // Recorded *and* rethrown: recorded so any other view of the same list can
        // show that it is stale, rethrown so the button that was pressed can say
        // the write did not happen.
        commit({ status: 'error', entries: snapshot.entries, error })
        // A failed write is very often a conflict — somebody else's write landed
        // first, which is exactly the case where the local snapshot is not just
        // stale but *wrong*: the caller's own row still reads its pre-conflict
        // state, so a control gated on that state (a resolve button checking
        // `status === 'pending'`) stays live and invites the retry that "fixes"
        // it. Refreshing here, not just on success, is what makes a rejected
        // trade-completion actually show as resolved instead of silently
        // requiring a second click — see the trade tracker's own bug writeup,
        // 2026-08-08. `.catch` because `startLoad()` already turns its own
        // failure into a committed error state; it cannot throw here in a way
        // that should replace the original `error` this call is about to rethrow.
        await startLoad().catch(() => {})
        throw error
      }
    },

    reset() {
      inFlight = null
      // Stale by construction: any response still in flight from before the
      // reset must not be allowed to resurrect the list it just cleared.
      generation += 1
      commit({ status: 'idle', entries: [], error: null })
    },
  }
}
