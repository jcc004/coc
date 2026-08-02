import { useState, type FormEvent } from 'react'
import { isValidEmail, MIN_PASSWORD_LENGTH, type SessionUser, type UserRole } from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { formatDateTime } from '../format.ts'
import { useAsync } from '../hooks.ts'
import { ErrorPanel, Loading } from './primitives.tsx'

/**
 * Account settings: a password change for anyone, plus user management for
 * admins. One page rather than two so there is a single place to send someone.
 */

function Message({ text, tone }: { text: string; tone: 'error' | 'ok' }) {
  return (
    <div className={tone === 'error' ? 'notice notice--error' : 'notice'}>
      <p className="notice__body">{text}</p>
    </div>
  )
}

function describe(cause: unknown): string {
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
      <div className="table-wrap">
        <table className="roster">
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
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          placeholder="Current password"
          aria-label="Current password"
          autoComplete="current-password"
        />
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder={`New password (at least ${MIN_PASSWORD_LENGTH} characters)`}
          aria-label="New password"
          autoComplete="new-password"
        />
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="Repeat new password"
          aria-label="Repeat new password"
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
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={`Initial password (${MIN_PASSWORD_LENGTH}+ characters)`}
          aria-label="Initial password"
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

function UsersCard({ currentUserId }: { currentUserId: number }) {
  const [version, setVersion] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const state = useAsync((signal) => api.users(signal), [version])

  const reload = () => setVersion((n) => n + 1)

  async function toggle(id: number, label: string, disabled: boolean): Promise<void> {
    const verb = disabled ? 'Disable' : 'Re-enable'
    // Worth spelling out: the shared rows they entered are not going anywhere.
    if (!window.confirm(`${verb} ${label}? Saved clans and owners they set are kept.`)) return

    setProblem(null)
    try {
      await api.setUserDisabled(id, disabled)
      reload()
    } catch (cause) {
      setProblem(describe(cause))
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

      {state.status === 'loading' ? <Loading what="users" /> : null}
      {state.status === 'error' ? <ErrorPanel error={state.error} /> : null}

      {state.status === 'ready' ? (
        <div className="table-wrap">
          <table className="roster">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>ID</th>
                <th>Role</th>
                <th>Added</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.users.map((user) => (
                <tr key={user.id}>
                  <td>{user.displayName}</td>
                  {/* No email means this account cannot sign in at all. */}
                  <td>{user.email ?? <span className="role-pill">No email — cannot sign in</span>}</td>
                  <td className="tag-cell">{user.guid}</td>
                  <td className="role-pill">{user.role === 'admin' ? 'Admin' : 'User'}</td>
                  <td>{formatDateTime(new Date(user.createdAt))}</td>
                  {/* Words, not a colour: disabled has to be legible on its own. */}
                  <td>{user.disabledAt ? 'Disabled' : 'Active'}</td>
                  <td className="row-actions">
                    {user.id === currentUserId ? (
                      <span className="role-pill">You</span>
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void toggle(user.id, user.displayName, !user.disabledAt)}
                      >
                        {user.disabledAt ? 'Re-enable' : 'Disable'}
                      </button>
                    )}
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
