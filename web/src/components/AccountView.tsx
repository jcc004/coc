import { useState, type FormEvent } from 'react'
import { MIN_PASSWORD_LENGTH, type SessionUser } from '@coc/shared'
import { api, describe } from '../api.ts'
import { formatDateTime } from '../format.ts'
import { hrefFor } from '../hooks.ts'
import { ColorSchemeCard } from './ColorSchemeCard.tsx'
import { PasswordField } from './primitives.tsx'

/**
 * Your own account: who the server thinks you are, the colors you have chosen, and
 * the form to change your password. Nothing on this page is about anybody else.
 *
 * Managing *other* accounts moved to `AdminView` and `#/admin`. What used to be here
 * was two pages sharing one URL — a member saw two cards, an admin saw those two plus
 * every control over every account, directly beneath their own password form.
 */

function Message({ text, tone }: { text: string; tone: 'error' | 'ok' }) {
  return (
    <div className={tone === 'error' ? 'notice notice--error' : 'notice'}>
      <p className="notice__body">{text}</p>
    </div>
  )
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

/**
 * A pointer to `#/base-order`, which lives on its own route rather than as a
 * card here — see the note on `AccountView` below for why, and `hooks.ts` for
 * the route itself. This card is the way in: one line saying what it is, one
 * link to it, the same "go look elsewhere" shape the topbar's own `Cards` and
 * `Progress` links use, just placed on the account page instead of the banner
 * since setting your own base order is a setting, not a section of the app.
 */
function BaseOrderCard() {
  return (
    <section className="card">
      <h2 className="section-title">Base order</h2>
      <p className="empty-hint">
        The order your own bases are listed in, for pages that narrow down to just yours.
      </p>
      <a className="icon-button" href={hrefFor({ view: 'base-order' })}>
        Set base order
      </a>
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

      <form className="search search--stacked" onSubmit={(event) => void submit(event)}>
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

export function AccountView({ user }: { user: SessionUser }) {
  return (
    <>
      <IdentityCard user={user} />
      {/* Above the password form on purpose: it is the thing on this page somebody
          comes back to, where changing a password is a once-a-year errand. */}
      <ColorSchemeCard user={user} />
      <BaseOrderCard />
      <PasswordCard />
    </>
  )
}
