import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_JUMP_TARGETS,
  CARD_SECTIONS,
  CARD_TOP_ID,
  scrollAndFocus,
  scrollAndFocusFirst,
  scrollBehaviorFor,
  type CardSectionId,
} from './card-sections.ts'

/**
 * jsdom implements neither `scrollIntoView` nor `focus` scrolling — `test-dom.ts`
 * documents why nothing here fakes a viewport instead — so `scrollIntoView` is
 * stubbed the same way `CardsView.test.tsx`'s `captureScrolls` does: recorded, not
 * asserted against real layout, because there is none to have an opinion about.
 */
function captureScrollCalls() {
  const calls: string[] = []
  const before = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function scrollIntoView(this: Element) {
      calls.push(this.id)
    },
  })

  return {
    calls,
    restore: () => {
      if (before) Object.defineProperty(Element.prototype, 'scrollIntoView', before)
    },
  }
}

/** A focusable element (needs `tabIndex` in jsdom, same as the real headings and rows). */
function focusTarget(id: string): HTMLDivElement {
  const el = document.createElement('div')
  el.id = id
  el.tabIndex = -1
  document.body.appendChild(el)
  return el
}

/*
 * The consistency half. That each id is a heading the page *draws* is asserted in
 * `CardsView.test.tsx`, against the rendered DOM — the same split `help.ts` uses,
 * because a list can only check itself and the thing that goes wrong is the list
 * disagreeing with the page.
 */

describe('CARD_SECTIONS', () => {
  it('gives every section a unique id', () => {
    const ids = CARD_SECTIONS.map((section) => section.id)

    assert.equal(new Set(ids).size, ids.length)
  })

  it('names every section in sentence case, not as the heading renders it', () => {
    /* The headings are `text-transform: uppercase`, and Chrome computes an accessible
       name *after* the transform — so a name derived from one reads out as
       "COLLECTION LEADERBOARD". These strings are the arrow's own words for that
       reason, and a shouted one here would be that bug arriving by the back door. */
    for (const section of CARD_SECTIONS) {
      assert.notEqual(section.title, section.title.toUpperCase(), section.id)
    }
  })

  it('includes the top of the page, so an arrow has somewhere to send focus', () => {
    assert.ok(CARD_SECTIONS.some((section) => section.id === CARD_TOP_ID))
  })
})

describe('CARD_JUMP_TARGETS', () => {
  it('points every chip at a section that exists', () => {
    /* The failure this module exists for: a chip whose id no longer matches a heading
       scrolls nowhere, leaves the reader at the top and looks like it worked. */
    const known = new Set<CardSectionId>(CARD_SECTIONS.map((section) => section.id))

    for (const target of CARD_JUMP_TARGETS) {
      assert.ok(known.has(target.id), `${target.id} is not a section`)
    }
  })

  it('runs in page order, with the totals last', () => {
    /* Pinned as a literal because it is a decision rather than a default, and one that
       has been taken both ways: an earlier revision led with the leaderboard. A change
       should have to come here and say so. */
    assert.deepEqual(
      CARD_JUMP_TARGETS.map((target) => target.id),
      ['cards-suggestions', 'cards-tracker', 'cards-leaderboard', 'cards-totals'],
    )
    assert.deepEqual(
      CARD_JUMP_TARGETS.map((target) => target.label),
      ['Suggestions', 'Tracker', 'Leaderboard', 'Totals'],
    )
  })

  it('follows the order the page renders those sections in', () => {
    /* Derived rather than restated, so this keeps holding if a section moves: the three
       that are part of the enter-and-trade sequence appear here in the same relative
       order as in `CARD_SECTIONS`. The totals are exempt — they are last in the row by
       decision, and last in the page by coincidence. */
    const pageOrder = CARD_SECTIONS.map((section) => section.id)
    const rowOrder = CARD_JUMP_TARGETS.filter((target) => !target.hideWhereCramped).map(
      (target) => target.id,
    )

    assert.deepEqual(rowOrder, pageOrder.filter((id) => rowOrder.includes(id)))
  })

  it('marks exactly one chip as the one that drops out on a narrow screen', () => {
    /* One, because the measurement is that the *fourth* chip is what wraps the row —
       hiding two would give up a chip that fits. */
    const cramped = CARD_JUMP_TARGETS.filter((target) => target.hideWhereCramped)

    assert.deepEqual(
      cramped.map((target) => target.id),
      ['cards-totals'],
    )
  })

  it('hides the last chip and never one in the middle, so the row cannot gap', () => {
    const index = CARD_JUMP_TARGETS.findIndex((target) => target.hideWhereCramped)

    assert.equal(index, CARD_JUMP_TARGETS.length - 1)
  })

  it('keeps the totals a section, so its arrow survives its chip being hidden', () => {
    assert.ok(CARD_SECTIONS.some((section) => section.id === 'cards-totals'))
  })

  it('never offers a chip back to the top, which is the arrows job', () => {
    assert.ok(!CARD_JUMP_TARGETS.some((target) => target.id === CARD_TOP_ID))
  })

  it('labels every chip in one word, because the row is a width budget', () => {
    /* Measured, not guessed: four of these need 372.8px of line and three need less,
       which is what sets the 480px breakpoint where the fourth is hidden. A two-word
       label would move that threshold, and nothing on screen would say so. */
    for (const target of CARD_JUMP_TARGETS) {
      assert.ok(!target.label.includes(' '), target.label)
    }
  })
})

describe('scrollBehaviorFor', () => {
  it('slides when nobody has asked it not to', () => {
    assert.equal(scrollBehaviorFor(false), 'smooth')
  })

  it('jumps outright for a reader who asked for less motion', () => {
    /* Not "a shorter slide" — `auto` is an instant scroll. A long smooth scroll down a
       page this tall is exactly the motion the preference exists to refuse. */
    assert.equal(scrollBehaviorFor(true), 'auto')
  })
})

describe('scrollAndFocus', () => {
  it('scrolls the element into view and moves the caret there, when it exists', () => {
    const target = focusTarget('present')
    const scrolls = captureScrollCalls()
    try {
      const found = scrollAndFocus('present', 'auto')

      assert.equal(found, true)
      assert.deepEqual(scrolls.calls, ['present'])
      assert.equal(document.activeElement, target)
    } finally {
      scrolls.restore()
      target.remove()
    }
  })

  it('returns false and touches nothing when the id is not on the page', () => {
    const scrolls = captureScrollCalls()
    const activeBefore = document.activeElement
    try {
      /* The whole point: a caller reaching for a row that is off the current page,
         or a section that only exists on a different one, gets told so rather than
         handed an exception — this runs inside click handlers with no error
         boundary above them. */
      const found = scrollAndFocus('not-on-the-page', 'auto')

      assert.equal(found, false)
      assert.deepEqual(scrolls.calls, [])
      assert.equal(document.activeElement, activeBefore)
    } finally {
      scrolls.restore()
    }
  })
})

describe('scrollAndFocusFirst', () => {
  it('stops at the first id that exists, and never tries the rest', () => {
    const target = focusTarget('second')
    const scrolls = captureScrollCalls()
    try {
      const found = scrollAndFocusFirst(['first-missing', 'second', 'third-unreachable'], 'auto')

      assert.equal(found, 'second')
      assert.deepEqual(scrolls.calls, ['second'])
      assert.equal(document.activeElement, target)
    } finally {
      scrolls.restore()
      target.remove()
    }
  })

  it('falls back to a later id when the first is missing', () => {
    /* The shape `TradeSuggestions.tsx`'s "On the tracker" link needs: the specific
       row first, the tracker's section heading if the row isn't rendered. */
    const target = focusTarget('cards-tracker')
    const scrolls = captureScrollCalls()
    try {
      const found = scrollAndFocusFirst(['trade-row-9999', 'cards-tracker'], 'auto')

      assert.equal(found, 'cards-tracker')
      assert.equal(document.activeElement, target)
    } finally {
      scrolls.restore()
      target.remove()
    }
  })

  it('returns null, and touches nothing, when none of the ids are on the page', () => {
    const activeBefore = document.activeElement
    const found = scrollAndFocusFirst(['nope-one', 'nope-two'], 'auto')

    assert.equal(found, null)
    assert.equal(document.activeElement, activeBefore)
  })
})
