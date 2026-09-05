import {
  CARD_JUMP_TARGETS,
  CARD_TOP_ID,
  scrollAndFocus,
  scrollBehaviorFor,
  type CardSectionId,
} from '../card-sections.ts'

/* ---------- jumping about the page ---------- */

/**
 * Scrolls one of the page's sections into view and puts the caret on it.
 *
 * **The focus move is not optional.** Scrolling alone leaves a keyboard user's caret
 * wherever it was — at the top of the page for a jump chip, at the bottom for a
 * back-to-top arrow — so the thing they pressed is now somewhere they have to tab the
 * whole document to reach. That is the trap `HelpView` records; the headings carry
 * `tabIndex={-1}` for no other reason than to let this succeed.
 *
 * `preventScroll`, because the browser's own focus scroll would race the one above and
 * land somewhere else. Same pairing, same reason, as `HelpView`.
 *
 * A missing element is a return, not a throw. It cannot happen while `card-sections.ts`
 * and the headings agree — which is what its tests are for — but this runs inside a
 * click handler on a page with no error boundary above it, and "the arrow did nothing"
 * is a far better failure than a blank page.
 *
 * The reusable half — find the element, scroll it into view, focus it — is
 * `scrollAndFocus` in `card-sections.ts`. What stays here is the one case that isn't
 * that: `cards-top`.
 */
function jumpToSection(id: CardSectionId): void {
  /* Read at press time rather than subscribed to: it is one decision per click, so
     there is no state to keep in step and no listener to unsubscribe. */
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const behavior = scrollBehaviorFor(still)

  /*
   * The top of the page is the *window's* top, not the top heading's.
   *
   * `cards-top` sits about 120px into the document — `.shell`'s 24px of padding, the
   * banner and its 20px margin, then the card's border and 20px of padding — so
   * `scrollIntoView` on it stops with the banner scrolled off and the card apparently
   * beheaded. Which is exactly what it was asked to do: it aligns the element, and the
   * element is not the top. Every other target wants the element, and gets it.
   *
   * Focus still moves to the heading, and that is the whole reason `cards-top` is an
   * anchored section at all — see `card-sections.ts`. Scrolling instead of focusing is
   * the trap; scrolling *and* focusing is not. `scrollAndFocus` cannot be reused for
   * this one case because it always scrolls the *element*, and this is the one target
   * that must not be.
   */
  if (id === CARD_TOP_ID) {
    const target = document.getElementById(id)
    if (target === null) return
    window.scrollTo({ top: 0, behavior })
    target.focus({ preventScroll: true })
    return
  }

  scrollAndFocus(id, behavior)
}

/**
 * The jump row, under the controls.
 *
 * Buttons rather than `href="#cards-leaderboard"`: the hash is the router, and a bare
 * fragment parses as an unknown route, unmounts this page to render home, *and* gets
 * remembered as the last route. The whole argument is in `card-sections.ts`.
 *
 * `.recents` and `.chip` rather than a new class, because that pair is already the
 * app's row-of-small-controls and `.chip` is already worn by buttons as well as links
 * (the saved-clans row, the trade tracker). A row this small does not earn a third
 * styling mechanism, and the chip's 44px touch target on a phone comes free with it.
 */
export function SectionJumpRow() {
  return (
    <nav className="recents card-jump" aria-label="Jump to a section">
      {CARD_JUMP_TARGETS.map((target) => (
        <button
          key={target.id}
          type="button"
          /* Always rendered; `.card-jump__wide` is what takes the fourth one out of the
             row — and out of the accessibility tree with it — below the width where
             four would wrap. Rendering conditionally instead would mean this component
             tracking the viewport, which is a `matchMedia` subscription and a re-render
             to do what one line of CSS already does. */
          className={target.hideWhereCramped ? 'chip card-jump__wide' : 'chip'}
          onClick={() => jumpToSection(target.id)}
        >
          {target.label}
        </button>
      ))}
    </nav>
  )
}

/**
 * The up arrow in the corner of a section heading.
 *
 * Named the way `HelpLink` is — the glyph `aria-hidden`, the words in a
 * `.visually-hidden` span, and the same string on `title` — rather than by an
 * `aria-label` on the button. An `aria-label` over a text node leaves the glyph in the
 * accessibility tree on some combinations, and `↑` is not a word.
 *
 * The name says what it is leaving, not just where it goes: four of these on one page
 * all reading "Back to top" is four identical controls in a screen reader's list, and
 * the section is the only thing that tells them apart. It comes from
 * `card-sections.ts` in sentence case and never from the heading beside it — those are
 * `text-transform: uppercase`, and Chrome computes the accessible name after the
 * transform, which is how the leaderboard table ended up named `COLLECTION
 * LEADERBOARD`.
 */
export function BackToTop({ from }: { from: string }) {
  const name = `Back to top, from ${from}`
  return (
    <button
      type="button"
      className="icon-button section-title__top"
      onClick={() => jumpToSection(CARD_TOP_ID)}
      title={name}
    >
      <span aria-hidden="true">↑</span>
      <span className="visually-hidden">{name}</span>
    </button>
  )
}

/**
 * A cross-link chip beside a heading's back-to-top arrow, pointing at the *other*
 * half of the propose-then-track workflow: "Tracker" in the suggestions heading,
 * "Suggestions" in the tracker's. The two panels are read downwards as one
 * sequence — see the comment above the tracker section — and this is the way back
 * up one of them without scrolling past it by hand.
 *
 * `.chip`, the same class the jump row below already wears, plus
 * `.section-title__jump-chip` so this claims the heading's leftover flex space
 * instead of `.section-title__top` splitting it with the arrow that follows — the
 * CSS comment on that class has the reasoning for why it is not done by editing
 * `.section-title__top` itself.
 */
export function HeadingJumpChip({ label, to }: { label: string; to: CardSectionId }) {
  return (
    <button
      type="button"
      className="chip section-title__jump-chip"
      onClick={() => jumpToSection(to)}
    >
      {label}
    </button>
  )
}
