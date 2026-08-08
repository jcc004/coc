import type { CardCategory } from '@coc/shared'
import { cardCategoriesInOrder } from './cards.ts'

/**
 * Which of the seven collection-leaderboard rankings the picker is showing.
 *
 * `'overall'` is `baseStandings()`, unchanged from before this picker existed;
 * the other six are the parallel rankings in `rarity-standings.ts`,
 * `category-standings.ts`, `row-standings.ts`, `deck-completion-standings.ts`,
 * `spares-standings.ts` and `trader-standings.ts`. This module owns only the
 * *picker's* state — which view is chosen, and which deck `'category'` is
 * showing — never the ranking logic itself, which stays in those six modules
 * exactly as `baseStandings()` already kept the leaderboard's own logic out of
 * `CardsView.tsx`.
 */
export type LeaderboardView =
  | 'overall'
  | 'rarity'
  | 'category'
  | 'rows'
  | 'decks'
  | 'spares'
  | 'traders'

/** One entry of the picker, in the order it offers them. */
export interface LeaderboardViewOption {
  value: LeaderboardView
  label: string
}

/**
 * The seven options, in this exact order — agreed through a full design
 * conversation and not to be reordered or relabeled independently of it.
 * Overall leads because it is the board that existed before this picker did,
 * so a reader who has never touched the control still sees what they always
 * saw.
 */
export const LEADERBOARD_VIEWS: readonly LeaderboardViewOption[] = [
  { value: 'overall', label: 'Overall' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'category', label: 'By category' },
  { value: 'rows', label: 'Full rows' },
  { value: 'decks', label: 'Full decks' },
  { value: 'spares', label: 'Spares on hand' },
  { value: 'traders', label: 'Most active trader' },
]

const DEFAULT_VIEW: LeaderboardView = 'overall'

/**
 * Reads a stored view choice back. Anything that is not one of the seven known
 * values — absent, hand-edited, or a value an older/newer build no longer
 * offers — falls back to `'overall'`, the same "unrecognized is the safe
 * default" shape `parseCardTotalSort` and `parseRowLimit` already use.
 */
export function parseLeaderboardView(stored: string | null): LeaderboardView {
  return LEADERBOARD_VIEWS.some((option) => option.value === stored)
    ? (stored as LeaderboardView)
    : DEFAULT_VIEW
}

/**
 * Reads a stored deck choice back, for the secondary picker "By category" shows.
 *
 * Falls back to the **first** category in `cardCategoriesInOrder()` — the same
 * "default to the first" the task asked for, and the same order the grid and
 * `cardsInGridOrder()` already draw the four decks in, so the fallback is not a
 * second ordering that happens to agree with theirs today. Anything not
 * currently one of the four decks (a stale value, or the manifest dropping a
 * category) is treated the same as absent rather than throwing.
 */
export function parseLeaderboardCategory(stored: string | null): CardCategory {
  const categories = cardCategoriesInOrder()
  const found = categories.find((category) => category === stored)
  // `categories` always holds at least one entry — the manifest ships four decks
  // and cardCategoriesInOrder() derives them from it — so the fallback is safe.
  return found ?? categories[0]!
}
