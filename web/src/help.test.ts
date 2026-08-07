import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HELP_SECTIONS, helpHref, helpSection, type HelpSectionId } from './help.ts'

/**
 * The ids every deep link in the app points at.
 *
 * Written out rather than derived from `HELP_SECTIONS`, so that deleting a section
 * fails here instead of quietly turning the `?` beside a panel into a link to the
 * top of the page. Each entry names the panel that links to it — if a panel is
 * retired, its line goes with it.
 */
const LINKED_FROM: Record<HelpSectionId, string> = {
  cards: 'the card grid',
  owners: "the roster's Owner column",
  trades: 'the trade suggestions panel',
  tracker: 'the trade tracker panel',
  leaderboard: 'the collection leaderboard',
  progress: 'the progress board and the weekly progress panel',
  'base-order': 'the base order page',
  shared: 'the help page contents only',
}

describe('HELP_SECTIONS', () => {
  it('has every section the panels deep-link into', () => {
    const drawn = new Set(HELP_SECTIONS.map((section) => section.id))
    for (const [id, panel] of Object.entries(LINKED_FROM)) {
      assert.ok(drawn.has(id as HelpSectionId), `${panel} links to #${id}, which no section draws`)
    }
  })

  it('gives every section a unique id', () => {
    const ids = HELP_SECTIONS.map((section) => section.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it('titles and summarizes every section, so the contents list is never a bare id', () => {
    for (const section of HELP_SECTIONS) {
      assert.ok(section.title.length > 0, `${section.id} needs a title`)
      assert.ok(section.summary.length > 0, `${section.id} needs a summary`)
    }
  })

  it('uses ids that are safe in a hash without escaping', () => {
    // The href is built by concatenation, so an id needing encoding would produce
    // a link that no longer parses back to itself.
    for (const section of HELP_SECTIONS) {
      assert.match(section.id, /^[a-z][a-z0-9-]*$/, `${section.id} is not URL-clean`)
    }
  })
})

describe('helpHref', () => {
  it('is the bare page for no section, with no trailing slash', () => {
    assert.equal(helpHref(null), '#/help')
  })

  it('puts the section in a path segment, like every other route here', () => {
    assert.equal(helpHref('trades'), '#/help/trades')
  })

  it('round-trips every section through the parser', () => {
    for (const section of HELP_SECTIONS) {
      const param = helpHref(section.id).slice('#/help/'.length)
      assert.equal(helpSection(param), section.id, `${section.id} did not round-trip`)
    }
  })
})

describe('helpSection', () => {
  it('answers null for no section, which is the whole page', () => {
    for (const param of [null, undefined, '', '   ']) {
      assert.equal(helpSection(param), null, `for ${JSON.stringify(param)}`)
    }
  })

  it('tolerates case and surrounding space, because this is a pasted URL', () => {
    assert.equal(helpSection('TRADES'), 'trades')
    assert.equal(helpSection(' owners '), 'owners')
  })

  it('falls back to the top of the page for a section it does not know', () => {
    // An old link, or a heading since renamed. Landing on the help page is right;
    // throwing, or routing home, would both be worse than a slightly wrong scroll.
    for (const param of ['chat', 'trade', 'owners/2', '../admin']) {
      assert.equal(helpSection(param), null, `for ${JSON.stringify(param)}`)
    }
  })
})
