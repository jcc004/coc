import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mayProposeTrade,
  mayResolveTrade,
  orientTrade,
  type ResolvableTrade,
  type TradeSides,
} from './trade-access.ts'
import type { BaseOwnership, BaseWriter } from './write-access.ts'

/*
 * The trade rules on their own — no database, no session, no HTTP, exactly like
 * `write-access.test.ts` next door. That is the point of them being pure
 * functions: a disabled admin, a base whose owner is an unlinked legacy label, a
 * trade somebody else resolved a moment ago are all one line of setup here, where
 * through the API each would be a small ceremony. `trades.test.ts` then proves the
 * routes really consult these.
 */

const OWNER_A: BaseWriter = { id: 7, role: 'user' }
const OWNER_B: BaseWriter = { id: 8, role: 'user' }
const STRANGER: BaseWriter = { id: 9, role: 'user' }
const ADMIN: BaseWriter = { id: 1, role: 'admin' }

const TAG_A = '#AAABBB'
const TAG_B = '#CCCDDD'

const held = (tag: string, id: number, label: string): BaseOwnership => ({
  tag,
  ownerUserId: id,
  ownerLabel: label,
})

/** The ordinary case: two bases, two different accounts. */
const sides: TradeSides = {
  baseA: held(TAG_A, 7, 'Jared'),
  baseB: held(TAG_B, 8, 'Sam'),
}

/** Neither side linked to an account: one legacy label, one nothing at all. */
const unheld: TradeSides = {
  baseA: { tag: TAG_A, ownerUserId: null, ownerLabel: 'Casey' },
  baseB: { tag: TAG_B, ownerUserId: null, ownerLabel: null },
}

const pending: ResolvableTrade = { status: 'pending' }

function refusal(decision: ReturnType<typeof mayProposeTrade>): string {
  return decision.allowed === false ? decision.refusal : 'allowed'
}

function message(decision: ReturnType<typeof mayProposeTrade>): string {
  return decision.allowed === false ? decision.message : ''
}

describe('who may propose a trade', () => {
  it('lets the owner of either base propose it', () => {
    // One side meaning it is enough — the other side gets to decline.
    assert.deepEqual(mayProposeTrade(OWNER_A, sides), { allowed: true })
    assert.deepEqual(mayProposeTrade(OWNER_B, sides), { allowed: true })
  })

  it('lets an admin propose a trade between two other people’s bases', () => {
    assert.deepEqual(mayProposeTrade(ADMIN, sides), { allowed: true })
  })

  it('refuses a member who owns neither base, and names who can', () => {
    // The rule that matters: a member cannot invent trades between two other
    // people's bases, because the other party would have to decline something
    // they never discussed.
    const decision = mayProposeTrade(STRANGER, sides)
    assert.equal(refusal(decision), 'notAParty')
    assert.match(message(decision), /#AAABBB \(Jared\)/)
    assert.match(message(decision), /#CCCDDD \(Sam\)/)
    assert.match(message(decision), /or an admin/)
    assert.match(message(decision), /propose this trade/)
  })

  it('refuses a disabled account whatever it owns and whatever its role', () => {
    for (const actor of [
      { ...OWNER_A, disabled: true },
      { ...ADMIN, disabled: true },
    ]) {
      const decision = mayProposeTrade(actor, sides)
      assert.equal(refusal(decision), 'accountDisabled', `${actor.role} must be refused`)
    }
  })

  it('treats an unlinked legacy label as granting nobody a trade', () => {
    // Same rule as the card counts: the label is a note about a person, not a
    // permission held by a session. Only an admin can act until it is linked.
    for (const actor of [OWNER_A, OWNER_B, STRANGER]) {
      assert.equal(refusal(mayProposeTrade(actor, unheld)), 'notAParty')
    }
    assert.match(message(mayProposeTrade(STRANGER, unheld)), /Casey, not linked to an account/)
    assert.match(message(mayProposeTrade(STRANGER, unheld)), /#CCCDDD \(no linked owner\)/)
    assert.deepEqual(mayProposeTrade(ADMIN, unheld), { allowed: true })
  })

  it('does not confuse an owner id of 0 with an unowned base', () => {
    // Ids are ints from SQLite, so 0 is not a real one — but a truthiness check
    // would be a silent hole, and this is the test that keeps it closed.
    const zero: TradeSides = { baseA: held(TAG_A, 0, 'Zero'), baseB: sides.baseB }
    assert.deepEqual(mayProposeTrade({ id: 0, role: 'user' }, zero), { allowed: true })
    assert.equal(refusal(mayProposeTrade(STRANGER, zero)), 'notAParty')
  })
})

describe('who may resolve a trade', () => {
  it('lets either party mark it complete or declined', () => {
    // The user's rule verbatim: either party to the trade can resolve it. A swap
    // is not something one side does to the other.
    assert.deepEqual(mayResolveTrade(OWNER_A, pending, sides), { allowed: true })
    assert.deepEqual(mayResolveTrade(OWNER_B, pending, sides), { allowed: true })
  })

  it('lets an admin resolve one, and refuses a member who owns neither base', () => {
    assert.deepEqual(mayResolveTrade(ADMIN, pending, sides), { allowed: true })

    const decision = mayResolveTrade(STRANGER, pending, sides)
    assert.equal(refusal(decision), 'notAParty')
    assert.match(message(decision), /Jared/)
    assert.match(message(decision), /Sam/)
    assert.match(message(decision), /mark this trade complete or declined/)
  })

  it('refuses a trade that is already resolved, naming who resolved it and when', () => {
    for (const status of ['complete', 'declined'] as const) {
      const decision = mayResolveTrade(
        OWNER_A,
        { status, resolvedBy: 'Sam', resolvedAt: '2026-08-02T10:00:00.000Z' },
        sides,
      )
      assert.equal(refusal(decision), 'alreadyResolved', `${status} must not be resolved again`)
      assert.match(message(decision), new RegExp(status))
      assert.match(message(decision), /Sam/)
      assert.match(message(decision), /2026-08-02T10:00:00\.000Z/)
    }
  })

  it('still refuses a resolved trade when the resolver’s account is gone', () => {
    // ON DELETE SET NULL leaves the row with a timestamp and no name; the refusal
    // must still be a sentence rather than "already marked complete by null".
    const decision = mayResolveTrade(
      OWNER_A,
      { status: 'complete', resolvedBy: null, resolvedAt: '2026-08-02T10:00:00.000Z' },
      sides,
    )
    assert.equal(refusal(decision), 'alreadyResolved')
    assert.match(message(decision), /account has since been deleted/)
  })

  it('checks who is asking before it checks the trade’s state', () => {
    // A stranger gets the same 403 whatever state the trade is in. The state is
    // public anyway; "here is who may act on this" is the more useful refusal.
    const decision = mayResolveTrade(STRANGER, { status: 'complete', resolvedBy: 'Sam' }, sides)
    assert.equal(refusal(decision), 'notAParty')
  })

  it('refuses a disabled party before anything else', () => {
    const decision = mayResolveTrade({ ...OWNER_A, disabled: true }, pending, sides)
    assert.equal(refusal(decision), 'accountDisabled')
  })
})

describe('a trade is stored in one canonical orientation', () => {
  const swap = { baseA: TAG_A, baseB: TAG_B, cardFromA: 3, cardFromB: 9, category: 'Elixir' }

  it('leaves a proposal that is already oriented alone', () => {
    assert.deepEqual(orientTrade(swap), swap)
  })

  it('swaps the bases and their cards together when they arrive the other way round', () => {
    // The same agreement, described from the other side. Storing it as sent would
    // make one agreement two rows — and would defeat the "one pending swap" index.
    assert.deepEqual(
      orientTrade({ baseA: TAG_B, baseB: TAG_A, cardFromA: 9, cardFromB: 3, category: 'Elixir' }),
      swap,
      'the card each side gives has to travel with the base that gives it',
    )
  })

  it('keeps everything else on the proposal', () => {
    const oriented = orientTrade({
      baseA: TAG_B,
      baseB: TAG_A,
      cardFromA: 1,
      cardFromB: 2,
      category: 'Dark Elixir',
      note: 'carried through',
    })
    assert.equal(oriented.category, 'Dark Elixir')
    assert.equal(oriented.note, 'carried through')
  })

  it('is idempotent, so orienting twice is orienting once', () => {
    const once = orientTrade({ baseA: TAG_B, baseB: TAG_A, cardFromA: 9, cardFromB: 3 })
    assert.deepEqual(orientTrade(once), once)
  })
})
