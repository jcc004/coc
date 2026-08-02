/**
 * Where the user was when they last closed the tab, so signing in puts them back
 * there instead of on the home page.
 *
 * Keyed per account: one browser can be shared, and dropping someone else's last
 * location on them would be worse than defaulting to home.
 */

export function lastRouteKey(userId: number): string {
  return `coc:lastRoute:${userId}`
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
