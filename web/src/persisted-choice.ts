/**
 * The parse half of every small "which of a few named states was last chosen"
 * control that persists its choice per browser: the card totals' Sort control
 * (`card-total-sort.ts`), the leaderboard's View picker (`leaderboard-view.ts`),
 * and the trade suggestions' Priority select (`trade-priority.ts`).
 *
 * A pure module, deliberately not `hooks.ts` — the three modules above are all
 * pure themselves, with no other reason to depend on React, and pairing this
 * with `usePersistedChoice` (`hooks.ts`) would give them one anyway. The write
 * half stays a hook, since writing is a React effect (`localStorage.setItem`
 * on change) in a way reading back a stored string never is.
 */

/**
 * Reads a stored value back against a fixed, known set of states. Anything
 * that is not one of `allowed` — absent, hand-edited, or a value an older/
 * newer build no longer offers — falls back to `fallback`. The "unrecognized
 * is the safe default" shape every caller above already used by hand before
 * this was extracted.
 */
export function parseAllowlisted<T extends string>(
  stored: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(stored as T) ? (stored as T) : fallback
}
