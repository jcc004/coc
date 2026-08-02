import {
  normalizeTag,
  type OwnerBulkResponse,
  type OwnerBulkRow,
  type OwnerRecord,
} from '@coc/shared'
import { api } from './api.ts'
import { createServerStore, type StoreSnapshot } from './server-store.ts'

/**
 * Who owns which base, keyed by player tag.
 *
 * **Shared, not per-browser.** This used to be `localStorage` under `coc:owners`,
 * which meant the same person saw different answers on their phone and ten people
 * saw ten different answers full stop. It is now one row per player tag on the
 * server, so "who owns this base" has a single canonical answer — which is the
 * point, and also why every write has to cope with somebody else having got there
 * first (see `applyOwners`).
 *
 * The exported shape is deliberately the same as before — `useOwners`, `ownerFor`,
 * `setOwner`, `clearOwner`, `knownOwners` — so the components barely changed. What
 * did change is that the writes are async and can fail.
 */

/** A local alias, so existing imports keep reading the same. */
export type OwnerAssignment = OwnerRecord

/**
 * The pre-server `coc:saved` payload. Read once, during the one-time import, and
 * never written — leaving it intact means nothing is destroyed by a migration that
 * turns out to be wrong.
 *
 * It extracts owner assignments from the old shape, which stored a whole curated
 * player list (name, TH, trophies, clan, owner) of which only the owner survives.
 * Entries with no owner carried no local information, so they are dropped rather
 * than migrated as blanks.
 *
 * Pure on purpose: it has to survive whatever is actually sitting in localStorage,
 * so it is the one piece of this that can be unit tested.
 */
export function migrateLegacySaved(rawJson: string | null): OwnerAssignment[] {
  if (rawJson === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const migrated: OwnerAssignment[] = []
  const seen = new Set<string>()

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue

    const { tag, owner, updatedAt } = entry as Record<string, unknown>
    if (typeof tag !== 'string' || typeof owner !== 'string') continue

    const trimmed = owner.trim()
    if (!trimmed) continue

    let canonical: string
    try {
      canonical = normalizeTag(tag)
    } catch {
      // A tag that cannot be normalised could never be looked up, so an owner
      // attached to it has nothing to annotate.
      continue
    }

    if (seen.has(canonical)) continue
    seen.add(canonical)
    migrated.push({
      tag: canonical,
      owner: trimmed,
      ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    })
  }

  return migrated
}

const store = createServerStore<OwnerAssignment>(async () => (await api.owners()).owners)

/** The entries alone, which is all most callers want. */
export function useOwners(): OwnerAssignment[] {
  return store.use().entries
}

/** Loading and error state, for the places that have to report it. */
export function useOwnersState(): StoreSnapshot<OwnerAssignment> {
  return store.use()
}

export function ownerFor(tag: string): string | undefined {
  const canonical = normalizeTag(tag)
  return store.peek().find((entry) => entry.tag === canonical)?.owner
}

/**
 * Assigns one owner. A blank owner clears the entry rather than storing `""`.
 *
 * It goes through the same expected-value check as a bulk apply, using whatever
 * this browser currently believes — so a single edit is no more able to clobber
 * somebody else's change than a bulk one is. Rejects if the server refused.
 */
export async function setOwner(tag: string, owner: string): Promise<void> {
  const canonical = normalizeTag(tag)
  const expectedOwner = ownerFor(canonical) ?? ''

  const result = await store.mutate(() =>
    api.applyOwners([{ tag: canonical, owner: owner.trim(), expectedOwner }]),
  )

  const conflict = result.conflicts[0]
  if (conflict) {
    throw new Error(
      `${canonical} was changed by someone else — it now reads "${conflict.currentOwner || '(none)'}". Nothing was written.`,
    )
  }
}

export async function clearOwner(tag: string): Promise<void> {
  await setOwner(tag, '')
}

/** Removes an assignment outright, whatever its current value. */
export async function deleteOwner(tag: string): Promise<void> {
  await store.mutate(() => api.removeOwner(tag))
}

/**
 * The bulk path. Returns the server's verdict — applied, cleared, and the rows it
 * refused because the expected value was stale — for the caller to put back in
 * front of the user.
 */
export async function applyOwners(rows: OwnerBulkRow[]): Promise<OwnerBulkResponse> {
  return store.mutate(() => api.applyOwners(rows))
}

/** Every distinct owner already in use — powers the datalist on the owner input. */
export function knownOwners(): string[] {
  return [...new Set(store.peek().map((entry) => entry.owner))].sort()
}

export function reloadOwners(): Promise<void> {
  return store.load()
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetOwners(): void {
  store.reset()
}
