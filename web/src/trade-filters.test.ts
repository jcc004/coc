import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TradePair } from './card-trades.ts'
import {
  UNOWNED,
  UNOWNED_LABEL,
  filterPairsByOwners,
  ownersInPairs,
  tradeFilterSummary,
} from './trade-filters.ts'

/*
 * Tags chosen so the orientation is visible in the fixture: suggestTrades puts the
 * lexicographically smaller tag on the left, so #AAA always precedes #BBB and #ZZZ
 * always trails. Anna owns #AAA and #ZZZ — which means she lands on the *left* of one
 * pair and the *right* of another, which is exactly the situation per-column filtering
 * cannot express.
 */
const OWNERS: Record<string, string | undefined> = {
  '#AAA': 'Anna',
  '#BBB': 'Bert',
  '#MMM': 'Carl',
  '#ZZZ': 'Anna',
  '#QQQ': undefined,
  '#RRR': undefined,
}
const ownerOf = (tag: string) => OWNERS[tag]

const pair = (a: string, b: string): TradePair => ({ baseA: a, baseB: b, trades: [] })

/** Anna is on the left here, and on the right in the next one. */
const ANNA_LEFT = pair('#AAA', '#BBB')
const ANNA_RIGHT = pair('#BBB', '#ZZZ')
const ANNAS_OWN = pair('#AAA', '#ZZZ')
const CARL_BERT = pair('#BBB', '#MMM')
const UNOWNED_SIDE = pair('#AAA', '#QQQ')
/** Two different unowned bases — not the same person, however the sentinel folds them. */
const BOTH_UNOWNED = pair('#QQQ', '#RRR')

const ALL = [ANNA_LEFT, ANNA_RIGHT, ANNAS_OWN, CARL_BERT, UNOWNED_SIDE]
const shape = (pairs: TradePair[]) => pairs.map((p) => p.baseA + '/' + p.baseB)

describe('ownersInPairs', () => {
  it('lists the owners present, alphabetically, ignoring case', () => {
    assert.deepEqual(ownersInPairs([ANNA_LEFT, CARL_BERT], ownerOf), ['Anna', 'Bert', 'Carl'])
  })

  it('offers each owner once however many pairs they are in', () => {
    assert.deepEqual(ownersInPairs(ALL, ownerOf), ['Anna', 'Bert', 'Carl', UNOWNED])
  })

  it('puts unowned last, because it is a category and not a person', () => {
    const owners = ownersInPairs(ALL, ownerOf)
    assert.equal(owners[owners.length - 1], UNOWNED)
  })

  it('omits unowned entirely when every base has an owner', () => {
    assert.ok(!ownersInPairs([ANNA_LEFT, CARL_BERT], ownerOf).includes(UNOWNED))
  })

  it('treats blank owner text as unowned rather than as a name', () => {
    const blank = (tag: string) => (tag === '#AAA' ? '   ' : 'Bert')
    assert.deepEqual(ownersInPairs([ANNA_LEFT], blank), ['Bert', UNOWNED])
  })

  it('answers empty for no pairs, so the control can hide itself', () => {
    assert.deepEqual(ownersInPairs([], ownerOf), [])
  })
})

describe('filterPairsByOwners', () => {
  it('returns everything when neither selection is made', () => {
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, null, null, false)), shape(ALL))
  })

  it('finds an owner on EITHER side from one selection', () => {
    // The heart of it. Anna is on the left of one pair and the right of another; a
    // per-column filter would have shown one of these and hidden the other.
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, 'Anna', null, false)), [
      '#AAA/#BBB',
      '#BBB/#ZZZ',
      '#AAA/#ZZZ',
      '#AAA/#QQQ',
    ])
  })

  it('does not care which selection an owner is put in', () => {
    assert.deepEqual(
      shape(filterPairsByOwners(ALL, ownerOf, 'Anna', null, false)),
      shape(filterPairsByOwners(ALL, ownerOf, null, 'Anna', false)),
    )
  })

  it('finds a pair between two owners whichever column each is in', () => {
    const wanted = ['#AAA/#BBB', '#BBB/#ZZZ']
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, 'Anna', 'Bert', false)), wanted)
    // Reversed selections, identical answer: the property per-column filtering lacks.
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, 'Bert', 'Anna', false)), wanted)
  })

  it('finds trades between two bases owned by the same person', () => {
    // A real query: one account can own several bases, and a swap between your own two
    // is the only one you can complete without waiting for anybody.
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, 'Anna', 'Anna', false)), ['#AAA/#ZZZ'])
  })

  it('does not let one side satisfy the same owner twice', () => {
    // #AAA/#BBB has one Anna side. Asking for two must not match it.
    assert.deepEqual(filterPairsByOwners([ANNA_LEFT], ownerOf, 'Anna', 'Anna', false), [])
  })

  it('matches an unowned base through the sentinel', () => {
    assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, UNOWNED, null, false)), ['#AAA/#QQQ'])
  })

  it('answers empty for an owner in no pair rather than falling back to everything', () => {
    assert.deepEqual(filterPairsByOwners(ALL, ownerOf, 'Nobody', null, false), [])
  })

  it('preserves the order it was given', () => {
    // The table is ordered by the rules that produced it; filtering must not resequence.
    const filtered = filterPairsByOwners(ALL, ownerOf, 'Anna', null, false)
    const expected = ALL.filter((p) => filtered.includes(p))
    assert.deepEqual(shape(filtered), shape(expected))
  })

  it('does not mutate or alias the input', () => {
    const input = [ANNA_LEFT, CARL_BERT]
    filterPairsByOwners(input, ownerOf, null, null, false).length = 0
    assert.equal(input.length, 2)
  })

  describe('otherOnly', () => {
    it('drops a pair where both sides share an owner', () => {
      assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, null, null, true)), [
        '#AAA/#BBB',
        '#BBB/#ZZZ',
        '#BBB/#MMM',
        '#AAA/#QQQ',
      ])
    })

    it('composes with an owner selection', () => {
      // Anna's own-base pair is the one otherOnly exists to remove.
      assert.deepEqual(shape(filterPairsByOwners(ALL, ownerOf, 'Anna', null, true)), [
        '#AAA/#BBB',
        '#BBB/#ZZZ',
        '#AAA/#QQQ',
      ])
    })

    it('leaves two different unowned bases alone', () => {
      // Two bases with no owner set are not thereby the same person.
      assert.deepEqual(
        shape(filterPairsByOwners([BOTH_UNOWNED], ownerOf, null, null, true)),
        shape([BOTH_UNOWNED]),
      )
    })
  })
})

describe('tradeFilterSummary', () => {
  it('says nothing when nothing is filtered', () => {
    assert.equal(tradeFilterSummary(5, 5, null, null, false), null)
  })

  it('names one owner as involvement', () => {
    assert.equal(
      tradeFilterSummary(4, 5, 'Anna', null, false),
      'Showing 4 of 5 pairs, involving Anna.',
    )
  })

  it('names two owners as being between them', () => {
    assert.equal(
      tradeFilterSummary(2, 5, 'Anna', 'Bert', false),
      'Showing 2 of 5 pairs, between Anna and Bert.',
    )
  })

  it('says whose bases when the same owner is picked twice', () => {
    assert.equal(
      tradeFilterSummary(1, 5, 'Anna', 'Anna', false),
      'Showing 1 of 5 pairs, between two bases owned by Anna.',
    )
  })

  it('spells the unowned sentinel as words', () => {
    const line = tradeFilterSummary(1, 5, UNOWNED, null, false)
    assert.ok(line?.includes(UNOWNED_LABEL))
    assert.ok(!line?.includes(UNOWNED), 'the raw sentinel must never reach the screen')
  })

  it('says so plainly when a filter matches nothing', () => {
    assert.equal(
      tradeFilterSummary(0, 5, 'Anna', 'Carl', false),
      'No suggested trades between Anna and Carl.',
    )
  })

  it('gets the singular right', () => {
    assert.equal(tradeFilterSummary(1, 1, 'Anna', null, false), 'Showing 1 of 1 pair, involving Anna.')
  })

  describe('otherOnly', () => {
    it('is said on its own when no owner is picked', () => {
      assert.equal(
        tradeFilterSummary(4, 5, null, null, true),
        "Showing 4 of 5 pairs, excluding a member's own bases.",
      )
    })

    it('is appended after an owner clause', () => {
      assert.equal(
        tradeFilterSummary(3, 5, 'Anna', null, true),
        "Showing 3 of 5 pairs, involving Anna, excluding a member's own bases.",
      )
    })

    it('says so plainly when it alone matches nothing', () => {
      assert.equal(
        tradeFilterSummary(0, 5, null, null, true),
        "No suggested trades excluding a member's own bases.",
      )
    })
  })
})
