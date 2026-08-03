import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mayWriteBaseCounts, type BaseOwnership, type BaseWriter } from './write-access.ts'

/*
 * The write rule on its own — no database, no session, no HTTP. That is the point
 * of it being a pure function: every case below is one line of setup, so the
 * combinations that would be tedious to reach through the API (a disabled account,
 * a legacy owner nobody's account matches) are cheap to state and impossible to
 * forget. `cards.test.ts` then proves the route actually consults it.
 */

const OWNER: BaseWriter = { id: 7, role: 'user' }
const OTHER: BaseWriter = { id: 8, role: 'user' }
const ADMIN: BaseWriter = { id: 1, role: 'admin' }

const TAG = '#2GCJ2QPU'

/** A base held by user 7. */
const owned: BaseOwnership = { tag: TAG, ownerUserId: 7, ownerLabel: 'Jared' }
/** No assignment at all. */
const unowned: BaseOwnership = { tag: TAG, ownerUserId: null, ownerLabel: null }
/** An assignment the migration could not match to an account — a label only. */
const legacyText: BaseOwnership = { tag: TAG, ownerUserId: null, ownerLabel: 'Casey' }

describe('who may write a base’s card counts', () => {
  it('lets the owning account write its own base', () => {
    assert.deepEqual(mayWriteBaseCounts(OWNER, owned), { allowed: true })
  })

  it('refuses a member who does not own the base, and names who does', () => {
    const decision = mayWriteBaseCounts(OTHER, owned)
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false && decision.refusal, 'notOwner')
    // Naming the owner is the difference between a usable message and a wall.
    assert.match(decision.allowed === false ? decision.message : '', /Jared/)
    assert.match(decision.allowed === false ? decision.message : '', /#2GCJ2QPU/)
  })

  it('lets an admin write a base somebody else owns', () => {
    // Deliberate: an admin can reassign the base to themselves in one request, so
    // refusing the direct write would only remove their way to fix a mistake.
    assert.deepEqual(mayWriteBaseCounts(ADMIN, owned), { allowed: true })
  })

  it('lets an admin write a base nobody owns', () => {
    assert.deepEqual(mayWriteBaseCounts(ADMIN, unowned), { allowed: true })
  })

  it('refuses a member on a base nobody owns', () => {
    const decision = mayWriteBaseCounts(OTHER, unowned)
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false && decision.refusal, 'unowned')
    assert.match(decision.allowed === false ? decision.message : '', /no owner/)
  })

  it('refuses a disabled account, whatever it owns and whatever its role', () => {
    // Sessions are revoked when an account is disabled, so this is defence in
    // depth — but the rule must not depend on that happening.
    for (const writer of [
      { ...OWNER, disabled: true },
      { ...ADMIN, disabled: true },
    ]) {
      const decision = mayWriteBaseCounts(writer, owned)
      assert.equal(decision.allowed, false, `${writer.role} must be refused while disabled`)
      assert.equal(decision.allowed === false && decision.refusal, 'accountDisabled')
    }
  })

  it('treats an unresolved legacy text owner as granting nobody the write', () => {
    // The 39 real assignments are names of clan members, most without accounts.
    // The label stays visible; it is not a permission.
    for (const writer of [OWNER, OTHER]) {
      const decision = mayWriteBaseCounts(writer, legacyText)
      assert.equal(decision.allowed, false)
      assert.equal(decision.allowed === false && decision.refusal, 'ownerNotLinked')
      assert.match(decision.allowed === false ? decision.message : '', /Casey/)
      assert.match(
        decision.allowed === false ? decision.message : '',
        /not linked to an account/,
        'the message has to explain why the name on screen is not enough',
      )
    }

    // …and an admin can still fix it, which is the only route out of that state.
    assert.deepEqual(mayWriteBaseCounts(ADMIN, legacyText), { allowed: true })
  })

  it('does not confuse an owner id of 0 with an unowned base', () => {
    // Ids are ints from SQLite, so 0 is not a real one — but a truthiness check
    // here would be a silent hole, and this is the test that keeps it closed.
    const zeroOwned: BaseOwnership = { tag: TAG, ownerUserId: 0, ownerLabel: 'Zero' }
    assert.deepEqual(mayWriteBaseCounts({ id: 0, role: 'user' }, zeroOwned), { allowed: true })
    const refused = mayWriteBaseCounts(OTHER, zeroOwned)
    assert.equal(refused.allowed === false && refused.refusal, 'notOwner')
  })
})
