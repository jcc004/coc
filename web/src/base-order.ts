import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from './api.ts'

/**
 * The signed-in user's own base order — `#/base-order`.
 *
 * Per-account and per-account only: there is no `:userId` on the wire (see
 * `BaseOrderResponse` in `@coc/shared`) and nothing here reads or writes anyone
 * else's list. That is also why this is plain component state rather than the
 * `createServerStore` shape `owners.ts` and `progress.ts` use — that shape exists
 * so two components watching the *same shared* list stay in sync; an order is
 * nobody's business but the account reading it, so there is only ever one reader
 * to keep in sync with, and every load already refetches it.
 */

/**
 * The order to show: the saved order with anything no longer owned dropped, and
 * anything newly owned but never saved appended at the end.
 *
 * Two things a stored order can disagree with reality about, and both need an
 * answer that never makes a base impossible to reach:
 *
 * - `savedOrder` may name a tag `ownedTags` no longer contains — a base that
 *   changed hands, or was unassigned. Dropped rather than shown, because a tag
 *   this account cannot act on is not a base to reorder.
 * - `ownedTags` may contain a tag `savedOrder` never mentioned — new, or the
 *   order predates it. Appended, in `ownedTags`' own order, rather than left out:
 *   a base excluded from its own owner's list would be lost until they happened
 *   to remember it exists.
 *
 * Order among the appended tags is whatever `ownedTags` handed in — this
 * function does not sort them — so the caller controls it by controlling the
 * order it passes in.
 */
export function reconcileOrder(
  ownedTags: readonly string[],
  savedOrder: readonly string[],
): string[] {
  const owned = new Set(ownedTags)
  const kept = savedOrder.filter((tag) => owned.has(tag))
  const alreadyKept = new Set(kept)
  const appended = ownedTags.filter((tag) => !alreadyKept.has(tag))
  return [...kept, ...appended]
}

/**
 * `tags` with the entry at `fromIndex` moved to `toIndex`, everything else
 * shifted to make room — the one array operation a drag-and-drop reorder needs,
 * kept separate from the DOM event handlers that call it because those cannot be
 * unit tested and this can.
 *
 * `toIndex` is clamped to the array's bounds (after the move) rather than
 * ignored when it is out of range, so "drop past the last row" and "drop before
 * the first" both do the obvious thing instead of nothing. An out-of-range
 * `fromIndex`, or `fromIndex === toIndex`, is a no-op that still returns a fresh
 * array — callers that always replace their state with the result do not need a
 * second case for "nothing moved".
 */
export function moveTag(tags: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= tags.length || fromIndex === toIndex) return [...tags]

  const next = [...tags]
  const [moved] = next.splice(fromIndex, 1)
  const clamped = Math.max(0, Math.min(toIndex, next.length))
  next.splice(clamped, 0, moved as string)
  return next
}

/**
 * `items` placed in `order`'s sequence — the shared step behind both places a
 * saved base order is actually displayed: the card page's Mine picker and the
 * progress grid's rows, each reusing the same tag list `useBaseOrder` already
 * reconciled rather than re-deriving what "in order" means.
 *
 * Every item whose tag appears in `order` is placed at that position; an item
 * `order` does not mention keeps `items`' own relative order and is appended
 * after the ones that were placed — the same append-at-the-end shape
 * `reconcileOrder` uses for a tag it has never seen, so a caller that (unlike
 * `useBaseOrder`'s own callers) hands in an `items` list wider than `order`
 * still shows every row rather than dropping the ones `order` is silent about.
 */
export function applyBaseOrder<T extends { tag: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const byTag = new Map(items.map((item) => [item.tag, item]))
  const placed = new Set<string>()
  const ordered: T[] = []
  for (const tag of order) {
    const item = byTag.get(tag)
    if (item === undefined) continue
    ordered.push(item)
    placed.add(tag)
  }
  const rest = items.filter((item) => !placed.has(item.tag))
  return [...ordered, ...rest]
}

/**
 * `tags` sorted by their display label rather than the tag itself — tags are
 * opaque `#XXXXXXX` identifiers nobody reads them by, so an "Alphabetize"
 * action has to sort by what is actually on screen, and only the caller knows
 * how to turn a tag into that label. Case-insensitive (`sensitivity: 'base'`)
 * so `'Alpha'` and `'alpha'` sort together rather than by case.
 */
export function alphabetizeTags(
  tags: readonly string[],
  labelOf: (tag: string) => string,
): string[] {
  return [...tags].sort((a, b) =>
    labelOf(a).localeCompare(labelOf(b), undefined, { sensitivity: 'base' }),
  )
}

export type BaseOrderStatus = 'loading' | 'error' | 'ready'

function toApiError(cause: unknown): ApiError {
  return cause instanceof ApiError
    ? cause
    : new ApiError(0, 'network', (cause as Error)?.message || 'Could not reach the server.')
}

/**
 * Loads the saved order, reconciles it against `ownedTags`, and persists every
 * reorder.
 *
 * `ready` gates the first load the same way `useBaseScope`'s does in
 * `hooks.ts`: `ownedTags` starts empty before the owner list has actually
 * landed, and reconciling against that empty set would drop every tag from a
 * saved order before there was anything to compare it to. Nothing runs until the
 * caller says the owner list is in.
 *
 * `ownedTags` is joined into a string for the effect's dependency, the same
 * device `useMemberNames` in `base-labels.ts` uses for its clan and base keys:
 * the array is rebuilt every render by callers deriving it with
 * `tagsInScope`, and comparing by reference would refetch on every render
 * rather than on an actual change of which tags are owned.
 */
export function useBaseOrder(
  ownedTags: readonly string[],
  ready: boolean,
): {
  status: BaseOrderStatus
  tags: string[]
  error: ApiError | null
  /** True while a reorder's `PUT` is in flight — distinct from the initial load. */
  saving: boolean
  reorder: (next: string[]) => void
} {
  const [status, setStatus] = useState<BaseOrderStatus>('loading')
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)

  const ownedKey = ownedTags.join(',')

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setStatus('loading')
    setError(null)

    api
      .getBaseOrder()
      .then(({ tags: saved }) => {
        if (cancelled) return
        const owned = ownedKey ? ownedKey.split(',') : []
        setTags(reconcileOrder(owned, saved))
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(toApiError(cause))
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
    // `ownedKey` is the only stand-in for `ownedTags` this effect reads, and it
    // is already a dependency — see the note above for why it is the array's
    // join rather than the array itself.
  }, [ready, ownedKey])

  /**
   * Applies a new order on screen immediately and saves it — there is no
   * "unsaved changes" state to hold, since the server accepts a partial list and
   * every drop is a complete, valid order on its own.
   *
   * A failed save leaves the reordered list on screen rather than reverting it:
   * reverting silently would make the drag look like it never happened, when
   * what actually happened is a write that did not take. `error` carries the
   * failure so the caller can say so and offer a retry.
   */
  const reorder = useCallback((next: string[]) => {
    setTags(next)
    setSaving(true)
    setError(null)
    api
      .saveBaseOrder(next)
      .catch((cause: unknown) => setError(toApiError(cause)))
      .finally(() => setSaving(false))
  }, [])

  return { status, tags, error, saving, reorder }
}
