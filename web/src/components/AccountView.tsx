import { useState, type FormEvent } from 'react'
import {
  isValidEmail,
  MIN_PASSWORD_LENGTH,
  type AdminUser,
  type SessionUser,
  type UserRole,
} from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { formatDateTime } from '../format.ts'
import { useAsync } from '../hooks.ts'
import { ErrorPanel, Loading, PasswordField } from './primitives.tsx'

/**
 * Account settings: a password change for anyone, plus user management for
 * admins. One page rather than two so there is a single place to send someone.
 *
 * Recovery is admin-mediated throughout — there is no mail infrastructure, so an
 * admin correcting an address or handing over a temporary password is the whole
 * story. See the README for why a public reset route is deliberately absent.
 */

function Message({ text, tone }: { text: string; tone: 'error' | 'ok' }) {
  return (
    <div className={tone === 'error' ? 'notice notice--error' : 'notice'}>
      <p className="notice__body">{text}</p>
    </div>
  )
}

export function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : 'Could not reach the server.'
}

/**
 * Who you are, as the server has it. The guid is shown but not editable: it is the
 * stable handle for this account, so it is worth being able to quote in a bug
 * report, and worth nobody being able to change.
 */
function IdentityCard({ user }: { user: SessionUser }) {
  return (
    <section className="card">
      <h2 className="section-title">Your account</h2>
      {/* Two columns at every width, so this one never stacks — `--pairs` only
          lets the cells wrap, which a 36-character guid needs on a phone. */}
      <div className="table-wrap">
        <table className="roster roster--pairs">
          <tbody>
            <tr>
              <th scope="row">Display name</th>
              <td>{user.displayName}</td>
            </tr>
            <tr>
              <th scope="row">Email</th>
              {/* Also the sign-in credential, which is worth saying here. */}
              <td>{user.email ?? <span className="role-pill">Not set</span>}</td>
            </tr>
            <tr>
              <th scope="row">ID</th>
              <td className="tag-cell">{user.guid}</td>
            </tr>
            <tr>
              <th scope="row">Role</th>
              <td className="role-pill">{user.role === 'admin' ? 'Admin' : 'User'}</td>
            </tr>
            <tr>
              <th scope="row">Added</th>
              <td>{formatDateTime(new Date(user.createdAt))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="lookup-preview">
        You sign in with your email address. Ask an admin to change it — the ID is fixed.
      </p>
    </section>
  )
}

function PasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [result, setResult] = useState<{ text: string; tone: 'error' | 'ok' } | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return

    if (next !== confirm) {
      setResult({ text: 'The two new passwords do not match.', tone: 'error' })
      return
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setResult({
        text: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        tone: 'error',
      })
      return
    }

    setBusy(true)
    try {
      const { revokedSessions } = await api.changePassword(current, next)
      setResult({
        text:
          revokedSessions > 0
            ? `Password changed. ${revokedSessions} other session${revokedSessions === 1 ? '' : 's'} signed out.`
            : 'Password changed.',
        tone: 'ok',
      })
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (cause) {
      setResult({ text: describe(cause), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">Change password</h2>
      {result ? <Message text={result.text} tone={result.tone} /> : null}

      <form className="search search--stacked" onSubmit={submit}>
        <PasswordField
          label="Current password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <PasswordField
          label="New password"
          placeholder={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <PasswordField
          label="Repeat new password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <button type="submit" disabled={busy || !current || !next}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>

      <p className="lookup-preview">
        Changing your password signs out every other session, so it is also how you get rid of
        someone who has the old one.
      </p>
    </section>
  )
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return

    // Checked here as well as server-side, so a typo does not cost a round trip.
    if (!isValidEmail(email)) {
      setProblem('That is not an email address — one @, no spaces.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      await api.createUser({ email: email.trim(), displayName: displayName.trim(), password, role })
      setEmail('')
      setDisplayName('')
      setPassword('')
      setRole('user')
      onCreated()
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form className="search" onSubmit={submit}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email"
          aria-label="New user's email"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Display name (optional)"
          aria-label="New user's display name"
          autoComplete="off"
        />
        <PasswordField
          label="Initial password"
          placeholder={`Initial password (${MIN_PASSWORD_LENGTH}+ characters)`}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <select
          value={role}
          onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'user')}
          aria-label="Role"
        >
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Adding…' : 'Add user'}
        </button>
      </form>
      {problem ? <p className="notice__hint">{problem}</p> : null}
      <p className="lookup-preview">
        They sign in with this email address. A blank display name uses the part before the @.
        Tell them the initial password out of band; they can change it here once signed in.
      </p>
    </>
  )
}

/**
 * The temporary password, on screen for the only time it will ever be legible.
 * The server keeps a hash, so if this is lost the only remedy is issuing another
 * one — hence the warning and the copy button rather than a quiet toast.
 *
 * Nothing here stores the value: no `localStorage`, no URL, no hidden input that
 * a form could autofill later. It lives in the parent's state until dismissed and
 * then it is gone.
 */
function TempPasswordPanel({
  user,
  password,
  revokedSessions,
  isSelf,
  onDismiss,
}: {
  user: AdminUser
  password: string
  revokedSessions: number
  isSelf: boolean
  onDismiss: () => void
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function toClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(password)
      setCopy('copied')
    } catch {
      // Clipboard access can simply be refused. Saying so is the only honest
      // option — claiming a copy that did not happen loses the password.
      setCopy('failed')
    }
  }

  return (
    <div className="notice temp-password">
      <p className="notice__title">
        Temporary password for {user.displayName}
        {user.email ? ` <${user.email}>` : ''}
      </p>
      {/* Monospace and selectable, so it can be read out or picked up by hand
          if the clipboard is unavailable. */}
      <p className="temp-password__value">{password}</p>
      <div className="temp-password__actions">
        <button type="button" className="icon-button" onClick={() => void toClipboard()}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="icon-button" onClick={onDismiss}>
          {isSelf ? 'Done — change my password now' : 'Done — I have it'}
        </button>
        {copy === 'failed' ? (
          <span className="role-pill">Copy was blocked — select the text instead.</span>
        ) : null}
      </div>
      <p className="notice__hint">
        <strong>Shown only once.</strong> The server stores a hash, not this text, so nobody can
        look it up later — if you lose it, issue another one.{' '}
        {isSelf
          ? 'This is your own account: keep it to hand, because the next screen asks for it.'
          : `Give it to ${user.displayName} by some channel you already trust.`}{' '}
        The old password stopped working and{' '}
        {revokedSessions === 1 ? '1 session was' : `${revokedSessions} sessions were`} signed out;
        a new password has to be set before {isSelf ? 'you' : 'they'} can use anything else.
      </p>
    </div>
  )
}

/**
 * The inline editor in the name cell. Same shape as the email cell, but a display
 * name is not a credential, so saving it revokes nothing.
 */
function NameCell({
  user,
  isSelf,
  onSaved,
  onProblem,
}: {
  user: AdminUser
  isSelf: boolean
  onSaved: () => void
  onProblem: (id: number, text: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(user.displayName)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const trimmed = draft.trim()
    if (!trimmed) {
      onProblem(user.id, 'A display name cannot be blank.')
      return
    }

    setBusy(true)
    onProblem(user.id, null)
    try {
      await api.setUserDisplayName(user.id, trimmed)
      setEditing(false)
      onSaved()
    } catch (cause) {
      onProblem(user.id, describe(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      /* The card's heading when the table stacks, so it carries no `data-label`. */
      <td className="stack-title" role="cell">
        {user.displayName}
        {isSelf ? <span className="role-pill"> (you)</span> : null}{' '}
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setDraft(user.displayName)
            onProblem(user.id, null)
            setEditing(true)
          }}
          aria-label={`Change the display name for ${user.displayName}`}
        >
          Edit
        </button>
      </td>
    )
  }

  return (
    <td className="stack-title" role="cell">
      <form className="row-edit" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Display name for ${user.displayName}`}
          autoComplete="off"
          autoFocus
        />
        <button type="submit" className="icon-button" disabled={busy || !draft.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setEditing(false)
            onProblem(user.id, null)
          }}
        >
          Cancel
        </button>
      </form>
    </td>
  )
}

/** The inline editor in the email cell. Own form, so Enter saves that one row. */
function EmailCell({
  user,
  onSaved,
  onProblem,
}: {
  user: AdminUser
  onSaved: () => void
  onProblem: (id: number, text: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(user.email ?? '')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    // Checked here as well as server-side so a typo costs no round trip.
    if (!isValidEmail(draft)) {
      onProblem(user.id, 'That is not an email address — one @, no spaces.')
      return
    }

    setBusy(true)
    onProblem(user.id, null)
    try {
      await api.setUserEmail(user.id, draft.trim())
      setEditing(false)
      onSaved()
    } catch (cause) {
      // Reported at this row's control, and the editor stays open holding the
      // rejected value — a 409 usually means one character needs changing.
      onProblem(user.id, describe(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <td role="cell" data-label="Email">
        {/* No email means this account cannot sign in at all. */}
        {user.email ?? <span className="role-pill">No email — cannot sign in</span>}{' '}
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setDraft(user.email ?? '')
            onProblem(user.id, null)
            setEditing(true)
          }}
          aria-label={`Change the email address for ${user.displayName}`}
        >
          Edit
        </button>
      </td>
    )
  }

  return (
    <td role="cell" data-label="Email">
      <form className="row-edit" onSubmit={submit}>
        <input
          type="email"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Email address for ${user.displayName}`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
        />
        <button type="submit" className="icon-button" disabled={busy || !draft.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setEditing(false)
            onProblem(user.id, null)
          }}
        >
          Cancel
        </button>
      </form>
    </td>
  )
}

interface Issued {
  user: AdminUser
  password: string
  revokedSessions: number
}

function UsersCard({ currentUserId }: { currentUserId: number }) {
  const [version, setVersion] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  /** Per-row failures, so a rejected write is reported where it was triggered. */
  const [rowProblems, setRowProblems] = useState<Record<number, string>>({})
  const [issued, setIssued] = useState<Issued | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const state = useAsync((signal) => api.users(signal), [version])

  const reload = () => setVersion((n) => n + 1)

  function setRowProblem(id: number, text: string | null): void {
    setRowProblems((current) => {
      const next = { ...current }
      if (text === null) delete next[id]
      else next[id] = text
      return next
    })
  }

  async function toggle(id: number, label: string, disabled: boolean): Promise<void> {
    const verb = disabled ? 'Disable' : 'Re-enable'
    // Worth spelling out: the shared rows they entered are not going anywhere.
    if (!window.confirm(`${verb} ${label}? Saved clans and owners they set are kept.`)) return

    setProblem(null)
    setRowProblem(id, null)
    try {
      await api.setUserDisabled(id, disabled)
      reload()
    } catch (cause) {
      setRowProblem(id, describe(cause))
    }
  }

  async function changeRole(user: AdminUser): Promise<void> {
    const promoting = user.role !== 'admin'
    const isSelf = user.id === currentUserId

    const question = promoting
      ? `Make ${user.displayName} an admin? They will be able to manage users, including issuing temporary passwords.`
      : isSelf
        ? 'Remove your own admin role? You will not be able to restore it yourself — another admin would have to.'
        : `Remove admin from ${user.displayName}?`
    if (!window.confirm(question)) return

    setProblem(null)
    setRowProblem(user.id, null)
    setBusyId(user.id)
    try {
      // The server demands explicit confirmation to strip your own admin role;
      // the dialog above is that confirmation.
      await api.setUserRole(user.id, promoting ? 'admin' : 'user', isSelf)
      reload()
    } catch (cause) {
      setRowProblem(user.id, describe(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function issueTempPassword(user: AdminUser): Promise<void> {
    const isSelf = user.id === currentUserId
    if (
      !window.confirm(
        `Issue a temporary password for ${user.displayName}?\n\n` +
          'Their current password stops working immediately and they will have to set a new one. ' +
          (isSelf
            ? 'This is your own account, so you will be asked to change it next.'
            : 'The password is shown once and cannot be retrieved afterwards.'),
      )
    ) {
      return
    }

    setProblem(null)
    setRowProblem(user.id, null)
    setBusyId(user.id)
    setIssued(null)
    try {
      const result = await api.issueTempPassword(user.id)
      setIssued({
        user: result.user,
        password: result.password,
        revokedSessions: result.revokedSessions,
      })
      /*
       * Not reloaded when the target is you: your own account is now flagged, so
       * the refetch would 403, the global handler would swap the whole app for the
       * change-password screen, and this panel — the only place the password will
       * ever be legible — would go with it. Dismissing does that reload instead,
       * which is the point of the panel's "I have it" button.
       */
      if (!isSelf) reload()
    } catch (cause) {
      setRowProblem(user.id, describe(cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>
          Users
        </h2>
      </div>

      <NewUserForm onCreated={reload} />
      {problem ? <p className="notice__hint">{problem}</p> : null}

      {/* Above the table, because it is the one thing on this page that cannot
          be recovered by scrolling back to it later. */}
      {issued ? (
        <TempPasswordPanel
          user={issued.user}
          password={issued.password}
          revokedSessions={issued.revokedSessions}
          isSelf={issued.user.id === currentUserId}
          onDismiss={() => {
            setIssued(null)
            // For your own account this is the hand-off: the refetch 403s, and
            // the app swaps itself for the change-password screen.
            reload()
          }}
        />
      ) : null}

      {state.status === 'loading' ? <Loading what="users" /> : null}
      {state.status === 'error' ? <ErrorPanel error={state.error} /> : null}

      {state.status === 'ready' ? (
        <div className="table-wrap">
          {/* One labelled card per user on a phone; nothing sorts, so the header
              row is hidden rather than kept — see the note in styles.css. */}
          <table className="roster roster--stack" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader">Name</th>
                <th role="columnheader">Email</th>
                <th role="columnheader">Role</th>
                <th role="columnheader">Added</th>
                <th role="columnheader">Status</th>
                <th role="columnheader" />
              </tr>
            </thead>
            <tbody role="rowgroup">
              {state.data.users.map((user) => (
                <tr key={user.id} role="row">
                  <NameCell
                    user={user}
                    isSelf={user.id === currentUserId}
                    onSaved={reload}
                    onProblem={setRowProblem}
                  />
                  <EmailCell user={user} onSaved={reload} onProblem={setRowProblem} />
                  <td role="cell" data-label="Role">
                    <span className="role-pill">{user.role === 'admin' ? 'Admin' : 'User'}</span>{' '}
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void changeRole(user)}
                      disabled={busyId === user.id}
                      aria-label={
                        user.role === 'admin'
                          ? `Remove admin from ${user.displayName}`
                          : `Make ${user.displayName} an admin`
                      }
                    >
                      {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                    </button>
                  </td>
                  <td role="cell" data-label="Added">
                    {formatDateTime(new Date(user.createdAt))}
                  </td>
                  {/* Words, not a colour: disabled has to be legible on its own. */}
                  <td role="cell" data-label="Status">
                    {user.disabledAt ? 'Disabled' : 'Active'}
                    {user.mustChangePassword ? (
                      <>
                        <br />
                        <span className="role-pill">Must change password</span>
                      </>
                    ) : null}
                  </td>
                  <td className="row-actions" role="cell">
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void issueTempPassword(user)}
                      disabled={busyId === user.id}
                      aria-label={`Issue a temporary password for ${user.displayName}`}
                    >
                      {busyId === user.id ? 'Issuing…' : 'Temp password'}
                    </button>
                    {/* Disabling yourself is refused by the server anyway — the
                        last active admin has to stay usable — so the control is
                        simply not offered on your own row. */}
                    {user.id === currentUserId ? null : (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void toggle(user.id, user.displayName, !user.disabledAt)}
                      >
                        {user.disabledAt ? 'Re-enable' : 'Disable'}
                      </button>
                    )}
                    {/* At the control that caused it, never as a page-level toast. */}
                    {rowProblems[user.id] ? (
                      <p className="row-actions__problem">{rowProblems[user.id]}</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

export function AccountView({ user }: { user: SessionUser }) {
  return (
    <>
      <IdentityCard user={user} />
      <PasswordCard />
      {user.role === 'admin' ? <UsersCard currentUserId={user.id} /> : null}
    </>
  )
}
