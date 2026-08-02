import { useSyncExternalStore } from 'react'
import { normalizeTag } from '@coc/shared'

export interface SavedPlayer {
  /** Canonical `#TAG`. The primary key. */
  tag: string
  /** Label shown in the list. Defaults to the in-game name. */
  name: string
  /** Set once the user renames, so refresh stops overwriting their label. */
  custom?: boolean
  /**
   * Who owns this base. Purely local bookkeeping — the API has no concept of
   * this, so it is never touched by a refresh.
   */
  owner?: string
  clanTag?: string
  clanName?: string
  townHallLevel?: number
  trophies?: number
  /** ISO timestamp of the last successful refresh. */
  updatedAt?: string
}

const KEY = 'coc:saved'

/*
 * A module-level store rather than component state: the save button on a player
 * profile and the saved list are rendered in different subtrees and must agree
 * immediately. useSyncExternalStore keeps every subscriber on one snapshot.
 */

function read(): SavedPlayer[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is SavedPlayer =>
        typeof entry === 'object' && entry !== null && typeof (entry as SavedPlayer).tag === 'string',
    )
  } catch {
    return []
  }
}

let snapshot: SavedPlayer[] = read()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function commit(next: SavedPlayer[]) {
  snapshot = next
  localStorage.setItem(KEY, JSON.stringify(next))
  emit()
}

// Another tab editing the list should not leave this one stale.
window.addEventListener('storage', (event) => {
  if (event.key === KEY) {
    snapshot = read()
    emit()
  }
})

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSavedPlayers(): SavedPlayer[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
}

export function isSaved(tag: string): boolean {
  const canonical = normalizeTag(tag)
  return snapshot.some((entry) => entry.tag === canonical)
}

/** Inserts, or merges into an existing entry without clobbering a custom name. */
export function savePlayer(entry: SavedPlayer): void {
  const tag = normalizeTag(entry.tag)
  const existing = snapshot.find((saved) => saved.tag === tag)

  const merged: SavedPlayer = {
    ...existing,
    ...entry,
    tag,
    name: existing?.custom ? existing.name : entry.name,
    custom: existing?.custom ?? entry.custom,
    // Owner is local-only, so an incoming API-derived entry must never clear it.
    owner: entry.owner ?? existing?.owner,
    updatedAt: new Date().toISOString(),
  }

  commit(
    existing
      ? snapshot.map((saved) => (saved.tag === tag ? merged : saved))
      : [...snapshot, merged],
  )
}

export function removePlayer(tag: string): void {
  const canonical = normalizeTag(tag)
  commit(snapshot.filter((entry) => entry.tag !== canonical))
}

/**
 * Applies a user edit. A changed name is marked `custom` so `refreshAll` stops
 * overwriting it; a blank owner clears the field rather than storing `""`.
 */
export function updatePlayer(tag: string, patch: { name?: string; owner?: string }): void {
  const canonical = normalizeTag(tag)

  commit(
    snapshot.map((entry) => {
      if (entry.tag !== canonical) return entry

      const next: SavedPlayer = { ...entry }

      if (patch.name !== undefined) {
        const trimmed = patch.name.trim()
        if (trimmed && trimmed !== entry.name) {
          next.name = trimmed
          next.custom = true
        }
      }

      if (patch.owner !== undefined) {
        const trimmed = patch.owner.trim()
        if (trimmed) next.owner = trimmed
        else delete next.owner
      }

      return next
    }),
  )
}

/** Every distinct owner already in use — powers the datalist on the owner input. */
export function knownOwners(): string[] {
  return [...new Set(snapshot.map((entry) => entry.owner).filter((o): o is string => !!o))].sort()
}
