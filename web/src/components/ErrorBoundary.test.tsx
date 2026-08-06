import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { installTestCleanup } from '../test-support.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'

installTestCleanup()

function Bomb({ message }: { message: string }): never {
  throw new Error(message)
}

describe('when nothing below it throws', () => {
  it('renders the children and nothing else', () => {
    render(
      <ErrorBoundary>
        <p>All is well</p>
      </ErrorBoundary>,
    )

    assert.ok(screen.getByText('All is well'))
    assert.equal(screen.queryByText('Something went wrong'), null)
  })
})

describe('when something below it throws', () => {
  it('replaces the tree with a message instead of leaving a blank page', () => {
    // React logs caught errors to the console too; the assertion is on the fallback
    // UI, not on staying silent, so the log is stubbed rather than treated as a failure.
    const consoleError = mock.method(console, 'error', () => {})
    try {
      render(
        <ErrorBoundary>
          <Bomb message="the wiki fetch was empty" />
        </ErrorBoundary>,
      )

      assert.ok(screen.getByText('Something went wrong'))
      assert.ok(screen.getByText('the wiki fetch was empty'))
      assert.equal(screen.queryByText('All is well'), null)
    } finally {
      consoleError.mock.restore()
    }
  })

  it('offers a reload rather than a dead end', async () => {
    const consoleError = mock.method(console, 'error', () => {})
    const onReload = mock.fn()
    try {
      render(
        <ErrorBoundary onReload={onReload}>
          <Bomb message="boom" />
        </ErrorBoundary>,
      )

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Reload' }))

      assert.equal(onReload.mock.calls.length, 1)
    } finally {
      consoleError.mock.restore()
    }
  })

  it('falls back to a generic message when the error carries none', () => {
    const consoleError = mock.method(console, 'error', () => {})
    try {
      render(
        <ErrorBoundary>
          <Bomb message="" />
        </ErrorBoundary>,
      )

      assert.ok(screen.getByText('The page hit an error it could not recover from.'))
    } finally {
      consoleError.mock.restore()
    }
  })
})
