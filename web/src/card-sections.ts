/**
 * The card page's own sections, and what the jump row points at.
 *
 * A pure module rather than a list inside `CardsView` for the reason `help.ts` is one,
 * and it is the same failure: a chip labeled `Tracker` that scrolls to the leaderboard
 * is worse than no chip at all, and a chip whose id has since been renamed lands at the
 * top of the page and **looks like it worked**. Neither is visible in a screenshot, and
 * neither throws. So the ids live here, once, the headings reference them by name, and
 * the tests assert that every id a chip can carry is a section the page actually draws.
 *
 * **How the jump is spelled: a button and a `scrollIntoView`, never `href="#id"`.**
 *
 * The hash is spent on the route. `parseHash` splits it on `/` and matches the first
 * segment, so `#leaderboard` is a one-segment route matching nothing, which falls
 * through to `{ view: 'home' }` — and `App` renders `CardsView` only for the `cards`
 * view, so the link would unmount the page it was scrolling within. Worse quietly:
 * `routeToRemember` keeps any non-blank hash, so the junk fragment is *persisted* as
 * the last route and restores to home on the next sign-in. Both were measured against
 * the real modules, not reasoned about.
 *
 * `help.ts` reached the same wall and answered it with a path segment
 * (`#/help/<section>`), which buys a linkable, shareable target. That is available here
 * too — `#/cards/<section>` — and was not taken: the ask is in-page navigation for a
 * page people scroll, not a set of addresses to send each other, and the segment
 * version means teaching `parseHash`, `hrefFor` and the `Route` union about a card
 * section. `hooks.ts` has no error boundary above it, so it is not a file to widen for
 * a convenience nobody asked for. If linkability is ever wanted, that is the shape.
 */

/**
 * One anchored section of the card page.
 *
 * The card page's element ids are all `cards-*` (`cards-scope`, `cards-base`,
 * `cards-search`, `cards-columns` are the form controls), so these follow. It also
 * keeps them clear of `leaderboard-owner` and `leaderboard-rows`, which are the
 * leaderboard's own controls and would otherwise be a near-miss for `leaderboard`.
 */
export type CardSectionId =
  | 'cards-top'
  | 'cards-suggestions'
  | 'cards-tracker'
  | 'cards-leaderboard'
  | 'cards-totals'

export interface CardSection {
  id: CardSectionId
  /**
   * What the back-to-top arrow's accessible name says it is leaving, and what a test
   * matches a heading on. Sentence case, deliberately: the headings are styled
   * `text-transform: uppercase` in CSS, and a name taken from the rendered heading
   * comes back as `COLLECTION LEADERBOARD` — Chrome computes the accessible name after
   * the transform, which is already recorded on the leaderboard table in `CardsView`.
   */
  title: string
}

/**
 * Every anchored section, **in the order the page renders them**.
 *
 * `cards-top` is the page's own header, and it is a section here because the
 * back-to-top arrows need somewhere to send focus. Scrolling the window to 0 would
 * move the view and leave the caret at the bottom of the page, which hands a keyboard
 * user the whole document to tab back through — the trap `HelpView` documents.
 */
export const CARD_SECTIONS: readonly CardSection[] = [
  { id: 'cards-top', title: 'Clash of Cards' },
  { id: 'cards-suggestions', title: 'Trade suggestions' },
  { id: 'cards-tracker', title: 'Trade tracker' },
  { id: 'cards-leaderboard', title: 'Collection leaderboard' },
  { id: 'cards-totals', title: 'Cards across the clan' },
]

export interface CardJumpTarget {
  id: CardSectionId
  /**
   * The chip's own word, not the heading's.
   *
   * One word each, because the row's width budget is what decides how many chips fit
   * on a line — measured against the real stylesheet, four of these need 559px and
   * three need 431px, and a phone has 336px of card to spend.
   */
  label: string
  /**
   * Whether this chip drops out where the row would otherwise wrap to two lines.
   *
   * True for exactly one chip, and it is a **CSS** decision carried out by
   * `.card-jump__wide` — the button is always rendered and always in the DOM, so this
   * flag only says which one wears the class. That matters for reading the tests: jsdom
   * does no layout and applies no media query, so the component tests see four buttons
   * at every width and only the browser measurement covers the narrow case.
   *
   * `display: none` rather than `visibility` or `opacity`, so the chip leaves the
   * accessibility tree instead of staying focusable while invisible. A keyboard user
   * tabbing onto a control they cannot see is worse than not having the control.
   */
  hideWhereCramped?: boolean
}

/**
 * The jump row, left to right — **page order**, then the totals.
 *
 * Suggestions, tracker and the leaderboard are the order the sections themselves are
 * rendered in, so the row reads as a map of what is below rather than as a ranking. An
 * earlier revision led with the leaderboard, on the grounds that it is what people open
 * the page for; that was tried and reversed, because a row whose order disagrees with
 * the page teaches nothing about where anything is.
 *
 * **`cards-totals` is last and is the one that drops out on a narrow screen.** It has
 * the strongest claim of the four — it is the bottom of the page, so the furthest to
 * scroll to — but a fourth chip is also what takes the row from one line to two, and
 * the row being one line is the reason it is worth its space at the top of a page
 * somebody is already scrolling. Last in the order for the same reason it is the one
 * hidden: it is the only one that is not part of the enter-cards-and-trade sequence.
 *
 * It keeps its back-to-top arrow at every width regardless. The arrow costs nothing at
 * the top of the page, and the section it sits on is the worst place to be stranded.
 */
export const CARD_JUMP_TARGETS: readonly CardJumpTarget[] = [
  { id: 'cards-suggestions', label: 'Suggestions' },
  { id: 'cards-tracker', label: 'Tracker' },
  { id: 'cards-leaderboard', label: 'Leaderboard' },
  { id: 'cards-totals', label: 'Totals', hideWhereCramped: true },
]

/** The section every back-to-top arrow returns to. */
export const CARD_TOP_ID: CardSectionId = 'cards-top'

/**
 * How a jump should move the page.
 *
 * A boolean in and a `ScrollBehavior` out, rather than a `matchMedia` call inside a
 * click handler, so the one rule here — **a reader who asked for less motion gets
 * none** — is a line a test can hold. Smooth scrolling across a page this tall is a
 * long slide, and it is the exact motion `prefers-reduced-motion` exists to refuse.
 *
 * The caller reads the query at click time rather than subscribing: this is a decision
 * made once per press, so there is nothing to keep in sync and no listener to leak.
 * Note that `test-dom.ts` answers `false` to every media query, so the component tests
 * exercise the smooth path unless they replace `window.matchMedia` themselves.
 */
export function scrollBehaviorFor(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? 'auto' : 'smooth'
}
