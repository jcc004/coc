import { currentEnvironment } from './environment.ts'
import { AccountView } from './components/AccountView.tsx'
import { AdminView } from './components/AdminView.tsx'
import { CardsView } from './components/CardsView.tsx'
import { ClanSearchView } from './components/ClanSearchView.tsx'
import { ClanView } from './components/ClanView.tsx'
import { ForcedPasswordChange } from './components/ForcedPasswordChange.tsx'
import { LoginScreen } from './components/Login.tsx'
import { PlayerView } from './components/PlayerView.tsx'
import { SavedClansView } from './components/SavedClansView.tsx'
import { SearchBar } from './components/SearchBar.tsx'
import { UserMenu } from './components/UserMenu.tsx'
import { WarView } from './components/WarView.tsx'
import {
  hrefFor,
  useLastClan,
  useRecents,
  useRestoredRoute,
  useRoute,
  useTheme,
  type Route,
} from './hooks.ts'
import { useOneTimeImport } from './import.ts'
import {
  ROSETTE_CARDINAL_PATH,
  ROSETTE_DIAGONAL_OPACITY,
  ROSETTE_DIAGONAL_PATH,
  ROSETTE_RING_OPACITY,
  ROSETTE_RING_RADIUS,
  ROSETTE_RING_WIDTH,
  ROSETTE_VIEWBOX,
} from './rosette.ts'
import { useSession } from './session.ts'

/**
 * The compass rosette beside the title, drawn by hand.
 *
 * Inline SVG and nothing else: every mark in this app is either game art from the
 * API and the wiki or it is CSS, and an icon font or an icon package for one
 * 24-pixel glyph would be the first dependency added for decoration.
 *
 * Two four-point stars — long on the cardinals, short and paler on the diagonals —
 * inside a ring. Both are painted in `currentColor`, so the mark takes the
 * topbar's ink in either theme and needs no colour of its own in `styles.css`;
 * `opacity` rather than a second colour is what separates the two stars, for the
 * same reason.
 *
 * **The geometry is imported rather than written here**, because the same mark is
 * now the browser tab's icon too: `rosette.ts` holds the paths and the plugin in
 * `vite.config.ts` builds `/favicon.svg` out of them, so the tab cannot end up
 * showing an older drawing than the banner. The icon simplifies what it *composes*
 * from those paths — see that module for what 16 pixels can hold.
 *
 * `aria-hidden`, and it sits **inside** the title's existing link rather than
 * beside it as a second one. Two adjacent links to the same place would be two
 * tab stops reading as two destinations, and giving the icon its own name ("Home")
 * would invent a second one. So: one link, one accessible name, and it is the
 * title's own words — see the topbar below.
 */
function CompassRosette() {
  return (
    <svg
      className="topbar__rosette"
      viewBox={ROSETTE_VIEWBOX}
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r={ROSETTE_RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={ROSETTE_RING_WIDTH}
        opacity={ROSETTE_RING_OPACITY}
      />
      {/* NE, SE, SW, NW, with the notches between them on the cardinals. */}
      <path d={ROSETTE_DIAGONAL_PATH} fill="currentColor" opacity={ROSETTE_DIAGONAL_OPACITY} />
      {/* N, E, S, W: longer, solid, and drawn last so they read as the needle. */}
      <path d={ROSETTE_CARDINAL_PATH} fill="currentColor" />
    </svg>
  )
}

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

  /* Feeds the topbar's Clan button. Also per account, and also declared up here
     because it is a hook; it returns null until a clan has been opened. */
  const lastClan = useLastClan(signedInUser?.id ?? null)

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

  /*
   * Where the Clan button goes: the last clan this account opened, or — before any
   * has been opened — the saved-clans list, which is where you go to pick one. It
   * is never a dead control and never navigates nowhere.
   */
  const clanTarget: Route = lastClan !== null ? { view: 'clan', tag: lastClan } : { view: 'home' }

  /* Which install this is. Read from `location`, so it needs no build-time flag and
     is right for a production build served from a laptop. */
  const environment = currentEnvironment()

  return (
    <div className="shell">
      {/*
       * Steel banner with a DEV SERVER marker on anything that is not the live host.
       * Production and a local copy are otherwise identical — same app, same
       * shared-looking data, same controls that remove a saved clan "for everyone" —
       * and the only cue was the address bar. See `environment.ts` for why the test is
       * the hostname rather than the build mode.
       */}
      <header className={environment.kind === 'production' ? 'topbar' : 'topbar topbar--dev'}>
        <h1 className="topbar__title">
          {/* One link over the rosette and the words, so the icon navigates home
              without becoming a second tab stop with its own name. */}
          <a className="topbar__home" href={hrefFor({ view: 'home' })}>
            <CompassRosette />
            Clash of Clans Explorer
          </a>
          {/*
           * Outside the link, so it is not read as part of the destination's name —
           * the link stays "Clash of Clans Explorer" — but inside the heading, so a
           * screen reader announces which install this is when it reads the title.
           * `role="status"` would be wrong: this never changes, so there is nothing
           * to announce politely; it is simply part of what the page is called.
           */}
          {environment.label ? (
            <span className="topbar__env">— {environment.label}</span>
          ) : null}
        </h1>
        {/*
         * Absent where it would point at the page you are already on, like the
         * Cards link below. Comparing the view is enough for the clan case: being
         * on a clan page is what makes it the last clan, so the target is this
         * page. The saved-clans list stays reachable from the title.
         */}
        {route.view !== clanTarget.view ? (
          <a
            className="icon-button"
            href={hrefFor(clanTarget)}
            title={
              lastClan !== null
                ? `Back to ${lastClan}, the last clan you opened`
                : 'No clan opened yet — this opens the saved clans'
            }
          >
            Clan
          </a>
        ) : null}
        {/* Present everywhere but the card page itself, like the Clan link above. */}
        {route.view !== 'cards' ? (
          <a className="icon-button" href={hrefFor({ view: 'cards' })} title="Card collection">
            Cards
          </a>
        ) : null}
        {/* One control for everything about *you*: the appearance switch, the
            password page, the admin panel if it is yours, and Sign out. It replaced
            three separate buttons that were squeezing the title on a phone. */}
        <UserMenu user={user} theme={theme} onTheme={setTheme} onSignOut={session.signOut} />
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

        {/*
         * Homepage only, and under the saved clans rather than beside them: two forms
         * for finding a base or a clan are what you want when you arrive with nothing
         * on screen, but on a clan or player page they were 260px of permanent chrome
         * beside the thing you had already found. The Recent chips travel with them —
         * they sit inside the lookup cards, because "where have I been" is the same
         * question as "where do I go", asked in the same place.
         */}
        {route.view === 'home' ? (
          <>
            <SavedClansView user={user} />
            <SearchBar recents={recents} />
          </>
        ) : null}

        {route.view === 'account' ? <AccountView user={user} /> : null}

        {/* Guarded inside the view, not here: a member who types the URL is told the
            page is admins-only rather than silently sent home, which would read as a
            broken link. Every `/api/admin/*` route is gated on the server anyway. */}
        {route.view === 'admin' ? <AdminView user={user} /> : null}

        {/* Both carry a card grid, and only a base's owner may type into it, so
            each needs to know who is signed in. Passed down rather than read from
            `useSession` again, which would refetch /api/auth/me per mount. */}
        {route.view === 'cards' ? <CardsView user={user} /> : null}

        {route.view === 'player' ? (
          <PlayerView key={route.tag} tag={route.tag} user={user} onLoaded={remember} />
        ) : null}

        {route.view === 'clan' ? (
          <ClanView key={route.tag} tag={route.tag} user={user} onLoaded={remember} />
        ) : null}

        {route.view === 'war' ? <WarView key={route.tag} tag={route.tag} /> : null}

        {route.view === 'search' ? <ClanSearchView key={route.name} name={route.name} /> : null}
      </main>

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
