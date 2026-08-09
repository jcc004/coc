import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ChangeRequest } from '@coc/shared'
import {
  changeRequestAmendAccess,
  changeRequestCancelAccess,
  changeRequestHideAccess,
  changeRequestStatus,
  hiddenChangeRequestCount,
  sortChangeRequests,
  visibleChangeRequests,
} from './change-request-rules.ts'

const AUTHOR = { id: 7 }
const STRANGER = { id: 9 }

function request(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 1,
    subject: 'Add dark mode',
    body: 'The app is too bright at night.',
    requestedByUserId: 7,
    requestedBy: 'Ada',
    requestedAt: '2026-08-02T10:00:00.000Z',
    amendments: [],
    canceledAt: null,
    resolution: null,
    hiddenAt: null,
    ...over,
  }
}

describe('changeRequestStatus', () => {
  it('is open when neither canceled nor resolved', () => {
    assert.equal(changeRequestStatus(request()), 'open')
  })

  it('is canceled once canceledAt is set', () => {
    assert.equal(changeRequestStatus(request({ canceledAt: '2026-08-03T00:00:00Z' })), 'canceled')
  })

  it('is resolved once a resolution exists', () => {
    const resolved = request({
      resolution: {
        type: 'asDesigned',
        note: null,
        commitHash: null,
        commitSubject: null,
        resolvedByUserId: 1,
        resolvedBy: 'Admin',
        resolvedAt: '2026-08-03T00:00:00Z',
      },
    })
    assert.equal(changeRequestStatus(resolved), 'resolved')
  })

  it('is resolvedCanceled when both apply — they are independent columns', () => {
    const both = request({
      canceledAt: '2026-08-03T00:00:00Z',
      resolution: {
        type: 'outOfScope',
        note: null,
        commitHash: null,
        commitSubject: null,
        resolvedByUserId: 1,
        resolvedBy: 'Admin',
        resolvedAt: '2026-08-04T00:00:00Z',
      },
    })
    assert.equal(changeRequestStatus(both), 'resolvedCanceled')
  })
})

describe('changeRequestAmendAccess', () => {
  it('lets the author amend an open request', () => {
    assert.deepEqual(changeRequestAmendAccess(AUTHOR, request()), { allowed: true })
  })

  it('refuses a stranger', () => {
    const decision = changeRequestAmendAccess(STRANGER, request())
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false ? decision.refusal : '', 'notAuthor')
  })

  it('refuses once canceled', () => {
    const decision = changeRequestAmendAccess(
      AUTHOR,
      request({ canceledAt: '2026-08-03T00:00:00Z' }),
    )
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false ? decision.refusal : '', 'closed')
  })

  it('refuses once resolved', () => {
    const decision = changeRequestAmendAccess(
      AUTHOR,
      request({
        resolution: {
          type: 'asDesigned',
          note: null,
          commitHash: null,
          commitSubject: null,
          resolvedByUserId: 1,
          resolvedBy: 'Admin',
          resolvedAt: '2026-08-03T00:00:00Z',
        },
      }),
    )
    assert.equal(decision.allowed, false)
    assert.equal(decision.allowed === false ? decision.refusal : '', 'closed')
  })
})

describe('changeRequestCancelAccess and changeRequestHideAccess', () => {
  it('let the author act regardless of state', () => {
    assert.deepEqual(changeRequestCancelAccess(AUTHOR, request()), { allowed: true })
    assert.deepEqual(
      changeRequestCancelAccess(AUTHOR, request({ canceledAt: '2026-08-03T00:00:00Z' })),
      { allowed: true },
    )
    assert.deepEqual(changeRequestHideAccess(AUTHOR, request()), { allowed: true })
  })

  it('refuse a stranger', () => {
    const cancel = changeRequestCancelAccess(STRANGER, request())
    assert.equal(cancel.allowed, false)
    const hide = changeRequestHideAccess(STRANGER, request())
    assert.equal(hide.allowed, false)
  })
})

describe('sortChangeRequests', () => {
  it('puts open requests first, oldest first', () => {
    const older = request({ id: 1, requestedAt: '2026-08-01T00:00:00Z' })
    const newer = request({ id: 2, requestedAt: '2026-08-05T00:00:00Z' })
    const closed = request({
      id: 3,
      requestedAt: '2026-07-01T00:00:00Z',
      canceledAt: '2026-08-02T00:00:00Z',
    })
    const sorted = sortChangeRequests([newer, closed, older])
    assert.deepEqual(
      sorted.map((r) => r.id),
      [1, 2, 3],
    )
  })

  it('sorts closed requests newest-closed-first', () => {
    const closedEarly = request({ id: 1, canceledAt: '2026-08-01T00:00:00Z' })
    const closedLate = request({ id: 2, canceledAt: '2026-08-05T00:00:00Z' })
    const sorted = sortChangeRequests([closedEarly, closedLate])
    assert.deepEqual(
      sorted.map((r) => r.id),
      [2, 1],
    )
  })

  it('breaks ties by id', () => {
    const a = request({ id: 5, requestedAt: '2026-08-01T00:00:00Z' })
    const b = request({ id: 6, requestedAt: '2026-08-01T00:00:00Z' })
    assert.deepEqual(
      sortChangeRequests([b, a]).map((r) => r.id),
      [5, 6],
    )
  })
})

describe('visibleChangeRequests and hiddenChangeRequestCount', () => {
  it('filters hidden requests out by default and back in when asked', () => {
    const shown = request({ id: 1, hiddenAt: null })
    const hidden = request({ id: 2, hiddenAt: '2026-08-03T00:00:00Z' })

    assert.deepEqual(
      visibleChangeRequests([shown, hidden], false).map((r) => r.id),
      [1],
    )
    assert.deepEqual(
      visibleChangeRequests([shown, hidden], true).map((r) => r.id),
      [1, 2],
    )
    assert.equal(hiddenChangeRequestCount([shown, hidden]), 1)
  })
})
