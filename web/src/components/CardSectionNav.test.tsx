import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CARD_JUMP_TARGETS, CARD_TOP_ID } from '../card-sections.ts'
import { installTestCleanup } from '../test-support.ts'
import { BackToTop, HeadingJumpChip, SectionJumpRow } from './CardSectionNav.tsx'

/**
 * `CardsView.test.tsx`'s own `describe('jumping about the card page', ...)` already
 * covers this logic through the whole page; these tests render `SectionJumpRow`,
 * `BackToTop` and `HeadingJumpChip` directly and in isolation instead, which is what
 * actually justifies this file existing as its own testable unit now that it is one.
 *
 * Same scroll/matchMedia mocking technique as `CardsView.test.tsx`, copied rather than
 * shared: jsdom implements no scrolling at all, and `jumpToSection` (internal to
 * `CardSectionNav.tsx`) reads both at press time.
 */

installTestCleanup()

function captureScrolls() {
  const calls: { target: string; behavior: ScrollBehavior | undefined; top?: number }[] = []
  const beforeElement = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  const beforeWindow = Object.getOwnPropertyDescriptor(window, 'scrollTo')

  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function scrollIntoView(this: Element, options?: ScrollIntoViewOptions) {
      calls.push({ target: this.id, behavior: options?.behavior })
    },
  })

  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    writable: true,
    value: (options?: ScrollToOptions) => {
      calls.push({ target: 'window', behavior: options?.behavior, top: options?.top })
    },
  })

  return {
    calls,
    restore: () => {
      if (beforeElement) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', beforeElement)
      } else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')

      if (beforeWindow) Object.defineProperty(window, 'scrollTo', beforeWindow)
      else Reflect.deleteProperty(window, 'scrollTo')
    },
  }
}

/** Same swap, for the query `jumpToSection` reads at press time. */
function withReducedMotion(matches: boolean) {
  const before = Object.getOwnPropertyDescriptor(window, 'matchMedia')

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })

  return () => {
    if (before) Object.defineProperty(window, 'matchMedia', before)
    else Reflect.deleteProperty(window, 'matchMedia')
  }
}

describe('SectionJumpRow', () => {
  it('draws one chip per jump target, in that array\'s own order, labeled by it', () => {
    render(<SectionJumpRow />)
    const row = screen.getByRole('navigation', { name: 'Jump to a section' })

    assert.deepEqual(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
      CARD_JUMP_TARGETS.map((target) => target.label),
    )
  })

  it('puts the wide-hiding class on exactly the targets that ask for it', () => {
    render(<SectionJumpRow />)
    const row = screen.getByRole('navigation', { name: 'Jump to a section' })
    const buttons = within(row).getAllByRole('button')

    CARD_JUMP_TARGETS.forEach((target, index) => {
      assert.equal(
        buttons[index]?.classList.contains('card-jump__wide'),
        target.hideWhereCramped === true,
        `${target.id} (${target.label})`,
      )
    })
  })

  it('scrolls to and focuses the target a chip names, honoring reduced motion', async () => {
    const restoreMotion = withReducedMotion(false)
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      /* A real target id has to exist on the page for `scrollAndFocus` to find it —
         off in this isolated render, `SectionJumpRow` supplies only the buttons. */
      render(
        <>
          <h2 id="cards-tracker" tabIndex={-1}>
            Trade tracker
          </h2>
          <SectionJumpRow />
        </>,
      )

      await user.click(screen.getByRole('button', { name: 'Tracker' }))

      assert.deepEqual(scrolls.calls, [{ target: 'cards-tracker', behavior: 'smooth' }])
      assert.equal(document.activeElement?.id, 'cards-tracker')
    } finally {
      scrolls.restore()
      restoreMotion()
    }
  })

  it('scrolls without smoothing when reduced motion is preferred', async () => {
    const restoreMotion = withReducedMotion(true)
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      render(
        <>
          <h2 id="cards-tracker" tabIndex={-1}>
            Trade tracker
          </h2>
          <SectionJumpRow />
        </>,
      )

      await user.click(screen.getByRole('button', { name: 'Tracker' }))

      assert.deepEqual(scrolls.calls, [{ target: 'cards-tracker', behavior: 'auto' }])
    } finally {
      scrolls.restore()
      restoreMotion()
    }
  })
})

describe('BackToTop', () => {
  it('names itself by what it is leaving, not a fixed label', () => {
    render(
      <>
        <BackToTop from="Trade suggestions" />
        <BackToTop from="Trade tracker" />
      </>,
    )

    assert.ok(screen.getByRole('button', { name: 'Back to top, from Trade suggestions' }))
    assert.ok(screen.getByRole('button', { name: 'Back to top, from Trade tracker' }))
  })

  it('scrolls the window to 0 and focuses the top heading, never scrollIntoView', async () => {
    const restoreMotion = withReducedMotion(false)
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      render(
        <>
          <h1 id={CARD_TOP_ID} tabIndex={-1}>
            Clash of Cards
          </h1>
          <BackToTop from="Collection leaderboard" />
        </>,
      )

      await user.click(screen.getByRole('button', { name: 'Back to top, from Collection leaderboard' }))

      assert.deepEqual(scrolls.calls, [{ target: 'window', behavior: 'smooth', top: 0 }])
      assert.equal(document.activeElement?.id, CARD_TOP_ID)
    } finally {
      scrolls.restore()
      restoreMotion()
    }
  })

  it('respects reduced motion on the window scroll too', async () => {
    const restoreMotion = withReducedMotion(true)
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      render(
        <>
          <h1 id={CARD_TOP_ID} tabIndex={-1}>
            Clash of Cards
          </h1>
          <BackToTop from="Collection leaderboard" />
        </>,
      )

      await user.click(screen.getByRole('button', { name: 'Back to top, from Collection leaderboard' }))

      assert.deepEqual(scrolls.calls, [{ target: 'window', behavior: 'auto', top: 0 }])
    } finally {
      scrolls.restore()
      restoreMotion()
    }
  })

  it('does nothing if the top heading is not on the page, rather than throwing', async () => {
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      render(<BackToTop from="Collection leaderboard" />)

      await user.click(screen.getByRole('button', { name: 'Back to top, from Collection leaderboard' }))

      assert.deepEqual(scrolls.calls, [])
    } finally {
      scrolls.restore()
    }
  })
})

describe('HeadingJumpChip', () => {
  it('renders the given label', () => {
    render(<HeadingJumpChip label="Tracker" to="cards-tracker" />)
    assert.ok(screen.getByRole('button', { name: 'Tracker' }))
  })

  it('scrolls to and focuses the section it names', async () => {
    const scrolls = captureScrolls()
    try {
      const user = userEvent.setup()
      render(
        <>
          <h2 id="cards-suggestions" tabIndex={-1}>
            Trade suggestions
          </h2>
          <HeadingJumpChip label="Suggestions" to="cards-suggestions" />
        </>,
      )

      await user.click(screen.getByRole('button', { name: 'Suggestions' }))

      assert.deepEqual(scrolls.calls, [{ target: 'cards-suggestions', behavior: 'smooth' }])
      assert.equal(document.activeElement?.id, 'cards-suggestions')
    } finally {
      scrolls.restore()
    }
  })
})
