import { normalizeTag, type BaseInventory, type CardCount } from '@coc/shared'
import { api } from './api.ts'
import { createServerStore, type StoreSnapshot } from './server-store.ts'

/**
 * The shared card inventory, mirrored client-side.
 *
 * Same mechanism as `owners.ts` and `saved-clans.ts` — one module-level external
 * store over `useSyncExternalStore`, built on `server-store.ts` — for the same
 * reason: the grid, the entry form and the trade suggestions are three views of
 * one list, and they must never disagree about it. The snapshot is a *cache of
 * something another person can alter*, so `status` and `error` are part of it and
 * a failed write rethrows rather than being swallowed.
 *
 * **What comes back is every base anyone has saved this season** — including one
 * whose counts are now all zero, which keeps its stamp and so arrives with an
 * empty `counts` (`groupByBase`, `server/src/cards/store.ts`: a base appears if it
 * has count rows *or* a stamp). A base that has never been entered is the only one
 * absent, which `inventoryFor` reports as `undefined` and the grid renders as sixty
 * zeroes.
 *
 * This said "only bases with at least one card recorded" until 2026-08-04, which was
 * wrong in the direction that matters: it denies the existence of the
 * checked-and-holds-nothing base, and it is the comment somebody reads to find out
 * what this array *is*. `card-holders.ts`' demand count is a count of exactly these
 * entries, so the distinction is now load-bearing on screen.
 */

const store = createServerStore<BaseInventory>(async () => (await api.cardInventory()).bases)

export function useCardInventory(): BaseInventory[] {
  return store.use().entries
}

/** Loading and error state, for the places that have to report it. */
export function useCardInventoryState(): StoreSnapshot<BaseInventory> {
  return store.use()
}

/** One base's record, or `undefined` when nothing has ever been entered for it. */
export function inventoryFor(
  bases: BaseInventory[],
  tag: string,
): BaseInventory | undefined {
  const canonical = normalizeTag(tag)
  return bases.find((base) => base.tag === canonical)
}

/**
 * How many base writes are in flight.
 *
 * A counter and not a boolean: the grid's auto-save can have a second write queued
 * behind the one it is waiting on (see the loop in `BaseCardEditor.commit`), and two
 * overlapping writes must not have the first one to finish declare the base idle.
 */
let writesInFlight = 0

/**
 * True while somebody's counts are on their way to the server.
 *
 * Read by the background refresh in `use-card-refresh.ts`, which must not fire a read
 * across a write: the inventory it would get back is the one from *before* the write,
 * so the refresh would be stale before it landed and would then sit in the store until
 * the next tick. There is nothing to wait for either — `store.mutate` reloads the
 * store itself once the write lands, which is the same refresh a tick would have made.
 *
 * Typing is a separate question and is not this flag's: a draft with unsaved edits is
 * protected inside `BaseCardEditor`, whose re-seed effect refuses to replace a draft
 * that differs from what the server was last known to hold. This is only about the
 * window where the request has already gone out.
 */
export function savingBaseCounts(): boolean {
  return writesInFlight > 0
}

/**
 * Writes one base's whole set of counts in a single request.
 *
 * Last-write-wins, unlike the owner flow's expected-value handshake: a count is a
 * number read off a screen moments ago rather than a decision somebody made, so
 * the cost of a clobber is re-typing one base. What makes that acceptable is that
 * the response carries `updatedAt` and who, and the UI shows both.
 *
 * Rethrows on failure so the Save button can say the write did not happen.
 */
export async function saveBaseCounts(tag: string, counts: CardCount[]): Promise<BaseInventory> {
  writesInFlight += 1
  try {
    const { base } = await store.mutate(() => api.saveCardInventory(tag, counts))
    return base
  } finally {
    /* In a `finally`, because this function rethrows: a refused or dropped write that
       left the counter up would suppress every background refresh for the rest of the
       session, which is a worse failure than the one that caused it. */
    writesInFlight -= 1
  }
}

export function reloadCardInventory(): Promise<void> {
  return store.load()
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetCardInventory(): void {
  store.reset()
}
