import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_CHAT_LENGTH, type BaseInventory, type CardCategory } from '@coc/shared'
import {
  groupTradesByPair,
  suggestTrades,
  tradeProposalMessage,
  type TradeSuggestion,
} from './card-trades.ts'

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

  it('drops a card id it cannot categorise rather than pairing it arbitrarily', () => {
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

describe('tradeProposalMessage', () => {
  const trade: TradeSuggestion = {
    baseA: '#AAA',
    baseB: '#BBB',
    cardFromA: 1,
    cardFromB: 2,
    category: 'Elixir',
  }
  const NAMES: Record<number, string> = { 1: 'Barbarian', 2: 'Archer' }
  const cardName = (id: number) => NAMES[id]
  const OWNERS: Record<string, string> = { '#AAA': 'Jared', '#BBB': 'Sam' }
  const owner = (tag: string) => OWNERS[tag]

  it('names both bases, both owners and both cards', () => {
    assert.equal(
      tradeProposalMessage(trade, { cardName, owner }),
      'Card trade (Elixir): #AAA (Jared) gives Barbarian <-> #BBB (Sam) gives Archer.',
    )
  })

  it('falls back to the bare tag when a base has no owner', () => {
    assert.equal(
      tradeProposalMessage(trade, { cardName, owner: (tag) => (tag === '#AAA' ? 'Jared' : '') }),
      'Card trade (Elixir): #AAA (Jared) gives Barbarian <-> #BBB gives Archer.',
    )
  })

  it('works with no owner resolver at all', () => {
    assert.equal(
      tradeProposalMessage(trade, { cardName }),
      'Card trade (Elixir): #AAA gives Barbarian <-> #BBB gives Archer.',
    )
  })

  it('names an unknown card by its id rather than leaving a gap', () => {
    assert.equal(
      tradeProposalMessage({ ...trade, cardFromB: 99 }, { cardName }),
      'Card trade (Elixir): #AAA gives Barbarian <-> #BBB gives card 99.',
    )
  })

  it('drops the owner names before it truncates, when they will not fit', () => {
    // Owner names are unbounded free text, so this is a real case and not a
    // theoretical one — an over-long body is a 400 from the chat route.
    const long = (tag: string) => (tag === '#AAA' ? 'J'.repeat(200) : 'S'.repeat(200))
    const message = tradeProposalMessage(trade, { cardName, owner: long, maxLength: 120 })

    assert.ok(message.length <= 120)
    assert.equal(message, 'Card trade (Elixir): #AAA gives Barbarian <-> #BBB gives Archer.')
    assert.ok(!message.includes('JJJ'), 'the giant owner name must be gone')
  })

  it('keeps the owners when they do fit', () => {
    const message = tradeProposalMessage(trade, { cardName, owner, maxLength: 120 })
    assert.ok(message.includes('(Jared)') && message.includes('(Sam)'))
  })

  it('truncates only as a last resort, still naming the first base', () => {
    const message = tradeProposalMessage(trade, { cardName, owner, maxLength: 40 })
    assert.ok(message.length <= 40, `got ${message.length}`)
    assert.ok(message.endsWith('…'))
    assert.ok(message.startsWith('Card trade (Elixir): #AAA'))
  })

  it('never exceeds the limit it was given', () => {
    for (const maxLength of [20, 30, 64, 120, 500]) {
      const message = tradeProposalMessage(
        { ...trade, category: 'Dark Elixir' },
        { cardName, owner, maxLength },
      )
      assert.ok(message.length <= maxLength, `${maxLength}: got ${message.length}`)
    }
  })

  it('fits the chat limit by default, with the longest realistic names', () => {
    const message = tradeProposalMessage(trade, {
      cardName: () => 'Super Wall Breaker',
      owner: () => 'Somebody With A Fairly Long Name',
    })
    assert.ok(message.length <= MAX_CHAT_LENGTH)
    assert.ok(message.includes('Super Wall Breaker'))
  })
})

describe('groupTradesByPair', () => {
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
