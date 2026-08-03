/**
 * Where the user was when they last closed the tab, so signing in puts them back
 * there instead of on the home page.
 *
 * Keyed per account: one browser can be shared, and dropping someone else's last
 * location on them would be worse than defaulting to home.
 */

import { normalizeTag } from '@coc/shared'

export function lastRouteKey(userId: number): string {
  return `coc:lastRoute:${userId}`
}

/**
 * Where the last clan this account opened is kept, for the topbar's **Clan**
 * button.
 *
 * Per account for the same reason the route above is: a shared browser must not
 * hand one person another person's clan. It is a separate key rather than being
 * derived from `coc:lastRoute:<id>`, because the last *route* is usually not a
 * clan — it is a player, or the card page — and the button has to keep working
 * from anywhere.
 */
export function lastClanKey(userId: number): string {
  return `coc:lastClan:${userId}`
}

/**
 * The clan tag the button should open, or `null` when there is not one to open.
 *
 * `null` is the "no clan visited yet" answer, and the caller's job is then to
 * fall back to the saved-clans list rather than leave a dead control. It is also
 * the answer for anything in storage that cannot be a tag: `localStorage` is
 * editable by hand and survives across versions, so a value that could never be
 * looked up is treated as absent instead of being navigated to.
 */
export function clanTargetTag(stored: string | null): string | null {
  if (stored === null) return null
  try {
    return normalizeTag(stored)
  } catch {
    return null
  }
}

/** Hashes that mean "no particular page", and so are not worth restoring to. */
function isBlank(hash: string): boolean {
  return hash === '' || hash === '#' || hash === '#/'
}

/**
 * Whether to send the browser to `stored`.
 *
 * Only a blank hash is filled in. Someone who opened a deep link — or hit reload
 * on a sub page — has already said where they want to be, and history must not
 * override that.
 */
export function shouldRestoreRoute(currentHash: string, stored: string | null): boolean {
  return isBlank(currentHash) && !!stored && !isBlank(stored)
}

/**
 * The value to hand `window.location.hash`, which wants it without the `#`.
 * Accepts a stored value written with or without the prefix.
 */
export function hashTarget(stored: string): string {
  return stored.replace(/^#/, '')
}

/**
 * What to persist for a given hash: `null` means forget, so that leaving someone
 * on the home page restores to the home page rather than to wherever they had
 * been before it.
 */
export function routeToRemember(currentHash: string): string | null {
  return isBlank(currentHash) ? null : currentHash
}
