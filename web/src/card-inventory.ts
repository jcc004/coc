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
 * Only bases with at least one card recorded come back from the server. A base
 * that has never been entered is simply absent, which `inventoryFor` reports as
 * `undefined` and the grid renders as sixty zeroes.
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
  const { base } = await store.mutate(() => api.saveCardInventory(tag, counts))
  return base
}

export function reloadCardInventory(): Promise<void> {
  return store.load()
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetCardInventory(): void {
  store.reset()
}
