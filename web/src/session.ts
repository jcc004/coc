import { useCallback, useEffect, useState } from 'react'
import type { SessionUser } from '@coc/shared'
import { api, setPasswordChangeRequiredHandler, setUnauthorizedHandler } from './api.ts'
import { resetCardInventory } from './card-inventory.ts'
import { resetOwners } from './owners.ts'
import { resetProgress, resetProgressReference } from './progress.ts'
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

/**
 * Empties the module-level caches of the shared lists.
 *
 * They are module state, so they outlive every component and every session in this
 * tab: without this the next person to sign in on a shared machine would see the
 * previous one's lists until their own first fetch landed.
 *
 * How much that matters depends on the exit. On a deliberate sign-out, quite a lot —
 * somebody else is expected to be standing there. On a 401 it is close to nothing,
 * because this data is **install-wide shared rather than per-user**: the owners, the
 * saved clans, the card inventory and the trades are the same rows whoever is looking,
 * so the stale snapshot the next sign-in would briefly show is the snapshot they were
 * going to be given anyway. It is done on both paths for consistency, not because the
 * 401 path was leaking anything. Progress is the same shape: `progress.ts`'s latest-
 * week store is the clan-wide board, not a per-account view.
 */
function dropSharedCaches(): void {
  resetOwners()
  resetSavedClans()
  resetCardInventory()
  resetTrades()
  resetProgress()
  resetProgressReference()
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
    setUnauthorizedHandler(() => {
      // The same two steps as `signOut`, in the same order, because this *is* a sign
      // out — it just was not asked for. See `dropSharedCaches` for why the caches
      // barely matter on this path and are dropped anyway.
      dropSharedCaches()
      setState({ status: 'anonymous' })
    })
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
    dropSharedCaches()
    setState({ status: 'anonymous' })
  }, [])

  return { state, signedIn, signOut }
}
