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
 * **What a screen reader hears.** A cell is two controls — the whole tile (`+`) and a
 * small corner circle (`−`) — over sixty tiles, so 120 things to land on, and the tiles
 * carry no name of their own: everything that says *which card* is in one of the two
 * controls' own accessible names. These assertions go through `getByRole(role, {
 * name })`, which is the accessible-name computation rather than a read of the
 * attribute, so they fail the same way a screen reader would if the naming came apart.
 * The badge over the art is not a third control — it is `aria-hidden`, decoration for a
 * sighted reader past a spare — so it is checked by reading the rendered pixel-facing
 * markup (`.card-tile__badge`'s text), not by role.
 *
 * **How many writes a press costs.** Leaving a cell is the save, and a press on either
 * control can move focus to the other one in the same cell — so the naive version turns
 * five presses of `+` into five PUTs, each rewriting the base's whole season and moving
 * the `updated_at` the attribution line reads out. The rules are `card-entry.ts`'s and
 * tested there; what is here is the wiring, which is the only place the count of
 * requests is observable.
 *
 * **The corner `−` is not always in the DOM, but its absence means only one thing.**
 * It is not rendered at all below a held copy — there is nothing to decrement — but
 * unlike that case, a read-only base with a held card still draws it, `disabled`, with
 * a `, read-only` accessible-name suffix: see `DecrementButton`'s own doc comment for
 * why an *absent* control on a read-only base used to be indistinguishable from "you
 * hold none of this," and is not any more. Tests that need the circle to exist seed a
 * base with at least one copy of the card under test.
 *
 * Both controls' *arrangement* (the corner circle's exact on-screen size and position)
 * answers to the tile's own width via a container query, and jsdom applies no
 * stylesheet, so that is invisible here and does not need to be — it is checked in a
 * real browser instead, not in this file.
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

/**
 * The two controls of one card's cell, each by its own accessible name.
 *
 * `more` is the tile-wide `+` — the whole card is the target, not a small button
 * under it, but it is still a `<button>` with this exact accessible name, so a role
 * query finds it the same way. `fewer` is the corner `−` circle, and only exists when
 * the card under test holds at least one copy; a test that needs it seeds a base
 * accordingly, and a test checking its *absence* uses `screen.queryByRole` directly
 * rather than this helper, since `getByRole` throws when nothing matches.
 */
const fewer = (card: string) => screen.getByRole('button', { name: `One fewer ${card}` })
const more = (card: string) => screen.getByRole('button', { name: `One more ${card}` })

/**
 * A card's tile, by the pointer tooltip `CardTile` sets from its name and deck — the
 * one place a card's identity reaches the DOM outside the two controls' own names.
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
    // A copy already held, so the corner `−` exists alongside the tile-wide `+`.
    editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    /* Landing on either control has to say which card it belongs to — there are
       sixty cells and the tile prints no name of its own — so the card's name is in
       both. Read through the accessible-name computation, so a change that only
       moved the text around would still have to leave these two names standing. */
    assert.ok(fewer('Barbarian'))
    assert.ok(more('Barbarian'))
  })

  it('never names the deck or a range on either control', () => {
    editor({ base: inventory([{ cardId: 1, count: 1 }]) })

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
    // control. Here the two controls are the named things and the picture is
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

describe('the corner − circle only exists past a held copy', () => {
  it('is absent at zero, present from one copy on', () => {
    editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    // Barbarian holds one: the circle exists.
    assert.ok(screen.getByRole('button', { name: 'One fewer Barbarian' }))
    // Archer holds none: no circle at all — not a disabled one.
    assert.equal(screen.queryByRole('button', { name: 'One fewer Archer' }), null)
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

  it('counts presses on both controls as the one edit they are', async () => {
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
    /* Tab, not a click on Archer's own control: a click there would both move focus
       *and* change Archer's count in the same gesture, which legitimately reopens
       `commit`'s while loop (a count changed while the first request was still in
       flight) and folds both cards into one second write — correct behavior, but not
       what this test is isolating. Tab moves focus with no value change, so the only
       thing under test is "a different card is a departure". The tile-wide `+` is
       the last control in Barbarian's cell (the corner `−`, when it exists, comes
       before it in the DOM — see `CardEntryTile`'s own note on why), so a Tab off it
       lands on Archer's own first control, a genuinely different card. */
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
  it('offers no − at zero, and disables + at the cap rather than a − that clamps', () => {
    editor({ base: inventory([{ cardId: 2, count: MAX_CARD_COUNT }]) })

    // Barbarian holds nothing: there is no − circle to decrement past zero with.
    assert.equal(screen.queryByRole('button', { name: 'One fewer Barbarian' }), null)
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, false)

    /* Archer is at the cap: `disabled`, not a press that clamps — a control that is
       offered and does nothing is a dead end, and this grid would hand out sixty of
       them. The bound is legible either way — the number is right there in the
       badge past a spare, and the grayscale below that. The corner − stays live:
       count - 1 from ten is always legal, so nothing about being at the cap takes
       it away. */
    assert.equal((more('Archer') as HTMLButtonElement).disabled, true)
    assert.equal((fewer('Archer') as HTMLButtonElement).disabled, false)
  })

  it('keeps a bound end out of the tab order rather than as a stop that does nothing', async () => {
    // Archer is at the cap, so its own `+` is disabled. Giant holds nothing, so it
    // has no `−` at all — not a disabled one, the circle simply is not rendered.
    // DOM order in a cell is the `−` circle (when it exists) then the `+` button —
    // see `CardEntryTile`'s own note on why that order, not the reverse, is what
    // keeps a cell's last live control exiting to the next card.
    const { user } = editor({ base: inventory([{ cardId: 2, count: MAX_CARD_COUNT }]) })

    fewer('Archer').focus()
    await user.tab()
    // Archer's own `+` is disabled and Giant has no `−` to land on at all, so this
    // Tab crosses both and lands on the first control still reachable on either
    // side: Giant's own `+`.
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

  it('hands focus to the tile-wide + on the press that removes the − circle', async () => {
    const { user } = editor({ base: inventory([{ cardId: 1, count: 1 }]) })

    await user.click(fewer('Barbarian'))

    /* The press that empties a tile un-mounts its own − circle on the next render —
       there is no `disabled` state to fall into the way the old stepper row had.
       Without an explicit handoff the browser would drop focus on `<body>`: the
       user loses their place, and per `blurDecision`'s `sameCell` rule that also
       reads as leaving the cell, firing a save mid-sequence. */
    assert.equal(document.activeElement, more('Barbarian'))
    assert.equal(screen.queryByRole('button', { name: 'One fewer Barbarian' }), null)
  })

  it('hands focus to the corner − circle on the press that caps the + button out', async () => {
    const { user } = editor({ base: inventory([{ cardId: 1, count: MAX_CARD_COUNT - 1 }]) })

    await user.click(more('Barbarian'))

    /* The mirror case: unlike the old two-button row, the receiving control here is
       never disabled by this same press — it only ever disappears at the opposite
       bound (count reaching zero), which a press on `+` can never cause — so it is
       always there, live, to receive focus. */
    assert.equal(document.activeElement, fewer('Barbarian'))
    assert.equal((more('Barbarian') as HTMLButtonElement).disabled, true)
  })
})

describe('keyboard operation', () => {
  it('reaches both controls by Tab and activates each with Enter or Space', async () => {
    const { user } = editor()

    more('Barbarian').focus()
    await user.keyboard('{Enter}')
    // A copy now exists, so the corner − has appeared.
    assert.ok(screen.getByRole('button', { name: 'One fewer Barbarian' }))

    fewer('Barbarian').focus()
    await user.keyboard(' ')
    // Back to zero: the circle is gone again, and nothing but a real click or key
    // press on a real `<button>` produced either change — no bespoke key handling
    // was written for either control, which is the point of both being native
    // buttons rather than a `div` with an `onClick`.
    assert.equal(screen.queryByRole('button', { name: 'One fewer Barbarian' }), null)
  })
})

describe('a base this session may not write', () => {
  const REFUSAL = `${TAG} belongs to Sam. Only Sam or an admin can change its card counts.`

  it('disables both controls and says why without saying it twice', () => {
    editor({ base: inventory([{ cardId: 1, count: 3 }]), owner: THEIRS })

    const plus = screen.getByRole('button', { name: 'One more Barbarian, read-only' })
    assert.equal((plus as HTMLButtonElement).disabled, true)

    /* Unlike the pre-fix behavior, the corner − still renders on a read-only base
       when the base holds the card — disabled, not absent — so a screen reader
       browsing this tile's controls can tell "you hold none of this" (no control
       at all) apart from "this base isn't yours" (a disabled one). See
       `DecrementButton`'s own doc comment. */
    const minus = screen.getByRole('button', { name: 'One fewer Barbarian, read-only' })
    assert.equal((minus as HTMLButtonElement).disabled, true)

    /* The tile-wide button says *that* it is read-only in its accessible name; the
       sentence itself is about the base and not this card — it is the same sentence
       on all sixty tiles — so it is said in full only once, in the notice above the
       grid, and never duplicated in the name. Unlike the corner circle (which has
       nothing else inside it to steal a tooltip resolution — see `DecrementButton`'s
       own doc comment), the tile-wide button carries no `title` of its own any more:
       `CardTile`'s own `title` on its inner element already wins hover resolution
       for the whole tile, so a `title` here could never have surfaced regardless of
       what it held. */
    assert.doesNotMatch(plus.getAttribute('aria-label') ?? '', /belongs to Sam/)
    assert.equal(plus.getAttribute('title'), null)
    assert.equal(minus.getAttribute('title'), REFUSAL)

    assert.ok(screen.getByText('Someone else owns this base'))
    assert.ok(screen.getByText(REFUSAL))
  })

  it('dims every tile on the base, not just the held ones', () => {
    editor({ base: inventory([{ cardId: 1, count: 3 }]), owner: THEIRS })

    // Barbarian (held, ×3) and Archer (unheld) both read the same "you cannot
    // touch this" cue — the read-only reason is about the base, not any one card.
    const heldButton = screen.getByRole('button', { name: 'One more Barbarian, read-only' })
    const unheldButton = screen.getByRole('button', { name: 'One more Archer, read-only' })
    assert.ok(heldButton.querySelector('.card-tile')?.classList.contains('card-tile--readonly'))
    assert.ok(unheldButton.querySelector('.card-tile')?.classList.contains('card-tile--readonly'))
  })

  it('writes nothing, and changes nothing, when either control is pressed', async () => {
    const { user, writes } = editor({ base: inventory([{ cardId: 1, count: 3 }]), owner: THEIRS })

    await user.click(screen.getByRole('button', { name: 'One more Barbarian, read-only' }))
    await user.click(screen.getByRole('button', { name: 'One fewer Barbarian, read-only' }))
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
       failure has to be visible at the tile as well as in the panel. The note sits
       beside the button now, not inside it — an aria-labeled button excludes its own
       descendant text from assistive tech, so the note moved out to where it is
       reachable, and `aria-describedby` is what still ties it to the button for a
       screen reader landing there by Tab. */
    const note = await screen.findByText('Not saved')
    assert.equal(note.closest('.card-entry-tile')?.querySelector('.card-tile')?.getAttribute('title'), 'Barbarian · Elixir')
    const plus = more('Barbarian')
    assert.equal(plus.getAttribute('aria-describedby'), note.id)
    const panel = screen.getByText('Nothing was saved').closest<HTMLElement>('.notice')
    assert.ok(panel)
    assert.match(panel.textContent ?? '', /Network is down/)
    // "leave the card", not "leave the box": the retry instruction has to name the
    // thing you actually have to leave.
    assert.match(within(panel).getByText(/still here/).textContent ?? '', /leave the card/)
  })
})
