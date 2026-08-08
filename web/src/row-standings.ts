import type { BaseInventory } from '@coc/shared'
import { cardsInGridOrder, type StandingBase } from './card-standings.ts'
import { countMap } from './cards.ts'
import type { GeneratedCard } from './cards.ts'

/**
 * A second leaderboard on top of the same sixty cards: not "how many do you
 * hold" but "how many of the real game's own rows have you completed."
 *
 * The real Clash of Clans collection screen is six cards wide, and — confirmed
 * against in-game screenshots on 2026-08-08 — it flows continuously across deck
 * boundaries the same way this app's grid already does: a deck finishing mid-row
 * does not push the next deck onto a fresh one. So `cardsInGridOrder()` (the
 * exact order the grid draws, from `card-standings.ts`), split into contiguous
 * groups of six, **is** the real game's row layout. Sixty cards ÷ six = ten rows
 * exactly, and no new card ordering is invented here — this module only groups
 * an order that already exists.
 *
 * A row is **full** when a base holds at least one copy of all six cards in it.
 * The score rewards both breadth across rows and rows completed *together*:
 *
 *   score = (full rows × 10) + (longest run of consecutive full row indices × 5)
 *
 * so five full rows scattered across the grid score 50, but the same five rows
 * as one unbroken run score 50 + 25 = 75 — finishing a deck (or a stretch of
 * decks) end-to-end is worth more than the same five rows picked at random. This
 * is an approved design decision, not something this module re-derives; see the
 * task that produced it for the reasoning behind the exact weights.
 */

/** Cards per row on the real game's collection screen — see the module doc. */
export const ROW_SIZE = 6

/** What one full row is worth, on its own. */
const FULL_ROW_POINTS = 10
/** What each row of the longest unbroken run of full rows adds, on top of that. */
const STREAK_POINTS = 5

/**
 * `cards`, chunked into the real game's rows of six.
 *
 * Not memoized: `cardsInGridOrder()` itself is not memoized either (it re-walks
 * the manifest on every call), and sixty cards is not a cost worth caching
 * behind a module-level variable that a test would then have to worry about
 * going stale across calls.
 */
function rowsOfCards(cards: readonly GeneratedCard[]): readonly GeneratedCard[][] {
  const rows: GeneratedCard[][] = []
  for (let start = 0; start < cards.length; start += ROW_SIZE) {
    rows.push(cards.slice(start, start + ROW_SIZE))
  }
  return rows
}

/**
 * Which of the grid's rows a single base's counts fill completely.
 *
 * Exported standalone — the same way `cardPoints` is usable without
 * `baseStandings` — so a future UI that only needs to shade the sixty tiles
 * (which rows are complete) does not have to run the whole ranking to get it.
 * `cards` defaults to `cardsInGridOrder()`; a caller passes its own list only to
 * test against a synthetic layout rather than the real sixty.
 */
export function fullRowsFor(
  inventory: BaseInventory | undefined,
  cards: readonly GeneratedCard[] = cardsInGridOrder(),
): boolean[] {
  const counts = countMap(inventory)
  return rowsOfCards(cards).map((row) => row.every((card) => (counts.get(card.id) ?? 0) > 0))
}

/** The score, and the two counts it is built from. */
export interface RowScore {
  /** How many of the ten rows are full. */
  fullRowCount: number
  /** The longest run of *consecutive row indices* that are all full — see the module doc. */
  longestStreak: number
  /** `fullRowCount * 10 + longestStreak * 5`. */
  score: number
}

/**
 * `fullRows` → `RowScore`, with no knowledge of bases or inventory.
 *
 * Exported standalone for the same reason as {@link fullRowsFor}: a caller that
 * already has a boolean-per-row reading (from {@link fullRowsFor}, or from a UI
 * recomputing one row at a time) can score it without going through
 * {@link rowStandings}.
 *
 * A run is broken by any non-full row, including one that is merely *absent*
 * from the input — `fullRows` is read strictly left to right, by array position,
 * so a caller must pass all ten in row order for the streak to mean what it says.
 */
export function rowScoreFor(fullRows: readonly boolean[]): RowScore {
  let fullRowCount = 0
  let longestStreak = 0
  let currentStreak = 0

  for (const full of fullRows) {
    if (full) {
      fullRowCount += 1
      currentStreak += 1
      longestStreak = Math.max(longestStreak, currentStreak)
    } else {
      currentStreak = 0
    }
  }

  return {
    fullRowCount,
    longestStreak,
    score: fullRowCount * FULL_ROW_POINTS + longestStreak * STREAK_POINTS,
  }
}

/** A base's standing on the full-rows board. */
export interface RowStanding extends StandingBase, RowScore {
  /**
   * One entry per row (ten, in grid order), so a leaderboard row can shade the
   * rows it completed rather than only print the final number. Same order and
   * same meaning as {@link fullRowsFor}'s return value.
   */
  fullRows: readonly boolean[]
  /**
   * Standing, sharing a number on a genuine tie — same convention as
   * {@link BaseStanding.rank} in `card-standings.ts`. See the sort below for what
   * "tie" means here.
   */
  rank: number
}

/**
 * The tracked bases, ranked by full rows, best first.
 *
 * **The order is: score descending, then full-row count descending, then member
 * name, then tag.** Score is the measure, but it is not injective — a base with
 * three full rows in one unbroken run (30 + 15 = 45) and a base with four full
 * rows scattered as four separate streaks of one (40 + 5 = 45) land on the same
 * score by two different routes. `fullRowCount` breaks that tie in favor of the
 * base that actually completed more rows outright, on the same reasoning
 * `baseStandings` gives `distinct` over `points`: reaching a score across more of
 * the board is the better position even when the arithmetic agrees. Name and then
 * tag are not merit, only what makes the order total, exactly as in
 * `baseStandings`.
 *
 * Mirrors `baseStandings`'s signature: takes the whole inventory rather than
 * requiring the caller to pre-join, so a base with no entry in it is a real base
 * with nothing recorded (all ten rows empty, score 0) rather than one dropped
 * from the board.
 */
export function rowStandings(
  bases: readonly StandingBase[],
  inventory: readonly BaseInventory[],
  cards: readonly GeneratedCard[] = cardsInGridOrder(),
): RowStanding[] {
  const byTag = new Map(inventory.map((base) => [base.tag, base]))

  const rows: RowStanding[] = bases.map((base) => {
    const fullRows = fullRowsFor(byTag.get(base.tag), cards)
    const { fullRowCount, longestStreak, score } = rowScoreFor(fullRows)
    return { ...base, fullRows, fullRowCount, longestStreak, score, rank: 0 }
  })

  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.fullRowCount - a.fullRowCount ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    /* Score alone decides a tie. Two bases on the same score have not out-completed
       one another, whatever their full-row counts or names sort like. */
    if (!previous || previous.score !== row.score) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}
