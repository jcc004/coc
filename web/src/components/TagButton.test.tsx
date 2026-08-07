import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installTestCleanup } from '../test-support.ts'
import { TagButton } from './TagButton.tsx'

installTestCleanup()

describe('TagButton', () => {
  it('copies the tag and shows the confirmation', async () => {
    const user = userEvent.setup()
    render(<TagButton tag="#ABC123" />)

    await user.click(screen.getByRole('button'))
    await screen.findByText(/· copied/)
  })

  it('clears its confirmation timer on unmount, so a late navigation cannot set state on it', async () => {
    const user = userEvent.setup()

    // Delegated to the real timer rather than replaced, unlike
    // `use-card-refresh.test.tsx`'s `setInterval` stub — `@testing-library`'s own
    // `findByText` polls on the bare, real `setTimeout`, and `TagButton.tsx` calls
    // that same bare identifier (`test-dom.ts` leaves it pointing at Node's global,
    // not jsdom's `window` copy, on purpose), so replacing it outright would starve
    // `findByText`'s own polling along with the component's. This only observes
    // which ids pass through.
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const started: ReturnType<typeof setTimeout>[] = []
    const cleared: unknown[] = []
    // 1200 is `TagButton`'s own confirmation delay, distinct from anything React or
    // `@testing-library` schedules for itself — that's what singles it out among
    // every other `setTimeout` call a mounted, interactive test fires.
    const setTimeoutMock = mock.method(globalThis, 'setTimeout', ((
      handler: () => void,
      ms?: number,
    ) => {
      const id = realSetTimeout(handler, ms)
      if (ms === 1200) started.push(id)
      return id
    }) as never)
    const clearTimeoutMock = mock.method(globalThis, 'clearTimeout', ((id: NodeJS.Timeout) => {
      cleared.push(id)
      realClearTimeout(id)
    }) as never)

    const { unmount } = render(<TagButton tag="#ABC123" />)
    await user.click(screen.getByRole('button'))
    await screen.findByText(/· copied/)

    assert.equal(started.length, 1, 'exactly one confirmation timer was started')
    const confirmationTimer = started[0]

    unmount()

    assert.ok(
      cleared.includes(confirmationTimer),
      'the confirmation timer was cleared on unmount',
    )

    setTimeoutMock.mock.restore()
    clearTimeoutMock.mock.restore()
  })
})
