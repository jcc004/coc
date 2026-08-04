import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_POLL_INTERVAL_MS,
  FOCUS_REFRESH_MIN_GAP_MS,
  minimumGapFor,
  refreshDecision,
  type RefreshDecision,
  type RefreshTrigger,
} from './card-refresh.ts'

/**
 * The decision behind the card pages' background refresh. No DOM and no timer: the
 * clock, the visibility and the two in-flight flags are all arguments, which is the
 * whole reason this is a function rather than four conditions inside an interval
 * callback nobody can run.
 */

const NOW = 1_770_000_000_000

/** A visible, idle page whose last read started a long time ago: always due. */
function due(over: Partial<Parameters<typeof refreshDecision>[0]> = {}) {
  return refreshDecision({
    trigger: 'poll',
    now: NOW,
    lastStartedAt: NOW - CARD_POLL_INTERVAL_MS * 10,
    visible: true,
    inFlight: false,
    saving: false,
    ...over,
  })
}

/** The refusal, or `null` when it decided to go. Keeps the assertions one line. */
function reason(decision: RefreshDecision): string | null {
  return decision.refresh ? null : decision.reason
}

describe('the poll interval', () => {
  it('is thirty seconds, as a named constant rather than a literal in the hook', () => {
    assert.equal(CARD_POLL_INTERVAL_MS, 30_000)
  })

  it('lets a focus re-read far sooner than a poll may', () => {
    // The gap on a focus exists only to collapse a pile-up. Making somebody who has
    // just come back to the tab wait out the poll window is the staleness this fixes.
    assert.ok(FOCUS_REFRESH_MIN_GAP_MS < CARD_POLL_INTERVAL_MS)
    assert.equal(minimumGapFor('poll'), CARD_POLL_INTERVAL_MS)
    assert.equal(minimumGapFor('focus'), FOCUS_REFRESH_MIN_GAP_MS)
  })
})

describe('refreshDecision', () => {
  it('reads immediately when the page has never read anything', () => {
    assert.deepEqual(due({ lastStartedAt: null }), { refresh: true })
  })

  it('refuses to poll while the tab is hidden', () => {
    // The condition that decides whether this whole idea is cheap or is eight
    // forgotten tabs making a thousand requests overnight.
    assert.equal(reason(due({ visible: false })), 'hidden')
  })

  it('refuses a focus refresh while the tab is hidden', () => {
    // `visibilitychange` fires on the way *out* as well as on the way back in.
    assert.equal(reason(due({ trigger: 'focus', visible: false })), 'hidden')
  })

  it('holds a hidden tab back even when a read is long overdue', () => {
    const decision = due({ visible: false, lastStartedAt: NOW - CARD_POLL_INTERVAL_MS * 1000 })
    assert.equal(reason(decision), 'hidden')
  })

  it('does not start a second read while the first is still in flight', () => {
    assert.equal(reason(due({ inFlight: true })), 'inFlight')
    assert.equal(reason(due({ trigger: 'focus', inFlight: true })), 'inFlight')
  })

  it('does not read across a save of somebody typing counts', () => {
    // The answer would be the inventory from before the write, so the refresh would
    // be stale before it landed — and `saveBaseCounts` reloads the store itself.
    assert.equal(reason(due({ saving: true })), 'saving')
    assert.equal(reason(due({ trigger: 'focus', saving: true })), 'saving')
  })

  it('waits out the whole interval between polls', () => {
    const lastStartedAt = NOW - (CARD_POLL_INTERVAL_MS - 1)
    assert.equal(reason(due({ lastStartedAt })), 'tooSoon')
  })

  it('polls again the moment the interval has elapsed', () => {
    const lastStartedAt = NOW - CARD_POLL_INTERVAL_MS
    assert.deepEqual(due({ lastStartedAt }), { refresh: true })
  })

  it('ignores a focus arriving in the same moment as a poll', () => {
    // The refetch storm this exists to prevent: `focus` and `visibilitychange` both
    // fire when a tab comes forward, and either can land on the heels of a tick.
    const justRead = { trigger: 'focus' as RefreshTrigger, lastStartedAt: NOW }
    assert.equal(reason(due(justRead)), 'tooSoon')
    assert.equal(reason(due({ ...justRead, lastStartedAt: NOW - 5 })), 'tooSoon')
  })

  it('reads on focus without waiting for the poll window to run out', () => {
    // Twenty seconds into a thirty-second window: too soon for a tick, not too soon
    // for somebody who has just come back to the tab.
    const lastStartedAt = NOW - 20_000
    assert.equal(reason(due({ lastStartedAt })), 'tooSoon')
    assert.deepEqual(due({ trigger: 'focus', lastStartedAt }), { refresh: true })
  })

  it('treats a clock that has moved backwards as due rather than stopping for good', () => {
    // An NTP correction or a laptop waking up. Reading the stamp as being in the
    // future would suppress every refresh until the clock caught up with it.
    assert.deepEqual(due({ lastStartedAt: NOW + 60 * 60_000 }), { refresh: true })
  })
})
