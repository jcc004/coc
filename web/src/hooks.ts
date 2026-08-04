import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ApiError } from './api.ts'
import { baseScopeFor, baseScopeKey, type BaseScope } from './base-scope.ts'
import { DEFAULT_CARD_COLUMNS, resolveCardColumns } from './card-scale.ts'
import {
  colorSchemeKey,
  DEFAULT_SCHEME,
  parseScheme,
  SCHEME_VARIABLES,
  schemeVariables,
  serializeScheme,
  type ColorScheme,
} from './color-scheme.ts'
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

    /* Wrapped rather than called bare, because a loader can fail *before* there is a
       promise to reject: `api.player` builds its path with `normalizeTag`, which
       raises `InvalidTagError` on a tag it cannot read, and `#/player/%zz` or
       `#/player/!` reaches here as exactly that. A throw inside an effect is caught
       by nothing — there is no error boundary over the app — so React unmounted the
       tree and the page went blank. The executor runs synchronously, so `load` is
       still called during this effect and the abort ordering below is unchanged; all
       that moves is where the failure lands, which is now the same place a rejection
       lands. */
    new Promise<T>((resolve) => resolve(load(controller.signal))).then(
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

/**
 * Percent-decodes the segment when it can and hands the raw one back when it cannot.
 *
 * The same call, the same failure and the same answer as `decodeIfPossible` in
 * `shared/src/tags.ts` — that one was fixed for the server and this one was missed.
 * `decodeURIComponent` throws `URIError` on an escape it cannot read, and `parseHash`
 * runs inside `useRoute`'s `useMemo`, so `#/search/%` threw during render, and with no
 * error boundary above it that is the whole app gone. A link truncated in transit is
 * an ordinary thing to be sent one of.
 *
 * The raw segment rather than the home route, because the line below already settles
 * the question the other way: an unrecognized help section is `null` and still opens
 * the help page, on the grounds that somebody following a mangled link should land
 * where it was aimed. So `#/player/%zz` opens the player page carrying the literal
 * `%zz`, where `normalizeTag` refuses it and the view says so — naming the tag it
 * could not read. Home would have been a page that looks like it worked.
 *
 * That landing is only survivable because `useAsync` now catches the synchronous
 * `InvalidTagError` that refusal is; see the note there. The two go together.
 */
function decodeIfPossible(param: string): string {
  try {
    return decodeURIComponent(param)
  } catch {
    return param
  }
}

export function parseHash(hash: string): Route {
  const [view, param] = hash.replace(/^#\/?/, '').split('/')
  const decoded = param ? decodeIfPossible(param) : ''

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

/* ---------- the user's colors ---------- */

/**
 * A store rather than a `useState`, because two components read the scheme: the picker
 * on the account page and the account menu, which shows whether anything is
 * customized. `useSyncExternalStore` over `localStorage` is the shape this file
 * already uses for the hash.
 */
const schemeListeners = new Set<() => void>()

const schemeCache = new Map<string, { raw: string | null; scheme: ColorScheme }>()

/**
 * Parsed at most once per stored value. `useSyncExternalStore` compares snapshots by
 * identity and re-renders whenever they differ, so a fresh object on every read would
 * loop forever — and a single-slot cache would do the same the moment two callers read
 * two different keys, which is why this is a map and not three module variables.
 */
function readScheme(key: string): ColorScheme {
  const raw = localStorage.getItem(key)
  const cached = schemeCache.get(key)
  if (cached && cached.raw === raw) return cached.scheme

  const scheme = parseScheme(raw)
  schemeCache.set(key, { raw, scheme })
  return scheme
}

function subscribeToScheme(onChange: () => void): () => void {
  schemeListeners.add(onChange)
  /* `storage` fires in the *other* tabs, which is exactly the case a same-tab
     notification cannot cover: the account page in one tab, the app in another. */
  window.addEventListener('storage', onChange)
  return () => {
    schemeListeners.delete(onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * The chosen accent, plate and banner: applied to the root element, remembered per
 * account.
 *
 * Sits beside `useTheme` because it is the same kind of thing — an appearance
 * preference that lives in this browser — but it is keyed by account where the theme
 * is not, following `coc:lastRoute:<id>` and `coc:baseScope:<id>`. A theme is about
 * the room you are in; a color scheme is somebody's own, and two people sharing a
 * laptop should not repaint each other's app.
 *
 * The parse is deliberately forgiving — see `parseScheme`. A stored value that is not
 * JSON, is an older shape, or names a color the guard would now refuse falls back to
 * the shipped theme rather than throwing during render, and the shipped theme is
 * exactly what the stylesheet renders when nothing is written at all.
 *
 * **The effect has no cleanup on unmount, deliberately.** Two components hold this
 * hook, and one of them unmounting is not a reason to repaint the app — a cleanup
 * would strip the variables when the account page closes and leave the menu, which
 * still holds the scheme, with no effect scheduled to put them back. The cost is that
 * signing out leaves the last scheme on screen until the next load; the sign-in
 * screen names nobody, and the next account's own effect overwrites all twenty
 * variables on mount.
 */
export function useColorScheme(userId: number): [ColorScheme, (next: ColorScheme) => void] {
  const key = colorSchemeKey(userId)

  const scheme = useSyncExternalStore(
    subscribeToScheme,
    () => readScheme(key),
    () => DEFAULT_SCHEME,
  )

  useEffect(() => {
    const root = document.documentElement
    const variables = schemeVariables(scheme)
    /* Cleared from the full list, not from the keys being written: a Reset writes
       nothing at all, and anything left behind would be a color nobody can now
       change. */
    for (const name of SCHEME_VARIABLES) {
      const value = variables[name]
      if (value === undefined) root.style.removeProperty(name)
      else root.style.setProperty(name, value)
    }
  }, [scheme])

  const choose = useCallback(
    (next: ColorScheme) => {
      localStorage.setItem(key, serializeScheme(next))
      for (const listener of schemeListeners) listener()
    },
    [key],
  )

  return [scheme, choose]
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
/**
 * The width an element actually occupies, kept current as it changes.
 *
 * Measured rather than modeled. The alternative is deriving the content width from
 * `window.innerWidth` minus the shell's padding minus the card's padding, which is
 * three constants duplicated from the stylesheet and silently wrong the first time any
 * of them is edited. A `ResizeObserver` on the element that is actually laid out
 * cannot drift.
 *
 * Starts at 0, which callers must treat as "not measured yet" rather than as "no
 * room": a control gated on width would otherwise flash absent on the first paint.
 *
 * **A callback ref, not a ref object**, and that is load-bearing. A `useRef` holds the
 * node but cannot announce that it arrived, so an effect keyed on `[]` runs once — and
 * for any element that mounts on a *later* render, as this one does once the base list
 * has loaded, it runs while the ref is still null, returns early, and never observes
 * anything. The width then stays 0 for good and every control gated on it stays hidden.
 * Storing the node in state makes attaching it a render, which is what lets the effect
 * re-run with something to watch.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return [setElement, width]
}

/**
 * How many cards across the grid draws, remembered per browser.
 *
 * Same mechanism as `useRowLimit`: a reading preference about one panel, so
 * `localStorage` rather than the server — nobody else's view of the shared data should
 * change because you wanted denser tiles.
 *
 * The stored value is resolved against the width on every read rather than at write
 * time, because the same browser is a desktop and a phone on different days.
 * `resolveCardColumns` is where that lands; see `card-scale.ts` for why it clamps to
 * the nearest offered step instead of falling back to the default.
 */
export function useCardColumns(
  key: string,
  contentWidth: number,
  gap: number,
): [number, (next: number) => void] {
  const [stored, setStored] = useState<string | null>(() => localStorage.getItem(key))

  const choose = useCallback(
    (next: number) => {
      setStored(String(next))
      localStorage.setItem(key, String(next))
    },
    [key],
  )

  /* Before the first measurement there is nothing to resolve against, so the default
     stands — which is also what the grid renders without any inline value at all. */
  const columns =
    contentWidth <= 0 ? DEFAULT_CARD_COLUMNS : resolveCardColumns(stored, contentWidth, gap)

  return [columns, choose]
}

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
