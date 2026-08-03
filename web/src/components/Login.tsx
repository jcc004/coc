import { useState, type FormEvent } from 'react'
import type { SessionUser } from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { PasswordField } from './primitives.tsx'

/**
 * Rendered instead of the app shell when there is no session. There is no signup
 * link because there is no signup: an admin creates accounts.
 *
 * The credential is an email address. It used to be a username; anyone whose
 * account predates that change signs in with the address an admin set for them.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !email.trim() || !password) return

    setBusy(true)
    setProblem(null)
    try {
      const { user } = await api.login(email.trim(), password)
      onSignedIn(user)
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? cause
          : new ApiError(0, 'network', 'Could not reach the server.'),
      )
      // Never leave a password sitting in a form field after a failed attempt.
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <header className="topbar">
        <h1 className="topbar__title">Clash of Clans Explorer</h1>
      </header>

      <section className="card">
        <h2 className="section-title">Sign in</h2>

        {problem ? (
          <div className="notice notice--error">
            <p className="notice__title">
              {problem.status ? `${problem.status} · ` : ''}
              {problem.reason}
            </p>
            <p className="notice__body">{problem.message}</p>
            {problem.hint ? <p className="notice__hint">{problem.hint}</p> : null}
          </div>
        ) : null}

        <form className="search search--stacked" onSubmit={(event) => void submit(event)}>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
          <PasswordField
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <button type="submit" disabled={busy || !email.trim() || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* No "forgot password" link, because there is no email to send one to.
            Saying who to ask is more use than a link that cannot work. */}
        <p className="lookup-preview">
          Accounts are created by an admin — there is no self-service signup. Forgotten your
          password? Ask an admin for a temporary one; they can also correct your email address.
        </p>
      </section>
    </div>
  )
}
