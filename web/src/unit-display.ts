import type { UnitCategory } from '@coc/shared'
import type { UnitProgress } from './progress-percent.ts'
import type { ArtKind } from './wiki-art.ts'

/**
 * Which vendored-art family a progress category's icons live under. Identical
 * to `UnitCategory` except `pet`: pet icons were vendored from the general
 * troop-sampling pass in `scripts/fetch-wiki-art.mjs` before pets were split
 * out as their own concept, so `wiki-art.generated.ts` has no `pet:` entries —
 * only `troop:` ones that happen to be pets. `artFor('troop', name)` is the
 * right lookup, and returns `undefined` for a pet the wiki pass never
 * sampled, same as any other unmatched name.
 */
export function artKindFor(category: UnitCategory): ArtKind {
  return category === 'pet' ? 'troop' : category
}

/** A unit whose captured level has reached (or passed) its TH-relative cap. */
export function isMaxed(unit: Pick<UnitProgress, 'level' | 'maxForTh'>): boolean {
  return unit.maxForTh !== null && unit.level >= unit.maxForTh
}

/**
 * A unit still short of its cap, as a raw fraction — `"40/110"` — rather than
 * a percentage. Started as equipment-only: equipment's real max level is
 * gated by Town Hall *and* Blacksmith level, and the API never exposes
 * Blacksmith, so a percentage there implied a precision about the ceiling the
 * app does not actually have. The user preferred the same fraction everywhere
 * once they saw it — a number holds the same information a percentage does
 * plus the cap itself, in the same width on screen.
 *
 * `maxForTh: null` (no reference row) falls back to the bare level, the same
 * "nothing to compare against" fallback every other uncovered unit gets.
 */
export function unitFraction(unit: Pick<UnitProgress, 'level' | 'maxForTh'>): string {
  return unit.maxForTh === null ? `Lv ${unit.level}` : `${unit.level}/${unit.maxForTh}`
}
