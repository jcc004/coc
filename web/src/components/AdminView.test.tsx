import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminUser } from '@coc/shared'
import { api, ApiError } from '../api.ts'
import { adminAccount, installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { AdminView } from './AdminView.tsx'

/**
 * The admin panel is the one screen here where a mistake is a security incident rather
 * than a wrong number: it creates accounts, disables them, changes who is an admin, and
 * prints the only copy of a temporary password that will ever exist.
 *
 * So the assertions are about which call went out with which arguments, and about what
 * the screen does and does not still hold afterwards — never about markup. The one
 * exception is the create form's copy, where the words *are* the behavior: they are
 * what an admin acts on when they decide how to hand the password over.
 */

installTestCleanup()

const ADMIN = adminAccount({ id: 1, displayName: 'Rae', email: 'rae@example.com', role: 'admin' })
const MEMBER = adminAccount({ id: 2, displayName: 'Sam', email: 'sam@example.com', role: 'user' })

/** Renders the panel for `who` and waits for the account rows to arrive. */
async function panel(accounts: AdminUser[], who = ADMIN) {
  const user = userEvent.setup()
  render(<AdminView user={who} />)
  for (const account of accounts) await screen.findByText(account.displayName)
  return user
}

describe('the guard', () => {
  it('refuses the panel to an account that is not an admin, and asks the server for nothing', () => {
    const users = mock.method(api, 'users', () => Promise.resolve({ users: [] }))
    stubApi({})

    render(<AdminView user={sessionUser({ role: 'user' })} />)

    // A refusal, not a redirect: being sent home for typing a URL leaves you
    // wondering whether the page exists or whether something broke.
    assert.ok(screen.getByText(/admins only/))
    assert.equal(screen.queryByLabelText("New user's email"), null)
    // And not merely hidden: the list of accounts was never requested.
    assert.equal(users.mock.callCount(), 0)
  })
})

describe('creating an account', () => {
  it('sends what was typed, trimming the name but never the password', async () => {
    const createUser = mock.method(api, 'createUser', () => Promise.resolve({ user: MEMBER }))
    stubApi({ users: () => Promise.resolve({ users: [ADMIN] }) })
    const user = await panel([ADMIN])

    await user.type(screen.getByLabelText("New user's email"), 'Nia@Example.com')
    await user.type(screen.getByLabelText("New user's display name"), '  Nia  ')
    await user.type(screen.getByLabelText('Initial password'), '  correct horse battery  ')
    await user.selectOptions(screen.getByLabelText('Role'), 'admin')
    await user.click(screen.getByRole('button', { name: 'Add user' }))

    await waitFor(() => assert.equal(createUser.mock.callCount(), 1))
    assert.deepEqual(createUser.mock.calls[0]?.arguments, [
      {
        email: 'Nia@Example.com',
        displayName: 'Nia',
        // Untouched: leading and trailing space is part of a password, and trimming it
        // here would hand over a string that no longer signs the account in.
        password: '  correct horse battery  ',
        role: 'admin',
      },
    ])
  })

  it('tells the admin the new account will be asked to choose its own password', async () => {
    /* The server flags every admin-created account `mustChangePassword`, so the
       password this form takes is spent the moment it is used. The copy used to read as
       though changing it were optional, and an admin who believes that has no reason
       not to reuse one password across every account they create. */
    stubApi({ users: () => Promise.resolve({ users: [ADMIN] }) })
    await panel([ADMIN])

    const hint = screen.getByText(/Tell them the initial password out of band/)
    assert.match(hint.textContent ?? '', /asked to choose their own password/)
  })

  it('reports a refusal at the form and keeps what was typed', async () => {
    const refusal = new ApiError(409, 'emailTaken', 'That email address already has an account.')
    stubApi({
      users: () => Promise.resolve({ users: [ADMIN] }),
      createUser: () => Promise.reject(refusal),
    })
    const user = await panel([ADMIN])

    const email = screen.getByLabelText("New user's email")
    await user.type(email, 'nia@example.com')
    await user.type(screen.getByLabelText('Initial password'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Add user' }))

    await screen.findByText(refusal.message)
    /* The form is cleared on success only. A 409 here usually needs one character
       changed, and clearing four fields to say so would be a punishment. */
    assert.equal((email as HTMLInputElement).value, 'nia@example.com')
  })
})

describe('the temporary password', () => {
  const secret = 'ripe-tangent-9142'

  const issuing = (revokedSessions = 2) => ({
    users: () => Promise.resolve({ users: [ADMIN, MEMBER] }),
    issueTempPassword: () => Promise.resolve({ user: MEMBER, password: secret, revokedSessions }),
  })

  const issueFor = (user: Awaited<ReturnType<typeof panel>>) =>
    user.click(
      screen.getByRole('button', { name: `Issue a temporary password for ${MEMBER.displayName}` }),
    )

  it('is shown once and kept nowhere', async () => {
    stubApi(issuing())
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await issueFor(user)
    await screen.findByText(secret)

    /*
     * The response body is the only place this plaintext will ever exist, so the panel
     * has to be the only place it goes. Storage, the address bar and any form control a
     * browser could autofill later are each a way for it to outlive the screen.
     */
    const holds = (value: string | null) => value !== null && value.includes(secret)
    assert.ok(!Object.keys(localStorage).some((key) => holds(localStorage.getItem(key))))
    assert.ok(!Object.keys(sessionStorage).some((key) => holds(sessionStorage.getItem(key))))
    assert.ok(!holds(window.location.href))
    for (const field of document.querySelectorAll('input')) assert.ok(!holds(field.value))

    // And gone for good once dismissed — there is nothing to scroll back to.
    await user.click(screen.getByRole('button', { name: 'Done — I have it' }))
    await waitFor(() => assert.equal(screen.queryByText(secret), null))
  })

  it('admits a copy did not happen rather than letting the password be lost', async () => {
    stubApi(issuing(0))
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await issueFor(user)
    await screen.findByText(secret)

    /* Defined after `setup()`, which installs a clipboard of its own. A refusal is what
       a real browser does when the page is not focused or the permission is denied. */
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    })

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    await screen.findByText(/Copy was blocked/)
    // Still legible, which is the whole point of admitting the copy failed.
    assert.ok(screen.getByText(secret))
  })

  it('is not issued when the confirmation is refused', async () => {
    const issue = mock.method(api, 'issueTempPassword', () =>
      Promise.resolve({ user: MEMBER, password: 'unused', revokedSessions: 0 }),
    )
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, MEMBER] }) })
    const confirm = mock.method(window, 'confirm', () => false)
    const user = await panel([ADMIN, MEMBER])

    await issueFor(user)

    assert.equal(confirm.mock.callCount(), 1)
    assert.equal(issue.mock.callCount(), 0)
  })
})

describe('changing a role', () => {
  it('promotes another account without the self-demotion confirmation', async () => {
    const setUserRole = mock.method(api, 'setUserRole', () =>
      Promise.resolve({ user: { ...MEMBER, role: 'admin' as const } }),
    )
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, MEMBER] }) })
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await user.click(screen.getByRole('button', { name: `Make ${MEMBER.displayName} an admin` }))

    await waitFor(() => assert.equal(setUserRole.mock.callCount(), 1))
    assert.deepEqual(setUserRole.mock.calls[0]?.arguments, [MEMBER.id, 'admin', false])
  })

  it('sends the explicit confirmation when an admin removes their own admin role', async () => {
    const setUserRole = mock.method(api, 'setUserRole', () =>
      Promise.resolve({ user: { ...ADMIN, role: 'user' as const } }),
    )
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, MEMBER] }) })
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await user.click(screen.getByRole('button', { name: `Remove admin from ${ADMIN.displayName}` }))

    await waitFor(() => assert.equal(setUserRole.mock.callCount(), 1))
    // The server demands `confirm` to strip your own role, since you cannot restore it.
    assert.deepEqual(setUserRole.mock.calls[0]?.arguments, [ADMIN.id, 'user', true])
  })

  it('surfaces the last-active-admin refusal at the row that caused it', async () => {
    const refusal = new ApiError(
      409,
      'lastAdmin',
      'The last active admin cannot give up the role — promote somebody else first.',
    )
    stubApi({
      users: () => Promise.resolve({ users: [ADMIN, MEMBER] }),
      setUserRole: () => Promise.reject(refusal),
    })
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await user.click(screen.getByRole('button', { name: `Remove admin from ${ADMIN.displayName}` }))

    // The server's own wording, beside the control, not as a page-level toast.
    const problem = await screen.findByText(refusal.message)
    assert.ok(problem.closest('.row-actions'))
    assert.match(problem.closest('tr')?.textContent ?? '', new RegExp(ADMIN.displayName))
    // Still an admin: a refused write must never look like one that took.
    assert.ok(screen.getByRole('button', { name: `Remove admin from ${ADMIN.displayName}` }))
  })
})

describe('disabling an account', () => {
  it('disables and re-enables the account named by the row that was pressed', async () => {
    const disabled = adminAccount({ ...MEMBER, disabledAt: '2026-08-01T00:00:00.000Z' })
    let accounts: AdminUser[] = [ADMIN, MEMBER]
    /* Stands in for the server: the refetch after a write is what redraws the row, so a
       stub that ignored the write would leave the control saying Disable for ever. */
    const setUserDisabled = mock.method(api, 'setUserDisabled', (_id: number, disable: boolean) => {
      accounts = [ADMIN, disable ? disabled : MEMBER]
      return Promise.resolve({ user: disable ? disabled : MEMBER })
    })
    stubApi({ users: () => Promise.resolve({ users: accounts }) })
    mock.method(window, 'confirm', () => true)
    const user = await panel([ADMIN, MEMBER])

    await user.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => assert.equal(setUserDisabled.mock.callCount(), 1))
    assert.deepEqual(setUserDisabled.mock.calls[0]?.arguments, [MEMBER.id, true])

    await user.click(await screen.findByRole('button', { name: 'Re-enable' }))
    await waitFor(() => assert.equal(setUserDisabled.mock.callCount(), 2))
    assert.deepEqual(setUserDisabled.mock.calls[1]?.arguments, [MEMBER.id, false])
  })

  it('is not offered on your own row, since the last active admin has to stay usable', async () => {
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, MEMBER] }) })
    await panel([ADMIN, MEMBER])

    const buttons = screen.getAllByRole('button', { name: 'Disable' })
    assert.equal(buttons.length, 1)
    assert.match(buttons[0]?.closest('tr')?.textContent ?? '', new RegExp(MEMBER.displayName))
  })

  it('disables nothing when the confirmation is refused', async () => {
    const setUserDisabled = mock.method(api, 'setUserDisabled', () =>
      Promise.resolve({ user: MEMBER }),
    )
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, MEMBER] }) })
    const confirm = mock.method(window, 'confirm', () => false)
    const user = await panel([ADMIN, MEMBER])

    await user.click(screen.getByRole('button', { name: 'Disable' }))

    assert.equal(confirm.mock.callCount(), 1)
    assert.equal(setUserDisabled.mock.callCount(), 0)
  })
})

describe('the account table', () => {
  it('names an account that still has to change its password', async () => {
    const pending = adminAccount({ ...MEMBER, mustChangePassword: true })
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, pending] }) })
    await panel([ADMIN, pending])

    const row = screen.getByText(pending.displayName).closest('tr')
    assert.match(row?.textContent ?? '', /Must change password/)
  })

  it('says an account with no email cannot sign in at all', async () => {
    const noEmail = adminAccount({ ...MEMBER, email: null })
    stubApi({ users: () => Promise.resolve({ users: [ADMIN, noEmail] }) })
    await panel([ADMIN, noEmail])

    // Email *is* the credential, so a null one is a fact about the account rather
    // than a blank cell.
    assert.ok(screen.getByText('No email — cannot sign in'))
  })
})
