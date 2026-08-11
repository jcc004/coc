import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OwnerRecord, SessionUser, TradeRecord } from '@coc/shared'
import {
  findPendingSwap,
  pendingCount,
  sidesOfTrade,
  sortTrades,
  tradeProposeAccess,
  tradeResolveAccess,
  tradeRowId,
  tradesInvolving,
  tradeUndoAccess,
  type TradeSides,
} from './trade-tracker.ts'

/* ---------- fixtures ---------- */

const ANNA = 1
const BERT = 2
const CARL = 3

const member = (id: number): Pick<SessionUser, 'id' | 'role'> => ({ id, role: 'user' })
const admin = (id: number): Pick<SessionUser, 'id' | 'role'> => ({ id, role: 'admin' })

/** A side held by an account. */
const held = (tag: string, userId: number, label: string) => ({
  tag,
  ownerUserId: userId,
  ownerLabel: label,
})
/** A side carrying only legacy free text — a note about a person, not a permission. */
const labeled = (tag: string, label: string) => ({
  tag,
  ownerUserId: null,
  ownerLabel: label,
})
const unowned = (tag: string) => ({ tag, ownerUserId: null, ownerLabel: null })

const sides = (a: TradeSides['baseA'], b: TradeSides['baseB']): TradeSides => ({
  baseA: a,
  baseB: b,
})

const ANNA_AND_BERT = sides(held('#AAA', ANNA, 'Anna'), held('#BBB', BERT, 'Bert'))

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 1,
    season: '2026-08',
    baseA: '#AAA',
    baseB: '#BBB',
    cardFromA: 3,
    cardFromB: 7,
    category: 'Elixir',
    status: 'pending',
    proposedByUserId: ANNA,
    proposedBy: 'Anna',
    proposedAt: '2026-08-02T10:00:00.000Z',
    resolvedByUserId: null,
    resolvedBy: null,
    resolvedAt: null,
    undoneByUserId: null,
    undoneBy: null,
    undoneAt: null,
    ...over,
  }
}

/* ---------- sidesOfTrade ---------- */

describe('sidesOfTrade', () => {
  const owners: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Anna', ownerUserId: ANNA },
    { tag: '#BBB', owner: 'legacy name', ownerUserId: null },
  ]

  it('resolves each tag against the owner list', () => {
    const resolved = sidesOfTrade(trade(), owners)
    assert.deepEqual(resolved.baseA, held('#AAA', ANNA, 'Anna'))
    assert.deepEqual(resolved.baseB, labeled('#BBB', 'legacy name'))
  })

  it('reports a tag with no owner row as unowned rather than throwing', () => {
    const resolved = sidesOfTrade(trade({ baseB: '#ZZZ' }), owners)
    assert.deepEqual(resolved.baseB, unowned('#ZZZ'))
  })

  it('keeps the tag on the side, so a refusal can name an unowned base', () => {
    const resolved = sidesOfTrade(trade({ baseA: '#QQQ', baseB: '#RRR' }), [])
    assert.equal(resolved.baseA.tag, '#QQQ')
    assert.equal(resolved.baseB.tag, '#RRR')
  })
})

/* ---------- who may propose ---------- */

describe('tradeProposeAccess', () => {
  it('lets the owner of either side propose', () => {
    assert.equal(tradeProposeAccess(member(ANNA), ANNA_AND_BERT).allowed, true)
    assert.equal(tradeProposeAccess(member(BERT), ANNA_AND_BERT).allowed, true)
  })

  it('refuses a member who owns neither side', () => {
    const decision = tradeProposeAccess(member(CARL), ANNA_AND_BERT)
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false && decision.refusal, 'notAParty')
  })

  it('names both owners in the refusal, so it says who can', () => {
    const decision = tradeProposeAccess(member(CARL), ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.match(decision.message, /Anna/)
    assert.match(decision.message, /Bert/)
  })

  it('lets an admin propose a swap between two other people', () => {
    assert.equal(tradeProposeAccess(admin(CARL), ANNA_AND_BERT).allowed, true)
  })

  it('grants a legacy text label nothing, whoever the text names', () => {
    // The same rule as `cardEntryAccess`: a label is a note, not a permission. Only
    // an admin can act until the base is linked to an account.
    const withLabel = sides(labeled('#AAA', 'Anna'), held('#BBB', BERT, 'Bert'))
    const decision = tradeProposeAccess(member(ANNA), withLabel)
    assert.equal(decision.allowed, false, 'the account named by the label is still not a party')
    assert.equal(tradeProposeAccess(member(BERT), withLabel).allowed, true)
    assert.equal(tradeProposeAccess(admin(CARL), withLabel).allowed, true)
  })

  it('describes an unowned side by its tag, having no name to give', () => {
    const decision = tradeProposeAccess(member(CARL), sides(unowned('#AAA'), unowned('#BBB')))
    assert.ok(decision.allowed === false)
    assert.match(decision.message, /#AAA/)
    assert.match(decision.message, /#BBB/)
  })
})

/* ---------- who may resolve ---------- */

describe('tradeResolveAccess', () => {
  it('lets either party resolve a pending trade — not just the proposer', () => {
    // The user's rule verbatim: either party to the trade can mark it complete or
    // declined. Bert did not propose this one.
    assert.equal(tradeResolveAccess(member(BERT), trade(), ANNA_AND_BERT).allowed, true)
    assert.equal(tradeResolveAccess(member(ANNA), trade(), ANNA_AND_BERT).allowed, true)
  })

  it('refuses a stranger, and says who can act rather than what the state is', () => {
    const decision = tradeResolveAccess(member(CARL), trade(), ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'notAParty')
    assert.match(decision.message, /complete or decline it/)
  })

  it('refuses a second resolution, so completing cannot move the cards twice', () => {
    const done = trade({ status: 'complete', resolvedBy: 'Bert', resolvedAt: '2026-08-02T11:00:00.000Z' })
    const decision = tradeResolveAccess(member(ANNA), done, ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'alreadyResolved')
    assert.match(decision.message, /Bert/)
  })

  it('refuses a second resolution of a declined trade too', () => {
    // Harmless to the counts, but it would rewrite somebody else's audit stamp.
    const declined = trade({ status: 'declined', resolvedBy: 'Anna', resolvedAt: '2026-08-02T11:00:00.000Z' })
    assert.equal(tradeResolveAccess(member(BERT), declined, ANNA_AND_BERT).allowed, false)
  })

  it('checks who before what state, matching the server', () => {
    // A stranger looking at a resolved trade hears "not yours", which is the more
    // useful of the two refusals — and the same one the server gives.
    const done = trade({ status: 'complete', resolvedBy: 'Bert' })
    const decision = tradeResolveAccess(member(CARL), done, ANNA_AND_BERT)
    assert.equal(decision.allowed === false && decision.refusal, 'notAParty')
  })

  it('says so plainly when the resolver’s account has since been deleted', () => {
    const orphaned = trade({ status: 'complete', resolvedBy: null, resolvedByUserId: null })
    const decision = tradeResolveAccess(member(ANNA), orphaned, ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.match(decision.message, /account has since been deleted/)
  })
})

/* ---------- who may undo ---------- */

describe('tradeUndoAccess', () => {
  it('lets either party undo a complete trade, not just an admin', () => {
    // The rule this used to refuse on purpose: an owner of either base may now
    // undo a trade they are a party to, the same as completing or declining it.
    for (const id of [ANNA, BERT]) {
      const decision = tradeUndoAccess(member(id), trade({ status: 'complete' }), ANNA_AND_BERT)
      assert.equal(decision.allowed, true, `${id} should be allowed to undo`)
    }
  })

  it('lets an admin undo a complete trade between two other people', () => {
    assert.equal(
      tradeUndoAccess(admin(CARL), trade({ status: 'complete' }), ANNA_AND_BERT).allowed,
      true,
    )
  })

  it('refuses a member who owns neither side, and names who can', () => {
    const decision = tradeUndoAccess(member(CARL), trade({ status: 'complete' }), ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'notAParty')
    assert.match(decision.message, /Anna/)
    assert.match(decision.message, /Bert/)
    assert.match(decision.message, /undo it/)
  })

  it('refuses an admin while the trade is still pending', () => {
    const decision = tradeUndoAccess(admin(CARL), trade({ status: 'pending' }), ANNA_AND_BERT)
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'notComplete')
    assert.match(decision.message, /still pending/)
  })

  it('refuses a party on a declined trade', () => {
    const decision = tradeUndoAccess(
      member(ANNA),
      trade({ status: 'declined', resolvedBy: 'Anna', resolvedAt: '2026-08-02T11:00:00.000Z' }),
      ANNA_AND_BERT,
    )
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'notComplete')
    assert.match(decision.message, /declined/)
  })

  it('refuses a second undo, naming who undid it', () => {
    const decision = tradeUndoAccess(
      member(ANNA),
      trade({
        status: 'undone',
        resolvedBy: 'Anna',
        resolvedAt: '2026-08-02T11:00:00.000Z',
        undoneBy: 'Bert',
        undoneAt: '2026-08-03T09:00:00.000Z',
      }),
      ANNA_AND_BERT,
    )
    assert.ok(decision.allowed === false)
    assert.equal(decision.refusal, 'notComplete')
    assert.match(decision.message, /Bert/)
  })

  it('says so plainly when the undoer’s account has since been deleted', () => {
    const decision = tradeUndoAccess(
      member(ANNA),
      trade({ status: 'undone', undoneBy: null, undoneAt: '2026-08-03T09:00:00.000Z' }),
      ANNA_AND_BERT,
    )
    assert.ok(decision.allowed === false)
    assert.match(decision.message, /account has since been deleted/)
  })

  it('checks who before what state, matching the server', () => {
    // A stranger gets the same refusal whatever state the trade is in.
    const decision = tradeUndoAccess(member(CARL), trade({ status: 'undone' }), ANNA_AND_BERT)
    assert.equal(decision.allowed === false && decision.refusal, 'notAParty')
  })
})

/* ---------- order ---------- */

describe('sortTrades', () => {
  const pendingOld = trade({ id: 1, proposedAt: '2026-08-01T00:00:00.000Z' })
  const pendingNew = trade({ id: 2, proposedAt: '2026-08-03T00:00:00.000Z' })
  const doneOld = trade({
    id: 3,
    status: 'complete',
    resolvedAt: '2026-08-01T12:00:00.000Z',
    resolvedBy: 'Anna',
  })
  const doneNew = trade({
    id: 4,
    status: 'declined',
    resolvedAt: '2026-08-04T12:00:00.000Z',
    resolvedBy: 'Bert',
  })

  const ids = (rows: TradeRecord[]) => rows.map((row) => row.id)

  it('puts every pending trade above every resolved one, however old', () => {
    // pendingOld is older than both resolved rows and still leads: it is the only
    // one anybody has to do something about.
    assert.deepEqual(ids(sortTrades([doneNew, pendingOld, doneOld, pendingNew])), [1, 2, 4, 3])
  })

  it('reads pending oldest-first, because that is the one being forgotten', () => {
    assert.deepEqual(ids(sortTrades([pendingNew, pendingOld])), [1, 2])
  })

  it('reads resolved newest-first, which is what "did that go through" wants', () => {
    assert.deepEqual(ids(sortTrades([doneOld, doneNew])), [4, 3])
  })

  it('reads an undone trade by when it was undone, not when it was completed', () => {
    // Undo does not overwrite resolvedAt, so an old completion that was undone
    // moments ago has to sort by undoneAt or it would look stale rather than like
    // the thing that "just went through".
    const oldCompletion = trade({
      id: 5,
      status: 'undone',
      resolvedAt: '2026-08-01T00:00:00.000Z',
      resolvedBy: 'Anna',
      undoneAt: '2026-08-05T00:00:00.000Z',
      undoneBy: 'Bert',
    })
    assert.deepEqual(ids(sortTrades([doneNew, oldCompletion])), [5, 4])
  })

  it('breaks a same-timestamp tie on the id, so polling cannot reshuffle it', () => {
    const a = trade({ id: 10, proposedAt: '2026-08-02T00:00:00.000Z' })
    const b = trade({ id: 11, proposedAt: '2026-08-02T00:00:00.000Z' })
    assert.deepEqual(ids(sortTrades([b, a])), [10, 11])
    assert.deepEqual(ids(sortTrades([a, b])), [10, 11])
  })

  it('does not mutate the list it is given', () => {
    const original = [pendingNew, pendingOld]
    sortTrades(original)
    assert.deepEqual(ids(original), [2, 1])
  })
})

/* ---------- filtering and counting ---------- */

describe('tradesInvolving', () => {
  const rows = [
    trade({ id: 1, baseA: '#AAA', baseB: '#BBB' }),
    trade({ id: 2, baseA: '#BBB', baseB: '#CCC' }),
    trade({ id: 3, baseA: '#CCC', baseB: '#DDD' }),
  ]

  it('finds a base on either side of the swap', () => {
    assert.deepEqual(
      tradesInvolving(rows, '#BBB').map((row) => row.id),
      [1, 2],
    )
  })

  it('answers empty for a base with nothing tracked', () => {
    assert.deepEqual(tradesInvolving(rows, '#ZZZ'), [])
  })
})

describe('pendingCount', () => {
  it('counts only what still needs somebody to act', () => {
    const rows = [
      trade({ id: 1 }),
      trade({ id: 2, status: 'complete', resolvedAt: '2026-08-02T11:00:00.000Z' }),
      trade({ id: 3, status: 'declined', resolvedAt: '2026-08-02T11:00:00.000Z' }),
      trade({ id: 4 }),
    ]
    assert.equal(pendingCount(rows), 2)
  })

  it('is zero for an empty tracker', () => {
    assert.equal(pendingCount([]), 0)
  })
})

/* ---------- duplicate detection ---------- */

describe('findPendingSwap', () => {
  const swap = { baseA: '#AAA', baseB: '#BBB', cardFromA: 3, cardFromB: 7 }

  it('finds the pending row for the same four columns', () => {
    assert.equal(findPendingSwap([trade({ id: 9 })], swap)?.id, 9)
  })

  it('ignores a resolved row, so the same swap can be agreed again later', () => {
    // Two people may well trade the same pair of cards twice in a month; only a
    // *pending* duplicate is one agreement counted twice.
    const done = trade({ status: 'complete', resolvedAt: '2026-08-02T11:00:00.000Z' })
    assert.equal(findPendingSwap([done], swap), undefined)
  })

  it('does not match when either card differs', () => {
    assert.equal(findPendingSwap([trade({ cardFromA: 4 })], swap), undefined)
    assert.equal(findPendingSwap([trade({ cardFromB: 8 })], swap), undefined)
  })

  it('does not match a different pair of bases', () => {
    assert.equal(findPendingSwap([trade({ baseB: '#CCC' })], swap), undefined)
  })

  it('compares rather than re-orienting, so a mirrored swap is not a match', () => {
    // Every producer orients — `suggestTrades`, the server's `orientTrade` — so a
    // mirrored row would be a bug upstream, and quietly matching it here would hide
    // the bug instead of letting it show.
    const mirrored = { baseA: '#BBB', baseB: '#AAA', cardFromA: 7, cardFromB: 3 }
    assert.equal(findPendingSwap([trade()], mirrored), undefined)
  })
})

/* ---------- the tracker row's DOM id ---------- */

describe('tradeRowId', () => {
  it('names a row after the trade it belongs to', () => {
    assert.equal(tradeRowId(9), 'trade-row-9')
  })

  it('gives two different trades two different ids', () => {
    // The one property that actually matters here: `TrackerTable` and
    // `TradeSuggestions`'s "On the tracker" link both call this and must land on
    // the same element for the same id, and never on each other's.
    assert.notEqual(tradeRowId(9), tradeRowId(10))
  })
})
