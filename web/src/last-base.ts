/**
 * The base the card page's picker was left on, so a reload comes back to it.
 *
 * Three decisions are worth recording, because each has an answer that looks
 * obvious and is wrong:
 *
 * 1. **Not the route.** `#/cards` deliberately carries no tag — `parseHash` in
 *    `hooks.ts` says why: a deep link to one base would be a link into somebody
 *    else's editing session. Remembering the choice *locally* is a different thing
 *    from handing out an address for it, and it is the thing being asked for here.
 *    Nothing about this makes the base linkable.
 * 2. **Per account**, at `coc:cardBase:<userId>`, for the same reason
 *    `coc:baseScope:<id>` and `coc:lastClan:<id>` are: one browser is shared, and
 *    two people signing in on the same profile must not be handed each other's
 *    base — here that is somebody else's counts under a picker they did not touch.
 * 3. **A remembered base that is gone is not an error.** Bases come and go with the
 *    owner assignments, and the season rolls; a stored tag can name a base that is
 *    no longer tracked, no longer yours under `Mine`, or was never one. That case is
 *    settled by `activeTag` in `base-scope.ts` — the rule that already decides "the
 *    chosen one while the list still offers it, otherwise the first it does" — and
 *    is deliberately *not* re-implemented here. A second membership check would be a
 *    second definition of a valid selection, and the two could disagree.
 *
 * So all this module owns is the key and the read, and the read's whole job is to
 * turn anything at all into either a tag or "nothing remembered".
 */

import { normalizeTag } from '@coc/shared'

/** Where the choice is kept, keyed by the account that made it. */
export function lastBaseKey(userId: number): string {
  return `coc:cardBase:${userId}`
}

/**
 * The tag to open on, or `null` for "nothing remembered" — which is the first
 * visit and is what leaves the page picking exactly what it picks today.
 *
 * `null` is also the answer for anything stored that could not be a tag.
 * `localStorage` is hand-editable and outlives versions, and `normalizeTag`
 * *throws* on input it cannot read (`InvalidTagError`) — this value is read while
 * seeding React state during render, where a throw has no error boundary above it
 * and takes the whole app down. That is the same class of bug as the `URIError`
 * `parseHash` had to be fixed for, on a value that is even easier to write by hand,
 * so the refusal is caught here and reads as absence.
 *
 * Canonicalised rather than compared raw, so a tag typed into storage in lower case
 * still matches the picker's options, which carry the server's canonical form.
 */
export function rememberedBaseTag(stored: string | null): string | null {
  if (stored === null) return null
  try {
    return normalizeTag(stored)
  } catch {
    return null
  }
}
