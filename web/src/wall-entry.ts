import type { WallReferenceRow } from '@coc/shared'

/**
 * Bounds for the walls editor in `PlayerProgressPanel.tsx`'s `ManualCaptureForm`,
 * mirroring the checks `parseManualCapture` (`server/src/progress/routes.ts`)
 * makes server-side against `wall_reference` — this is UX only, so a request the
 * client waved through can still be refused there, but a request the client
 * already knows is doomed should not go out at all.
 *
 * `cap` is `null` exactly when the server would also have nothing to validate
 * against: the base's Town Hall has never been auto-captured, or the weekly wiki
 * refresh has not covered it yet. Every function here treats `null` as "no bound
 * to check", the same fallback the server takes.
 */

/** This base's wall cap — the `wall_reference` row for its known Town Hall. */
export function wallCapFor(
  thLevel: number | null,
  reference: readonly WallReferenceRow[],
): WallReferenceRow | null {
  if (thLevel === null) return null
  return reference.find((row) => row.thLevel === thLevel) ?? null
}

/**
 * Whether `level`, as typed, is a wall level `cap` allows — a positive whole
 * number at or below `maxWallLevel`. An empty string is treated as valid (a row
 * mid-typed, or a blank spare row, is not yet wrong), matching `rowsToWalls`'
 * own stance of dropping rather than flagging an incomplete row. Without a cap,
 * any positive whole number is accepted — there is nothing to bound it by.
 */
export function isWallLevelInRange(level: string, cap: WallReferenceRow | null): boolean {
  const trimmed = level.trim()
  if (trimmed === '') return true
  if (!/^\d+$/.test(trimmed)) return false
  const parsed = Number(trimmed)
  if (parsed <= 0) return false
  return cap === null || parsed <= cap.maxWallLevel
}

/**
 * Sum of the counts across every row, parsed the same leniently-drop-the-rest
 * way `rowsToWalls` does — a count that is not a finite non-negative number
 * contributes 0 rather than throwing, since this runs on every keystroke while
 * a row may be mid-typed.
 */
export function wallsTotal(counts: readonly string[]): number {
  return counts.reduce((sum, raw) => {
    const count = Number(raw)
    return Number.isFinite(count) && count > 0 ? sum + Math.trunc(count) : sum
  }, 0)
}
