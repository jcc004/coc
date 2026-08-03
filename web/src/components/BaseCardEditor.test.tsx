import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CARD_SEASON,
  MAX_CARD_COUNT,
  type BaseInventory,
  type CardCount,
  type SessionUser,
} from '@coc/shared'
import { api } from '../api.ts'
import type { BaseOwner } from '../card-entry.ts'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { BaseCardEditor } from './BaseCardEditor.tsx'

/**
 * The entry grid, from the two things it can get wrong that no screenshot would show.
 *
 * **What a screen reader hears.** A cell is three controls — `−`, the count box, `+` —
 * over sixty tiles, so 180 things to land on, and the tiles carry no names: everything
 * that says *which card* is in an accessible name. These assertions go through
 * `getByRole(role, { name })`, which is the accessible-name computation rather than a
 * read of the attribute, so they fail the same way a screen reader would if the naming
 * came apart.
 *
 * **How many writes a press costs.** Leaving a cell is the save, and a button press
 * moves focus off the box — so the naive version turns five presses of `+` into five
 * PUTs, each rewriting the base's whole season and moving the `updated_at` the
 * attribution line reads out. The rules are `card-entry.ts`' and tested there; what is
 * here is the wiring, which is the only place the count of requests is observable.
 *
 * The stepper buttons are hidden by CSS on a tile too narrow to hold them — a container
 * query, measured in a browser and documented at `.card-tile__step`. jsdom applies no
 * stylesheet, so every test here sees the markup as it is at a width that fits, which
 * is the case the markup has to be right for.
 */

installTestCleanup()

const RAE = sessionUser({ id: 1, displayName: 'Rae' })
const TAG = '#AAA'

/** Rae's own base, so the grid is writable. */
const MINE: BaseOwner = { ownerUserId: RAE.id, ownerLabel: 'Rae' }
/** Somebody else's, which is the read-only case. */
const THEIRS: BaseOwner = { ownerUserId: 2, ownerLabel: 'Sam' }

const inventory = (counts: CardCount[]): BaseInventory => ({ tag: TAG, counts })

function editor(
  options: {
    base?: BaseInventory
    owner?: BaseOwner
    user?: SessionUser
    failWith?: Error
  } = {},
) {
  const user = userEvent.setup()
  /* Every write the grid makes, in order. The count of these is the assertion in half
     this file, so it is recorded rather than merely stubbed. */
  const writes: CardCount[][] = []

  stubApi({
    // `saveBaseCounts` re-reads the shared store after a successful write, so this is
    // the request that lands *after* the one under test.
    cardInventory: () => Promise.resolve({ season: CARD_SEASON, bases: [] }),
  })
  mock.method(api, 'saveCardInventory', (tag: string, counts: CardCount[]) => {
    writes.push(counts)
    if (options.failWith) return Promise.reject(options.failWith)
    return Promise.resolve({ season: CARD_SEASON, base: { tag, counts } })
  })

  render(
    <BaseCardEditor
      tag={TAG}
      label="Alda"
      base={options.base}
      owner={options.owner ?? MINE}
      user={options.user ?? RAE}
    />,
  )

  return { user, writes }
}

/** The three controls of one card's cell, each by its own accessible name. */
const box = (name: string) => screen.getByRole('spinbutton', { name })
const fewer = (card: string) => screen.getByRole('button', { name: `One fewer ${card}` })
const more = (card: string) => screen.getByRole('button', { name: `One more ${card}` })

/** Somewhere outside every cell, for a click that ends the edit. */
const away = () => screen.getByRole('heading', { name: 'Alda' })

describe('what a screen reader hears at one card', () => {
  it('names all three controls, and names the card in each of them', () => {
    editor()

    /* Landing on a `+` has to say which card it belongs to — there are sixty of them
       and the tile prints no name — so the card's name is in all three. Read through
       the accessible-name computation, so a change that only moved the text around
       would still have to leave these three names standing. */
    assert.ok(fewer('Barbarian'))
    assert.ok(box('Barbarian, Elixir — copies held, 0 to 10'))
    assert.ok(more('Barbarian'))
  })

  it('says the deck and the range once per cell, not three times', () => {
    editor()

    /* The cost of naming three controls is measured in what a reader has to sit
       through: the deck is the one thing the tiles no longer show, and the range is
       true of all sixty, so both belong on the control the cell is *about*. Tripled,
       one deck would read out `Elixir` nineteen times over. */
    const label = (el: Element) => el.getAttribute('aria-label') ?? ''
    for (const button of [fewer('Barbarian'), more('Barbarian')]) {
      assert.doesNotMatch(label(button), /Elixir/)
      assert.doesNotMatch(label(button), /0 to 10/)
      assert.doesNotMatch(label(button), /copies held/)
    }
  })

  it('leaves the tile itself unnamed, so a card is not announced a fourth time', () => {
    editor()

    // `CardTile` takes a `label` for the totals grid, where nothing inside it is a
    // control. Here the controls are the named things and the picture is decoration
    // over them, so the tile is given none.
    assert.equal(screen.queryByRole('img', { name: /Barbarian/ }), null)
  })

  it('carries the count in the box, not only in the greyed art', () => {
    editor({ base: inventory([{ cardId: 1, count: 3 }]) })

    assert.equal((box('Barbarian, Elixir — copies held, 0 to 10') as HTMLInputElement).value, '3')
    assert.equal((box('Archer, Elixir — copies held, 0 to 10') as HTMLInputElement).value, '0')
  })
})

describe('a run of presses is one save', () => {
  it('writes nothing until focus leaves the card, however many times + is pressed', async () => {
    const { user, writes } = editor()

    for (let press = 0; press < 5; press += 1) await user.click(more('Barbarian'))

    /* The whole point. Each press blurs whatever had focus, and a save on blur would
       be five PUTs of the entire season, each moving the base's `updated_at`. */
    assert.equal(writes.length, 0)
    assert.equal((box('Barbarian, Elixir — copies held, 0 to 10') as HTMLInputElement).value, '5')

    await user.click(away())

    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 5 }])
  })

  it('counts presses and a click into the box as the one edit they are', async () => {
    const { user, writes } = editor()

    await user.click(more('Barbarian'))
    await user.click(more('Barbarian'))
    await user.click(box('Barbarian, Elixir — copies held, 0 to 10'))
    await user.click(fewer('Barbarian'))
    await user.click(away())

    /* Focus crosses all three controls of the cell here, in both directions.
       `blurDecision`'s `sameCell` skip is what makes that one departure rather than
       four. */
    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 1 }])
  })

  it('still takes a typed count, which is the reason the box did not become a button', async () => {
    const { user, writes } = editor()

    // Sixty cards is sixty numbers: somebody entering them types `7` rather than
    // pressing `+` seven times, and that is why the buttons went beside the box.
    await user.type(box('Barbarian, Elixir — copies held, 0 to 10'), '7')
    await user.click(away())

    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 7 }])
  })

  it('saves when focus moves on to a different card, which is a departure', async () => {
    const { user, writes } = editor()

    await user.click(more('Barbarian'))
    // The next card's own box: outside this cell, so this edit is finished.
    await user.click(box('Archer, Elixir — copies held, 0 to 10'))

    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 1 }])

    // And nothing further, because leaving a card nobody changed writes nothing.
    await user.click(away())
    assert.equal(writes.length, 1)
  })

  it('still writes nothing at all when a cell is left exactly as it was found', async () => {
    const { user, writes } = editor({ base: inventory([{ cardId: 1, count: 4 }]) })

    /* Up and straight back down, then away. The comparison is against what the server
       holds, not against the value the focus started on, so this is silent — the same
       property that keeps tabbing across sixty boxes from firing sixty requests. */
    await user.click(more('Barbarian'))
    await user.click(fewer('Barbarian'))
    await user.click(away())

    assert.equal(writes.length, 0)
  })
})

describe('the ends of the range', () => {
  it('offers no − at zero and no + at the cap', () => {
    editor({ base: inventory([{ cardId: 2, count: MAX_CARD_COUNT }]) })

    /* `disabled`, not a press that clamps: a control that is offered and does nothing
       is a dead end, and this grid would hand out sixty of them. The bound is legible
       either way — the number is right there, and the box's name gives the range. */
    assert.equal((fewer('Barbarian') as HTMLButtonElement).disabled, true)
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, false)
    assert.equal((fewer('Archer') as HTMLButtonElement).disabled, false)
    assert.equal((more('Archer') as HTMLButtonElement).disabled, true)
  })

  it('keeps a bound end out of the tab order rather than as a stop that does nothing', async () => {
    // Archer is at the cap and Giant holds nothing, so Archer's `+` and Giant's `−`
    // are both unavailable and Tab should cross straight from one box to the next.
    const { user } = editor({ base: inventory([{ cardId: 2, count: MAX_CARD_COUNT }]) })

    box('Barbarian, Elixir — copies held, 0 to 10').focus()
    await user.tab()
    assert.equal(document.activeElement, more('Barbarian'))

    box('Archer, Elixir — copies held, 0 to 10').focus()
    await user.tab()
    assert.equal(document.activeElement, box('Giant, Elixir — copies held, 0 to 10'))
  })

  it('stops at the cap rather than counting past it', async () => {
    const { user } = editor()
    const barbarian = box('Barbarian, Elixir — copies held, 0 to 10')

    for (let press = 0; press < MAX_CARD_COUNT + 3; press += 1) {
      const plus = more('Barbarian') as HTMLButtonElement
      if (plus.disabled) break
      await user.click(plus)
    }

    assert.equal((barbarian as HTMLInputElement).value, String(MAX_CARD_COUNT))
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, true)
  })

  it('hands focus to the count box on the press that takes a button away', async () => {
    const { user } = editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    await user.click(fewer('Barbarian'))

    /* A disabled element cannot hold focus, so without this the browser drops it on
       `<body>`: the user loses their place, and the cell is left with an edit that
       nothing focused is going to commit. */
    assert.equal(document.activeElement, box('Barbarian, Elixir — copies held, 0 to 10'))
    assert.equal((fewer('Barbarian') as HTMLButtonElement).disabled, true)
  })
})

describe('a base this session may not write', () => {
  const REFUSAL = `${TAG} belongs to Sam. Only Sam or an admin can change its card counts.`
  /** What the three controls are called when the base is somebody else's. */
  const READ_ONLY = {
    fewer: 'One fewer Barbarian, read-only',
    box: `Barbarian, Elixir — copies held, read-only. ${REFUSAL}`,
    more: 'One more Barbarian, read-only',
  }

  it('disables all three controls, and says why without saying it three times', () => {
    editor({ owner: THEIRS })

    const buttons = [READ_ONLY.fewer, READ_ONLY.more].map((name) =>
      screen.getByRole('button', { name }),
    )
    for (const button of buttons) assert.equal((button as HTMLButtonElement).disabled, true)
    assert.equal((box(READ_ONLY.box) as HTMLInputElement).disabled, true)

    /* The buttons say *that* they are read-only; the sentence itself is about the
       base and not this card — it is the same sentence on all sixty tiles — so it is
       said once in the cell, on the control that would have taken the typing, and
       once in full in the notice above the grid. */
    for (const button of buttons) {
      assert.doesNotMatch(button.getAttribute('aria-label') ?? '', /belongs to Sam/)
      // A pointer still gets the whole reason, where a tooltip costs nothing.
      assert.equal(button.getAttribute('title'), REFUSAL)
    }
    assert.ok(screen.getByText('Someone else owns this base'))
    assert.ok(screen.getByText(REFUSAL))
  })

  it('writes nothing, and changes nothing, when a disabled stepper is pressed', async () => {
    const { user, writes } = editor({ base: inventory([{ cardId: 1, count: 3 }]), owner: THEIRS })

    await user.click(screen.getByRole('button', { name: READ_ONLY.more }))
    await user.click(away())

    /* The counts are still readable — they are shared, and reading them is most of what
       the page is for. What is gone is the ability to change them, on all three. */
    assert.equal(writes.length, 0)
    assert.equal((box(READ_ONLY.box) as HTMLInputElement).value, '3')
  })
})

describe('a save that did not happen', () => {
  it('reports at the card it was typed on, and keeps the number', async () => {
    const { user } = editor({ failWith: new Error('Network is down.') })

    await user.click(more('Barbarian'))
    await user.click(away())

    /* Sixty fields that save themselves have no Save button left to go quiet in, so a
       failure has to be visible at the tile as well as in the panel. */
    const note = await screen.findByText('Not saved')
    assert.equal(note.closest('.card-tile')?.getAttribute('title'), 'Barbarian · Elixir')
    assert.equal((box('Barbarian, Elixir — copies held, 0 to 10') as HTMLInputElement).value, '1')
    const panel = screen.getByText('Nothing was saved').closest<HTMLElement>('.notice')
    assert.ok(panel)
    assert.match(panel.textContent ?? '', /Network is down/)
    // "leave the card", not "leave the box": a cell is three controls now, and the
    // retry instruction has to name the thing you actually have to leave.
    assert.match(within(panel).getByText(/still here/).textContent ?? '', /leave the card/)
  })
})
