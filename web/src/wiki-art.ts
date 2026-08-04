/**
 * Looks up vendored wiki artwork for the names the CoC API hands back. The map
 * itself is generated (`wiki-art.generated.ts`); the normalization and lookup
 * below are hand-written because they are the part that silently rots when
 * Supercell renames a unit, so they carry tests.
 *
 * Two deliberate properties:
 *
 * 1. A name that does not resolve returns `undefined`, and the caller renders no
 *    icon at all. There is no near-miss matching and no family fallback — a
 *    "Super Barbarian" with no art must not borrow the "Barbarian" icon, because
 *    a confidently wrong troop icon is worse than a missing one.
 * 2. Even a name that *does* resolve may have no file on disk: `web/public/coc/`
 *    is gitignored, so any checkout that has not run `npm run assets:wiki` knows
 *    the paths but has none of the art. Unlike league and label icons there is no
 *    CDN to fall back to (we do not hotlink the wiki), so `GameIcon` is used
 *    without a `fallback` and drops the element on error.
 */
import { WIKI_ART } from './wiki-art.generated.ts'

/**
 * Which family a name belongs to. Kinds are namespaced so an equipment piece can
 * never resolve to a same-named troop's art — "Barbarian Puppet" the equipment
 * and any future "Barbarian Puppet" the troop stay separate entries.
 */
export type ArtKind = 'hero' | 'equipment' | 'troop' | 'spell' | 'townHall'

/**
 * Case-, punctuation- and spacing-insensitive lookup key. `"P.E.K.K.A"`,
 * `"pekka"` and `"P E K K A"` all collapse to `pekka`; `"L.A.S.S.I"` to `lassi`;
 * `"Builder's Workshop"` to `buildersworkshop`. Accents are stripped via NFD so a
 * decorated spelling still lands on the plain key.
 *
 * Must stay in step with `normalize` in scripts/fetch-wiki-art.mjs, which writes
 * the other half of the same key.
 */
export function normalizeArtName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Path to the vendored icon for one API name, or `undefined` when the wiki had no
 * art for it. Callers must treat `undefined` as "render nothing", not as a cue to
 * substitute something similar.
 */
export function artFor(kind: ArtKind, name: string): string | undefined {
  return WIKI_ART[`${kind}:${normalizeArtName(name)}`]
}

/** Town Hall badge art for a level, or `undefined` outside the vendored range. */
export function townHallArt(level: number): string | undefined {
  if (!Number.isInteger(level) || level < 1) return undefined
  return artFor('townHall', String(level))
}
