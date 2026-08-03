import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError } from './api.ts'
import { baseScopeFor, baseScopeKey, type BaseScope } from './base-scope.ts'
import { helpHref, helpSection, type HelpSectionId } from './help.ts'
import {
  clanTargetTag,
  hashTarget,
  lastClanKey,
  lastRouteKey,
  routeToRemember,
  shouldRestoreRoute,
} from './last-route.ts'
import { addRecent, parseRecents, RECENTS_KEY, type Recent } from './recents.ts'
import { parseRowLimit, type RowLimit } from './saved-table.ts'

export type { Recent } from './recents.ts'

export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; data: T }

/**
 * Runs `load` whenever `deps` change, aborting the previous call. Pass `null`
 * for `load` to stay idle — that's how views wait for a tag to be chosen.
 */
export function useAsync<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  deps: unknown[],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: load ? 'loading' : 'idle' })

  useEffect(() => {
    if (!load) {
      setState({ status: 'idle' })
      return
    }

    const controller = new AbortController()
    setState({ status: 'loading' })

    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        setState({
          status: 'error',
          error:
            cause instanceof ApiError
              ? cause
              : new ApiError(0, 'network', (cause as Error).message ?? 'Request failed'),
        })
      },
    )

    return () => controller.abort()
    // `load` is intentionally excluded: callers pass an inline closure and
    // declare the values it actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return state
}

/* ---------- hash routing ---------- */

export type Route =
  | { view: 'home' }
  | { view: 'player'; tag: string }
  | { view: 'clan'; tag: string }
  | { view: 'war'; tag: string }
  | { view: 'search'; name: string }
  | { view: 'account' }
  /**
   * The admin panel. A route of its own rather than a card on `account`, so an admin
   * can be sent a link to it — and so "the account page" means one thing whoever
   * opens it. A member reaching it is refused *on the page*, by `AdminView`, not
   * bounced: see the note there.
   */
  | { view: 'admin' }
  | { view: 'cards' }
  /**
   * The help page, optionally scrolled to one section.
   *
   * A route of its own for the same reason `admin` is: it has to be linkable. The
   * `?` beside a panel is a link *into* a section, so the section has to be part of
   * the address — see `help.ts` for why it is a path segment and not a fragment.
   * `null` is the whole page, from the top.
   */
  | { view: 'help'; section: HelpSectionId | null }

export function parseHash(hash: string): Route {
  const [view, param] = hash.replace(/^#\/?/, '').split('/')
  const decoded = param ? decodeURIComponent(param) : ''

  if (view === 'account') return { view: 'account' }
  if (view === 'admin') return { view: 'admin' }
  // An unknown section is `null` rather than a miss, so an old link still opens
  // the page. The whole scheme is in `help.ts`, tested there.
  if (view === 'help') return { view: 'help', section: helpSection(decoded) }
  // No tag in the route: the card page picks its base from the shared list, so a
  // deep link to one base would be a link into somebody else's editing session.
  if (view === 'cards') return { view: 'cards' }
  if (view === 'player' && decoded) return { view: 'player', tag: decoded }
  if (view === 'clan' && decoded) return { view: 'clan', tag: decoded }
  if (view === 'war' && decoded) return { view: 'war', tag: decoded }
  if (view === 'search' && decoded) return { view: 'search', name: decoded }
  return { view: 'home' }
}

export function hrefFor(route: Route): string {
  switch (route.view) {
    case 'player':
      return `#/player/${encodeURIComponent(route.tag)}`
    case 'clan':
      return `#/clan/${encodeURIComponent(route.tag)}`
    case 'war':
      return `#/war/${encodeURIComponent(route.tag)}`
    case 'search':
      return `#/search/${encodeURIComponent(route.name)}`
    case 'account':
      return '#/account'
    case 'admin':
      return '#/admin'
    case 'cards':
      return '#/cards'
    case 'help':
      return helpHref(route.section)
    case 'home':
      return '#/'
  }
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => '',
  )
  return useMemo(() => parseHash(hash), [hash])
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route).slice(1)
}

/* ---------- stacked tables ---------- */

/**
 * The width at which a table stops being a table and becomes one card per row.
 * It must stay in step with the `roster--stack` block in styles.css, which is
 * what actually restyles the markup this decides to render.
 */
const STACKED_TABLES = '(max-width: 900px)'

function subscribeToStackedTables(onChange: () => void): () => void {
  const query = window.matchMedia(STACKED_TABLES)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * True while tables are rendering as stacked cards.
 *
 * The one place this responsive pass needs JavaScript rather than CSS. A stacked
 * card has no column heading to hang a sort button off, and the header row
 * reflowed into a strip of gold labels above cards that already print their own
 * field names reads as noise. So the two sortable tables render *different DOM*
 * at this width: plain `<th>` text plus a single Sort control, in place of a row
 * of header buttons. Rendering both and hiding one in CSS would leave the hidden
 * set in the accessibility tree, giving a keyboard user a run of invisible
 * duplicate controls to tab through.
 */
export function useStackedTables(): boolean {
  return useSyncExternalStore(
    subscribeToStackedTables,
    () => window.matchMedia(STACKED_TABLES).matches,
    () => false,
  )
}

/* ---------- theme ---------- */

export type Theme = 'light' | 'dark' | 'system'

export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('coc:theme') as Theme | null) ?? 'system',
  )

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    localStorage.setItem('coc:theme', theme)
  }, [theme])

  return [theme, setTheme]
}

/* ---------- last visited route ---------- */

/**
 * Records the current hash and, once per mount, restores the stored one when the
 * app was opened without a hash — so signing in resumes where the user left off.
 *
 * Pass the signed-in user's id; the hook does nothing until there is one, which
 * keeps the login screen from writing or reading anyone's history.
 */
export function useRestoredRoute(userId: number | null): void {
  const restored = useRef(false)

  useEffect(() => {
    if (userId === null) return
    const key = lastRouteKey(userId)

    // Reading and subscribing live in one effect so the restore cannot race the
    // first write and read back a hash it just cleared.
    if (!restored.current) {
      restored.current = true
      const stored = localStorage.getItem(key)
      if (shouldRestoreRoute(window.location.hash, stored) && stored) {
        window.location.hash = hashTarget(stored)
      }
    }

    const remember = () => {
      const next = routeToRemember(window.location.hash)
      if (next === null) localStorage.removeItem(key)
      else localStorage.setItem(key, next)
    }

    remember()
    window.addEventListener('hashchange', remember)
    return () => window.removeEventListener('hashchange', remember)
  }, [userId])
}

/**
 * The last clan this account opened, recorded as it happens.
 *
 * Drives the topbar's **Clan** button, which is why it is a hook returning the
 * tag rather than a read at click time: the button's destination is on screen (in
 * its tooltip) and has to re-render when the destination changes.
 *
 * Only `#/clan/<tag>` counts as visiting a clan. A war page is *about* a clan but
 * is not the clan, and treating it as one would send the button somewhere the
 * user did not choose to be.
 */
export function useLastClan(userId: number | null): string | null {
  const [tag, setTag] = useState<string | null>(null)

  useEffect(() => {
    if (userId === null) {
      // Signed out: forget the tag in memory. The stored one stays put, keyed by
      // the account, so signing back in resumes it and nobody else sees it.
      setTag(null)
      return
    }
    const key = lastClanKey(userId)

    const remember = () => {
      const route = parseHash(window.location.hash)
      if (route.view === 'clan') {
        // Stored canonical, so the button's href does not depend on how the tag
        // happened to be typed in the address bar.
        const canonical = clanTargetTag(route.tag)
        if (canonical !== null) localStorage.setItem(key, canonical)
      }
      setTag(clanTargetTag(localStorage.getItem(key)))
    }

    remember()
    window.addEventListener('hashchange', remember)
    return () => window.removeEventListener('hashchange', remember)
  }, [userId])

  return tag
}

/* ---------- Mine / All on the card page ---------- */

/**
 * The card page's base filter, remembered per account.
 *
 * Every rule is in `base-scope.ts`; what is here is the timing, which is the part
 * a pure function cannot own. The default depends on whether this account owns a
 * base, and that answer arrives from the server — so resolving it eagerly would
 * read "owns nothing" from an empty first snapshot and open on `All` for everybody.
 * `ready` is the caller saying the owner list has actually landed; until then the
 * filter reads `All`, which shows every base rather than an empty list.
 *
 * Resolved exactly once. After that the state is the user's, and a later change to
 * who owns what must not move a control they are looking at.
 */
export function useBaseScope(
  userId: number,
  ownsAny: boolean,
  ready: boolean,
): [BaseScope, (next: BaseScope) => void] {
  /* The account is held alongside the choice rather than being reset by a second
     effect: signing in as somebody else must not carry the previous person's filter
     over, and a state that names whose it is answers that without an ordering
     dependency between two effects. */
  const [chosen, setChosen] = useState<{ userId: number; scope: BaseScope } | null>(null)

  useEffect(() => {
    if (!ready) return
    setChosen((current) =>
      current?.userId === userId
        ? current
        : { userId, scope: baseScopeFor(localStorage.getItem(baseScopeKey(userId)), ownsAny) },
    )
    // `ownsAny` is deliberately not a dependency: it seeds the first value only,
    // and re-running on it would overwrite a choice already made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, ready])

  const choose = useCallback(
    (next: BaseScope) => {
      setChosen({ userId, scope: next })
      localStorage.setItem(baseScopeKey(userId), next)
    },
    [userId],
  )

  return [chosen?.userId === userId ? chosen.scope : 'all', choose]
}

/* ---------- recent lookups ---------- */

export function useRecents(): [Recent[], (entry: Recent) => void] {
  const [recents, setRecents] = useState<Recent[]>(() =>
    parseRecents(localStorage.getItem(RECENTS_KEY)),
  )

  const remember = useCallback((entry: Recent) => {
    setRecents((current) => {
      const next = addRecent(current, entry)
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return [recents, remember]
}

/* ---------- row-count limits ---------- */

/**
 * A table's rows-per-page choice, persisted so it survives a reload. Each table
 * passes its own key; the value is read once on mount and written on change.
 */
export function useRowLimit(key: string, fallback: RowLimit): [RowLimit, (next: RowLimit) => void] {
  const [limit, setLimit] = useState<RowLimit>(() =>
    parseRowLimit(localStorage.getItem(key), fallback),
  )

  const choose = useCallback(
    (next: RowLimit) => {
      setLimit(next)
      localStorage.setItem(key, String(next))
    },
    [key],
  )

  return [limit, choose]
}
