import { useState, type FormEvent } from 'react'
import {
  isValidEmail,
  MIN_PASSWORD_LENGTH,
  type AdminUser,
  type SessionUser,
  type UserRole,
} from '@coc/shared'
import { api, describe } from '../api.ts'
import { formatDateTime } from '../format.ts'
import { useAsync } from '../hooks.ts'
import { ErrorPanel, Loading, PasswordField } from './primitives.tsx'

/**
 * The admin panel: the accounts, and everything only an admin may do to them —
 * create one, rename it, correct its address, promote or demote it, disable it, or
 * hand it a temporary password.
 *
 * **Its own page (`#/admin`), reached from the user menu.** It used to be a third
 * card under Your account and Change password, hidden from members. That put an
 * admin's rarest and most consequential controls directly beneath the form they use
 * to change their own password, and it made "the account page" mean two different
 * things depending on who opened it.
 *
 * Recovery is admin-mediated throughout: there is no mail infrastructure, so an
 * admin correcting an address or reading out a temporary password is the whole
 * story. See `docs/authentication.md` — "Password recovery is admin-mediated, and
 * there is deliberately no email reset" — for why a public reset route is absent.
 * (That was in the README until it was split into `docs/`.)
 */

/**
 * The refusal a member gets for asking directly.
 *
 * **A refusal, not a redirect.** Bouncing somebody to the homepage for typing a URL
 * leaves them wondering whether the page exists, whether they mistyped, or whether
 * something broke. This says which of those it is. It is also only the *screen*:
 * every `/api/admin/*` route is gated by `requireAdmin` on the server, so a member
 * who reaches this page has been told no, not merely shown less.
 */
function NotAnAdmin() {
  return (
    <section className="card">
      <h2 className="section-title">Admin panel</h2>
      <p className="empty-hint">
        This page manages the accounts, so it is <strong>admins only</strong> — your account is
        not one, and nothing here is hidden from you by accident. Ask an admin if you need an
        address corrected, a password reset, or a new account created.
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

    /*
     * A backstop, and only that — not the round-trip saving this comment used to
     * claim. The input below is `type="email"`, whose native constraint validation
     * is *stricter* than `isValidEmail` and refuses to submit the form at all, so
     * nothing reachable through the UI gets this far having failed it. Found by
     * writing a test for this branch that could not be made to fail.
     *
     * It stays because it is what holds if the input type changes, or if the form is
     * ever submitted programmatically — both of which would otherwise send a
     * malformed address and surface the server's 400 instead of this sentence.
     */
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
      <form className="search" onSubmit={(event) => void submit(event)}>
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
      {/*
       * The password this form takes is a **hand-over**, not the account's password:
       * the server flags every admin-created account `mustChangePassword`, so it is
       * spent the moment it is used and the account picks its own before it can reach
       * anything else. The copy used to say they "can change it here once signed in",
       * which read as optional — and an admin who believes it is optional has no
       * reason not to reuse one password across every account they create.
       */}
      <p className="lookup-preview">
        They sign in with this email address. A blank display name uses the part before the @.
        Tell them the initial password out of band: it gets them in once, and then they are
        asked to choose their own password before they can use anything else.
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
      <form className="row-edit" onSubmit={(event) => void submit(event)}>
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

    // A backstop, for the reason spelled out on the same check in NewUserForm: the
    // input is `type="email"`, so native validation already refuses to submit
    // anything this would catch. It is not the round-trip saving it once claimed.
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
      <form className="row-edit" onSubmit={(event) => void submit(event)}>
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
          {/* One labeled card per user on a phone; nothing sorts, so the header
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
                  {/* Words, not a color: disabled has to be legible on its own. */}
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

/**
 * The page. Everything below the guard needs an admin, and the guard is here rather
 * than at the route so that a direct `#/admin` says why instead of appearing to be
 * a broken link.
 */
export function AdminView({ user }: { user: SessionUser }) {
  if (user.role !== 'admin') return <NotAnAdmin />
  return <UsersCard currentUserId={user.id} />
}
