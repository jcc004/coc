import { JSDOM } from 'jsdom'

/**
 * A DOM for the component tests, installed as globals before any test module loads.
 *
 * The runner is `node --import tsx --test`, which has no DOM at all, and the pure
 * modules never needed one. The components do, and the three largest files in this
 * repo are components — so rather than move the whole project onto vitest or jest for
 * the sake of an environment flag, this is the environment: one jsdom window, hoisted
 * onto `globalThis` by `--import` so it exists before the first `import`.
 *
 * **`--import`, not a plain `import` at the top of each test.** `@testing-library/react`
 * builds `screen` from `document.body` *while it is being evaluated*, so a DOM that
 * arrives with the test file's own imports arrives too late unless every file is careful
 * to order them — a rule nobody would remember on the fourth test file. Loading this
 * before the module graph makes the ordering unbreakable instead of merely documented.
 *
 * Nothing here is imported by the app, and jsdom is a devDependency, so none of it can
 * reach the production bundle.
 */

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  // A real origin: `localStorage` throws on an opaque one, and half the app's
  // preferences (theme, row limits, the Mine/All filter) are stored there.
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

/**
 * jsdom implements neither of these, and both are load-bearing here: the roster and
 * the saved-clans table render *different DOM* depending on `matchMedia`, and every
 * measured-width control asks for a `ResizeObserver` on mount.
 *
 * Both are deliberately inert rather than clever. `matchMedia` answers "no" to every
 * query, which is the wide layout — the one with the real column heads and sort
 * buttons — and `ResizeObserver` never fires, which leaves `useMeasuredWidth` at its
 * documented "not measured yet" 0. Faking a viewport width instead would mean this
 * file quietly deciding which breakpoint every test runs at; a test that cares about
 * the stacked layout should say so by replacing `window.matchMedia` itself.
 */
Object.defineProperty(dom.window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

Object.defineProperty(dom.window, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const from = dom.window as unknown as Record<string, unknown>
const onto = globalThis as unknown as Record<string, unknown>

/*
 * Only the names Node does not already define. Copying over Node's own `Promise`,
 * `setTimeout` or `AbortController` would replace them with the jsdom realm's
 * versions, and cross-realm `instanceof` is false — which breaks `node:test` and any
 * library that checks. Underscore-prefixed keys are jsdom's internals.
 */
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key.startsWith('_') || key in onto) continue
  onto[key] = from[key]
}

/*
 * `navigator` is the exception: Node defines one, but the app reads
 * `navigator.clipboard` — which Node's lacks, and which `user-event` installs onto the
 * *window's* navigator. Two different objects would mean the stub landing somewhere
 * the component never looks.
 */
Object.defineProperty(onto, 'navigator', {
  configurable: true,
  writable: true,
  value: dom.window.navigator,
})

/** React 19 warns on every state update outside `act` until this is set. */
onto.IS_REACT_ACT_ENVIRONMENT = true
