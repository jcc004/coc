import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { act, renderHook } from '@testing-library/react'
import { api } from './api.ts'
import { PENDING_CHANGE_REQUEST_POLL_MS, usePendingChangeRequestCount } from './change-requests.ts'
import { installTestCleanup, stubApi } from './test-support.ts'

/**
 * `usePendingChangeRequestCount` — the wiring behind the account-menu badge.
 * The same "no fake timers" approach `use-card-refresh.test.tsx` documents:
 * `window.setInterval` is stubbed and its callback captured, so a test fires
 * it directly rather than faking the whole timer queue.
 */

installTestCleanup()

const domEvent = (type: string) => new window.Event(type)

function mountProbe(
  isAdmin: boolean,
  respond: () => ReturnType<typeof api.pendingChangeRequestCount> = () => Promise.resolve({ count: 3 }),
) {
  const count = mock.method(api, 'pendingChangeRequestCount', respond)
  stubApi({})

  let tick: (() => void) | null = null
  let ticker = 0
  let period = 0
  let cleared: number | null = null
  mock.method(window, 'setInterval', ((handler: () => void, ms: number) => {
    tick = handler
    period = ms
    ticker = 7
    return ticker
  }) as never)
  mock.method(window, 'clearInterval', ((id: number) => {
    cleared = id
  }) as never)

  const view = renderHook(
    ({ admin, open }: { admin: boolean; open: boolean }) => usePendingChangeRequestCount(admin, open),
    { initialProps: { admin: isAdmin, open: false } },
  )

  return {
    view,
    reads: () => count.mock.callCount(),
    tick: () => {
      assert.ok(tick, 'the hook registered no interval')
      tick()
    },
    period: () => period,
    ticker: () => ticker,
    cleared: () => cleared,
  }
}

/**
 * Lets an in-flight fetch's `.then(setCount)` land, wrapped in `act` so the
 * resulting state update is applied before the next assertion reads
 * `result.current` — the same requirement `hooks.test.ts`'s `useAsync` tests
 * meet with `await act(async () => { call.resolve(...) })`.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('usePendingChangeRequestCount', () => {
  it('does not ask at all for a non-admin', async () => {
    const probe = mountProbe(false)
    await settle()
    assert.equal(probe.reads(), 0)
    assert.equal(probe.view.result.current, null)
  })

  it('fetches once on mount for an admin, and returns the count', async () => {
    const probe = mountProbe(true)
    await settle()
    assert.equal(probe.reads(), 1)
    assert.equal(probe.view.result.current, 3)
  })

  it('polls on PENDING_CHANGE_REQUEST_POLL_MS, not a literal of its own', async () => {
    const probe = mountProbe(true)
    await settle()
    assert.equal(probe.period(), PENDING_CHANGE_REQUEST_POLL_MS)
  })

  it('refetches when the interval elapses', async () => {
    const probe = mountProbe(true)
    await settle()
    probe.tick()
    await settle()
    assert.equal(probe.reads(), 2)
  })

  it('refetches on window focus and on visibilitychange', async () => {
    const probe = mountProbe(true)
    await settle()

    window.dispatchEvent(domEvent('focus'))
    await settle()
    assert.equal(probe.reads(), 2)

    document.dispatchEvent(domEvent('visibilitychange'))
    await settle()
    assert.equal(probe.reads(), 3)
  })

  it('refetches when the menu opens', async () => {
    const probe = mountProbe(true)
    await settle()

    probe.view.rerender({ admin: true, open: true })
    await settle()
    assert.equal(probe.reads(), 2)
  })

  it('clears to null and tears down its interval the moment admin status is lost', async () => {
    const probe = mountProbe(true)
    await settle()
    assert.equal(probe.view.result.current, 3)
    const readsBeforeLosingAdmin = probe.reads()

    probe.view.rerender({ admin: false, open: false })
    await settle()
    assert.equal(probe.view.result.current, null)
    // The effect's cleanup ran (the true-admin interval was cleared) rather
    // than a second interval quietly starting for the now-member session.
    assert.equal(probe.cleared(), probe.ticker())
    assert.equal(probe.reads(), readsBeforeLosingAdmin, 'losing admin status asks nothing new')
  })

  it('stops polling and listening once unmounted', async () => {
    const probe = mountProbe(true)
    await settle()

    probe.view.unmount()
    assert.equal(probe.cleared(), probe.ticker())

    window.dispatchEvent(domEvent('focus'))
    document.dispatchEvent(domEvent('visibilitychange'))
    await settle()
    assert.equal(probe.reads(), 1)
  })

  it('keeps the last known count when a poll fails', async () => {
    let calls = 0
    const probe = mountProbe(true, () => {
      calls += 1
      return calls === 1 ? Promise.resolve({ count: 2 }) : Promise.reject(new Error('offline'))
    })
    await settle()
    assert.equal(probe.view.result.current, 2)

    probe.tick()
    await settle()
    assert.equal(probe.view.result.current, 2, 'a failed poll should not clear the badge')
  })
})
