import { ClanSearchView } from './components/ClanSearchView.tsx'
import { ClanView } from './components/ClanView.tsx'
import { PlayerView } from './components/PlayerView.tsx'
import { SavedClansView } from './components/SavedClansView.tsx'
import { SearchBar } from './components/SearchBar.tsx'
import { WarView } from './components/WarView.tsx'
import { hrefFor, useRecents, useRoute, useTheme, type Theme } from './hooks.ts'

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<Theme, string> = { system: '◐ System', light: '☀ Light', dark: '☾ Dark' }

export function App() {
  const route = useRoute()
  const [recents, remember] = useRecents()
  const [theme, setTheme] = useTheme()

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
        <button
          type="button"
          className="icon-button"
          onClick={() => setTheme(NEXT_THEME[theme])}
          title="Switch theme"
        >
          {THEME_LABEL[theme]}
        </button>
      </header>

      <main className="shell__main">
        {route.view === 'home' ? <SavedClansView /> : null}

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
        <SearchBar recents={recents} />
      </aside>

      {/*
       * Required by Supercell's Fan Content Policy, near-verbatim: this app shows
       * their clan badges, league badges and label icons, so the notice has to be
       * on the page rather than buried in the README.
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
          Clash of Clans is a trademark of Supercell Oy. Game data and icons come from the{' '}
          <a
            href="https://developer.clashofclans.com/"
            target="_blank"
            rel="noreferrer noopener"
          >
            official Clash of Clans API
          </a>
          ; all game artwork remains the property of Supercell.
        </p>
      </footer>
    </div>
  )
}
