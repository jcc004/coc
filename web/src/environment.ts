/**
 * Which instance you are looking at, and what to say about it.
 *
 * The banner is bright gold on production, and the same gold tarnished with a
 * **DEV SERVER** marker anywhere else. It exists because the two are otherwise
 * indistinguishable: the same app, the
 * same shared-looking data, the same controls that delete a saved clan "for
 * everyone". Typing into the wrong one is a mistake with no undo, and the only cue
 * was the address bar.
 *
 * **The test is the hostname, not the build mode.** `import.meta.env.DEV` answers a
 * different question — was this served by `vite dev` — and gets the important case
 * wrong: a production *build* running against a local database is exactly the thing
 * you must not mistake for the live site, and `DEV` is false for it. It also missed
 * the fault this project actually shipped, where `NODE_ENV=development` produced a
 * development React that `import.meta.env.DEV` still reported as production.
 *
 * So: one canonical host is production. Everything else — localhost, a bare IP, a
 * tunnel, a future staging box — is not, and says so. That is the safe direction to
 * fail in. Being told "DEV SERVER" on the real site would be irritating; being told
 * nothing on a copy is how you delete the wrong row.
 */

/** The one host that is production. Everything else is marked. */
export const PRODUCTION_HOST = 'coc.jcciv.com'

export type SiteEnvironment =
  | { kind: 'production'; label: null }
  | { kind: 'development'; label: string }

/**
 * What this hostname is.
 *
 * Case-folded, and a trailing dot is tolerated: `coc.jcciv.com.` is the same host in
 * DNS terms and a resolver may well hand it over that way. A port is never part of
 * `location.hostname`, so there is nothing to strip.
 *
 * A subdomain is deliberately **not** production. `staging.coc.jcciv.com` is not the
 * live site, and a suffix match would quietly call it one.
 */
export function siteEnvironment(hostname: string): SiteEnvironment {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (host === PRODUCTION_HOST) return { kind: 'production', label: null }
  /*
   * Title case, not DEV SERVER.
   *
   * Both strings rasterize with the same font — confirmed by asking the renderer which
   * face it used, not by reading the CSS. But set in capitals beside a mixed-case
   * title, Trebuchet's caps read as a second typeface, and it was reported as one
   * twice. Matching the title's casing is what actually makes it look like the same
   * words in the same voice, which is the point: the marker should read as part of the
   * app's name on this install, not as a sticker on top of it.
   */
  return { kind: 'development', label: 'Dev Server' }
}

/** Reads the live location. Split out so the rule above stays testable. */
export function currentEnvironment(): SiteEnvironment {
  return siteEnvironment(window.location.hostname)
}
