import { useCallback, useEffect, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { api, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from './api.ts'
import { resetCardInventory } from './card-inventory.ts'
import { resetOwners } from './owners.ts'
import { resetSavedClans } from './saved-clans.ts'
import { resetTrades } from './trades.ts'

/**
 * Who is signed in, for the whole app.
 *
 * There is nothing persisted here on purpose: the `HttpOnly` cookie is the entire
 * mechanism, so the only way to answer "am I signed in" is to ask the server, and
 * `localStorage` never holds a token or a password.
 */

export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'signedIn'; user: SessionUser }

export interface Session {
  state: SessionState
  signedIn: (user: SessionUser) => void
  signOut: () => void
}

export function useSession(): Session {
  const [state, setState] = useState<SessionState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()

    api.me(controller.signal).then(
      ({ user }) => {
        if (!controller.signal.aborted) setState({ status: 'signedIn', user })
      },
      () => {
        // A 401 is the ordinary answer here, and a network failure is equally
        // unusable — either way the login screen is the honest thing to show.
        if (!controller.signal.aborted) setState({ status: 'anonymous' })
      },
    )

    return () => controller.abort()
  }, [])

  // One place turns any 401 anywhere in the app into the login screen, so an
  // expiry mid-session cannot land as a puzzling error inside a data panel.
  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }))
    return () => setUnauthorizedHandler(null)
  }, [])

  /*
   * And the same for a forced password change, which an admin can start while
   * this tab is open. Flipping the flag on the session we already have is enough:
   * the app renders the change screen off it. Nothing is re-fetched, because the
   * 403 that got us here already *is* the server's answer.
   */
  useEffect(() => {
    setPasswordChangeRequiredHandler(() =>
      setState((current) =>
        current.status === 'signedIn' && !current.user.mustChangePassword
          ? { status: 'signedIn', user: { ...current.user, mustChangePassword: true } }
          : current,
      ),
    )
    return () => setPasswordChangeRequiredHandler(null)
  }, [])

  const signedIn = useCallback((user: SessionUser) => setState({ status: 'signedIn', user }), [])

  const signOut = useCallback(() => {
    // Drop the local state whatever the server says: if the call failed because
    // the session was already dead, signed-out is still the correct end state.
    void api.logout().catch(() => undefined)
    // The shared lists are cached in module state, so they have to go too —
    // otherwise the next person to sign in on this machine sees them before their
    // own first fetch lands.
    resetOwners()
    resetSavedClans()
    resetCardInventory()
    resetTrades()
    setState({ status: 'anonymous' })
  }, [])

  return { state, signedIn, signOut }
}
