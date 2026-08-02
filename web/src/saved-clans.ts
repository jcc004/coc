import { normalizeTag, type SavedClanInput, type SavedClanRecord } from '@coc/shared'
import { api } from './api.ts'
import { createServerStore, type StoreSnapshot } from './server-store.ts'

/**
 * The saved clan list — one list for the whole install, on the server.
 *
 * It was `localStorage` under `coc:savedClans`, which made "the saved clans" a
 * per-browser opinion. It is now shared for the same reason owners are: ten people
 * curating ten private lists is not a list, it is ten of them.
 *
 * A rename marks the row `custom` server-side, so `Refresh all` cannot undo
 * somebody else's label — the same rule as before, just enforced in one place
 * instead of once per browser.
 */

/** A local alias, so existing imports keep reading the same. */
export type SavedClan = SavedClanRecord

const store = createServerStore<SavedClan>(async () => (await api.savedClans()).clans)

export function useSavedClans(): SavedClan[] {
  return store.use().entries
}

export function useSavedClansState(): StoreSnapshot<SavedClan> {
  return store.use()
}

export function isClanSaved(tag: string): boolean {
  const canonical = normalizeTag(tag)
  return store.peek().some((entry) => entry.tag === canonical)
}

/** Inserts, or refreshes an existing entry without clobbering a custom name. */
export async function saveClan(entry: SavedClanInput): Promise<void> {
  await store.mutate(() => api.saveClan(entry))
}

export async function removeClan(tag: string): Promise<void> {
  await store.mutate(() => api.removeClan(tag))
}

/**
 * Applies a user edit. A changed name marks the row `custom`, which is what stops
 * `Refresh all` overwriting it.
 */
export async function updateClan(tag: string, patch: { name?: string }): Promise<void> {
  const name = patch.name?.trim()
  if (!name) return
  await store.mutate(() => api.renameClan(tag, name))
}

export function reloadSavedClans(): Promise<void> {
  return store.load()
}

export function resetSavedClans(): void {
  store.reset()
}
