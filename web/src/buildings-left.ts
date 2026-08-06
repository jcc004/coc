/**
 * The three-way shape `ManualCapturePayload.buildingsLeft` takes on the wire: a
 * whole number typed as a digit string, or one of two literals for when counting is
 * not the point — `'LOTS'` ("too many to bother") and `'DONE!'` (zero left).
 *
 * Mirrors `BUILDINGS_LEFT_PATTERN` in `server/src/progress/routes.ts` — that pattern
 * is the actual enforcement, this only shapes a three-way control (a mode plus a
 * count) so the UI can never construct a string the server would reject. Pulled out
 * of the panel component because the round trip between the control's state and the
 * wire string is exactly the kind of thing that is easy to get subtly wrong in one
 * direction (a negative count, a decimal, an empty string) and cheap to pin down here.
 */

export type BuildingsLeftMode = 'count' | 'lots' | 'done'

export interface BuildingsLeftValue {
  mode: BuildingsLeftMode
  /** Only meaningful when `mode === 'count'`; ignored (and not sent) otherwise. */
  count: number
}

/** What a base with nothing entered yet starts from. */
export const BUILDINGS_LEFT_UNSET: BuildingsLeftValue = { mode: 'count', count: 0 }

/**
 * The stored wire string — or `null`/`undefined` for "nothing entered yet" — as the
 * control's value. Anything that is not one of the two literals or a plain digit
 * string (the same set `BUILDINGS_LEFT_PATTERN` accepts) reads as the unset count
 * rather than throwing: a value this function cannot make sense of is not something
 * the control should crash render over.
 */
export function parseBuildingsLeft(raw: string | null | undefined): BuildingsLeftValue {
  if (raw === 'LOTS') return { mode: 'lots', count: 0 }
  if (raw === 'DONE!') return { mode: 'done', count: 0 }
  if (raw !== null && raw !== undefined && /^\d+$/.test(raw)) {
    return { mode: 'count', count: Number(raw) }
  }
  return BUILDINGS_LEFT_UNSET
}

/**
 * The control's value, back to the wire string `ManualCapturePayload.buildingsLeft`
 * takes. Always one of the three shapes `BUILDINGS_LEFT_PATTERN` accepts — a
 * negative or fractional count is clamped rather than sent as typed, because the
 * count only ever reaches here through `parseBuildingsLeft` or arithmetic on it, and
 * neither should be able to produce a string the server would 400 on.
 */
export function formatBuildingsLeft(value: BuildingsLeftValue): string {
  if (value.mode === 'lots') return 'LOTS'
  if (value.mode === 'done') return 'DONE!'
  return String(Math.max(0, Math.trunc(value.count)))
}
