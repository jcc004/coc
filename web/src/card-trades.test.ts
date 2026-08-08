import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BaseInventory, CardCategory } from '@coc/shared'
import { groupTradesByPair, suggestTrades, type TradeSuggestion } from './card-trades.ts'
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
 * One base holding every real card, so `cardTotals`/`cardRarity` never see a
 * card absent (total zero) — without this, ~56 of the 60 real cards would tie
 * at zero and, since zero-total cards alone already fill 9 of the 10 tiers,
 * swallow every card a test actually trades into that same single bottom tier
 * together, leaving no room for a test to tell a "rare" trade from a "common"
 * one.
 *
 * `rareIds` get a padding count of 1 — enough to make this base immune (see
 * below) but too small to be a spare, so a test's own bases decide their real
 * total via however many copies *they* hold. Every other id gets `1000 + id`:
 * larger than any count a test base plausibly holds, and spread out by id so
 * ties among them are impossible. That guarantees `rareIds` sort as the
 * smallest totals in the whole 60-card set — tier 1, the rarest, however many
 * of them there are (as long as it's within the tier's 6-card width) — while
 * anything a test wants to read as "common" needs no special-casing at all:
 * left out of `rareIds`, its `1000 + id` floor already puts it at the
 * opposite end.
 *
 * This base can never itself appear in a suggestion, regardless of which ids
 * are in `rareIds`: holding a *positive* count of literally every id (1 or
 * `1000 + id`, never 0) means it can never satisfy rule 2 ("the receiver must
 * hold zero") on either side of any pair, for any card. So it inflates the
 * totals `cardRarity` sees without adding any noise to the trade list itself.
 */
function paddingBase(rareIds: readonly number[]): BaseInventory {
  const rare = new Set(rareIds)
  const counts = Object.fromEntries(
    ALL_CARDS.map((card) => [card.id, rare.has(card.id) ? 1 : 1000 + card.id]),
  )
  return base('#PAD', counts)
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
    // The only way X === Y would need A to hold 2+ of X while B holds none and
    // 2+ of X at once, so it is unreachable — asserted rather than assumed.
    const trades = suggestTrades(
      [base('#AAA', { 1: 2, 2: 2, 3: 2 }), base('#BBB', { 4: 2, 5: 2 })],
      categoryOf,
    )
    for (const trade of trades) assert.notEqual(trade.cardFromA, trade.cardFromB)
  })

  it('lets a one-sided surplus produce nothing, since a trade needs both halves', () => {
    // A has spares B lacks, but B has nothing A can receive.
    const trades = suggestTrades([base('#AAA', { 1: 3, 2: 4 }), base('#BBB', {})], categoryOf)
    assert.deepEqual(trades, [])
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
        paddingBase([1, 2]),
        base('#AAA', { 58: 2 }), // Super Troop — common: no special padding, so its 1000+id floor stands
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
        paddingBase([1, 2, 3, 4]),
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
      [paddingBase([1, 2, 20, 21]), base('#GGG', { 1: 2, 20: 2 }), base('#HHH', { 2: 2, 21: 2 })],
      categoryOfCard,
    )

    assert.deepEqual(shape(trades), [
      '#GGG:1 <-> #HHH:2 (Elixir)',
      '#GGG:20 <-> #HHH:21 (Dark Elixir)',
    ])
  })
})

describe('groupTradesByPair', () => {
  it('orders pairs by their best trade’s value, not alphabetically', () => {
    // Same rare-vs-common setup as the suggestTrades rarity test above: #AAA/#BBB
    // sorts first alphabetically but #YYY/#ZZZ holds the rarer card, so the pair
    // list should come out with #YYY/#ZZZ first too.
    const trades = suggestTrades(
      [
        paddingBase([1, 2]),
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
