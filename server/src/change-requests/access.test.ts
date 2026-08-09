import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mayAmendChangeRequest,
  mayCancelChangeRequest,
  mayHideChangeRequest,
  mayResolveChangeRequest,
  maySubmitChangeRequest,
  type ChangeRequestActor,
  type ChangeRequestDecision,
  type OwnedChangeRequest,
} from './access.ts'

/*
 * Pure functions, no database, no session, no HTTP — the same shape as
 * `trade-access.test.ts` next door, and for the same reason: a disabled admin, a
 * closed request, a stranger poking at somebody else's row are each one line of
 * setup here.
 */

const AUTHOR: ChangeRequestActor = { id: 7, role: 'user' }
const STRANGER: ChangeRequestActor = { id: 9, role: 'user' }
const ADMIN: ChangeRequestActor = { id: 1, role: 'admin' }
const DISABLED_AUTHOR: ChangeRequestActor = { id: 7, role: 'user', disabled: true }

const OPEN: OwnedChangeRequest = { requestedByUserId: 7, canceledAt: null, resolution: null }
const CANCELED: OwnedChangeRequest = {
  requestedByUserId: 7,
  canceledAt: '2026-08-01T00:00:00Z',
  resolution: null,
}
const RESOLVED: OwnedChangeRequest = {
  requestedByUserId: 7,
  canceledAt: null,
  resolution: { resolvedAt: '2026-08-01T00:00:00Z' },
}
const CANCELED_AND_RESOLVED: OwnedChangeRequest = {
  requestedByUserId: 7,
  canceledAt: '2026-08-01T00:00:00Z',
  resolution: { resolvedAt: '2026-08-02T00:00:00Z' },
}

function refusal(decision: ChangeRequestDecision): string {
  return decision.allowed === false ? decision.refusal : 'allowed'
}

describe('maySubmitChangeRequest', () => {
  it('allows any signed-in account', () => {
    assert.deepEqual(maySubmitChangeRequest(AUTHOR), { allowed: true })
    assert.deepEqual(maySubmitChangeRequest(ADMIN), { allowed: true })
  })

  it('refuses a disabled account', () => {
    assert.equal(refusal(maySubmitChangeRequest(DISABLED_AUTHOR)), 'accountDisabled')
  })
})

describe('mayAmendChangeRequest', () => {
  it('lets the author amend an open request', () => {
    assert.deepEqual(mayAmendChangeRequest(AUTHOR, OPEN), { allowed: true })
  })

  it('refuses anyone but the author, admin included', () => {
    assert.equal(refusal(mayAmendChangeRequest(STRANGER, OPEN)), 'notAuthor')
    assert.equal(refusal(mayAmendChangeRequest(ADMIN, OPEN)), 'notAuthor')
  })

  it('refuses once the request is canceled', () => {
    assert.equal(refusal(mayAmendChangeRequest(AUTHOR, CANCELED)), 'closed')
  })

  it('refuses once the request is resolved', () => {
    assert.equal(refusal(mayAmendChangeRequest(AUTHOR, RESOLVED)), 'closed')
  })

  it('refuses a disabled author', () => {
    assert.equal(refusal(mayAmendChangeRequest(DISABLED_AUTHOR, OPEN)), 'accountDisabled')
  })
})

describe('mayCancelChangeRequest', () => {
  it('lets the author cancel an open request', () => {
    assert.deepEqual(mayCancelChangeRequest(AUTHOR, OPEN), { allowed: true })
  })

  it('refuses anyone but the author, admin included', () => {
    assert.equal(refusal(mayCancelChangeRequest(STRANGER, OPEN)), 'notAuthor')
    assert.equal(refusal(mayCancelChangeRequest(ADMIN, OPEN)), 'notAuthor')
  })

  it('is unaffected by cancel or resolve state — cancel is allowed at any time', () => {
    assert.deepEqual(mayCancelChangeRequest(AUTHOR, CANCELED), { allowed: true })
    assert.deepEqual(mayCancelChangeRequest(AUTHOR, RESOLVED), { allowed: true })
    assert.deepEqual(mayCancelChangeRequest(AUTHOR, CANCELED_AND_RESOLVED), { allowed: true })
  })
})

describe('mayHideChangeRequest', () => {
  it('lets the author hide or unhide, in any state', () => {
    assert.deepEqual(mayHideChangeRequest(AUTHOR, OPEN), { allowed: true })
    assert.deepEqual(mayHideChangeRequest(AUTHOR, CANCELED), { allowed: true })
    assert.deepEqual(mayHideChangeRequest(AUTHOR, RESOLVED), { allowed: true })
    assert.deepEqual(mayHideChangeRequest(AUTHOR, CANCELED_AND_RESOLVED), { allowed: true })
  })

  it('refuses anyone but the author, admin included', () => {
    assert.equal(refusal(mayHideChangeRequest(STRANGER, OPEN)), 'notAuthor')
    assert.equal(refusal(mayHideChangeRequest(ADMIN, OPEN)), 'notAuthor')
  })
})

describe('mayResolveChangeRequest', () => {
  it('allows an admin', () => {
    assert.deepEqual(mayResolveChangeRequest(ADMIN), { allowed: true })
  })

  it('refuses a non-admin, the request’s own author included', () => {
    assert.equal(refusal(mayResolveChangeRequest(AUTHOR)), 'notAdmin')
    assert.equal(refusal(mayResolveChangeRequest(STRANGER)), 'notAdmin')
  })

  it('refuses a disabled admin', () => {
    assert.equal(refusal(mayResolveChangeRequest({ ...ADMIN, disabled: true })), 'accountDisabled')
  })
})
