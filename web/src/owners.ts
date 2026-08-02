import { useSyncExternalStore } from 'react'
import { normalizeTag } from '@coc/shared'

/**
 * Who owns which base. Purely local bookkeeping keyed by player tag — the API
 * has no concept of it, so nothing else in the app can supply or overwrite it.
 */
export interface OwnerAssignment {
  /** Canonical `#TAG`. The primary key. */
  tag: string
  /** Always non-empty: clearing an owner removes the entry outright. */
  owner: string
  /** ISO timestamp of the last edit. */
  updatedAt?: string
}

const KEY = 'coc:owners'

/**
 * The pre-migration saved-bases key. Read once, when `coc:owners` does not
 * exist yet, and never written — leaving it intact means an older build of the
 * app (or a mistaken migration) still has the original data to fall back on.
 */
const LEGACY_KEY = 'coc:saved'

/**
 * Extracts owner assignments from the old `coc:saved` payload, which stored a
 * whole curated player list (name, TH, trophies, clan, owner) of which only the
 * owner survives. Entries with no owner carried no local information, so they
 * are dropped rather than migrated as blanks.
 *
 * Pure on purpose: it is the one piece of the store that has to be testable, and
 * it has to survive whatever is actually sitting in localStorage.
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

/*
 * Same module-level external store as `saved-clans.ts`, and for the same reason:
 * the clan roster reads owners while the bulk bar writes them, and every
 * subscriber has to see one snapshot immediately.
 */

function read(): OwnerAssignment[] {
  try {
    const stored = localStorage.getItem(KEY)

    if (stored === null) {
      const migrated = migrateLegacySaved(localStorage.getItem(LEGACY_KEY))
      if (migrated.length > 0) localStorage.setItem(KEY, JSON.stringify(migrated))
      return migrated
    }

    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is OwnerAssignment =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as OwnerAssignment).tag === 'string' &&
        typeof (entry as OwnerAssignment).owner === 'string',
    )
  } catch {
    return []
  }
}

let snapshot: OwnerAssignment[] = read()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function commit(next: OwnerAssignment[]) {
  snapshot = next
  localStorage.setItem(KEY, JSON.stringify(next))
  emit()
}

// Another tab editing owners should not leave this one stale. Guarded so the
// module stays importable outside a browser, which is how the migration above
// gets unit tested.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) {
      snapshot = read()
      emit()
    }
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOwners(): OwnerAssignment[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
}

export function ownerFor(tag: string): string | undefined {
  const canonical = normalizeTag(tag)
  return snapshot.find((entry) => entry.tag === canonical)?.owner
}

/** Assigns an owner. A blank owner clears the entry rather than storing `""`. */
export function setOwner(tag: string, owner: string): void {
  const trimmed = owner.trim()
  if (!trimmed) {
    clearOwner(tag)
    return
  }

  const canonical = normalizeTag(tag)
  const next: OwnerAssignment = {
    tag: canonical,
    owner: trimmed,
    updatedAt: new Date().toISOString(),
  }

  commit(
    snapshot.some((entry) => entry.tag === canonical)
      ? snapshot.map((entry) => (entry.tag === canonical ? next : entry))
      : [...snapshot, next],
  )
}

export function clearOwner(tag: string): void {
  const canonical = normalizeTag(tag)
  if (!snapshot.some((entry) => entry.tag === canonical)) return
  commit(snapshot.filter((entry) => entry.tag !== canonical))
}

/** Every distinct owner already in use — powers the datalist on the owner input. */
export function knownOwners(): string[] {
  return [...new Set(snapshot.map((entry) => entry.owner))].sort()
}
