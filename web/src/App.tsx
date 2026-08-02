import { AccountView } from './components/AccountView.tsx'
import { CardsView } from './components/CardsView.tsx'
import { ClanSearchView } from './components/ClanSearchView.tsx'
import { ClanView } from './components/ClanView.tsx'
import { ForcedPasswordChange } from './components/ForcedPasswordChange.tsx'
import { LoginScreen } from './components/Login.tsx'
import { PlayerView } from './components/PlayerView.tsx'
import { SavedClansView } from './components/SavedClansView.tsx'
import { SearchBar } from './components/SearchBar.tsx'
import { WarView } from './components/WarView.tsx'
import { hrefFor, useRecents, useRestoredRoute, useRoute, useTheme, type Theme } from './hooks.ts'
import { useOneTimeImport } from './import.ts'
import { useSession } from './session.ts'

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<Theme, string> = { system: '◐ System', light: '☀ Light', dark: '☾ Dark' }

export function App() {
  const route = useRoute()
  const [recents, remember] = useRecents()
  const [theme, setTheme] = useTheme()
  const session = useSession()

  /* Resumes the page this account was last on. Declared before the early
     returns below, since a hook cannot be called conditionally; it no-ops until
     there is a signed-in user to key the history by. */
  const signedInUser = session.state.status === 'signedIn' ? session.state.user : null
  useRestoredRoute(signedInUser?.id ?? null)

  /* Saved clans and owners moved to the server. Anything this browser still holds
     in localStorage is handed over once, on the first sign-in after that change.
     Held back while a password change is forced, because `/api/import` is one of
     the routes the server refuses until then — it would fail, say so alarmingly,
     and then be retried anyway on the next sign-in. */
  const imported = useOneTimeImport(signedInUser !== null && !signedInUser.mustChangePassword)

  /*
   * Every /api route but health and login needs a session, so the shell is not
   * rendered at all until we know who is asking — otherwise each panel would
   * mount, fire a request, and paint its own 401. The same state is what a
   * mid-session expiry falls back to, via the global handler in `api.ts`.
   */
  if (session.state.status === 'loading') {
    return <div className="auth-screen">{/* brief; a spinner here would only flash */}</div>
  }

  if (session.state.status === 'anonymous') {
    return <LoginScreen onSignedIn={session.signedIn} />
  }

  const user = session.state.user

  /*
   * An admin has issued this account a temporary password, so nothing but the
   * change form is reachable. The server enforces that independently — every
   * other `/api/*` route answers 403 `passwordChangeRequired` while the flag is
   * set — so this is the explanation and the form, not the lock itself.
   */
  if (user.mustChangePassword) {
    return (
      <ForcedPasswordChange
        user={user}
        onChanged={session.signedIn}
        onSignOut={session.signOut}
      />
    )
  }

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="topbar__title">
          <a href={hrefFor({ view: 'home' })}>Clash of Clans Explorer</a>
        </h1>
        {/* Present on every sub page, absent on the list it points at. */}
        {route.view !== 'home' ? (
          <a className="icon-button" href={hrefFor({ view: 'home' })}>
            ← Saved clans
          </a>
        ) : null}
        {/* Present everywhere but the card page itself, like the Saved clans link. */}
        {route.view !== 'cards' ? (
          <a className="icon-button" href={hrefFor({ view: 'cards' })} title="Card collection">
            Cards
          </a>
        ) : null}
        <button
          type="button"
          className="icon-button"
          onClick={() => setTheme(NEXT_THEME[theme])}
          title="Switch theme"
        >
          {THEME_LABEL[theme]}
        </button>
        <a
          className="icon-button"
          href={hrefFor({ view: 'account' })}
          title={user.role === 'admin' ? 'Password and users' : 'Change your password'}
        >
          {user.displayName}
        </a>
        <button type="button" className="icon-button" onClick={session.signOut}>
          Sign out
        </button>
      </header>

      <main className="shell__main">
        {/*
         * Shown once, and dismissible. The import is a one-off, but quietly moving
         * somebody's data without saying what became of it is not on — especially
         * when some rows were skipped because the server already had them.
         */}
        {imported.summary ? (
          <div className="notice">
            <p className="notice__body">{imported.summary}</p>
            <button type="button" className="icon-button" onClick={imported.dismiss}>
              Dismiss
            </button>
          </div>
        ) : null}

        {route.view === 'home' ? <SavedClansView /> : null}

        {route.view === 'account' ? <AccountView user={user} /> : null}

        {route.view === 'cards' ? <CardsView /> : null}

        {route.view === 'player' ? (
          <PlayerView key={route.tag} tag={route.tag} onLoaded={remember} />
        ) : null}

        {route.view === 'clan' ? (
          <ClanView key={route.tag} tag={route.tag} onLoaded={remember} />
        ) : null}

        {route.view === 'war' ? <WarView key={route.tag} tag={route.tag} /> : null}

        {route.view === 'search' ? <ClanSearchView key={route.name} name={route.name} /> : null}
      </main>

      {/* Lookup lives here so it stays put while the main column scrolls. */}
      <aside className="shell__side">
        <SearchBar recents={recents} currentUserId={user.id} />
      </aside>

      {/*
       * Required by Supercell's Fan Content Policy, near-verbatim: this app shows
       * their clan badges, league badges and label icons, so the notice has to be
       * on the page rather than buried in the README.
       *
       * The second paragraph now also names the community wiki, because unit art no
       * longer comes from the API. Fandom hosts those files under its CC BY-SA text
       * licence, which does not cover the images themselves — they are game rips and
       * remain Supercell's, so the attribution has to credit the source without
       * implying a licence it cannot grant.
       */}
      <footer className="site-footer">
        <p>
          This material is unofficial and is not endorsed by Supercell. For more information see{' '}
          <a
            href="https://supercell.com/en/fan-content-policy/"
            target="_blank"
            rel="noreferrer noopener"
          >
            Supercell's Fan Content Policy
          </a>
          .
        </p>
        <p>
          Clash of Clans is a trademark of Supercell Oy. Game data, clan and league badges come
          from the{' '}
          <a
            href="https://developer.clashofclans.com/"
            target="_blank"
            rel="noreferrer noopener"
          >
            official Clash of Clans API
          </a>
          ; troop, spell, hero, equipment and Town Hall artwork comes from the{' '}
          <a
            href="https://clashofclans.fandom.com/"
            target="_blank"
            rel="noreferrer noopener"
          >
            Clash of Clans Wiki
          </a>
          . All game artwork remains the property of Supercell. This is a non-commercial fan
          project and does not use Supercell's assets as its own branding.
        </p>
      </footer>
    </div>
  )
}
