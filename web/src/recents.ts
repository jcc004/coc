/**
 * Recently viewed players and clans.
 *
 * The cap is applied *per kind* rather than to one shared list, because the
 * sidebar shows the two separately: a run of player lookups must not be able to
 * evict every clan and leave that panel empty.
 */

export interface Recent {
  kind: 'player' | 'clan'
  tag: string
  name: string
}

export const RECENTS_KEY = 'coc:recents'

/** How many of each kind the sidebar shows, and therefore how many are kept. */
export const MAX_RECENTS_PER_KIND = 3

const KINDS = ['player', 'clan'] as const

/**
 * Puts `entry` at the front, drops any earlier visit to the same tag, and trims
 * each kind to {@link MAX_RECENTS_PER_KIND}. Overall recency order is preserved,
 * so the flat list still reads newest-first.
 */
export function addRecent(current: Recent[], entry: Recent): Recent[] {
  const deduped = [entry, ...current.filter((item) => item.tag !== entry.tag)]

  const kept = new Set(
    KINDS.flatMap((kind) =>
      deduped
        .filter((item) => item.kind === kind)
        .slice(0, MAX_RECENTS_PER_KIND)
        .map((item) => item.tag),
    ),
  )

  return deduped.filter((item) => kept.has(item.tag))
}

/** The newest few of one kind, for that kind's panel. */
export function recentsOfKind(recents: Recent[], kind: Recent['kind']): Recent[] {
  // Sliced again on read as well as on write: a list stored before the per-kind
  // cap existed can hold more than three of either kind.
  return recents.filter((item) => item.kind === kind).slice(0, MAX_RECENTS_PER_KIND)
}

/** Tolerates anything `localStorage` may hold, including from an older version. */
export function parseRecents(raw: string | null): Recent[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is Recent =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Recent).tag === 'string' &&
        typeof (item as Recent).name === 'string' &&
        ((item as Recent).kind === 'player' || (item as Recent).kind === 'clan'),
    )
  } catch {
    return []
  }
}
