import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { groupTradesByPair, type TradeSuggestion } from './card-trades.ts'
import {
  parseTradeMemberSort,
  sortTradePairsByMember,
  tradeMemberSortLabel,
  TRADE_MEMBER_SORTS,
} from './trade-member-sort.ts'

/** Same shape as `trade-priority.test.ts`'s own `suggestion` helper. */
function suggestion(baseA: string, baseB: string, cardFromA: number, cardFromB: number): TradeSuggestion {
  return { baseA, baseB, cardFromA, cardFromB, category: 'Elixir', mutual: true }
}

const NAMES: Record<string, string> = {
  '#A': 'Zara',
  '#B': 'Anna',
  '#C': 'Milo',
}
const labelOf = (tag: string) => NAMES[tag] ?? tag
const noOwners = () => undefined

describe('sortTradePairsByMember — none leaves the incoming pair order untouched', () => {
  it('returns the same order as the input, for a copy rather than the same array', () => {
    const flatTrades = [suggestion('#B', '#A', 1, 2), suggestion('#B', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)

    const sorted = sortTradePairsByMember(pairs, 'none', labelOf, noOwners, null)

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
    )
    assert.notEqual(sorted, pairs)
  })

  it('does not mutate the array handed in', () => {
    const flatTrades = [suggestion('#B', '#A', 1, 2), suggestion('#B', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    const before = pairs.map((pair) => `${pair.baseA}-${pair.baseB}`)

    sortTradePairsByMember(pairs, 'none', labelOf, noOwners, null)

    assert.deepEqual(
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
      before,
    )
  })
})

describe('sortTradePairsByMember — first/second member, both directions, no owner focus', () => {
  // Two pairs with different baseA bases: #A(Zara)-#B(Anna) and #C(Milo)-#B(Anna).
  it('firstAsc/firstDesc order by baseA’s own name', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#C', '#B', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    // pairs: {baseA:'#A', baseB:'#B'} (Zara/Anna), {baseA:'#C', baseB:'#B'} (Milo/Anna)

    const ascending = sortTradePairsByMember(pairs, 'firstAsc', labelOf, noOwners, null)
    assert.deepEqual(
      ascending.map((pair) => labelOf(pair.baseA)),
      ['Milo', 'Zara'],
    )

    const descending = sortTradePairsByMember(pairs, 'firstDesc', labelOf, noOwners, null)
    assert.deepEqual(
      descending.map((pair) => labelOf(pair.baseA)),
      ['Zara', 'Milo'],
    )
  })

  it('secondAsc/secondDesc order by baseB’s own name', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#A', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    // pairs: {baseA:'#A', baseB:'#B'} (Zara/Anna), {baseA:'#A', baseB:'#C'} (Zara/Milo)

    const ascending = sortTradePairsByMember(pairs, 'secondAsc', labelOf, noOwners, null)
    assert.deepEqual(
      ascending.map((pair) => labelOf(pair.baseB)),
      ['Anna', 'Milo'],
    )

    const descending = sortTradePairsByMember(pairs, 'secondDesc', labelOf, noOwners, null)
    assert.deepEqual(
      descending.map((pair) => labelOf(pair.baseB)),
      ['Milo', 'Anna'],
    )
  })

  it('does not mutate the array handed in', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#C', '#B', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)
    const before = pairs.map((pair) => `${pair.baseA}-${pair.baseB}`)

    sortTradePairsByMember(pairs, 'firstAsc', labelOf, noOwners, null)

    assert.deepEqual(
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
      before,
    )
  })

  it('ties keep the incoming order — a stable sort, not a re-derived one', () => {
    // Both pairs share a baseA display name ("Zara" is reused for #D here), so
    // firstAsc has nothing to break the tie with and must fall back to arrival order.
    const tiedNames: Record<string, string> = { ...NAMES, '#D': 'Zara' }
    const tiedLabelOf = (tag: string) => tiedNames[tag] ?? tag
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#D', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)

    const sorted = sortTradePairsByMember(pairs, 'firstAsc', tiedLabelOf, noOwners, null)

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
    )
  })
})

describe('sortTradePairsByMember — sorts by what is actually printed, not by raw baseA/baseB', () => {
  // Regression: focusing a single "Involving" owner makes `orientRowForOwner` swap a
  // pair's display left/right so that owner's own base always reads on the left,
  // whichever tag `suggestTrades` happened to call `baseA`. The sort has to key off
  // that same swap — see the module's own doc comment — or "First member (A–Z)"
  // silently stops matching what the first column shows.
  //
  // #B (Anna) is owned by 'anna-owner' and is `baseB` in the first pair, `baseA` in
  // the second — `orientPairForOwner` puts Anna's base on the left of *both* once
  // 'anna-owner' is focused, so the displayed-left column reads ['Anna', 'Anna'], a
  // tie that keeps arrival order. The buggy, raw-`baseA` version instead reads
  // ['Zara', 'Anna'] (pair 1's raw `baseA` is #A/Zara, pair 2's is #B/Anna) and would
  // sort pair 2 ahead of pair 1 — a different, wrong order this test rules out.
  const owners: Record<string, string> = { '#B': 'anna-owner' }
  const ownerOf = (tag: string) => owners[tag]

  it('firstAsc keeps arrival order once the focused owner ties every displayed-left name', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#B', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)

    const sorted = sortTradePairsByMember(pairs, 'firstAsc', labelOf, ownerOf, 'anna-owner')

    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      pairs.map((pair) => `${pair.baseA}-${pair.baseB}`),
    )
  })

  it('secondAsc, with the focused owner fixed on the left, sorts by the counterparty’s name', () => {
    const flatTrades = [suggestion('#A', '#B', 1, 2), suggestion('#B', '#C', 3, 4)]
    const pairs = groupTradesByPair(flatTrades)

    const sorted = sortTradePairsByMember(pairs, 'secondAsc', labelOf, ownerOf, 'anna-owner')

    // Displayed-right is the counterparty either way: Zara (pair 1) and Milo (pair 2).
    // Ascending puts Milo first.
    assert.deepEqual(
      sorted.map((pair) => `${pair.baseA}-${pair.baseB}`),
      ['#B-#C', '#A-#B'],
    )
  })
})

describe('tradeMemberSortLabel', () => {
  it('gives every state its own label', () => {
    for (const sort of TRADE_MEMBER_SORTS) {
      assert.ok(tradeMemberSortLabel(sort).length > 0)
    }
  })
})

describe('parseTradeMemberSort', () => {
  it('accepts every known state', () => {
    for (const sort of TRADE_MEMBER_SORTS) {
      assert.equal(parseTradeMemberSort(sort), sort)
    }
  })

  it('falls back to none for anything unrecognized', () => {
    assert.equal(parseTradeMemberSort(null), 'none')
    assert.equal(parseTradeMemberSort(''), 'none')
    assert.equal(parseTradeMemberSort('bogus'), 'none')
  })
})
