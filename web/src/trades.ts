import type { ProposeTradeRequest, TradeRecord } from '@coc/shared'
import { api, ApiError } from './api.ts'
import { reloadCardInventory } from './card-inventory.ts'
import { createServerStore, type StoreSnapshot } from './server-store.ts'
import { findPendingSwap } from './trade-tracker.ts'

/**
 * The Trade Tracker's rows, mirrored client-side.
 *
 * Same mechanism as `card-inventory.ts`, `owners.ts` and `saved-clans.ts` — one
 * module-level external store over `useSyncExternalStore` — for the same reason:
 * the tracker appears on the card page and inside every player page's card panel,
 * and those must never disagree about what is pending.
 *
 * The one thing this store does that the others do not: **resolving a trade changes
 * the card inventory too.** A completion moves a card each way, so a tracker that
 * refreshed only itself would leave the sixty tiles above it showing the counts from
 * before the swap. Both stores are therefore refreshed together — see `resolve`.
 */

const store = createServerStore<TradeRecord>(async () => (await api.trades()).trades)

export function useTrades(): TradeRecord[] {
  return store.use().entries
}

/** Loading and error state, for the panel that has to report it. */
export function useTradesState(): StoreSnapshot<TradeRecord> {
  return store.use()
}

/**
 * Records an agreed swap, and answers with the row now on the tracker.
 *
 * **A duplicate is a success.** The server answers 409 `alreadyProposed` with the
 * existing trade in the body, and that is the right outcome for the button that was
 * pressed: what it promises is "this swap is on the tracker", which is true either
 * way. Surfacing it as an error would make two people proposing the same swap —
 * the normal thing, since it is *their* swap — look like a fault.
 *
 * Every other failure rethrows, so the button can say the proposal did not land.
 */
export async function proposeTrade(proposal: ProposeTradeRequest): Promise<TradeRecord> {
  try {
    const { trade } = await store.mutate(() => api.proposeTrade(proposal))
    return trade
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.reason !== 'alreadyProposed') throw cause

    /* The 409 body carries the existing row, but `ApiError` deliberately keeps only
       status, reason, message and hint — one error shape for every route — so the
       row is found in the refreshed list instead. `findPendingSwap` is the same
       match the server's unique index makes, which is why it is a tested function
       rather than a comparison written out here. */
    await store.load()
    const existing = findPendingSwap(store.peek(), proposal)
    if (existing) return existing

    /* Refused as a duplicate, yet no pending duplicate came back: somebody resolved
       it between the two requests. That is a real disagreement about the state and
       the caller has to hear about it rather than be told the swap is tracked. */
    throw cause
  }
}

/**
 * Completes, declines or undoes a trade, and refreshes the counts it moved.
 *
 * The response carries both bases' new counts, but the inventory store is reloaded
 * rather than patched from them: it is one request, it is the same request the page
 * would make on any other write, and patching would introduce a second path by which
 * counts can enter the cache — one that no other write uses and that would be wrong
 * in exactly the case that matters (a card whose count fell to zero and so is absent
 * from the response rather than present as a zero).
 *
 * A decline moves nothing, so the refresh is strictly unnecessary there. It happens
 * anyway: three branches would mean the harmless one is the one nobody exercises.
 */
async function resolve(
  id: number,
  act: (id: number) => ReturnType<typeof api.completeTrade>,
): Promise<TradeRecord> {
  const { trade } = await store.mutate(() => act(id))
  await reloadCardInventory()
  return trade
}

export function completeTrade(id: number): Promise<TradeRecord> {
  return resolve(id, api.completeTrade)
}

export function declineTrade(id: number): Promise<TradeRecord> {
  return resolve(id, api.declineTrade)
}

/**
 * Undoes a completed trade, moving the two cards back. Shares `resolve` with
 * `completeTrade` / `declineTrade` on purpose: an undo edits both bases' counts
 * exactly as a completion does, so it needs the same inventory reload afterwards.
 */
export function undoTrade(id: number): Promise<TradeRecord> {
  return resolve(id, api.undoTrade)
}

export function reloadTrades(): Promise<void> {
  return store.load()
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetTrades(): void {
  store.reset()
}
