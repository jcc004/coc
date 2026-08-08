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
 * **What a screen reader hears.** A cell is two controls — `−`, `+` — over sixty
 * tiles, so 120 things to land on, and the tiles carry no names: everything that says
 * *which card* is in an accessible name. These assertions go through
 * `getByRole(role, { name })`, which is the accessible-name computation rather than a
 * read of the attribute, so they fail the same way a screen reader would if the naming
 * came apart. The badge over the art is not a third control — it is `aria-hidden`,
 * decoration for a sighted reader past a spare — so it is checked by reading the
 * rendered pixel-facing markup (`.card-tile__badge`'s text), not by role.
 *
 * **How many writes a press costs.** Leaving a cell is the save, and a button press
 * moves focus off its sibling — so the naive version turns five presses of `+` into
 * five PUTs, each rewriting the base's whole season and moving the `updated_at` the
 * attribution line reads out. The rules are `card-entry.ts`' and tested there; what is
 * here is the wiring, which is the only place the count of requests is observable.
 *
 * Both steppers are drawn unconditionally — there is no width below which either goes
 * undrawn, unlike the number box this design once had. Only their *arrangement*
 * (stacked or side by side) answers to width, and jsdom applies no stylesheet, so that
 * distinction is invisible here and does not need to be: the markup is right at every
 * width the container query could choose between.
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

/** The two controls of one card's cell, each by its own accessible name. */
const fewer = (card: string) => screen.getByRole('button', { name: `One fewer ${card}` })
const more = (card: string) => screen.getByRole('button', { name: `One more ${card}` })

/**
 * A card's tile, by the pointer tooltip `CardTile` sets from its name and deck — the
 * one place a card's identity reaches the DOM outside the two steppers' own names.
 * Scopes the badge lookup below to one card among sixty.
 */
const tileFor = (card: string, category: string) =>
  screen.getByTitle(`${card} · ${category}`)

/**
 * The badge's own text, or `null` when the tile draws none — `count > 1` is the whole
 * condition, so a card held once or not at all renders nothing here at all. Read off
 * the DOM directly rather than through a role: the badge is `aria-hidden`, decoration
 * for a sighted reader, never a control a screen reader lands on.
 */
const badgeText = (card: string, category: string): string | null =>
  tileFor(card, category).querySelector('.card-tile__badge')?.textContent ?? null

/** Somewhere outside every cell, for a click that ends the edit. */
const away = () => screen.getByRole('heading', { name: 'Alda' })

describe('what a screen reader hears at one card', () => {
  it('names both controls, and names the card in each of them', () => {
    editor()

    /* Landing on a `+` has to say which card it belongs to — there are sixty of them
       and the tile prints no name — so the card's name is in both. Read through the
       accessible-name computation, so a change that only moved the text around would
       still have to leave these two names standing. */
    assert.ok(fewer('Barbarian'))
    assert.ok(more('Barbarian'))
  })

  it('never names the deck or a range on either stepper', () => {
    editor()

    // There is no third control left to carry this in words — the badge that once
    // might have is `aria-hidden`. Recorded here as a regression guard, not because
    // this cell says the deck or the range anywhere: it does not, any more.
    const label = (el: Element) => el.getAttribute('aria-label') ?? ''
    for (const button of [fewer('Barbarian'), more('Barbarian')]) {
      assert.doesNotMatch(label(button), /Elixir/)
      assert.doesNotMatch(label(button), /0 to 10/)
      assert.doesNotMatch(label(button), /held/)
    }
  })

  it('leaves the tile itself unnamed, so a card is not announced a third time', () => {
    editor()

    // `CardTile` takes a `label` for the totals grid, where nothing inside it is a
    // control. Here the two steppers are the named things and the picture is
    // decoration over them, so the tile is given none.
    assert.equal(screen.queryByRole('img', { name: /Barbarian/ }), null)
  })

  it('draws the badge only past a spare, and never as anything a screen reader lands on', () => {
    editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    // Held once, or not at all: the grayscale is the only signal, same as the totals
    // grid gives every card on it — not a gap introduced here.
    assert.equal(badgeText('Barbarian', 'Elixir'), null)
    assert.equal(badgeText('Archer', 'Elixir'), null)
    // A screen reader never lands on it even where it is drawn.
    assert.equal(screen.queryByRole('button', { name: /×/ }), null)
    assert.equal(screen.queryByRole('spinbutton'), null)
  })

  it('draws the badge past a spare, decoratively', () => {
    editor({ base: inventory([{ cardId: 1, count: 3 }]) })

    const badge = tileFor('Barbarian', 'Elixir').querySelector('.card-tile__badge')
    assert.equal(badge?.textContent, '×3')
    assert.equal(badge?.getAttribute('aria-hidden'), 'true')
  })
})

describe('a run of presses is one save', () => {
  it('writes nothing until focus leaves the card, however many times + is pressed', async () => {
    const { user, writes } = editor()

    for (let press = 0; press < 5; press += 1) await user.click(more('Barbarian'))

    /* Each press blurs whatever had focus, and a save on blur would be five PUTs of
       the entire season, each moving the base's `updated_at`. */
    assert.equal(writes.length, 0)
    assert.equal(badgeText('Barbarian', 'Elixir'), '×5')

    await user.click(away())

    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 5 }])
  })

  it('counts presses on both steppers as the one edit they are', async () => {
    const { user, writes } = editor()

    await user.click(more('Barbarian'))
    await user.click(more('Barbarian'))
    await user.click(fewer('Barbarian'))
    await user.click(away())

    /* Focus crosses both controls of the cell here, in both directions.
       `blurDecision`'s `sameCell` skip is what makes that one departure rather than
       three. */
    await waitFor(() => assert.equal(writes.length, 1))
    assert.deepEqual(writes[0], [{ cardId: 1, count: 1 }])
  })

  it('saves when focus moves on to a different card, which is a departure', async () => {
    const { user, writes } = editor()

    await user.click(more('Barbarian'))
    /* Tab, not a click on Archer's own stepper: a click there would both move focus
       *and* change Archer's count in the same gesture, which legitimately reopens
       `commit`'s while loop (a count changed while the first request was still in
       flight) and folds both cards into one second write — correct behavior, but not
       what this test is isolating. Tab moves focus with no value change, so the only
       thing under test is "a different card is a departure". */
    await user.tab()

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
       property that keeps tabbing across sixty cells from firing sixty requests. */
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
       either way — the number is right there in the badge past a spare, and the
       grayscale below that. */
    assert.equal((fewer('Barbarian') as HTMLButtonElement).disabled, true)
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, false)
    assert.equal((fewer('Archer') as HTMLButtonElement).disabled, false)
    assert.equal((more('Archer') as HTMLButtonElement).disabled, true)
  })

  it('keeps a bound end out of the tab order rather than as a stop that does nothing', async () => {
    // Archer is at the cap, so its `+` is unavailable; Giant holds nothing, so its
    // `−` is. DOM order in a cell is just `−` then `+` — the badge is never a tab
    // stop, `aria-hidden` and otherwise a plain `<span>`.
    const { user } = editor({ base: inventory([{ cardId: 2, count: MAX_CARD_COUNT }]) })

    fewer('Archer').focus()
    await user.tab()
    // Archer's own `+` is disabled and Giant's own `−` is disabled, so this Tab
    // crosses both and lands on the first control still reachable on either side.
    assert.equal(document.activeElement, more('Giant'))
  })

  it('stops at the cap rather than counting past it', async () => {
    const { user } = editor()

    for (let press = 0; press < MAX_CARD_COUNT + 3; press += 1) {
      const plus = more('Barbarian') as HTMLButtonElement
      if (plus.disabled) break
      await user.click(plus)
    }

    assert.equal(badgeText('Barbarian', 'Elixir'), `×${MAX_CARD_COUNT}`)
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, true)
  })

  it('hands focus to the sibling stepper on the press that takes a button away', async () => {
    const { user } = editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    await user.click(fewer('Barbarian'))

    /* A disabled element cannot hold focus, so without this the browser drops it on
       `<body>`: the user loses their place, and the cell is left with an edit that
       nothing focused is going to commit. There is no count box or badge to fall back
       on — the badge is never a focus target at all — so focus goes to the sibling
       stepper, the one control in the cell guaranteed not disabled by this same
       press. */
    assert.equal(document.activeElement, more('Barbarian'))
    assert.equal((fewer('Barbarian') as HTMLButtonElement).disabled, true)
  })
})

describe('a base this session may not write', () => {
  const REFUSAL = `${TAG} belongs to Sam. Only Sam or an admin can change its card counts.`
  /** What the two controls are called when the base is somebody else's. */
  const READ_ONLY = {
    fewer: 'One fewer Barbarian, read-only',
    more: 'One more Barbarian, read-only',
  }

  it('disables both controls, and says why without saying it twice', () => {
    editor({ owner: THEIRS })

    const steppers = [READ_ONLY.fewer, READ_ONLY.more].map((name) =>
      screen.getByRole('button', { name }),
    )
    for (const button of steppers) assert.equal((button as HTMLButtonElement).disabled, true)

    /* The steppers say *that* they are read-only; the sentence itself is about the
       base and not this card — it is the same sentence on all sixty tiles — so it is
       said in full only once, in the notice above the grid, and never duplicated at
       the tile: there is no longer a third control there to carry it. */
    for (const button of steppers) {
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
       the page is for. What is gone is the ability to change them. The badge does not
       care who owns the base; it draws the same past a spare either way. */
    assert.equal(writes.length, 0)
    assert.equal(badgeText('Barbarian', 'Elixir'), '×3')
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
    const panel = screen.getByText('Nothing was saved').closest<HTMLElement>('.notice')
    assert.ok(panel)
    assert.match(panel.textContent ?? '', /Network is down/)
    // "leave the card", not "leave the box": the retry instruction has to name the
    // thing you actually have to leave.
    assert.match(within(panel).getByText(/still here/).textContent ?? '', /leave the card/)
  })
})
