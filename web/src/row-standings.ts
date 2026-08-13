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
 * A row is **full** when a base holds at least one copy of all six cards in it,
 * and **doubled** when it holds at least *two* of every one of those six — a
 * stronger, rarer completion. The score rewards breadth, rows completed
 * *together*, and rows completed twice over:
 *
 *   score = (full rows × 10) + (streak rows × 5) + (doubled rows × 10)
 *
 * where **streak rows** is the sum, over every maximal run of consecutive full
 * rows that is at least two long, of that run's own length — not just the
 * longest run. Two bases can hold the same five rows full and still land on
 * different scores depending on how those five are arranged:
 *
 * - five full rows scattered, no two adjacent: streak rows = 0, score = 50.
 * - the same five as one unbroken run: streak rows = 5, score = 50 + 25 = 75.
 * - the same five as a run of three plus a separate run of two: streak rows =
 *   3 + 2 = 5, score = 50 + 25 = 75 — each qualifying run earns its own bonus,
 *   summed, rather than only the single longest run counting. A base with a
 *   run of three plus two rows completed on their own (not adjacent to
 *   anything) only banks the run of three: streak rows = 3, score = 50 + 15 =
 *   65 — an isolated full row earns its 10 points same as any other, but nets
 *   no togetherness bonus on its own; it needs a neighbor.
 *
 * This is an approved design decision, not something this module re-derives;
 * see the task that produced it for the reasoning behind the exact weights.
 *
 * Reported live, 2026-08-12: two bases each holding 5 of 10 rows, one as a run
 * of three plus two rows scattered, the other as a run of three plus a
 * *separate* run of two, scored identically (65) under the previous
 * longest-run-only formula — the second base's own second streak was not
 * being credited at all. This module's history before that date only ever
 * rewarded the single longest run; the multi-run sum above is what replaced
 * it.
 */

/** Cards per row on the real game's collection screen — see the module doc. */
export const ROW_SIZE = 6

/** How full a single row is: not held at all, held once over, or held twice
 *  over — see the module doc for what each threshold means and scores. */
export type RowLevel = 'empty' | 'full' | 'double'

/** What one full row is worth, on its own — includes a doubled row, which is
 *  full and then some. */
const FULL_ROW_POINTS = 10
/** What each row of a qualifying (two-or-longer) streak of full rows adds,
 *  on top of that — summed across every such streak, not just the longest. */
const STREAK_POINTS = 5
/** What one doubled row adds, on top of {@link FULL_ROW_POINTS}. */
const DOUBLE_ROW_POINTS = 10

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
 * How full each of the grid's rows is for a single base's counts.
 *
 * Exported standalone — the same way `cardPoints` is usable without
 * `baseStandings` — so a future UI that only needs to shade the sixty tiles
 * (which rows are complete, which are doubled) does not have to run the whole
 * ranking to get it. `cards` defaults to `cardsInGridOrder()`; a caller passes
 * its own list only to test against a synthetic layout rather than the real
 * sixty.
 */
export function rowLevelsFor(
  inventory: BaseInventory | undefined,
  cards: readonly GeneratedCard[] = cardsInGridOrder(),
): RowLevel[] {
  const counts = countMap(inventory)
  return rowsOfCards(cards).map((row) => {
    const minHeld = row.reduce((min, card) => Math.min(min, counts.get(card.id) ?? 0), Infinity)
    return minHeld >= 2 ? 'double' : minHeld >= 1 ? 'full' : 'empty'
  })
}

/** The score, and the counts it is built from. */
export interface RowScore {
  /** How many of the ten rows are full — includes doubled rows, which are full and then some. */
  fullRowCount: number
  /** How many of the ten rows are doubled: every one of that row's six cards held at least twice. */
  doubleRowCount: number
  /** Rows counted toward the togetherness bonus: the sum, over every run of
   *  consecutive full rows that is at least two long, of that run's own
   *  length — see the module doc. A run of exactly one contributes nothing. */
  streakRows: number
  /** `fullRowCount * 10 + streakRows * 5 + doubleRowCount * 10`. */
  score: number
}

/**
 * `rowLevels` → `RowScore`, with no knowledge of bases or inventory.
 *
 * Exported standalone for the same reason as {@link rowLevelsFor}: a caller that
 * already has a level-per-row reading (from {@link rowLevelsFor}, or from a UI
 * recomputing one row at a time) can score it without going through
 * {@link rowStandings}.
 *
 * A streak is broken by any non-full row, including one that is merely *absent*
 * from the input — `rowLevels` is read strictly left to right, by array
 * position, so a caller must pass all ten in row order for the streaks to mean
 * what they say.
 */
export function rowScoreFor(rowLevels: readonly RowLevel[]): RowScore {
  let fullRowCount = 0
  let doubleRowCount = 0
  let streakRows = 0
  let currentStreak = 0

  const closeStreak = () => {
    if (currentStreak >= 2) streakRows += currentStreak
    currentStreak = 0
  }

  for (const level of rowLevels) {
    if (level === 'empty') {
      closeStreak()
      continue
    }
    fullRowCount += 1
    if (level === 'double') doubleRowCount += 1
    currentStreak += 1
  }
  closeStreak()

  return {
    fullRowCount,
    doubleRowCount,
    streakRows,
    score:
      fullRowCount * FULL_ROW_POINTS + streakRows * STREAK_POINTS + doubleRowCount * DOUBLE_ROW_POINTS,
  }
}

/** A base's standing on the full-rows board. */
export interface RowStanding extends StandingBase, RowScore {
  /**
   * One entry per row (ten, in grid order), so a leaderboard row can shade the
   * rows it completed — and, separately, doubled — rather than only print the
   * final number. Same order and same meaning as {@link rowLevelsFor}'s return
   * value.
   */
  rowLevels: readonly RowLevel[]
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
 * three full rows as a run of two plus one on its own (30 + 10 = 40) and a base
 * with four full rows scattered, no two adjacent (40 + 0 = 40) land on the same
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
    const rowLevels = rowLevelsFor(byTag.get(base.tag), cards)
    const { fullRowCount, doubleRowCount, streakRows, score } = rowScoreFor(rowLevels)
    return { ...base, rowLevels, fullRowCount, doubleRowCount, streakRows, score, rank: 0 }
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
