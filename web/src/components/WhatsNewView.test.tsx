import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, render } from '@testing-library/react'
import { installTestCleanup } from '../test-support.ts'
import { WhatsNewView } from './WhatsNewView.tsx'

/**
 * What is left to test here is the intro's width, not the page's content: the list is
 * parsed, filtered and ordered in `changelog.ts`, which has its own tests, and the
 * payload is a build-time `define` that no test runner supplies.
 *
 * The width is worth pinning because it is what shipped a defect. Both paragraphs
 * carried `help-prose` — the help page's 68ch — which stopped them around 600px inside
 * a panel the full width of the shell, so the intro ran out halfway across the page.
 * They take the card now. jsdom does no layout, so what these assert is the class list
 * that would take the width away again, whether by `help-prose` returning or by a new
 * measure class appearing beside it. The width itself is checked in a browser.
 */

installTestCleanup()

/**
 * Mounted and then settled, because the list arrives asynchronously and lands in its
 * error state here: `loadChanges` imports the chunk holding `__BUILD_CHANGES__`, which
 * is a build-time `define` and undefined under the runner. Which state it lands in is
 * not what these tests are about — settling it inside `act` is only what keeps React's
 * "not wrapped in act" warning off the output of an otherwise clean suite.
 */
async function renderPage(): Promise<void> {
  await act(async () => {
    render(<WhatsNewView commit={null} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** The intro panel's paragraphs. It is the first of the view's two `.card` sections. */
function introParagraphs(): HTMLParagraphElement[] {
  const panel = document.querySelector('.card')
  assert.ok(panel, 'the intro panel renders')
  return [...panel.querySelectorAll('p')]
}

describe('the intro', () => {
  it('carries no measure, so it fills the panel', async () => {
    await renderPage()

    const intro = introParagraphs()
    assert.equal(intro.length, 2)
    for (const paragraph of intro) {
      assert.deepEqual(
        [...paragraph.classList],
        ['empty-hint'],
        'a second class here is a width, and this paragraph is meant to take the card',
      )
    }
  })

  it('does not borrow the help page measure', async () => {
    await renderPage()

    for (const paragraph of introParagraphs()) {
      assert.ok(
        !paragraph.classList.contains('help-prose'),
        'help-prose is 68ch of the help page, and stopped the intro halfway across this one',
      )
    }
  })
})
