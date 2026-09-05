import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MIN_PASSWORD_LENGTH } from '@coc/shared'
import { api, ApiError } from '../api.ts'
import { installTestCleanup, sessionUser } from '../test-support.ts'
import { AccountView } from './AccountView.tsx'

/**
 * `ColorSchemeCard` and `DateFormatCard` are separate files with their own
 * coverage — this only exercises what actually lives in `AccountView.tsx`:
 * the identity table and the password-change form's real validation and
 * request handling.
 */

installTestCleanup()

const USER = sessionUser({
  id: 1,
  displayName: 'Rae',
  email: 'rae@example.com',
  guid: '00000000-0000-4000-8000-000000000001',
  createdAt: '2026-01-15T09:00:00.000Z',
})

const LONG_ENOUGH = 'a'.repeat(MIN_PASSWORD_LENGTH)

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, next: string, confirm: string) {
  await user.type(screen.getByLabelText('Current password'), 'oldpassword')
  await user.type(screen.getByLabelText('New password'), next)
  await user.type(screen.getByLabelText('Repeat new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Change password' }))
}

describe('the identity table', () => {
  it('shows the account as the server has it', () => {
    render(<AccountView user={USER} />)

    assert.ok(screen.getByText('Rae'))
    assert.ok(screen.getByText('rae@example.com'))
    assert.ok(screen.getByText('00000000-0000-4000-8000-000000000001'))
    assert.ok(screen.getByText('User'))
  })
})

describe('changing your password', () => {
  it('refuses a mismatched confirmation without ever calling the API', async () => {
    const changePassword = mock.method(api, 'changePassword', () =>
      Promise.resolve({ revokedSessions: 0 }),
    )
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, `${LONG_ENOUGH}x`)

    assert.ok(screen.getByText('The two new passwords do not match.'))
    assert.equal(changePassword.mock.callCount(), 0)
  })

  it('refuses a new password shorter than the minimum, without calling the API', async () => {
    const changePassword = mock.method(api, 'changePassword', () =>
      Promise.resolve({ revokedSessions: 0 }),
    )
    const user = userEvent.setup()
    render(<AccountView user={USER} />)
    const tooShort = 'short'

    await fillAndSubmit(user, tooShort, tooShort)

    assert.ok(screen.getByText(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`))
    assert.equal(changePassword.mock.callCount(), 0)
  })

  it('sends the current and new password, unmodified, once validation passes', async () => {
    const changePassword = mock.method(api, 'changePassword', () =>
      Promise.resolve({ revokedSessions: 0 }),
    )
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)

    await waitFor(() => assert.equal(changePassword.mock.callCount(), 1))
    assert.deepEqual(changePassword.mock.calls[0]?.arguments, ['oldpassword', LONG_ENOUGH])
  })

  it('reports how many other sessions were signed out, pluralized correctly', async () => {
    mock.method(api, 'changePassword', () => Promise.resolve({ revokedSessions: 1 }))
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)

    assert.ok(await screen.findByText('Password changed. 1 other session signed out.'))
  })

  it('says just "Password changed." when nothing else was signed out', async () => {
    mock.method(api, 'changePassword', () => Promise.resolve({ revokedSessions: 0 }))
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)

    assert.ok(await screen.findByText('Password changed.'))
  })

  it('clears every field on success', async () => {
    mock.method(api, 'changePassword', () => Promise.resolve({ revokedSessions: 0 }))
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)
    await screen.findByText('Password changed.')

    assert.equal(screen.getByLabelText<HTMLInputElement>('Current password').value, '')
    assert.equal(screen.getByLabelText<HTMLInputElement>('New password').value, '')
    assert.equal(screen.getByLabelText<HTMLInputElement>('Repeat new password').value, '')
  })

  it('shows the server error and leaves what you typed on a failed change', async () => {
    mock.method(api, 'changePassword', () =>
      Promise.reject(new ApiError(401, 'wrong-password', 'Current password is incorrect.')),
    )
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)

    assert.ok(await screen.findByText('Current password is incorrect.'))
    // Not cleared: only a successful change resets the form.
    assert.equal(screen.getByLabelText<HTMLInputElement>('New password').value, LONG_ENOUGH)
  })

  it('disables the submit button and says "Saving…" while the request is in flight', async () => {
    let resolveChange!: (value: { revokedSessions: number }) => void
    mock.method(
      api,
      'changePassword',
      () => new Promise<{ revokedSessions: number }>((resolve) => (resolveChange = resolve)),
    )
    const user = userEvent.setup()
    render(<AccountView user={USER} />)

    await fillAndSubmit(user, LONG_ENOUGH, LONG_ENOUGH)

    const button = screen.getByRole('button', { name: 'Saving…' })
    assert.ok(button.hasAttribute('disabled'))

    resolveChange({ revokedSessions: 0 })
    await screen.findByText('Password changed.')
  })

  it('keeps the submit button disabled until both current and new passwords are typed', () => {
    render(<AccountView user={USER} />)
    assert.ok(screen.getByRole('button', { name: 'Change password' }).hasAttribute('disabled'))
  })
})
