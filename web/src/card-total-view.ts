import { parseAllowlisted } from './persisted-choice.ts'

/**
 * Which reading of the "Cards across the clan" panel is on screen.
 *
 * `'totals'` is the panel as it has always worked — every tile badged with its
 * clan-wide count. `'fodder'` is a second reading of the **same** sixty tiles,
 * answering a different question: not "how many does the clan hold" but "which of
 * these is safe to give away" — see `tradeFodder()` in `trade-fodder.ts` for the
 * rule behind it. A picker, not a toggle two states would already cover, on the
 * same reasoning `LeaderboardView` (`leaderboard-view.ts`) is a picker rather than
 * a boolean: a third reading is a plausible future addition, and a `boolean` prop
 * threaded through three components would need renaming at that point rather than
 * just widening a union.
 */
export type CardTotalView = 'totals' | 'fodder'

/** One entry of the picker, in the order it offers them. */
export interface CardTotalViewOption {
  value: CardTotalView
  label: string
}

/**
 * The two options, in this order. `'totals'` leads because it is the view that
 * existed before this picker did, so a reader who has never touched the control
 * still sees what they always saw — the same reasoning `LEADERBOARD_VIEWS` orders
 * `'overall'` first.
 */
export const CARD_TOTAL_VIEWS: readonly CardTotalViewOption[] = [
  { value: 'totals', label: 'Totals' },
  { value: 'fodder', label: 'Trade Fodder' },
]

const DEFAULT_VIEW: CardTotalView = 'totals'

/** `CARD_TOTAL_VIEWS`' own values, for `parseAllowlisted` below — that option list
    is `{value, label}` pairs, not a plain array of the values themselves. */
const CARD_TOTAL_VIEW_VALUES: readonly CardTotalView[] = CARD_TOTAL_VIEWS.map(
  (option) => option.value,
)

/**
 * Reads a stored view choice back. Anything that is not one of the two known
 * values — absent, hand-edited, or a value an older/newer build no longer offers
 * — falls back to `'totals'`. See `parseAllowlisted` (`persisted-choice.ts`) for
 * the shared shape this and every other picker's own parse function use.
 */
export function parseCardTotalView(stored: string | null): CardTotalView {
  return parseAllowlisted(stored, CARD_TOTAL_VIEW_VALUES, DEFAULT_VIEW)
}
