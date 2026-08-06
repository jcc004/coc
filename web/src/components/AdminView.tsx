import { useState, type FormEvent } from 'react'
import {
  isValidEmail,
  MIN_PASSWORD_LENGTH,
  type AdminUser,
  type HandEnteredReferenceCategory,
  type MaxLevelReferenceRow,
  type SessionUser,
  type UserRole,
} from '@coc/shared'
import { api, describe } from '../api.ts'
import { formatDateTime } from '../format.ts'
import { useAsync } from '../hooks.ts'
import { parseBulkPasteRows } from '../progress-bulk-paste.ts'
import { refreshProgressReference, useProgressReference } from '../progress.ts'
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

/* ---------- weekly base progress: hand-entered pet & equipment caps ---------- */

const REFERENCE_CATEGORIES: { value: HandEnteredReferenceCategory; label: string }[] = [
  { value: 'pet', label: 'Pets' },
  { value: 'equipment', label: 'Hero equipment' },
]

/** `(name, thLevel)` is the upsert key `max_level_reference` is keyed on. */
function rowKey(row: Pick<MaxLevelReferenceRow, 'name' | 'thLevel'>): string {
  return `${row.name}#${row.thLevel}`
}

/**
 * One stored cap, editable in place — but **only `maxLevel`**. `name` and
 * `thLevel` together are the row's key (`upsertMaxLevelReference`), so letting
 * either drift here would not correct the row, it would upsert a second one and
 * leave the original sitting in the table under its old numbers. Renaming a unit
 * or moving it to a different Town Hall is a new row, added below, not an edit
 * of an old one.
 */
function ReferenceRow({
  category,
  row,
  problem,
  onProblem,
}: {
  category: HandEnteredReferenceCategory
  row: MaxLevelReferenceRow
  problem?: string
  onProblem: (key: string, text: string | null) => void
}) {
  const key = rowKey(row)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(row.maxLevel))
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const maxLevel = Number(draft)
    if (!Number.isInteger(maxLevel) || maxLevel <= 0) {
      onProblem(key, 'Max level must be a positive whole number.')
      return
    }

    setBusy(true)
    onProblem(key, null)
    try {
      await api.saveProgressReference(category, [
        { name: row.name, thLevel: row.thLevel, maxLevel },
      ])
      await refreshProgressReference()
      setEditing(false)
    } catch (cause) {
      onProblem(key, describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr role="row">
      <td className="stack-title" role="cell">
        {row.name}
      </td>
      <td role="cell" data-label="Town Hall">
        {row.thLevel}
      </td>
      <td role="cell" data-label="Max level">
        {editing ? (
          <form className="row-edit" onSubmit={(event) => void submit(event)}>
            <input
              type="number"
              min={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label={`Max level for ${row.name} at Town Hall ${row.thLevel}`}
              autoFocus
            />
            <button type="submit" className="icon-button" disabled={busy || !draft.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setDraft(String(row.maxLevel))
                setEditing(false)
                onProblem(key, null)
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            {row.maxLevel}{' '}
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setDraft(String(row.maxLevel))
                onProblem(key, null)
                setEditing(true)
              }}
              aria-label={`Change the max level for ${row.name} at Town Hall ${row.thLevel}`}
            >
              Edit
            </button>
          </>
        )}
        {problem ? <p className="row-actions__problem">{problem}</p> : null}
      </td>
      <td role="cell" data-label="Updated">
        {formatDateTime(new Date(row.updatedAt))}
      </td>
    </tr>
  )
}

/** Adds one new `(name, thLevel)` row. Same shape as `NewUserForm` above. */
function AddReferenceRowForm({ category }: { category: HandEnteredReferenceCategory }) {
  const [name, setName] = useState('')
  const [thLevel, setThLevel] = useState('')
  const [maxLevel, setMaxLevel] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const trimmedName = name.trim()
    const th = Number(thLevel)
    const max = Number(maxLevel)

    if (!trimmedName) {
      setProblem('Unit name cannot be blank.')
      return
    }
    if (!Number.isInteger(th) || th <= 0) {
      setProblem('Town Hall level must be a positive whole number.')
      return
    }
    if (!Number.isInteger(max) || max <= 0) {
      setProblem('Max level must be a positive whole number.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      await api.saveProgressReference(category, [
        { name: trimmedName, thLevel: th, maxLevel: max },
      ])
      await refreshProgressReference()
      setName('')
      setThLevel('')
      setMaxLevel('')
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
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Unit name"
          aria-label="Unit name"
          autoComplete="off"
        />
        <input
          type="number"
          min={1}
          value={thLevel}
          onChange={(event) => setThLevel(event.target.value)}
          placeholder="Town Hall level"
          aria-label="Town Hall level"
        />
        <input
          type="number"
          min={1}
          value={maxLevel}
          onChange={(event) => setMaxLevel(event.target.value)}
          placeholder="Max level at that Town Hall"
          aria-label="Max level at that Town Hall"
        />
        <button type="submit" disabled={busy || !name.trim() || !thLevel || !maxLevel}>
          {busy ? 'Adding…' : 'Add row'}
        </button>
      </form>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

/**
 * "name, town hall, max level" — one line per row, comma or tab separated (a
 * spreadsheet paste is tab-delimited; typing it by hand is easier with commas).
 * See `parseBulkPasteRows` for the parsing itself, kept pure and tested on its
 * own. Worth having at all because a first-time fill-in is ~10 pets and ~40
 * equipment items across a dozen-plus Town Hall levels each — closer to 150
 * numbers than 15 — and typing each into its own add-row form would be the
 * tedious part of a feature whose whole point is replacing a spreadsheet.
 */
function BulkPastePanel({ category }: { category: HandEnteredReferenceCategory }) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [imported, setImported] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    const parsed = parseBulkPasteRows(text)
    if ('problem' in parsed) {
      setProblem(parsed.problem)
      setImported(null)
      return
    }

    setBusy(true)
    setProblem(null)
    setImported(null)
    try {
      const result = await api.saveProgressReference(category, parsed.rows)
      await refreshProgressReference()
      setText('')
      setImported(result.written)
    } catch (cause) {
      setProblem(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="progress-form" onSubmit={(event) => void submit(event)}>
      <label className="progress-form__field">
        <span className="progress-form__label">
          Bulk paste — one row per line: name, town hall, max level
        </span>
        <textarea
          className="progress-form__notes"
          rows={5}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          placeholder={'L.A.S.S.I, 7, 5\nMighty Yak, 9, 10'}
          aria-label="Bulk paste — one row per line: name, town hall, max level"
        />
      </label>
      <button type="submit" disabled={busy || !text.trim()}>
        {busy ? 'Importing…' : 'Import pasted rows'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
      {imported !== null ? (
        <p className="notice__hint">
          Imported {imported} row{imported === 1 ? '' : 's'}.
        </p>
      ) : null}
    </form>
  )
}

/**
 * Pet and hero-equipment level caps — the two `max_level_reference` categories
 * the weekly wiki scrape (`refresh-reference.ts`) cannot cover, because their
 * wiki pages use table layouts (rowspan grids; rarity not stated on the page)
 * it will not parse on a guess rather than risk a silently-wrong number. Hero,
 * troop, spell and wall caps need no admin attention at all — they refresh on
 * their own every week.
 *
 * Reads through `useProgressReference`, the same module-level store every other
 * "% to max" computation in the app shares, so what an admin sees here before
 * typing anything is the same table the percent bars are already scoring
 * against — including a category with nothing in it yet, today.
 */
function ProgressReferenceCard() {
  const [category, setCategory] = useState<HandEnteredReferenceCategory>('pet')
  const [rowProblems, setRowProblems] = useState<Record<string, string>>({})
  const reference = useProgressReference()

  function setRowProblem(key: string, text: string | null): void {
    setRowProblems((current) => {
      const next = { ...current }
      if (text === null) delete next[key]
      else next[key] = text
      return next
    })
  }

  const activeLabel =
    REFERENCE_CATEGORIES.find((option) => option.value === category)?.label ?? category
  const rows = reference.maxLevels
    .filter((row) => row.category === category)
    .sort((a, b) => a.name.localeCompare(b.name) || a.thLevel - b.thLevel)

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="section-title" style={{ marginBottom: 0 }}>
          Level caps: pets &amp; hero equipment
        </h2>
      </div>
      <p className="empty-hint">
        Hero, troop, spell and wall caps refresh on their own every week from the wiki. Pet and
        hero equipment do not — their wiki pages cannot be parsed safely, so they are entered here
        by hand instead. The numbers only move when Supercell changes them, so this is occasional
        upkeep, not a weekly one.
      </p>

      <div className="progress-reference-tabs" role="group" aria-label="Reference category">
        {REFERENCE_CATEGORIES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="icon-button"
            aria-pressed={category === option.value}
            onClick={() => setCategory(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {reference.status === 'loading' ? <Loading what="the reference tables" /> : null}
      {reference.status === 'error' && reference.error ? (
        <ErrorPanel error={reference.error} />
      ) : null}

      {reference.status === 'ready' ? (
        <div className="table-wrap">
          <table className="roster roster--stack" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader">Unit</th>
                <th role="columnheader">Town Hall</th>
                <th role="columnheader">Max level</th>
                <th role="columnheader">Updated</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {rows.length === 0 ? (
                <tr role="row">
                  <td role="cell" colSpan={4}>
                    No {activeLabel.toLowerCase()} entered yet — add rows below.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <ReferenceRow
                    key={rowKey(row)}
                    category={category}
                    row={row}
                    problem={rowProblems[rowKey(row)]}
                    onProblem={setRowProblem}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      <h3 className="section-title" style={{ fontSize: 14, marginTop: 20 }}>
        Add a row
      </h3>
      <AddReferenceRowForm category={category} />

      <h3 className="section-title" style={{ fontSize: 14, marginTop: 20 }}>
        Bulk paste
      </h3>
      <BulkPastePanel category={category} />
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
  return (
    <>
      <UsersCard currentUserId={user.id} />
      <ProgressReferenceCard />
    </>
  )
}
