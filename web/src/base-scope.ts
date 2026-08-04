/**
 * The `Mine` / `All` filter on the card page's base picker.
 *
 * Four decisions, all of them with a wrong answer that leaves somebody staring at
 * a screen they cannot act on, so all four are pure and tested rather than inline
 * in the view:
 *
 * 1. **What `Mine` means.** The base's `ownerUserId`, never the owner *label*: 23
 *    of the tracked assignments are free text that has never been matched to an
 *    account, and a name that happens to match yours is a note about a person, not
 *    a base you may write. It is the same field the write rule uses
 *    (`cardEntryAccess`), so "mine" on the picker and "mine" on the grid cannot
 *    come apart.
 * 2. **Where the selection goes when the filter drops it.** Switching to `Mine`
 *    while looking at somebody else's base leaves the chosen tag outside the list,
 *    and leaving it selected would show counts nobody can act on under a picker
 *    that no longer offers it.
 * 3. **Which way to default.** Most accounts here own nothing, so defaulting
 *    blindly to `Mine` would land them on an empty screen.
 * 4. **Whose choice it is.** Per account, like `coc:lastClan:<id>`, because one
 *    browser is shared.
 */

export type BaseScope = 'mine' | 'all'

/**
 * Where the choice is kept. Per account, for the reason `lastClanKey` is: a shared
 * browser must not hand one person the other's filter, and the difference here is
 * not cosmetic — one person's `Mine` is the other person's empty list.
 */
export function baseScopeKey(userId: number): string {
  return `coc:baseScope:${userId}`
}

/** `localStorage` is editable by hand and survives across versions. */
export function isBaseScope(value: string | null): value is BaseScope {
  return value === 'mine' || value === 'all'
}

/**
 * The filter to start on.
 *
 * A stored choice is honored as made, including `Mine` by an account that now
 * owns nothing — they asked for it, and the empty list says so in words. What
 * `ownsAny` decides is the case where there is nothing stored: `Mine` only when
 * the account actually holds a base, because the alternative is a first visit that
 * opens on an empty dropdown and an editor with nothing in it.
 */
export function baseScopeFor(stored: string | null, ownsAny: boolean): BaseScope {
  if (isBaseScope(stored)) return stored
  return ownsAny ? 'mine' : 'all'
}

/** A tracked base, as `GET /api/owners` describes its ownership. */
export interface ScopedBase {
  tag: string
  /** The owning account, or `null` for a row that is only a text label. */
  ownerUserId: number | null
}

/** Whether this account holds any base at all — which is what decides the default. */
export function ownsAnyBase(bases: readonly ScopedBase[], userId: number): boolean {
  return bases.some((base) => base.ownerUserId === userId)
}

/**
 * The tags the picker should offer, in the order they arrived.
 *
 * Ordering is left to `baseOptions`, which is where every rule about how a base is
 * *written* already lives; this only decides membership.
 */
export function tagsInScope(
  bases: readonly ScopedBase[],
  scope: BaseScope,
  userId: number,
): string[] {
  if (scope === 'all') return bases.map((base) => base.tag)
  return bases.filter((base) => base.ownerUserId === userId).map((base) => base.tag)
}

/**
 * The base to actually show: the chosen one while the list still offers it, and
 * otherwise the first one it does.
 *
 * This is the whole answer to "what happens when the filter drops your
 * selection" — the selection moves to the head of the filtered list rather than
 * being left pointing outside it. It is also, deliberately, the same rule as the
 * initial default, so there is one definition of "a valid selection" instead of a
 * default and a repair that could disagree. `null` only when there is nothing to
 * offer, which the caller has to say something about.
 */
export function activeTag(
  options: readonly { tag: string }[],
  chosen: string | null,
): string | null {
  if (chosen !== null && options.some((option) => option.tag === chosen)) return chosen
  return options[0]?.tag ?? null
}
