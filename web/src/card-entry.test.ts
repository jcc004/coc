import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OwnerRecord } from '@coc/shared'
import { ApiError } from './api.ts'
import {
  baseOwnerOf,
  blurDecision,
  cardEntryAccess,
  classifySaveFailure,
  countsDiffer,
} from './card-entry.ts'

const OWNER = { id: 7, role: 'user' } as const
const OTHER = { id: 8, role: 'user' } as const
const ADMIN = { id: 9, role: 'admin' } as const

const TAG = '#2GCJ2QPU'

describe('cardEntryAccess', () => {
  it('lets the owning account write its own base', () => {
    const access = cardEntryAccess(OWNER, { ownerUserId: 7, ownerLabel: 'Jared' }, TAG)
    assert.deepEqual(access, { writable: true })
  })

  it('lets an admin write any base', () => {
    // Including one they do not own, and one nobody owns: an admin can reassign a
    // base to themselves anyway, so refusing the direct write would stop nothing.
    assert.deepEqual(cardEntryAccess(ADMIN, { ownerUserId: 7, ownerLabel: 'Jared' }, TAG), {
      writable: true,
    })
    assert.deepEqual(cardEntryAccess(ADMIN, { ownerUserId: null, ownerLabel: null }, TAG), {
      writable: true,
    })
  })

  it('refuses a member somebody else owns, and names them', () => {
    const access = cardEntryAccess(OTHER, { ownerUserId: 7, ownerLabel: 'Jared' }, TAG)
    assert.equal(access.writable, false)
    assert.equal(access.writable === false && access.refusal, 'notOwner')
    assert.match(access.writable === false ? access.message : '', /belongs to Jared/)
    assert.match(access.writable === false ? access.message : '', /#2GCJ2QPU/)
  })

  it('names the base rather than nobody when the owning account has no label', () => {
    const access = cardEntryAccess(OTHER, { ownerUserId: 7, ownerLabel: null }, TAG)
    assert.match(access.writable === false ? access.message : '', /another member/)
  })

  it('treats a text-only legacy label as owning nothing', () => {
    // 23 of the 40 rows are like this: a name typed before accounts existed, which
    // grants its namesake no more than it grants anyone else.
    const access = cardEntryAccess(OWNER, { ownerUserId: null, ownerLabel: 'Jared' }, TAG)
    assert.equal(access.writable, false)
    assert.equal(access.writable === false && access.refusal, 'ownerNotLinked')
    assert.match(access.writable === false ? access.message : '', /not linked to an account/)
  })

  it('makes an unowned base admin-only, and says how to get it', () => {
    const access = cardEntryAccess(OWNER, { ownerUserId: null, ownerLabel: null }, TAG)
    assert.equal(access.writable, false)
    assert.equal(access.writable === false && access.refusal, 'unowned')
    assert.match(access.writable === false ? access.message : '', /Ask an admin/)
  })
})

describe('baseOwnerOf', () => {
  it('reads an owner record', () => {
    const record: OwnerRecord = { tag: TAG, owner: 'Jared', ownerUserId: 7 }
    assert.deepEqual(baseOwnerOf(record), { ownerUserId: 7, ownerLabel: 'Jared' })
  })

  it('reports a missing record as owned by nobody', () => {
    assert.deepEqual(baseOwnerOf(undefined), { ownerUserId: null, ownerLabel: null })
  })

  it('reports a record with no linked account as a label only', () => {
    // `ownerUserId` is optional on the wire, so absent and null both have to land
    // as "no account owns this".
    assert.deepEqual(baseOwnerOf({ tag: TAG, owner: 'Jared' }), {
      ownerUserId: null,
      ownerLabel: 'Jared',
    })
  })
})

describe('countsDiffer', () => {
  const map = (entries: [number, number][]) => new Map(entries)

  it('is false for two empty sets', () => {
    assert.equal(countsDiffer(map([]), map([])), false)
  })

  it('is false for the same numbers in a different insertion order', () => {
    assert.equal(
      countsDiffer(
        map([
          [1, 3],
          [44, 2],
        ]),
        map([
          [44, 2],
          [1, 3],
        ]),
      ),
      false,
    )
  })

  it('treats zero and absent as the same holding', () => {
    assert.equal(countsDiffer(map([[7, 0]]), map([])), false)
    assert.equal(countsDiffer(map([]), map([[7, 0]])), false)
  })

  it('spots a changed count, a new card and a removed one', () => {
    assert.equal(countsDiffer(map([[1, 3]]), map([[1, 4]])), true)
    assert.equal(countsDiffer(map([[1, 3]]), map([])), true)
    assert.equal(countsDiffer(map([]), map([[1, 3]])), true)
  })
})

describe('blurDecision', () => {
  const saved = new Map([
    [1, 3],
    [44, 2],
  ])

  it('stays silent when nothing changed — the sixty-blurs case', () => {
    const draft = new Map(saved)
    assert.deepEqual(blurDecision({ draft, saved, writable: true, saving: false }), {
      save: false,
      reason: 'unchanged',
    })
  })

  it('saves once a number really changed', () => {
    const draft = new Map(saved).set(1, 4)
    assert.deepEqual(blurDecision({ draft, saved, writable: true, saving: false }), { save: true })
  })

  it('compares against the last saved value, not the value before this focus', () => {
    // Typing 4 and then putting 3 back is not a change, however many keystrokes it
    // took, and must not churn the base's updated_at.
    const draft = new Map(saved).set(1, 4)
    draft.set(1, 3)
    assert.deepEqual(blurDecision({ draft, saved, writable: true, saving: false }), {
      save: false,
      reason: 'unchanged',
    })
  })

  it('never writes a base the session may not write', () => {
    const draft = new Map(saved).set(1, 4)
    assert.deepEqual(blurDecision({ draft, saved, writable: false, saving: false }), {
      save: false,
      reason: 'notWritable',
    })
  })

  it('defers rather than racing a request already in flight', () => {
    const draft = new Map(saved).set(1, 4)
    assert.deepEqual(blurDecision({ draft, saved, writable: true, saving: true }), {
      save: false,
      reason: 'busy',
    })
  })
})

describe('classifySaveFailure', () => {
  it('reads a 403 as a rule, not a breakage', () => {
    const refusal = new ApiError(403, 'forbidden', '#AAA belongs to Jared.')
    assert.deepEqual(classifySaveFailure(refusal, '#AAA'), {
      kind: 'refused',
      message: '#AAA belongs to Jared.',
    })
  })

  it('reads every other status as a failure worth retrying', () => {
    assert.deepEqual(classifySaveFailure(new ApiError(500, 'server', 'Boom.'), '#AAA'), {
      kind: 'failed',
      message: 'Boom.',
    })
    assert.deepEqual(classifySaveFailure(new ApiError(400, 'badRequest', 'Nope.'), '#AAA'), {
      kind: 'failed',
      message: 'Nope.',
    })
  })

  it('falls back to naming the base when there is no message at all', () => {
    assert.deepEqual(classifySaveFailure(undefined, '#AAA'), {
      kind: 'failed',
      message: 'Could not reach the server to save #AAA.',
    })
    assert.deepEqual(classifySaveFailure(new Error(''), '#AAA'), {
      kind: 'failed',
      message: 'Could not reach the server to save #AAA.',
    })
  })
})
