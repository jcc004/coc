import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MIN_PASSWORD_LENGTH, type SessionUser } from '@coc/shared'
import { api, describe } from '../api.ts'
import { PasswordField } from './primitives.tsx'

/**
 * Shown instead of the app shell while `mustChangePassword` is set — which is
 * what an admin-issued temporary password sets.
 *
 * There is deliberately no way out of this screen but changing the password or
 * signing out. It is **not** the enforcement, though: the server refuses every
 * route but `/api/auth/me`, `/api/auth/password` and `/api/auth/logout` while the
 * flag is set (`requirePasswordUpToDate`), so someone editing the URL or the
 * React state gets an empty, 403-ing app rather than a way in. This screen exists
 * so that they get an explanation and a form instead.
 */
export function ForcedPasswordChange({
  user,
  onChanged,
  onSignOut,
}: {
  user: SessionUser
  onChanged: (user: SessionUser) => void
  onSignOut: () => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * The server's own count of *other* sessions this change just signed out —
   * `api.changePassword`'s real `revokedSessions`, not the generic "signs out
   * every other session" claim the form states going in. Set only on success,
   * and only for the brief window before {@link onChanged} unmounts this
   * screen; there is nowhere else on the page this number could be shown.
   */
  const [revokedSessions, setRevokedSessions] = useState<number | null>(null)
  const continueTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Cleared on unmount, the same guard `TagButton.tsx` uses for its own transient
  // confirmation timer: this component can be torn down (a sign-out elsewhere in
  // the tab, a hot reload) before the timer fires, and firing `onChanged` after
  // that would be a state update with nothing left to receive it.
  useEffect(() => () => clearTimeout(continueTimer.current), [])

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return

    if (next !== confirm) {
      setProblem('The two new passwords do not match.')
      return
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setProblem(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const result = await api.changePassword(current, next)
      /*
       * A 200 here means the server cleared the flag, so the local copy can be
       * flipped rather than costing another round trip to /api/auth/me. Only on
       * success — reporting a change that did not happen would drop somebody into
       * an app whose every request 403s, with no explanation on screen.
       *
       * `onChanged` is delayed a beat rather than fired in the same tick as the
       * 200: the server's `revokedSessions` is real, per-change information, and
       * showing it for a moment before navigating away is the only place on this
       * screen it can be read at all — this component navigates itself away on
       * success, so there is no persistent settings screen it could be logged to
       * instead.
       */
      setRevokedSessions(result.revokedSessions)
      continueTimer.current = setTimeout(() => {
        onChanged({ ...user, mustChangePassword: false })
      }, 1500)
    } catch (cause) {
      setProblem(describe(cause))
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <header className="topbar">
        <h1 className="topbar__title">Clash of Clans Explorer</h1>
        {/* The only other way off this screen, and it has to exist: somebody who
            cannot reach whoever has their temporary password should be able to
            leave rather than be stuck in a form they cannot complete. */}
        <button type="button" className="icon-button" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <section className="card">
        <h2 className="section-title">Set a new password</h2>

        <div className="notice">
          <p className="notice__title">Your password was reset by an admin</p>
          <p className="notice__body">
            You are signed in as {user.email ?? user.displayName}. Choose your own password to carry
            on — the rest of the app stays closed until you do.
          </p>
          <p className="notice__hint">
            Enter the temporary password you were given, then the one you want. Changing it signs
            out every other session, including any the admin's reset left behind.
          </p>
        </div>

        {problem ? (
          <div className="notice notice--error">
            <p className="notice__body">{problem}</p>
          </div>
        ) : null}

        {revokedSessions === null ? (
          <form className="search search--stacked" onSubmit={(event) => void submit(event)}>
            {/* `current-password` is right for the temporary one: it *is* the
                current credential, and a password manager should offer what it has
                stored rather than try to save this throwaway value as the new one. */}
            <PasswordField
              label="Temporary password"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              autoFocus
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
            <button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? 'Saving…' : 'Set password and continue'}
            </button>
          </form>
        ) : (
          /* Replaces the form rather than sitting beside it: the password fields have
             already done their job and there is nothing left to submit. `aria-live`
             so the confirmation is announced the same way `BaseCardEditor.tsx`'s
             "Saving…" indicator and `TagButton.tsx`'s copy confirmation are. */
          <div className="notice" aria-live="polite">
            <p className="notice__body">
              Password changed. Signed out {revokedSessions}{' '}
              {revokedSessions === 1 ? 'other session' : 'other sessions'}, including any the
              admin's reset left behind.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
