import { useSyncExternalStore } from 'react'
import { normalizeTag } from '@coc/shared'

export interface SavedClan {
  /** Canonical `#TAG`. The primary key. */
  tag: string
  /** Label shown in the list. Defaults to the in-game name. */
  name: string
  /** Set once the user renames, so refresh stops overwriting their label. */
  custom?: boolean
  clanLevel?: number
  members?: number
  warLeague?: string
  clanPoints?: number
  /** ISO timestamp of the last successful refresh. */
  updatedAt?: string
}

const KEY = 'coc:savedClans'

/*
 * Same shape as the saved-players store in `saved.ts`, and for the same reason:
 * the save button on a clan profile and the saved list live in different
 * subtrees and must agree immediately.
 */

function read(): SavedClan[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is SavedClan =>
        typeof entry === 'object' && entry !== null && typeof (entry as SavedClan).tag === 'string',
    )
  } catch {
    return []
  }
}

let snapshot: SavedClan[] = read()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function commit(next: SavedClan[]) {
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

export function useSavedClans(): SavedClan[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
}

export function isClanSaved(tag: string): boolean {
  const canonical = normalizeTag(tag)
  return snapshot.some((entry) => entry.tag === canonical)
}

/** Inserts, or merges into an existing entry without clobbering a custom name. */
export function saveClan(entry: SavedClan): void {
  const tag = normalizeTag(entry.tag)
  const existing = snapshot.find((saved) => saved.tag === tag)

  const merged: SavedClan = {
    ...existing,
    ...entry,
    tag,
    name: existing?.custom ? existing.name : entry.name,
    custom: existing?.custom ?? entry.custom,
    updatedAt: new Date().toISOString(),
  }

  commit(
    existing ? snapshot.map((saved) => (saved.tag === tag ? merged : saved)) : [...snapshot, merged],
  )
}

export function removeClan(tag: string): void {
  const canonical = normalizeTag(tag)
  commit(snapshot.filter((entry) => entry.tag !== canonical))
}

/**
 * Applies a user edit. A changed name is marked `custom` so `Refresh all` stops
 * overwriting it.
 */
export function updateClan(tag: string, patch: { name?: string }): void {
  const canonical = normalizeTag(tag)

  commit(
    snapshot.map((entry) => {
      if (entry.tag !== canonical) return entry

      const next: SavedClan = { ...entry }

      if (patch.name !== undefined) {
        const trimmed = patch.name.trim()
        if (trimmed && trimmed !== entry.name) {
          next.name = trimmed
          next.custom = true
        }
      }

      return next
    }),
  )
}
