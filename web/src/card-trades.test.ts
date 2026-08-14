import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory, CardCategory } from '@coc/shared'
import {
  flattenTradePairs,
  groupTradesByPair,
  resourceKey,
  sortTradesByMutuality,
  spareCapacity,
  suggestTrades,
  type TradeSuggestion,
} from './card-trades.ts'
import { ALL_CARDS, categoryOfCard } from './cards.ts'

/*
 * A five-card toy deck, so every rule can be exercised on its own instead of
 * being buried in sixty real cards. Two Elixir, two Dark Elixir, one Super Troop
 * — enough for a same-category match, a cross-category near-miss, and an id with
 * no category at all.
 */
const CATEGORY: Record<number, CardCategory> = {
  1: 'Elixir',
  2: 'Elixir',
  3: 'Dark Elixir',
  4: 'Dark Elixir',
  5: 'Super Troop',
}

const categoryOf = (id: number): CardCategory | undefined => CATEGORY[id]

function base(tag: string, counts: Record<number, number>): BaseInventory {
  return {
    tag,
    counts: Object.entries(counts).map(([cardId, count]) => ({ cardId: Number(cardId), count })),
  }
}

/** Compact form for assertions: who gives what to whom. */
function shape(trades: TradeSuggestion[]): string[] {
  return trades.map((t) => `${t.baseA}:${t.cardFromA} <-> ${t.baseB}:${t.cardFromB} (${t.category})`)
}

/*
 * The rarity-ordering tests below cannot use the toy deck above. `suggestTrades`
 * gets its rarity map from `cardTotals(bases)`, whose default card list is the
 * real 60-card manifest (`cardsInGridOrder()`), not whatever `categoryOf` a
 * caller happens to pass in — so a made-up id like the toy deck's `5` would just
 * be an id `cardTotals` never sees priced at all, no matter what
 * `categoryOf(5)` claims about it. These tests use real ids and `categoryOfCard`
 * (`cards.ts`) instead, so a base's holdings are also what the rarity engine
 * measures them as.
 */

/**
 * Enough bases holding every real card that `cardTotals`/`cardRarity` never
 * see a card absent (total zero) — without this, ~56 of the 60 real cards
 * would tie at zero and, since zero-total cards alone already fill 9 of the
 * 10 tiers, swallow every card a test actually trades into that same single
 * bottom tier together, leaving no room for a test to tell a "rare" trade
 * from a "common" one.
 *
 * **Every padding base holds at most 1 of any single card — never a spare**
 * (`MIN_TRADEABLE_COUNT` is 2). That is what keeps these bases invisible to
 * `suggestTrades`: a candidate trade needs a spare to give away on *both*
 * sides, and a base with no spares at all can never supply `cardFromA` or
 * `cardFromB`, regardless of what it does or doesn't hold. Older versions of
 * this fixture relied on "the receiver already holds everything" instead —
 * true only while rule 2 required *both* sides of a trade to be missing what
 * they'd receive. `suggestTrades` now also offers a trade only one side
 * needs, and a base holding a real spare of nearly every card (the old
 * `1000 + id` design) turned out to generate exactly that kind of one-sided
 * trade with almost every other base in the suite once the rule relaxed —
 * found by running the suite after the rule changed, not reasoned out in
 * advance. Capping every padding base at "at most 1 of anything" is immune to
 * that regardless of which matching rule is in force: it is not a spare
 * either way.
 *
 * A single count of 1 can't carry both jobs at once for the "common" ids —
 * scarcer than nothing, but a total safely above `rareIds`' own total and
 * above whatever a test's own bases separately add — so the magnitude comes
 * from *how many* padding bases hold that 1, not from the size of the count
 * itself. `rareIds` get their 1 from a single dedicated base, keeping their
 * total at exactly 1 regardless of `COMMON_PADDING`. Every other real card id
 * gets a 1 from each of `COMMON_PADDING` separate bases, summing to a total
 * comfortably larger than any count a test base plausibly holds — the same
 * property the old `1000 + id` gave a single base, here spread across many
 * spare-ineligible ones instead. No test in this file compares one "common"
 * id's rank against another's, so — unlike the old `1000 + id` — this does
 * not need to spread non-rare ids apart from each other, only from the
 * `rareIds` floor.
 *
 * 20 is not load-bearing on its own — any value comfortably above the largest
 * count a test base in this file actually holds (10, at most) keeps a
 * non-rare id's total ahead of a rare id's, since both add whatever their own
 * test bases contribute on top of this floor.
 */
const COMMON_PADDING = 20

function paddingBases(rareIds: readonly number[]): BaseInventory[] {
  const rare = new Set(rareIds)
  const commonIds = ALL_CARDS.filter((card) => !rare.has(card.id)).map((card) => card.id)

  const rareBase = base('#PAD-rare', Object.fromEntries(rareIds.map((id) => [id, 1])))
  const commonBases = Array.from({ length: COMMON_PADDING }, (_, index) =>
    base(`#PAD-common-${index}`, Object.fromEntries(commonIds.map((id) => [id, 1]))),
  )
  return [rareBase, ...commonBases]
}

describe('suggestTrades — the core swap', () => {
  it('pairs two bases that each hold a spare the other lacks', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })

  it('treats a count of 2 as tradeable and a count of 1 as not', () => {
    const tradeable = suggestTrades([base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 })], categoryOf)
    assert.equal(tradeable.length, 1, 'two copies is a spare')

    // The rule people get wrong by hand: one copy is the copy you keep.
    const lastCopy = suggestTrades([base('#AAA', { 1: 1 }), base('#BBB', { 2: 2 })], categoryOf)
    assert.deepEqual(lastCopy, [], 'a base must never trade away its last copy')

    const neither = suggestTrades([base('#AAA', { 1: 1 }), base('#BBB', { 2: 1 })], categoryOf)
    assert.deepEqual(neither, [])
  })

  it('counts above two are still just spares, and still trade', () => {
    const trades = suggestTrades([base('#AAA', { 1: 10 }), base('#BBB', { 2: 3 })], categoryOf)
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })
})

describe('suggestTrades — you may only receive what you do not hold', () => {
  it('refuses when the receiver already holds one of the card', () => {
    // B holds a single Barbarian, so a second is worthless to it.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 2: 2 }), base('#BBB', { 1: 1, 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(trades, [])
  })

  it('refuses when the receiver holds a spare of the same card', () => {
    const trades = suggestTrades([base('#AAA', { 1: 2 }), base('#BBB', { 1: 2 })], categoryOf)
    assert.deepEqual(trades, [], 'both holding spares of the same card is not a trade')
  })

  it('never proposes a card for itself', () => {
    // X === Y would need the shared card to be both a spare (2+) and a need
    // (zero) for the same base at once — still self-contradictory even with
    // rule 2 relaxed to "at least one side needs it", since whichever base is
    // giving the card away must hold 2+ of it (rule 1). Unreachable, asserted
    // rather than assumed.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 2: 2, 3: 2 }), base('#BBB', { 4: 2, 5: 2 })],
      categoryOf,
    )
    for (const trade of trades) assert.notEqual(trade.cardFromA, trade.cardFromB)
  })

  it('lets a one-sided surplus produce nothing when the other base has nothing to give', () => {
    // A has spares B lacks, but B has nothing at all — a trade still needs
    // both bases to have something to give, even when only one needs to gain.
    const trades = suggestTrades([base('#AAA', { 1: 3, 2: 4 }), base('#BBB', {})], categoryOf)
    assert.deepEqual(trades, [])
  })
})

describe('suggestTrades — one-sided trades, mutual: false', () => {
  it('offers a swap the proposer needs even when the acceptor already owns what it would receive', () => {
    // #AAA is missing 2 and spares 1; #BBB already holds a 1 (not a spare, but
    // owns one) and spares 2. #BBB doesn't gain a new card, but #AAA does.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2 }), base('#BBB', { 1: 1, 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
    assert.equal(trades[0]?.mutual, false)
  })

  it('offers the mirror image just as readily — either side may be the one already holding its card', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 2: 1 }), base('#BBB', { 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
    assert.equal(trades[0]?.mutual, false)
  })

  it('still refuses when neither side would gain a new card', () => {
    // Both bases already hold one of the other's spare — nobody gains anything.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 2: 1 }), base('#BBB', { 1: 1, 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(trades, [])
  })

  it('marks the ordinary two-sided-need swap mutual: true', () => {
    const trades = suggestTrades([base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 })], categoryOf)
    assert.equal(trades[0]?.mutual, true)
  })

  it('stays pure rarity order on its own — mutual-ness does not affect suggestTrades’ own sort', () => {
    // #YYY/#ZZZ swap the clan's rarest cards (1, 2) but one-sided — #ZZZ
    // already owns a 1. #AAA/#BBB swap only common cards (58, 59) but both
    // sides gain a new one. suggestTrades ranks by rarity alone, so the rare
    // one-sided trade still sorts first — `trade-priority.ts`'s `highestValue`
    // mode depends on this staying true. `sortTradesByMutuality` (below) is
    // the layer that reorders mutual ahead, applied by callers that want it.
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2]),
        base('#AAA', { 58: 2 }),
        base('#BBB', { 59: 2 }),
        base('#YYY', { 1: 2 }),
        base('#ZZZ', { 1: 1, 2: 2 }),
      ],
      categoryOfCard,
    )

    assert.deepEqual(shape(trades), [
      '#YYY:1 <-> #ZZZ:2 (Elixir)',
      '#AAA:58 <-> #BBB:59 (Super Troop)',
    ])
    assert.equal(trades[0]?.mutual, false)
    assert.equal(trades[1]?.mutual, true)
  })
})

describe('sortTradesByMutuality', () => {
  it('moves every mutual trade ahead of every one-sided one, regardless of rarity', () => {
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2]),
        base('#AAA', { 58: 2 }),
        base('#BBB', { 59: 2 }),
        base('#YYY', { 1: 2 }),
        base('#ZZZ', { 1: 1, 2: 2 }),
      ],
      categoryOfCard,
    )
    // Confirms the input actually mixes the two groups, so the reorder below
    // is exercising something — see the previous test for why this is the order.
    assert.deepEqual(
      trades.map((t) => t.mutual),
      [false, true],
    )

    const sorted = sortTradesByMutuality(trades)
    assert.deepEqual(shape(sorted), [
      '#AAA:58 <-> #BBB:59 (Super Troop)',
      '#YYY:1 <-> #ZZZ:2 (Elixir)',
    ])
    assert.deepEqual(
      sorted.map((t) => t.mutual),
      [true, false],
    )
  })

  it('is a stable sort — keeps each group in whatever order it arrived in', () => {
    const trade = (
      baseA: string,
      baseB: string,
      cardFromA: number,
      cardFromB: number,
      mutual: boolean,
    ): TradeSuggestion => ({ baseA, baseB, cardFromA, cardFromB, category: 'Elixir', mutual })
    const trades = [
      trade('#AAA', '#BBB', 1, 2, true),
      trade('#CCC', '#DDD', 3, 4, false),
      trade('#EEE', '#FFF', 5, 6, true),
      trade('#GGG', '#HHH', 7, 8, false),
    ]
    assert.deepEqual(shape(sortTradesByMutuality(trades)), [
      '#AAA:1 <-> #BBB:2 (Elixir)',
      '#EEE:5 <-> #FFF:6 (Elixir)',
      '#CCC:3 <-> #DDD:4 (Elixir)',
      '#GGG:7 <-> #HHH:8 (Elixir)',
    ])
  })

  it('returns nothing for nothing', () => {
    assert.deepEqual(sortTradesByMutuality([]), [])
  })
})

describe('suggestTrades — categories', () => {
  it('refuses a cross-category pair however well the counts line up', () => {
    const trades = suggestTrades([base('#AAA', { 1: 2 }), base('#BBB', { 3: 2 })], categoryOf)
    assert.deepEqual(trades, [], 'Elixir does not swap for Dark Elixir')
  })

  it('finds the same-category pair and ignores the cross-category one beside it', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 5: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })

  it('drops a card id it cannot categorize rather than pairing it arbitrarily', () => {
    const trades = suggestTrades(
      [base('#AAA', { 99: 2 }), base('#BBB', { 98: 2 })],
      categoryOf,
    )
    assert.deepEqual(trades, [])
  })

  it('still trades the known card when an unknown one sits alongside it', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 99: 2 }), base('#BBB', { 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })
})

describe('suggestTrades — a base never trades with itself', () => {
  it('yields nothing for a single base, however many spares it holds', () => {
    const trades = suggestTrades([base('#AAA', { 1: 3, 2: 4, 3: 2, 4: 2 })], categoryOf)
    assert.deepEqual(trades, [])
  })

  it('yields nothing when the same tag appears twice in the input', () => {
    // Two rows for one base is a caller bug, not a trading partner.
    const trades = suggestTrades([base('#AAA', { 1: 2 }), base('#AAA', { 2: 2 })], categoryOf)
    assert.deepEqual(trades, [])
  })
})

describe('suggestTrades — mirrors are reported once', () => {
  it('does not report A↔B and B↔A as two trades', () => {
    const trades = suggestTrades([base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 })], categoryOf)
    assert.equal(trades.length, 1)
  })

  it('gives the identical answer whichever order the bases are passed in', () => {
    const forward = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 4: 2 })],
      categoryOf,
    )
    const backward = suggestTrades(
      [base('#BBB', { 2: 2, 4: 2 }), base('#AAA', { 1: 2, 3: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(backward), shape(forward))
  })

  it('always orients a suggestion with the smaller tag as baseA', () => {
    const trades = suggestTrades([base('#ZZZ', { 1: 2 }), base('#AAA', { 2: 2 })], categoryOf)
    assert.deepEqual(shape(trades), ['#AAA:2 <-> #ZZZ:1 (Elixir)'])
  })
})

describe('suggestTrades — degenerate inputs', () => {
  it('yields nothing for an empty set of bases', () => {
    assert.deepEqual(suggestTrades([], categoryOf), [])
  })

  it('yields nothing when every base is empty', () => {
    assert.deepEqual(
      suggestTrades([base('#AAA', {}), base('#BBB', {}), base('#CCC', {})], categoryOf),
      [],
    )
  })

  it('yields nothing when a base already holds every card', () => {
    // Nothing can be given to it, so it cannot be half of a swap.
    const complete = base('#AAA', { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 })
    const partner = base('#BBB', { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 })
    assert.deepEqual(suggestTrades([complete, partner], categoryOf), [])
  })

  it('yields nothing when both bases hold everything, even against a third', () => {
    const everything = { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 }
    const trades = suggestTrades(
      [base('#AAA', everything), base('#BBB', everything), base('#CCC', everything)],
      categoryOf,
    )
    assert.deepEqual(trades, [])
  })

  it('ignores a zero count, which means the base does not hold the card', () => {
    const giver = base('#AAA', { 1: 2 })
    // A stray 0 must not read as a distinct state; B still lacks card 1.
    const receiver = base('#BBB', { 1: 0, 2: 2 })
    assert.deepEqual(shape(suggestTrades([giver, receiver], categoryOf)), [
      '#AAA:1 <-> #BBB:2 (Elixir)',
    ])
  })

  it('ignores a negative count the same way', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2 }), base('#BBB', { 1: -3, 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })

  it('ignores a non-integer card id', () => {
    const odd: BaseInventory = { tag: '#AAA', counts: [{ cardId: 1.5, count: 4 }] }
    assert.deepEqual(suggestTrades([odd, base('#BBB', { 2: 2 })], categoryOf), [])
  })

  it('keeps the larger of two rows that repeat one card id', () => {
    // A repeated id is a malformed payload; the larger reading is the one that
    // matches what was on the screen the number was copied from.
    const repeated: BaseInventory = {
      tag: '#AAA',
      counts: [
        { cardId: 1, count: 1 },
        { cardId: 1, count: 2 },
      ],
    }
    assert.deepEqual(shape(suggestTrades([repeated, base('#BBB', { 2: 2 })], categoryOf)), [
      '#AAA:1 <-> #BBB:2 (Elixir)',
    ])
  })
})

describe('suggestTrades — several bases and several options', () => {
  it('reports every distinct swap a pair can make', () => {
    // A spares 1 and 3; B spares 2 and 4. Both categories line up, so two swaps.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 4: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), [
      '#AAA:1 <-> #BBB:2 (Elixir)',
      '#AAA:3 <-> #BBB:4 (Dark Elixir)',
    ])
  })

  it('offers one spare to more than one partner, since these are options', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 2: 2 })],
      categoryOf,
    )
    assert.deepEqual(shape(trades), [
      '#AAA:1 <-> #BBB:2 (Elixir)',
      '#AAA:1 <-> #CCC:2 (Elixir)',
    ])
  })

  it('considers every pair in a group of three, once each', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2 }), base('#BBB', { 2: 2 }), base('#CCC', { 3: 2, 4: 2 })],
      categoryOf,
    )
    // C's two Dark Elixir spares match nobody; A and B match each other.
    assert.deepEqual(shape(trades), ['#AAA:1 <-> #BBB:2 (Elixir)'])
  })

  it('sorts deterministically by base then card', () => {
    const trades = suggestTrades(
      [
        base('#CCC', { 1: 2, 3: 2 }),
        base('#AAA', { 2: 2, 4: 2 }),
        base('#BBB', { 2: 2, 4: 2 }),
      ],
      categoryOf,
    )
    assert.deepEqual(shape(trades), [
      '#AAA:2 <-> #CCC:1 (Elixir)',
      '#AAA:4 <-> #CCC:3 (Dark Elixir)',
      '#BBB:2 <-> #CCC:1 (Elixir)',
      '#BBB:4 <-> #CCC:3 (Dark Elixir)',
    ])
  })
})

describe('suggestTrades — ordered by rarity value', () => {
  it('sorts a trade moving a rare card ahead of one moving only common cards', () => {
    // #AAA/#BBB swap cards padded up to the clan's most-common tier; #YYY/#ZZZ
    // swap cards left near the padding floor, the clan's rarest tier. Alphabetically
    // AAA/BBB would sort first ('A' < 'Y'); rarity should override that.
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2]),
        base('#AAA', { 58: 2 }), // Super Troop — common: sits on the COMMON_PADDING floor
        base('#BBB', { 59: 2 }), // Super Troop partner
        base('#YYY', { 1: 2 }), // Elixir — rare: in `rareIds`, so its total is just this base's count
        base('#ZZZ', { 2: 2 }), // Elixir partner
      ],
      categoryOfCard,
    )

    assert.deepEqual(shape(trades), [
      '#YYY:1 <-> #ZZZ:2 (Elixir)',
      '#AAA:58 <-> #BBB:59 (Super Troop)',
    ])
  })

  it('still breaks a tie on rarity value by tag, when two different pairs tie', () => {
    // Cards 1-4 are all in `rareIds`, so all four tie at the same low total —
    // these two trades tie on value, and the old alphabetical-by-tag order is
    // what has to decide it.
    //
    // #EEE/#FFF and #CCC/#DDD also each hold a single (non-spare) copy of the
    // *other* pair's cards. That is not padding noise, it is what keeps the two
    // pairs from cross-trading with each other: without it, #EEE (spare 1) and
    // #CCC (spare 3, category Elixir like 1) would satisfy rule 2 for each
    // other too, and every one of the four bases would trade with every other
    // one instead of just its intended partner.
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2, 3, 4]),
        base('#EEE', { 1: 2, 3: 1, 4: 1 }),
        base('#FFF', { 2: 2, 3: 1, 4: 1 }),
        base('#CCC', { 3: 2, 1: 1, 2: 1 }),
        base('#DDD', { 4: 2, 1: 1, 2: 1 }),
      ],
      categoryOfCard,
    )

    assert.deepEqual(shape(trades), [
      '#CCC:3 <-> #DDD:4 (Elixir)',
      '#EEE:1 <-> #FFF:2 (Elixir)',
    ])
  })

  it('still breaks a tie on rarity value by card id, for two options on one pair', () => {
    // Same reasoning as above, but both options are between the same two bases,
    // so it is the cardFromA/cardFromB tiebreak doing the work this time. Cards
    // 1 and 2 are Elixir, 20 and 21 are Dark Elixir, so category (rule 3) keeps
    // this to exactly the two intended combinations rather than all four
    // cross-category ones.
    const trades = suggestTrades(
      [...paddingBases([1, 2, 20, 21]), base('#GGG', { 1: 2, 20: 2 }), base('#HHH', { 2: 2, 21: 2 })],
      categoryOfCard,
    )

    assert.deepEqual(shape(trades), [
      '#GGG:1 <-> #HHH:2 (Elixir)',
      '#GGG:20 <-> #HHH:21 (Dark Elixir)',
    ])
  })
})

describe('spareCapacity', () => {
  it('is count - 1, keeping the last copy, for every card held two or more of', () => {
    const capacity = spareCapacity([base('#AAA', { 1: 2, 2: 5 })])
    assert.equal(capacity.get(resourceKey('#AAA', 1)), 1)
    assert.equal(capacity.get(resourceKey('#AAA', 2)), 4)
  })

  it('omits a card held once, or not at all — never a capacity of zero', () => {
    // A capacity of 0 would be indistinguishable from "never held this card" to a
    // caller reading the map with `?? 0`; leaving it absent for both is one
    // representation for "cannot give this away", not two.
    const capacity = spareCapacity([base('#AAA', { 1: 1, 2: 0 })])
    assert.equal(capacity.size, 0)
  })

  it('reads a malformed row the same way suggestTrades does', () => {
    // Duplicated id keeps the larger count; negative and non-integer entries drop.
    const malformed: BaseInventory = {
      tag: '#AAA',
      counts: [
        { cardId: 1, count: 1 },
        { cardId: 1, count: 3 },
        { cardId: 2, count: -5 },
        { cardId: 1.5, count: 9 },
      ],
    }
    const capacity = spareCapacity([malformed])
    assert.equal(capacity.get(resourceKey('#AAA', 1)), 2)
    assert.equal(capacity.size, 1)
  })

  it('keys by base and card, so two bases sharing a card id get separate entries', () => {
    const capacity = spareCapacity([base('#AAA', { 1: 3 }), base('#BBB', { 1: 2 })])
    assert.equal(capacity.get(resourceKey('#AAA', 1)), 2)
    assert.equal(capacity.get(resourceKey('#BBB', 1)), 1)
  })

  it('is empty for no bases, or bases with nothing spare', () => {
    assert.equal(spareCapacity([]).size, 0)
    assert.equal(spareCapacity([base('#AAA', {})]).size, 0)
  })
})

describe('groupTradesByPair', () => {
  it('orders pairs by their best trade’s value, not alphabetically', () => {
    // Same rare-vs-common setup as the suggestTrades rarity test above: #AAA/#BBB
    // sorts first alphabetically but #YYY/#ZZZ holds the rarer card, so the pair
    // list should come out with #YYY/#ZZZ first too.
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2]),
        base('#AAA', { 58: 2 }),
        base('#BBB', { 59: 2 }),
        base('#YYY', { 1: 2 }),
        base('#ZZZ', { 2: 2 }),
      ],
      categoryOfCard,
    )
    const pairs = groupTradesByPair(trades)

    assert.deepEqual(
      pairs.map((pair) => [pair.baseA, pair.baseB]),
      [
        ['#YYY', '#ZZZ'],
        ['#AAA', '#BBB'],
      ],
    )
  })

  it('collects a pair’s options under one heading, in order', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 4: 2 }), base('#CCC', { 2: 2 })],
      categoryOf,
    )
    const pairs = groupTradesByPair(trades)

    assert.deepEqual(
      pairs.map((pair) => [pair.baseA, pair.baseB, pair.trades.length]),
      [
        ['#AAA', '#BBB', 2],
        ['#AAA', '#CCC', 1],
      ],
    )
  })

  it('returns nothing for nothing', () => {
    assert.deepEqual(groupTradesByPair([]), [])
  })
})

describe('flattenTradePairs', () => {
  it('emits one row per option, marking only the first of each pair as pairStart', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 4: 2 }), base('#CCC', { 2: 2 })],
      categoryOf,
    )
    const pairs = groupTradesByPair(trades)
    const rows = flattenTradePairs(pairs)

    assert.deepEqual(
      rows.map((row) => [row.pair.baseA, row.pair.baseB, row.trade.cardFromA, row.pairStart]),
      [
        ['#AAA', '#BBB', 1, true],
        ['#AAA', '#BBB', 3, false],
        ['#AAA', '#CCC', 1, true],
      ],
    )
  })

  it('preserves pair order and each pair’s own trade order', () => {
    const trades = suggestTrades(
      [
        ...paddingBases([1, 2]),
        base('#AAA', { 58: 2 }),
        base('#BBB', { 59: 2 }),
        base('#YYY', { 1: 2 }),
        base('#ZZZ', { 2: 2 }),
      ],
      categoryOfCard,
    )
    const pairs = groupTradesByPair(trades)
    const rows = flattenTradePairs(pairs)

    assert.deepEqual(
      rows.map((row) => [row.pair.baseA, row.pair.baseB]),
      [
        ['#YYY', '#ZZZ'],
        ['#AAA', '#BBB'],
      ],
    )
  })

  it('counts one row total per option across every pair, not one per pair', () => {
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 3: 2 }), base('#BBB', { 2: 2, 4: 2 }), base('#CCC', { 2: 2 })],
      categoryOf,
    )
    const pairs = groupTradesByPair(trades)
    // Two pairs, but the first has two options — three rows in total, the fact
    // this whole change exists to make the row-limit selector honor.
    assert.equal(pairs.length, 2)
    assert.equal(flattenTradePairs(pairs).length, 3)
  })

  it('returns nothing for nothing', () => {
    assert.deepEqual(flattenTradePairs([]), [])
  })
})
