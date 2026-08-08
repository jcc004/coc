import type { TradeRecord } from '@coc/shared'
import type { StandingBase } from './card-standings.ts'

/**
 * "Most active trader" — the Trade Tracker's own leaderboard, ranking which
 * **bases**, not which owners, have completed the most trades.
 *
 * Ranked by base and never rolled up to the owner, on purpose — the user's own
 * framing of the requirement: an owner running nine bases would otherwise
 * out-rank someone running one who trades every card they can get, and the
 * number would measure how many bases somebody manages rather than how much
 * trading happened on any one of them. `TradeRecord.baseA` / `.baseB` are
 * already per-base tags (`shared/src/trade-types.ts`), so this counts on the
 * same identity the rest of the app ranks by and never joins through an owner
 * id at all.
 *
 * Counts `status === 'complete'` **and** `status === 'undone'` — every trade
 * that ever reached completion, whether or not an admin later reversed the
 * cards it moved. `pending` is a proposal, not activity yet, and `declined`
 * never happened at all, so both stay excluded. But `undoneAt` is documented
 * elsewhere (`TradeRecord.undoneAt`, `docs/trade-tracker.md`) as a *third*
 * event layered on top of a completion, never a rewrite of it — `resolvedAt`
 * / `resolvedBy` stay exactly as completion wrote them. This is an *activity*
 * ranking, not a current-holdings one: a base that completed twenty trades and
 * had one undone by an admin correcting a mistake still did the work of
 * completing twenty trades. Penalizing that here would make an admin's
 * correction of one trade retroactively erase unrelated history.
 */

/** One base's standing on the trade leaderboard. */
export interface TraderStanding extends StandingBase {
  /** Completed trades this base was a party to, either side. */
  completedTrades: number
  /**
   * Distinct bases this base has completed a trade with — the tiebreak below,
   * not part of the headline count. A base that traded the same partner five
   * times and one that traded five different partners tie on `completedTrades`
   * but are not equally established in the trade network. Unlike a points or
   * distinct-cards tiebreak (`baseStandings`'s own precedent for "who's more
   * established" — `card-standings.ts:129`), this needs no data beyond the
   * trades themselves, so `traderStandings` stays a function of `TradeRecord`
   * and `StandingBase` alone.
   */
  distinctPartners: number
  /**
   * Standing, sharing a number on a genuine tie — same convention as
   * `BaseStanding.rank` (`card-standings.ts:123`).
   */
  rank: number
}

/**
 * The trade leaderboard, best first.
 *
 * **Every base in `bases` gets a row, whether or not it has traded.** Same
 * choice `baseStandings` makes for card counts (`card-standings.ts:140`): a
 * base with nothing recorded is a real, zero-scored base, not one dropped off
 * the board. "Has this base traded at all" is exactly the question this board
 * exists to answer, so a base that never has must be visible at 0 to answer it
 * — the established "a missing element is a return/zero, not a throw" rule.
 *
 * **A base tag on a trade that is not in `bases` gets no row of its own.**
 * `bases` is the roster this board is drawn against, the same as
 * `baseStandings`'s own `bases` parameter — a tag with no matching
 * `StandingBase` has no label or owner to print, so there is nothing to rank
 * it under. It is not silently miscounted, though: if a *known* base completed
 * a trade with an untracked one, that trade still adds one to the known base's
 * `completedTrades` and counts the untracked tag toward its
 * `distinctPartners` — only the untracked side is left off the board, not the
 * trade itself.
 *
 * **Sort: `completedTrades` descending, then `distinctPartners` descending,
 * then name, then tag** — the same total-order shape as `baseStandings`
 * (`card-standings.ts:129`-`136`): a leading measure, one supporting measure
 * to separate a tie, and name/tag only to make the order total rather than to
 * reward anything. Rank is shared and skipped on `completedTrades` alone,
 * matching `BaseStanding.rank`'s own reasoning (`card-standings.ts:116`-`123`):
 * two bases who have completed the same number of trades have not out-traded
 * one another, however many partners or however their names happen to sort.
 */
export function traderStandings(
  bases: readonly StandingBase[],
  trades: readonly TradeRecord[],
): TraderStanding[] {
  const activity = new Map<string, { completed: number; partners: Set<string> }>()

  const record = (tag: string, partner: string) => {
    const entry = activity.get(tag) ?? { completed: 0, partners: new Set<string>() }
    entry.completed += 1
    entry.partners.add(partner)
    activity.set(tag, entry)
  }

  for (const trade of trades) {
    if (trade.status !== 'complete' && trade.status !== 'undone') continue
    record(trade.baseA, trade.baseB)
    record(trade.baseB, trade.baseA)
  }

  const rows: TraderStanding[] = bases.map((base) => {
    const entry = activity.get(base.tag)
    return {
      ...base,
      completedTrades: entry?.completed ?? 0,
      distinctPartners: entry?.partners.size ?? 0,
      rank: 0,
    }
  })

  rows.sort(
    (a, b) =>
      b.completedTrades - a.completedTrades ||
      b.distinctPartners - a.distinctPartners ||
      a.label.localeCompare(b.label) ||
      a.tag.localeCompare(b.tag),
  )

  let rank = 0
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    /* Trade count alone decides a tie. Two bases on the same count have not
       out-traded one another, whatever their partner counts or names sort like. */
    if (!previous || previous.completedTrades !== row.completedTrades) {
      rank = index + 1
    }
    row.rank = rank
  })

  return rows
}
