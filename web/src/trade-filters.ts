import type { TradePair, TradeRow } from './card-trades.ts'

/**
 * Narrowing the trade suggestions to the people involved.
 *
 * **The two selections are matched as a set, not one per column, and that is the design
 * decision here.** The obvious reading of "filter each member column" is one filter per
 * column, but the columns are not stable by anything a reader can see: `suggestTrades`
 * orients every pair with the lexicographically smaller *tag* on the left, so whether
 * Anna appears first or second depends on her base's tag against her partner's. Filtering
 * the left column to Anna would return the subset of her trades where her tag happens to
 * sort first, with nothing on screen to explain the rest being gone — and asking for Anna
 * on the left with Bert on the right could return nothing at all while Anna-Bert trades
 * sit one column-swap away.
 *
 * So one selection means "every trade involving this person", two means "trades between
 * these two" whichever side each lands on, and the same person twice means "trades
 * between two of their own bases". That last one is a real query rather than a
 * degenerate case: one account can own several bases, and a swap between two of your own
 * is the only trade you can complete without waiting for anybody.
 */

/** The value standing for a base nobody owns. Leading space, so no display name collides. */
export const UNOWNED = ' unowned'

/** How that reads in the picker and in the summary line. */
export const UNOWNED_LABEL = 'No owner'

/** A base's owner folded to the value the filter matches on. */
function ownerKey(tag: string, ownerOf: (tag: string) => string | undefined): string {
  const owner = ownerOf(tag)?.trim()
  return owner ? owner : UNOWNED
}

/**
 * The owners worth offering, in display order, with {@link UNOWNED} last when some base
 * in these pairs has none.
 *
 * Drawn from the pairs on screen rather than from the whole account list: an option that
 * matches nothing is a dead end, and this control exists to narrow what is already here.
 * Unowned goes last because it is a residual category rather than a person, and sorting
 * it among the names by its sentinel would put it in an arbitrary place.
 */
export function ownersInPairs(
  pairs: readonly TradePair[],
  ownerOf: (tag: string) => string | undefined,
): string[] {
  const found = new Set<string>()
  for (const pair of pairs) {
    found.add(ownerKey(pair.baseA, ownerOf))
    found.add(ownerKey(pair.baseB, ownerOf))
  }

  const named = [...found].filter((owner) => owner !== UNOWNED)
  named.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))
  return found.has(UNOWNED) ? [...named, UNOWNED] : named
}

/**
 * The pairs matching the two selections. `null` means anybody.
 *
 * Order between the selections never matters. Each is **consumed** against one side, so
 * picking the same owner twice needs two sides owned by that person rather than being
 * satisfied twice over by one of them.
 *
 * `otherOnly` drops any pair where both sides belong to the same owner — a real result,
 * since `suggestTrades` only rules out the same *base* trading with itself, not the same
 * *owner*'s two bases. {@link UNOWNED} is exempted from the comparison: two bases with no
 * owner set are not thereby the same person, and treating the sentinel as one would hide
 * every unowned pair the moment the checkbox is on.
 */
export function filterPairsByOwners(
  pairs: readonly TradePair[],
  ownerOf: (tag: string) => string | undefined,
  first: string | null,
  second: string | null,
  otherOnly: boolean,
): TradePair[] {
  const wanted = [first, second].filter((owner): owner is string => owner !== null)

  return pairs.filter((pair) => {
    const sides = [ownerKey(pair.baseA, ownerOf), ownerKey(pair.baseB, ownerOf)]
    if (otherOnly && sides[0] === sides[1] && sides[0] !== UNOWNED) return false
    if (wanted.length === 0) return true

    return wanted.every((owner) => {
      const at = sides.indexOf(owner)
      if (at === -1) return false
      sides.splice(at, 1)
      return true
    })
  })
}

/** One side of a displayed row: which base, and which card it gives. */
export interface TradeSide {
  tag: string
  cardId: number
}

/**
 * Which side of one row to print on the left, once the "Involving" picker has
 * narrowed the table to a single owner.
 *
 * `card-trades.ts` orients every pair by *tag*, not by who is looking at it — the
 * lexicographically smaller tag is always `baseA` (`suggestTrades`'s own doc
 * comment). Left alone, that means the very owner somebody filtered *for* prints
 * on the left of one row and the right of the next, which defeats the point of
 * narrowing to one person: there is no single column to read down. This
 * reorients for **display only** — `row.pair` and `row.trade` themselves are
 * untouched, so the pair-identity key, `tradeKey`, and `data-pair-start` all keep
 * working from the unswapped originals.
 *
 * `soleOwner` is `null` whenever there is nothing to orient around — no
 * "Involving" selection, same as {@link filterPairsByOwners}'s `first`. A row
 * where *both* sides belong to `soleOwner` (their own two bases trading) has no
 * real left/right to prefer; canonical order is kept rather than picked
 * arbitrarily.
 */
export function orientRowForOwner(
  row: TradeRow,
  ownerOf: (tag: string) => string | undefined,
  soleOwner: string | null,
): { left: TradeSide; right: TradeSide } {
  const a: TradeSide = { tag: row.pair.baseA, cardId: row.trade.cardFromA }
  const b: TradeSide = { tag: row.pair.baseB, cardId: row.trade.cardFromB }
  if (soleOwner === null) return { left: a, right: b }

  const aMatches = ownerKey(a.tag, ownerOf) === soleOwner
  const bMatches = ownerKey(b.tag, ownerOf) === soleOwner
  return bMatches && !aMatches ? { left: b, right: a } : { left: a, right: b }
}

/**
 * What the filter did, in words, or `null` when nothing is filtered.
 *
 * Said out loud because a shorter list with no explanation reads as missing data — the
 * same failure the blank member cells were.
 */
export function tradeFilterSummary(
  shown: number,
  total: number,
  first: string | null,
  second: string | null,
  otherOnly: boolean,
): string | null {
  if (first === null && second === null && !otherOnly) return null
  const name = (owner: string) => (owner === UNOWNED ? UNOWNED_LABEL : owner)

  const who =
    first !== null && second !== null
      ? first === second
        ? `between two bases owned by ${name(first)}`
        : `between ${name(first)} and ${name(second)}`
      : first !== null || second !== null
        ? `involving ${name(first ?? second ?? '')}`
        : null

  const clause = [who, otherOnly ? "excluding a member's own bases" : null]
    .filter((part): part is string => part !== null)
    .join(', ')

  if (shown === 0) return `No suggested trades ${clause}.`
  return `Showing ${shown} of ${total} pair${total === 1 ? '' : 's'}, ${clause}.`
}
