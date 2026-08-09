import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, waitFor } from '@testing-library/react'
import { api } from '../api.ts'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { ChangeRequestsView } from './ChangeRequestsView.tsx'

/**
 * Just the one behavior added alongside the account-menu badge: landing on
 * this page marks it viewed. Everything else about the page — the submit
 * form, "My requests", the admin table — is exercised only indirectly here
 * (via the `myChangeRequests` stub every render needs) and is otherwise
 * untested at the component level, the same gap `CLAUDE.md`'s Testing
 * section already names for sibling views; this file does not attempt to
 * close that gap, only to pin the one new thing this task added.
 */

installTestCleanup()

describe('marking the page viewed', () => {
  it('calls markChangeRequestsViewed once on mount', async () => {
    mock.method(api, 'myChangeRequests', () => Promise.resolve({ requests: [] }))
    const markViewed = mock.method(api, 'markChangeRequestsViewed', () =>
      Promise.resolve({ ok: true as const }),
    )
    stubApi({})

    render(<ChangeRequestsView user={sessionUser({ role: 'user' })} />)

    await waitFor(() => assert.equal(markViewed.mock.callCount(), 1))
  })

  it('a failed call is swallowed — the page still renders', async () => {
    mock.method(api, 'myChangeRequests', () => Promise.resolve({ requests: [] }))
    mock.method(api, 'markChangeRequestsViewed', () => Promise.reject(new Error('offline')))
    stubApi({})

    render(<ChangeRequestsView user={sessionUser({ role: 'user' })} />)

    // The submit form is always present; if the rejected mark-viewed promise
    // were left unhandled it would still not stop this from rendering, so the
    // real assertion is the absence of an unhandled-rejection failure for this
    // test — Node's test runner fails a test on one of those even with no
    // explicit assertion tripped.
    await screen.findByRole('button', { name: /submit/i })
  })
})
