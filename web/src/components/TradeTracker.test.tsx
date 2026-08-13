import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OwnerRecord, TradeRecord } from '@coc/shared'
import { api, ApiError } from '../api.ts'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { TradeTracker } from './TradeTracker.tsx'

/**
 * `ResolveActions.act` and `UndoAction.act` (both module-scope inside
 * `TradeTracker.tsx`) each catch a failed write and choose between two messages:
 * the server's own refusal, verbatim, or a fixed "Could not reach the server."
 * fallback — decided by `cause instanceof ApiError`. A regression in that check (the
 * `instanceof` breaking across a bundler/module boundary, or a new `ApiError`
 * subclass this check stops recognizing) would silently relabel every real server
 * refusal as a network failure, which is actively misleading: a user would retry
 * something that is going to keep failing for a reason they were never told. This
 * file exists to pin both branches of both functions.
 *
 * Both `act` functions call through `completeTrade` / `declineTrade` / `undoTrade`
 * (`../trades.ts`), which wrap the underlying `api.*` call in `server-store.ts`'s
 * `store.mutate`. `mutate` unconditionally normalizes *any* failure — `ApiError` or
 * not — into an `ApiError` before rethrowing (`toApiError`, `server-store.ts:46-50`
 * and the `catch` block at `server-store.ts:143-161`), so by the time a rejection
 * reaches `TradeTracker.tsx`'s own `catch (cause)`, `cause` is always `instanceof
 * ApiError` — through every real path, including a genuine `fetch` failure. The
 * component's own `: 'Could not reach the server.'` fallback is therefore dead code
 * given the current call graph; there is no way to make it execute short of
 * mocking `../trades.ts`'s named exports directly, which `node:test`'s `mock.method`
 * cannot do for a live ES module without `--experimental-test-module-mocks` (a flag
 * this project's `npm test` does not pass — confirmed by hand: mocking a named
 * export this way throws "Cannot redefine property").
 *
 * So the second test in each pair below does not exercise that literal `else` arm —
 * nothing can, as currently wired — but it does pin the *user-visible* fallback
 * text for the case that produces it today: an underlying failure with no message
 * of its own (a bare `fetch` throw with an empty `.message`), which `toApiError`
 * itself falls back to the identical "Could not reach the server." string for
 * before it ever reaches the component. If this ever changes — if `toApiError`'s
 * fallback text drifts from `TradeTracker.tsx`'s own literal, or if `trades.ts`
 * stops routing every write through `store.mutate` and a raw non-`ApiError` cause
 * starts reaching these `catch` blocks directly — this file is the place a real
 * false-branch test belongs, once one of those exceptions is reachable.
 */

installTestCleanup()

const ANNA = sessionUser({ id: 1, displayName: 'Anna' })

const OWNERS: OwnerRecord[] = [
  { tag: '#AAA', owner: 'Anna', ownerUserId: 1 },
  { tag: '#BBB', owner: 'Bert', ownerUserId: 2 },
]

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
    proposedByUserId: 1,
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

/** Renders the tracker with one row, Anna (owner of `#AAA`) signed in. */
async function renderTracker(record: TradeRecord) {
  stubApi({
    trades: () => Promise.resolve({ season: record.season, trades: [record] }),
    owners: () => Promise.resolve({ owners: OWNERS }),
  })
  const user = userEvent.setup()
  render(<TradeTracker user={ANNA} labelOf={(tag) => (tag === '#AAA' ? 'Anna' : 'Bert')} />)
  await screen.findByRole('table', { name: 'Trade tracker' })
  return user
}

describe('ResolveActions.act — completing a pending trade', () => {
  it('shows the server refusal verbatim', async () => {
    const user = await renderTracker(trade())
    mock.method(api, 'completeTrade', () =>
      Promise.reject(new ApiError(409, 'alreadyResolved', 'Bert already completed this trade.')),
    )

    await user.click(screen.getByRole('button', { name: 'Complete' }))

    await screen.findByText('Bert already completed this trade.')
    // Not the generic fallback — a real refusal must never be relabeled as one.
    assert.equal(screen.queryByText('Could not reach the server.'), null)
  })

  it('falls back to the generic message for a failure with no message of its own', async () => {
    const user = await renderTracker(trade())
    // A bare fetch-style throw, the shape `toApiError` (server-store.ts:46-50)
    // itself has no message to carry forward from — see the file-level comment
    // above for why this is the reachable stand-in for the component's own
    // `else` branch, not a direct exercise of it.
    mock.method(api, 'completeTrade', () => Promise.reject(new TypeError()))

    await user.click(screen.getByRole('button', { name: 'Complete' }))

    await screen.findByText('Could not reach the server.')
  })
})

describe('UndoAction.act — undoing a completed trade', () => {
  const completedByBert = () =>
    trade({
      status: 'complete',
      resolvedByUserId: 2,
      resolvedBy: 'Bert',
      resolvedAt: '2026-08-02T11:00:00.000Z',
    })

  it('shows the server refusal verbatim', async () => {
    const user = await renderTracker(completedByBert())
    mock.method(window, 'confirm', () => true)
    mock.method(api, 'undoTrade', () =>
      Promise.reject(new ApiError(409, 'alreadyUndone', 'Someone already undid this trade.')),
    )

    await user.click(screen.getByRole('button', { name: 'Undo' }))

    await screen.findByText('Someone already undid this trade.')
    assert.equal(screen.queryByText('Could not reach the server.'), null)
  })

  it('falls back to the generic message for a failure with no message of its own', async () => {
    const user = await renderTracker(completedByBert())
    mock.method(window, 'confirm', () => true)
    mock.method(api, 'undoTrade', () => Promise.reject(new TypeError()))

    await user.click(screen.getByRole('button', { name: 'Undo' }))

    await screen.findByText('Could not reach the server.')
  })
})
