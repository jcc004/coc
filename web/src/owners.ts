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
 * The writes are async, they can fail, and — since ownership became an account
 * rather than a label — **they are admin-only on the server**. `assignOwner` and
 * `clearOwner` therefore reject with the server's own message rather than pretending
 * to have written something; the UI's job is to not offer them to a member at all,
 * which the roster does by rendering the owner as text for anyone who is not an
 * admin (see `owner-picker.ts` for the rules and `ClanView` for the controls).
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
      // A tag that cannot be normalized could never be looked up, so an owner
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

/**
 * The whole assignment, not just the label. Card entry needs `ownerUserId` to ask
 * whether *this* session owns the base, and a name alone cannot answer that: an
 * unlinked legacy label is a note about a person, not a permission.
 *
 * Takes the records rather than reading the store, so a component looks up in the
 * same snapshot it subscribed to and re-renders when an admin reassigns a base.
 */
export function ownerRecordFor(
  records: readonly OwnerAssignment[],
  tag: string,
): OwnerAssignment | undefined {
  const canonical = normalizeTag(tag)
  return records.find((entry) => entry.tag === canonical)
}

/**
 * Hands one base to one account, through `PUT /api/owners/:tag`.
 *
 * **This used to be a single-row bulk apply of free text.** It is not any more,
 * because the thing being set is not text: it is which account holds the base, and
 * therefore who may write its card counts. A name could only ever be matched to an
 * account by display name and left as an unlinked label when it matched nobody —
 * which is precisely the 32-row mess the picker now exists to clear up.
 *
 * There is no expected-value check on this path, and that is the endpoint's design
 * rather than an omission: the picker is offered to admins only, it shows the row's
 * current owner as its selected value, and the store refreshes from the server after
 * every write — so an admin choosing a name is choosing it against what is on
 * screen. The bulk bar, which writes many rows blind from one typed value, keeps
 * its conditional write.
 *
 * Rejects with the server's own `ApiError` — including the 403 a non-admin gets,
 * whose message names the rule ("An admin assigns ownership of a base…"). Callers
 * show `error.message`; nothing here rewords it.
 */
export async function assignOwner(tag: string, userId: number): Promise<void> {
  await store.mutate(() => api.assignOwner(normalizeTag(tag), userId))
}

/**
 * Removes an assignment, whatever it currently says.
 *
 * Still reachable — and still one action, not "assign to nobody" — because a base
 * changes hands, leaves the clan, or turns out to have been recorded against the
 * wrong person, and a stale owner is worse than none: it is what makes card counts
 * unwritable by the person actually holding the base.
 */
export async function clearOwner(tag: string): Promise<void> {
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

/**
 * Every distinct owner label already in use, for the roster's Owner **filter** —
 * which has to be able to name what is stored, legacy labels included, and is shown
 * to everybody.
 *
 * Deliberately *not* what the picker offers. Suggesting the labels already in use
 * would keep proposing the unlinked ones, so the picker's options come from
 * `GET /api/admin/users` through `ownerOptions()` in `owner-picker.ts`.
 *
 * Takes the records, for the same reason `ownerRecordFor` does: this used to read
 * `store.peek()` and take no arguments, which made it a function whose answer
 * changed with nothing its caller could name. The roster memoized it against the
 * snapshot anyway — `useMemo(() => knownOwners(), [owners])` — and got the right
 * answer, but only because the dependency it declared happened to be the hidden read
 * it was standing in for. `exhaustive-deps` called that dependency unnecessary, and
 * on what it could see it was right. Passing the records makes it true.
 */
export function knownOwners(records: readonly OwnerAssignment[]): string[] {
  return [...new Set(records.map((entry) => entry.owner))].sort()
}

export function reloadOwners(): Promise<void> {
  return store.load()
}

/** Dropped on sign-out, so a shared machine hands nothing to the next person. */
export function resetOwners(): void {
  store.reset()
}
