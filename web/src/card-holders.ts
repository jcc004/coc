import { MIN_TRADEABLE_COUNT, type BaseInventory } from '@coc/shared'
import { countMap } from './cards.ts'

/**
 * One card, and which of the tracked bases are sitting on a copy of it.
 *
 * The clan-totals grid says *how many* copies the clan holds of each card; this is
 * the other half of that sentence — **who**. It is the question the badge on a tile
 * raises and cannot answer: `×4` tells you a trade is theoretically possible and
 * nothing at all about whom to message.
 *
 * Its own module, and not a few lines inside `CardsView`, for the reason the rest of
 * `card-standings.ts` and `card-summary.ts` are: the order has a wrong answer a
 * screenshot would not catch. A comparator that stops at the count leaves bases that
 * hold the same number in whatever order the inventory arrived in, which is a table
 * that reshuffles itself between renders — the same trap `baseStandings` documents.
 *
 * Counting is `countMap`'s, not a second implementation. That is what makes the rows
 * add up to the badge on the tile: a card id the list does not know, or a count that
 * is not positive, is dropped here on exactly the terms the grid and `cardTotals`
 * drop it. It builds a map per base to read one entry out of it, which is more work
 * than a scan of `base.counts` would be — a base holds at most sixty rows, and this
 * runs once per selection rather than once per tile, so agreeing with the grid is
 * worth more than the arithmetic saved.
 */

export interface CardHolder {
  /** Canonical `#TAG` — the identity, as everywhere else. */
  tag: string
  /** What to print for the base, from the caller's labeler. */
  label: string
  /** Copies of this one card. At least 1: a base holding none is not a holder. */
  count: number
  /**
   * Whether this base could give one away — `count >= MIN_TRADEABLE_COUNT`.
   *
   * The distinction the whole table is for. A base never gives away its last copy
   * (the rule is `card-trades.ts`' and the server's, and this is the same constant),
   * so a lone copy is a holding you cannot ask for and two is an offer.
   */
  canSpare: boolean
}

/**
 * The bases holding `cardId`, **most copies first**.
 *
 * Then by label, then by tag, which is not merit: it makes the order *total*, so two
 * bases on the same count render in the same sequence on every re-render instead of
 * swapping places. A base no roster names is labeled with its tag and so sorts under
 * `#`, exactly as the leaderboard's comparator leaves it — the picker's "unnamed
 * last" rule belongs to `baseOptions`, which is choosing what to offer rather than
 * reporting what is held.
 *
 * Sorting by count here does not contradict the totals grid's rule that **nothing
 * sorts by count, in any mode**. That rule is about tile *position*: the grid only
 * earns its place by being scannable card-for-card against the entry grid above it,
 * and there is no such counterpart for a list of holders. What this table is asked is
 * "who could give me one", and the bases with a spare are the answer, so they go at
 * the top.
 *
 * Takes the whole inventory rather than a pre-joined subset, so "nobody holds it"
 * comes back as an empty array from the same call — a card 38 of the sixty are in.
 * `labelOf` is required rather than defaulted to the tag: naming a base is
 * `useBaseLabels`' job on both pages that do it, and a default here would be a
 * second, quieter way to name one.
 */
export function cardHolders(
  inventory: readonly BaseInventory[],
  cardId: number,
  labelOf: (tag: string) => string,
): CardHolder[] {
  const rows: CardHolder[] = []

  for (const base of inventory) {
    const count = countMap(base).get(cardId)
    if (count === undefined) continue
    rows.push({
      tag: base.tag,
      label: labelOf(base.tag),
      count,
      canSpare: count >= MIN_TRADEABLE_COUNT,
    })
  }

  rows.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.tag.localeCompare(b.tag),
  )

  return rows
}

/** One base that does not hold `cardId` — no `count`, no `canSpare`: there is nothing to report. */
export interface CardNeeder {
  /** Canonical `#TAG` — the identity, as everywhere else. */
  tag: string
  /** What to print for the base, from the caller's labeler. */
  label: string
}

/**
 * The reporting bases that do **not** hold `cardId` — the names behind `cardDemand()`'s
 * `needing` count.
 *
 * `cardDemand` answers "how many"; this answers "which ones", and is the piece the
 * summary line has never been able to show, because the bases it is counting are
 * precisely the ones with no row in `cardHolders()`'s table. Sibling to that function
 * rather than a filter over its output for the same reason: there is no "holder with a
 * zero count" row to filter out of, since a count of 0 deletes the row entirely (see
 * `cardDemand`'s own `needing` doc comment) — the only way to find these bases is the
 * same negative scan `cardDemand` already does, `!countMap(base).has(cardId)`, not
 * `count === 0`, which would find nothing.
 *
 * Takes the whole inventory rather than a pre-joined subset, matching `cardHolders`:
 * "everybody needs it" comes back as every entry, not a special case. `labelOf` is
 * required for the same reason it is on `cardHolders` — naming a base is
 * `useBaseLabels`' job, and a default here would be a second, quieter way to name one.
 *
 * Sorted by label then tag, the same total order `cardHolders` uses for its own tie
 * break — but with nothing to break the tie *on*: every row here is "zero copies" by
 * construction, so there is no count to sort by first.
 */
export function basesNeeding(
  inventory: readonly BaseInventory[],
  cardId: number,
  labelOf: (tag: string) => string,
): CardNeeder[] {
  const rows: CardNeeder[] = []

  for (const base of inventory) {
    if (countMap(base).has(cardId)) continue
    rows.push({ tag: base.tag, label: labelOf(base.tag) })
  }

  rows.sort((a, b) => a.label.localeCompare(b.label) || a.tag.localeCompare(b.tag))

  return rows
}

/** How many bases have an answer for this card, and how many of those answers is "none". */
export interface CardDemand {
  /**
   * Bases that have reported at all this season — every entry in the inventory.
   *
   * Membership of that array *is* the definition: the server returns a base if it has
   * count rows **or** a stamp (`groupByBase`, `server/src/cards/store.ts`), so a base
   * saved and then cleared to nothing is still reporting and a base nobody has ever
   * entered is simply not here. That is the same distinction `BaseStanding.recorded`
   * draws, and re-deriving it per base would be a no-op on this input.
   *
   * Deliberately **not** the tracked bases. `useBaseLabels` unions the owner
   * assignments in, and a base nobody has entered has not told us it lacks the card —
   * counting it as needing one would invent a demand from an absence of data.
   */
  reporting: number
  /**
   * Of those, the ones holding no copy of this card.
   *
   * Counted through `countMap`, not by looking for a row that says zero: **counts are
   * sparse**, a count of 0 deletes the row, and a base that reported and holds none of
   * this card therefore has no row for it at all. A scan looking for `count === 0`
   * would find nothing and report that nobody needs anything.
   */
  needing: number
}

/**
 * How many reporting bases still want `cardId` — the line's third statistic.
 *
 * The panel already says who holds it and who could spare one; both are answers to
 * "can I get one". This is the other side, "who am I competing with", and it is the
 * one number on the line that a scan of the table below cannot recover, because the
 * bases it counts are precisely the ones with no row in that table.
 *
 * Scans rather than returning `reporting - cardHolders().length`. The subtraction
 * would be true by construction and so could never disagree with the rows; going
 * through `countMap` on the same terms `cardHolders` does is what makes the agreement
 * a fact the tests can check instead of an identity they restate. A zero, a negative
 * and an id the generated list has never heard of are absences in both.
 */
export function cardDemand(inventory: readonly BaseInventory[], cardId: number): CardDemand {
  let needing = 0

  for (const base of inventory) {
    if (!countMap(base).has(cardId)) needing += 1
  }

  return { reporting: inventory.length, needing }
}
