import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render } from '@testing-library/react'
import { CARD_SEASON } from '@coc/shared'
import { api } from './api.ts'
import { CARD_POLL_INTERVAL_MS, FOCUS_REFRESH_MIN_GAP_MS } from './card-refresh.ts'
import { installTestCleanup, stubApi } from './test-support.ts'
import { useCardRefresh } from './use-card-refresh.ts'

/**
 * The wiring around `refreshDecision`: what is listened to, what is torn down, and
 * that the two shared stores are the things re-read.
 *
 * The rules themselves are pure and tested in `card-refresh.test.ts`. What is here is
 * the part that has no test anywhere else — an interval that outlives its page, or a
 * listener that keeps firing after unmount, is invisible until somebody profiles a
 * tab that has been open all day.
 *
 * **No fake timers.** The clock is `Date.now`, stubbed, and the interval callback is
 * captured from a stubbed `window.setInterval` and called directly. Faking the timer
 * queue would also fake the one Testing Library's `waitFor` is standing on.
 */

installTestCleanup()

const NOW = 1_770_000_000_000

/**
 * jsdom's `Event`, not Node's.
 *
 * `test-dom.ts` copies only the window globals Node does not already define, and Node
 * defines `Event` — so the bare constructor builds an event from the wrong realm and
 * jsdom's `dispatchEvent` refuses it by name.
 */
const domEvent = (type: string) => new window.Event(type)

function Probe() {
  useCardRefresh()
  return null
}

/** Renders the probe with both card endpoints stubbed, and hands back the spies. */
function mountProbe() {
  let clock = NOW
  const setClock = (to: number) => {
    clock = to
  }
  mock.method(Date, 'now', () => clock)

  const inventory = mock.method(api, 'cardInventory', () =>
    Promise.resolve({ season: CARD_SEASON, bases: [] }),
  )
  const trades = mock.method(api, 'trades', () => Promise.resolve({ season: CARD_SEASON, trades: [] }))
  /* The fence: anything this subtree asks for that is not stubbed names itself. */
  stubApi({})

  let tick: (() => void) | null = null
  let ticker = 0
  let period = 0
  let cleared: number | null = null
  mock.method(window, 'setInterval', ((handler: () => void, ms: number) => {
    tick = handler
    period = ms
    ticker = 41
    return ticker
  }) as never)
  mock.method(window, 'clearInterval', ((id: number) => {
    cleared = id
  }) as never)

  const view = render(<Probe />)

  return {
    view,
    setClock,
    reads: () => inventory.mock.callCount(),
    tradeReads: () => trades.mock.callCount(),
    tick: () => {
      assert.ok(tick, 'the hook registered no interval')
      tick()
    },
    period: () => period,
    ticker: () => ticker,
    cleared: () => cleared,
  }
}

/** Lets the two in-flight store loads settle before the counts are read. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useCardRefresh', () => {
  it('re-reads both shared stores as soon as a card page opens', async () => {
    // Both, not just the inventory: a trade completed elsewhere changes the tracker
    // and the counts, and a page showing one without the other contradicts itself.
    const probe = mountProbe()
    await settle()

    assert.equal(probe.reads(), 1)
    assert.equal(probe.tradeReads(), 1)
  })

  it('polls on the interval named in card-refresh.ts, not a literal of its own', async () => {
    const probe = mountProbe()
    await settle()

    assert.equal(probe.period(), CARD_POLL_INTERVAL_MS)
  })

  it('re-reads when the interval elapses while the page is open', async () => {
    const probe = mountProbe()
    await settle()

    probe.setClock(NOW + CARD_POLL_INTERVAL_MS)
    probe.tick()
    await settle()

    assert.equal(probe.reads(), 2)
    assert.equal(probe.tradeReads(), 2)
  })

  it('re-reads when the tab is brought back to the front', async () => {
    const probe = mountProbe()
    await settle()

    probe.setClock(NOW + FOCUS_REFRESH_MIN_GAP_MS)
    window.dispatchEvent(domEvent('focus'))
    await settle()

    assert.equal(probe.reads(), 2)
  })

  it('makes one request of a tab coming forward, not one per event', async () => {
    // `focus` and `visibilitychange` both fire when a window comes back, and a poll
    // can land in the same moment. Three events, one pair of requests.
    const probe = mountProbe()
    await settle()

    probe.setClock(NOW + FOCUS_REFRESH_MIN_GAP_MS)
    window.dispatchEvent(domEvent('focus'))
    document.dispatchEvent(domEvent('visibilitychange'))
    probe.tick()
    await settle()

    assert.equal(probe.reads(), 2)
    assert.equal(probe.tradeReads(), 2)
  })

  it('does not poll while the tab is hidden', async () => {
    const probe = mountProbe()
    await settle()

    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      probe.setClock(NOW + CARD_POLL_INTERVAL_MS * 100)
      probe.tick()
      await settle()
      assert.equal(probe.reads(), 1)
    } finally {
      delete (document as unknown as Record<string, unknown>)['visibilityState']
      assert.ok(visibility, 'jsdom no longer defines visibilityState')
    }
  })

  it('stops polling and stops listening once the page unmounts', async () => {
    // The interval must not outlive the page that wanted it, and a listener that
    // survives the unmount would refresh stores nothing on screen is reading.
    const probe = mountProbe()
    await settle()

    probe.view.unmount()
    assert.equal(probe.cleared(), probe.ticker())

    probe.setClock(NOW + CARD_POLL_INTERVAL_MS * 2)
    window.dispatchEvent(domEvent('focus'))
    document.dispatchEvent(domEvent('visibilitychange'))
    probe.tick()
    await settle()

    assert.equal(probe.reads(), 1)
    assert.equal(probe.tradeReads(), 1)
  })
})
