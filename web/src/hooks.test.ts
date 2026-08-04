import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { InvalidTagError } from '@coc/shared'
import { ApiError } from './api.ts'
import { hrefFor, parseHash, useAsync, type AsyncState, type Route } from './hooks.ts'
import { installTestCleanup } from './test-support.ts'

/**
 * The two things in `hooks.ts` that can be wrong without anything on screen saying
 * so: the address bar's grammar, and what `useAsync` does when two loads overlap.
 *
 * The rest of the file is storage plumbing around pure modules that are tested where
 * they live (`help.ts`, `base-scope.ts`, `last-route.ts`, `saved-table.ts`), so there
 * is nothing here about theme, recents or row limits — asserting them again would only
 * assert `localStorage`.
 */

installTestCleanup()

/* ---------- hash routing ---------- */

/** Every route the app can be in, as the address that has to survive a round trip. */
const ROUTES: readonly Route[] = [
  { view: 'home' },
  { view: 'player', tag: '#G88CYQP' },
  { view: 'clan', tag: '#2PP' },
  { view: 'war', tag: '#2PP' },
  { view: 'search', name: 'Reddit Zulu' },
  { view: 'account' },
  { view: 'admin' },
  { view: 'cards' },
  { view: 'whats-new' },
  { view: 'help', section: null },
  { view: 'help', section: 'trades' },
]

describe('parseHash — the views that take no parameter', () => {
  it('reads each of them off the hash', () => {
    assert.deepEqual(parseHash('#/account'), { view: 'account' })
    assert.deepEqual(parseHash('#/admin'), { view: 'admin' })
    assert.deepEqual(parseHash('#/cards'), { view: 'cards' })
    assert.deepEqual(parseHash('#/whats-new'), { view: 'whats-new' })
  })

  it('reads the hyphenated one as a single segment, not as two', () => {
    // `parseHash` splits on `/`, so the hyphen is ordinary text in the view name —
    // which is what lets the view name and the hash segment stay the same string.
    assert.deepEqual(parseHash('#/whats-new/anything'), { view: 'whats-new' })
    assert.deepEqual(parseHash('#/whats'), { view: 'home' })
    assert.deepEqual(parseHash('#/whats/new'), { view: 'home' })
  })

  it('accepts the hash with or without its leading slash', () => {
    // `window.location.hash` is whatever was typed or pasted, and both spellings
    // reach here from real links.
    assert.deepEqual(parseHash('#account'), { view: 'account' })
    assert.deepEqual(parseHash('#/account'), { view: 'account' })
  })

  it('ignores a parameter on a view that has none', () => {
    // The card page picks its base from the shared list, so a tag in the address is
    // not a deep link into somebody's editing session — it is nothing at all.
    assert.deepEqual(parseHash('#/cards/%23AAA'), { view: 'cards' })
    assert.deepEqual(parseHash('#/admin/1'), { view: 'admin' })
  })
})

describe('parseHash — the views that take a parameter', () => {
  it('decodes the parameter', () => {
    assert.deepEqual(parseHash('#/player/%23G88CYQP'), { view: 'player', tag: '#G88CYQP' })
    assert.deepEqual(parseHash('#/clan/%232PP'), { view: 'clan', tag: '#2PP' })
    assert.deepEqual(parseHash('#/war/%232PP'), { view: 'war', tag: '#2PP' })
    assert.deepEqual(parseHash('#/search/Reddit%20Zulu'), { view: 'search', name: 'Reddit Zulu' })
  })

  it('falls back to home when the parameter is missing or blank', () => {
    // A player page with no tag has nothing to ask the API for, so it is not a page.
    for (const hash of ['#/player', '#/player/', '#/clan', '#/clan/', '#/war', '#/war/', '#/search', '#/search/']) {
      assert.deepEqual(parseHash(hash), { view: 'home' }, hash)
    }
  })

  it('takes the first segment and ignores whatever follows it', () => {
    assert.deepEqual(parseHash('#/player/%23AAA/stats'), { view: 'player', tag: '#AAA' })
  })
})

describe('parseHash — the help page', () => {
  it('opens the whole page when no section is named', () => {
    assert.deepEqual(parseHash('#/help'), { view: 'help', section: null })
    assert.deepEqual(parseHash('#/help/'), { view: 'help', section: null })
  })

  it('resolves a named section', () => {
    assert.deepEqual(parseHash('#/help/owners'), { view: 'help', section: 'owners' })
    assert.deepEqual(parseHash('#/help/leaderboard'), { view: 'help', section: 'leaderboard' })
  })

  it('tolerates the mangling a link picks up in transit', () => {
    assert.deepEqual(parseHash('#/help/OWNERS'), { view: 'help', section: 'owners' })
    assert.deepEqual(parseHash('#/help/%20trades%20'), { view: 'help', section: 'trades' })
  })

  /*
   * The distinction the `Route` union is built around: an unknown *section* is still
   * the help page, where an unknown *view* is not. Somebody following a link to a
   * heading that has since been renamed should land on the help page, not on home
   * wondering what they clicked.
   */
  it('still opens the page for a section it does not recognize', () => {
    assert.deepEqual(parseHash('#/help/renamed-last-year'), { view: 'help', section: null })
  })
})

describe('parseHash — a percent-escape that arrived truncated', () => {
  /*
   * The crash this closes: `decodeURIComponent` throws `URIError` on an escape it
   * cannot read, `parseHash` runs inside `useRoute`'s `useMemo`, and a throw during
   * render with no error boundary over it takes the whole app down. A link cut short
   * by a chat client is an ordinary thing to be sent one of, and pasting one blanked
   * the page.
   *
   * The same bug, on the same call, was fixed for the server in `shared/src/tags.ts`
   * — `decodeIfPossible`, and the test named for it in `tags.test.ts` — and missed
   * here.
   */
  it('keeps the raw segment rather than throwing URIError', () => {
    assert.deepEqual(parseHash('#/search/%'), { view: 'search', name: '%' })
    assert.deepEqual(parseHash('#/player/%zz'), { view: 'player', tag: '%zz' })
    assert.deepEqual(parseHash('#/clan/%'), { view: 'clan', tag: '%' })
    assert.deepEqual(parseHash('#/war/%E0%A4%A'), { view: 'war', tag: '%E0%A4%A' })
  })

  it('still resolves the views that do not read their parameter', () => {
    assert.deepEqual(parseHash('#/help/%'), { view: 'help', section: null })
    assert.deepEqual(parseHash('#/cards/%'), { view: 'cards' })
  })

  /* The address is rewritten from the route on every link the app draws, so a segment
     that could not be decoded has to survive being encoded again — otherwise the next
     click quietly changes which base the page is about. */
  it('re-encodes the segment it could not decode, so the address round-trips', () => {
    assert.equal(hrefFor(parseHash('#/player/%zz')), '#/player/%25zz')
    assert.deepEqual(parseHash('#/player/%25zz'), { view: 'player', tag: '%zz' })
  })
})

describe('parseHash — anything else is home', () => {
  it('treats an empty hash as home', () => {
    for (const hash of ['', '#', '#/']) {
      assert.deepEqual(parseHash(hash), { view: 'home' }, JSON.stringify(hash))
    }
  })

  it('treats an unknown view as home rather than as an error', () => {
    assert.deepEqual(parseHash('#/dashboard'), { view: 'home' })
    assert.deepEqual(parseHash('#/dashboard/anything'), { view: 'home' })
    assert.deepEqual(parseHash('#/home'), { view: 'home' })
  })

  it('matches the view name exactly, so a differently-cased one is not a route', () => {
    assert.deepEqual(parseHash('#/Player/%23AAA'), { view: 'home' })
    assert.deepEqual(parseHash('#/ACCOUNT'), { view: 'home' })
  })
})

describe('hrefFor', () => {
  it('percent-encodes the parameter, so a tag survives its hash', () => {
    // An unencoded `#` would start a second fragment and truncate the address.
    assert.equal(hrefFor({ view: 'player', tag: '#G88CYQP' }), '#/player/%23G88CYQP')
    assert.equal(hrefFor({ view: 'search', name: 'Reddit Zulu' }), '#/search/Reddit%20Zulu')
  })

  it('writes the help page without a trailing slash when no section is named', () => {
    assert.equal(hrefFor({ view: 'help', section: null }), '#/help')
    assert.equal(hrefFor({ view: 'help', section: 'tracker' }), '#/help/tracker')
  })

  /* The pair has to be an exact inverse: every link in the app is written by one and
     read back by the other, so a disagreement is a link that goes somewhere else. */
  it('round-trips every route through parseHash', () => {
    for (const route of ROUTES) {
      assert.deepEqual(parseHash(hrefFor(route)), route, hrefFor(route))
    }
  })

  it('round-trips a parameter containing the separator parseHash splits on', () => {
    const route: Route = { view: 'search', name: 'war/peace' }
    assert.equal(hrefFor(route), '#/search/war%2Fpeace')
    assert.deepEqual(parseHash(hrefFor(route)), route)
  })
})

/* ---------- useAsync ---------- */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
}

/**
 * A load the test settles by hand. Real timing is what makes a race test flaky; this
 * makes the overlap the test's own decision rather than the scheduler's.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (cause: unknown) => void = () => undefined
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

interface ProbeProps {
  load: ((signal: AbortSignal) => Promise<string>) | null
  deps: unknown[]
}

/**
 * `useAsync` under a name the hooks lint rule accepts — a hook may only be called
 * from a component or from another hook, and `renderHook(() => …)` is neither.
 */
function useProbe({ load, deps }: ProbeProps): AsyncState<string> {
  return useAsync(load, deps)
}

/**
 * Mounts the probe. A named wrapper rather than `renderHook` inline, so `rerender`
 * is typed against the whole `ProbeProps` — inferring it from the first call's
 * literal would make `load: null` on a later render a type error.
 */
function probe(initialProps: ProbeProps): RenderHookResult<AsyncState<string>, ProbeProps> {
  return renderHook(useProbe, { initialProps })
}
describe('useAsync — the happy path', () => {
  it('starts loading and settles on what the loader resolved', async () => {
    const call = deferred<string>()
    const { result } = probe({ load: () => call.promise, deps: ['a'] })

    assert.deepEqual(result.current, { status: 'loading' })

    await act(async () => {
      call.resolve('the clan')
    })
    assert.deepEqual(result.current, { status: 'ready', data: 'the clan' })
  })

  it('stays idle when there is nothing to load', () => {
    // How every view that waits for a tag to be chosen spends its first render.
    const { result } = probe({ load: null, deps: [] })
    assert.deepEqual(result.current, { status: 'idle' })
  })

  it('returns to idle when the loader goes away', async () => {
    const call = deferred<string>()
    const { result, rerender } = probe({ load: () => call.promise, deps: ['a'] })
    await act(async () => {
      call.resolve('the clan')
    })

    rerender({ load: null, deps: ['b'] })

    /* Not left showing the previous answer: the caller passing `null` is the caller
       saying there is nothing to show, and stale data under a cleared selection is
       the one state that looks like a working page. */
    assert.deepEqual(result.current, { status: 'idle' })
  })
})

describe('useAsync — overlapping calls', () => {
  it('aborts the previous call when the dependencies change', () => {
    const signals: AbortSignal[] = []
    const first = deferred<string>()
    const second = deferred<string>()
    const { rerender } = probe({
      load: (signal: AbortSignal) => {
        signals.push(signal)
        return first.promise
      },
      deps: ['a'],
    })

    rerender({
      load: (signal: AbortSignal) => {
        signals.push(signal)
        return second.promise
      },
      deps: ['b'],
    })

    assert.equal(signals.length, 2, 'a changed dependency has to start a new call')
    assert.equal(signals[0]?.aborted, true, 'the superseded request must be canceled')
    assert.equal(signals[1]?.aborted, false)
  })

  /*
   * The failure this prevents: type a tag, type a second one, and the first clan's
   * response arrives last and paints over the clan you asked for. The abort is what
   * stops the network deciding which answer wins.
   */
  it('ignores an answer that arrives after it has been superseded', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const { result, rerender } = probe({ load: () => first.promise, deps: ['a'] })

    rerender({ load: () => second.promise, deps: ['b'] })
    await act(async () => {
      first.resolve('the clan nobody is looking at')
    })

    assert.deepEqual(result.current, { status: 'loading' }, 'the stale answer must not land')

    await act(async () => {
      second.resolve('the clan that was asked for')
    })
    assert.deepEqual(result.current, { status: 'ready', data: 'the clan that was asked for' })
  })

  it('ignores a failure that arrives after it has been superseded', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const { result, rerender } = probe({ load: () => first.promise, deps: ['a'] })

    rerender({ load: () => second.promise, deps: ['b'] })
    await act(async () => {
      second.resolve('the clan that was asked for')
      first.reject(new ApiError(404, 'notFound', 'No such clan.'))
    })

    // A canceled request failing is not news, and showing its error over a panel
    // that has already loaded is worse than not showing it.
    assert.deepEqual(result.current, { status: 'ready', data: 'the clan that was asked for' })
  })

  it('aborts the outstanding call when the caller unmounts', () => {
    const signals: AbortSignal[] = []
    const call = deferred<string>()
    const { unmount } = probe({
      load: (signal: AbortSignal) => {
        signals.push(signal)
        return call.promise
      },
      deps: ['a'],
    })

    unmount()

    assert.equal(signals[0]?.aborted, true, 'nothing may set state on a gone component')
  })
})

describe('useAsync — failures', () => {
  it('surfaces an ApiError as itself', async () => {
    const failure = new ApiError(404, 'notFound', 'No such player.', 'Check the tag.')
    const call = deferred<string>()
    const { result } = probe({ load: () => call.promise, deps: ['a'] })

    await act(async () => {
      call.reject(failure)
    })

    /* The same object, not a copy of its message: the view shows `hint` beside the
       message, and rebuilding the error here would drop it. */
    assert.deepEqual(result.current, { status: 'error', error: failure })
  })

  it('wraps anything that is not an ApiError as a network failure', async () => {
    const call = deferred<string>()
    const { result } = probe({ load: () => call.promise, deps: ['a'] })

    // What a fetch that never got an answer throws.
    await act(async () => {
      call.reject(new TypeError('Failed to fetch'))
    })

    const state = result.current
    assert.ok(state.status === 'error')
    assert.ok(state.error instanceof ApiError, 'every view reads `error` as an ApiError')
    assert.equal(state.error.status, 0, 'there was no response, so there is no status')
    assert.equal(state.error.reason, 'network')
    assert.equal(state.error.message, 'Failed to fetch')
  })

  /*
   * The other half of the truncated-link crash. `parseHash` now hands `%zz` on to the
   * player page, and `api.player` builds its path with `normalizeTag`, which raises
   * `InvalidTagError` *synchronously* — before there is a promise to reject. Called
   * bare inside the effect, that throw is caught by nothing and React unmounts the
   * tree, so the fix in `parseHash` would only have moved the blank page from the
   * render phase to the commit phase.
   *
   * It is not only reachable through a mangled escape: `#/player/!` is a tag nobody
   * can look up and took the app down the same way.
   */
  it('reports a loader that throws before returning, rather than letting it escape', async () => {
    const { result } = probe({
      load: () => {
        throw new InvalidTagError('%zz')
      },
      deps: ['%zz'],
    })

    // Settles a microtask later than the throw, exactly as a rejection does — which
    // is the point: it is the same failure path, not a second one.
    await act(async () => undefined)

    const state = result.current
    assert.ok(state.status === 'error', 'a throw during the effect must land as an error state')
    assert.equal(state.error.message, '"%zz" is not a valid Clash of Clans tag')
  })

  it('keeps an ApiError thrown before the request as itself', async () => {
    const failure = new ApiError(400, 'invalidTag', 'That is not a tag.', 'Check the tag.')
    const { result } = probe({
      load: () => {
        throw failure
      },
      deps: ['a'],
    })
    await act(async () => undefined)

    // Same rule as a rejection: the view reads `reason` and `hint` off it, and
    // rebuilding the error as a network failure would throw both away.
    assert.deepEqual(result.current, { status: 'error', error: failure })
  })

  it('falls back to a generic message when the rejection carries none', async () => {
    const call = deferred<string>()
    const { result } = probe({ load: () => call.promise, deps: ['a'] })

    await act(async () => {
      call.reject('something threw a string')
    })

    const state = result.current
    assert.ok(state.status === 'error')
    assert.equal(state.error.message, 'Request failed')
    assert.equal(state.error.reason, 'network')
  })
})
