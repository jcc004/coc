/**
 * How many cards across, and which choices are worth offering at a given width.
 *
 * Six columns is the layout the grid is built on — ten rows of six, the same shape at
 * every width, so a card can be found by where it sits rather than by reading every
 * tile. This module does not change that; it decides when it is worth offering to go
 * **denser**, and refuses to offer a density that would make the tiles unusable.
 *
 * The rule that earns a tested module: an option is only offered if the tiles it
 * produces clear {@link MIN_OPTIONAL_TILE}. Without that, a picker offering twelve
 * across on a phone would hand back 25-pixel cards — technically more on screen, and
 * useless. It is also what makes the control **hide itself on a phone**, where six is
 * the only density that fits: an empty picker is worse than no picker.
 *
 * Six is exempt from the floor. It is the mandated baseline rather than a choice, so
 * it is always in the list even where it is tight — which is the case at 360px, where
 * it yields about 48px. That is a decision already taken and measured; this module
 * must not quietly overrule it.
 */

/** The densities offered, in order. Six first because it is the default. */
export const CARD_COLUMN_STEPS: readonly number[] = [6, 8, 10, 12]

/** The default, and the baseline the grid was designed around. */
export const DEFAULT_CARD_COLUMNS = 6

/**
 * The smallest tile an *optional* denser view may produce, in CSS pixels.
 *
 * 64 rather than the ~48px that six columns yields on a small phone: this is a floor
 * on choices the user opts into, and a denser view is only worth having if the art is
 * still recognisable and the count box still typeable. The mandated six-column
 * baseline is deliberately not held to it — see the module note.
 */
export const MIN_OPTIONAL_TILE = 64

/** What one row costs: the tiles, plus the gaps between them. */
export function tileWidthFor(contentWidth: number, columns: number, gap: number): number {
  if (columns <= 0) return 0
  return (contentWidth - gap * (columns - 1)) / columns
}

/**
 * The densities worth offering for this content width.
 *
 * Always contains {@link DEFAULT_CARD_COLUMNS}. Returns a single-entry list when
 * nothing denser fits, which is the caller's cue to render no control at all.
 */
export function cardColumnOptions(contentWidth: number, gap: number): number[] {
  return CARD_COLUMN_STEPS.filter(
    (columns) =>
      columns === DEFAULT_CARD_COLUMNS ||
      tileWidthFor(contentWidth, columns, gap) >= MIN_OPTIONAL_TILE,
  )
}

/** Whether a density picker has more than one thing to say here. */
export function cardScaleIsUseful(contentWidth: number, gap: number): boolean {
  return cardColumnOptions(contentWidth, gap).length > 1
}

/**
 * A stored preference made safe for this width.
 *
 * A choice made on a desktop follows the account to a phone, where it may no longer
 * be offered. Clamping to the nearest *available* step keeps the intent — the user
 * asked for dense — without producing a width the tiles cannot survive. Anything
 * unrecognisable falls back to the default rather than being coerced: `Number('')` is
 * 0, and a zero-column grid is not a layout.
 */
export function resolveCardColumns(stored: unknown, contentWidth: number, gap: number): number {
  const options = cardColumnOptions(contentWidth, gap)
  const wanted = typeof stored === 'number' ? stored : Number(stored)
  if (!Number.isInteger(wanted) || wanted <= 0) return DEFAULT_CARD_COLUMNS
  if (options.includes(wanted)) return wanted

  // Nearest offered step, preferring the denser one on a tie: the user asked for
  // more on screen, so err toward more.
  let best = DEFAULT_CARD_COLUMNS
  let bestGap = Infinity
  for (const option of options) {
    const distance = Math.abs(option - wanted)
    if (distance < bestGap || (distance === bestGap && option > best)) {
      best = option
      bestGap = distance
    }
  }
  return best
}
