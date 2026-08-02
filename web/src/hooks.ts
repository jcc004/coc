import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ApiError } from './api.ts'
import { parseRowLimit, type RowLimit } from './saved-table.ts'

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

export function parseHash(hash: string): Route {
  const [view, param] = hash.replace(/^#\/?/, '').split('/')
  const decoded = param ? decodeURIComponent(param) : ''

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

/* ---------- recent lookups ---------- */

export interface Recent {
  kind: 'player' | 'clan'
  tag: string
  name: string
}

const RECENTS_KEY = 'coc:recents'
const MAX_RECENTS = 8

export function useRecents(): [Recent[], (entry: Recent) => void] {
  const [recents, setRecents] = useState<Recent[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
      return Array.isArray(parsed) ? (parsed as Recent[]) : []
    } catch {
      return []
    }
  })

  const remember = useCallback((entry: Recent) => {
    setRecents((current) => {
      const next = [entry, ...current.filter((r) => r.tag !== entry.tag)].slice(0, MAX_RECENTS)
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
