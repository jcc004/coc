import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CARD_SEASON, type BaseInventory, type ClanMember, type OwnerRecord } from '@coc/shared'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { CardsView } from './CardsView.tsx'

/**
 * The card page, from the two questions it can get wrong in a way that leaves somebody
 * staring at a screen they cannot act on: **which bases am I offered** (the Mine/All
 * filter, which defaults differently depending on whether this account owns anything),
 * and **what is the whole clan doing** (the leaderboard and the totals, which are
 * deliberately *not* narrowed by that filter).
 *
 * The scoring curve, the base filter's rules and the labelling are pure and tested in
 * `card-standings.ts`, `base-scope.ts` and `base-names.ts`. What is here is the wiring
 * between them, which is the part that has no test anywhere else.
 */

installTestCleanup()

const RAE = sessionUser({ id: 1, displayName: 'Rae' })

const member = (over: { tag: string; name: string }): ClanMember => ({
  role: 'member',
  townHallLevel: 15,
  expLevel: 100,
  trophies: 3000,
  clanRank: 1,
  previousClanRank: 1,
  donations: 0,
  donationsReceived: 0,
  ...over,
})

const ALDA = member({ tag: '#AAA', name: 'Alda' })
const BRIX = member({ tag: '#BBB', name: 'Brix' })

/** One base's holdings. Sparse, ascending by card id, exactly as the server sends. */
const inventory = (tag: string, counts: BaseInventory['counts']): BaseInventory => ({ tag, counts })

async function cards(owners: OwnerRecord[], bases: BaseInventory[], who = RAE) {
  const user = userEvent.setup()
  stubApi({
    owners: () => Promise.resolve({ owners }),
    cardInventory: () => Promise.resolve({ season: CARD_SEASON, bases }),
    trades: () => Promise.resolve({ season: CARD_SEASON, trades: [] }),
    // The bases are named from the saved clans' rosters, one request per clan rather
    // than one per base — so a clan is what a test has to supply to get names.
    savedClans: () => Promise.resolve({ clans: [{ tag: '#CLAN', name: 'Clan' }] }),
    clanMembers: () => Promise.resolve({ items: [ALDA, BRIX] }),
  })
  render(<CardsView user={who} />)
  return user
}

describe('the base picker', () => {
  it('says there is nothing to track until a base has an owner', async () => {
    await cards([], [])

    // The bases *are* the owner assignments, so there is no second list to curate.
    await screen.findByText(/No bases to track yet/)
  })

  it('opens on All for an account that owns nothing', async () => {
    // Defaulting blindly to Mine would land most accounts on an empty screen.
    await cards([{ tag: '#AAA', owner: 'Sam', ownerUserId: 2 }], [])

    const show = await screen.findByLabelText('Show')
    assert.equal((show as HTMLSelectElement).value, 'all')
  })

  it('opens on Mine for an account that owns a base', async () => {
    await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [])

    const show = await screen.findByLabelText('Show')
    await waitFor(() => assert.equal((show as HTMLSelectElement).value, 'mine'))
  })

  it('reads Mine off the owning account, never off a matching name', async () => {
    /* 32 of this install's assignments are free text that has never been matched to an
       account. A label that happens to spell your name is a note about a person, not a
       base you may write — and `ownerUserId` is the field the write rule uses too. */
    await cards([{ tag: '#AAA', owner: RAE.displayName, ownerUserId: null }], [])

    const show = await screen.findByLabelText('Show')
    assert.equal((show as HTMLSelectElement).value, 'all')
  })

  it('explains an empty Mine instead of leaving an empty dropdown', async () => {
    const user = await cards([{ tag: '#AAA', owner: 'Sam', ownerUserId: 2 }], [])

    await user.selectOptions(await screen.findByLabelText('Show'), 'mine')

    // Ownership is an admin decision, so that is the actual next step to name.
    const hint = await screen.findByText(/None of the 1 tracked base is yours/)
    assert.match(hint.textContent ?? '', /admin assigns it to your account/)
    assert.equal(screen.queryByLabelText('Base'), null)
  })
})

describe('the collection leaderboard', () => {
  const OWNERS: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#BBB', owner: 'Sam', ownerUserId: 2 },
  ]

  it('ranks by points, so breadth outranks hoarding', async () => {
    /*
     * Six cards held once scores 60; ten copies of one card scores 55, and ten is the
     * cap, so no single card can ever contribute more. The direction is easy to state
     * backwards, which is why it is worth pinning: the base with fewer *copies* wins.
     */
    await cards(OWNERS, [
      inventory(
        '#AAA',
        [1, 2, 3, 4, 5, 6].map((cardId) => ({ cardId, count: 1 })),
      ),
      inventory('#BBB', [{ cardId: 1, count: 10 }]),
    ])

    const board = await screen.findByRole('table', { name: 'Collection leaderboard' })
    const [first, second] = within(board).getAllByRole('row').slice(1)
    assert.match(first?.textContent ?? '', /Alda/)
    assert.match(second?.textContent ?? '', /Brix/)
  })

  it('covers the whole clan whatever Show is set to', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])
    const board = await screen.findByRole('table', { name: 'Collection leaderboard' })
    await within(board).findByText('Brix')

    await user.selectOptions(await screen.findByLabelText('Show'), 'mine')

    /* Narrowed to one person's bases it would be a leaderboard of one and would answer
       nothing — so the filter above must not reach it. */
    assert.ok(within(board).getByText('Brix'))
    assert.ok(within(board).getByText('Alda'))
  })

  it('says a base nobody has saved is not a base holding zero of everything', async () => {
    await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])

    const board = await screen.findByRole('table', { name: 'Collection leaderboard' })
    const brix = (await within(board).findByText('Brix')).closest('tr')
    assert.match(brix?.textContent ?? '', /Nothing recorded yet/)
  })
})

describe('the clan-wide card totals', () => {
  it('says in words that nobody holds a card, rather than only greying the tile', async () => {
    await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [
      inventory('#AAA', [{ cardId: 1, count: 3 }]),
    ])

    // A colour cue and a *missing* badge cannot be the whole story, so the zero is in
    // the tile's own accessible name.
    await screen.findByLabelText('Barbarian, Elixir — 3 held across the clan')
    assert.ok(screen.getByLabelText('Archer, Elixir — none held across the clan'))
  })
})

/**
 * Pressing a tile in that grid for the bases holding the card.
 *
 * Who holds what and in what order is `card-holders.ts`', tested there against made-up
 * inventories. What is here is what that grid cannot be trusted about from a
 * screenshot: that the tile is a real control, that the same press puts the table away
 * again, that a card nobody holds still answers, and that the table is not narrowed by
 * the picker above it.
 */
describe('who holds a card', () => {
  const OWNERS: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#BBB', owner: 'Sam', ownerUserId: 2 },
  ]

  /* The panel is a disclosure and opens closed, so every test here opens it first —
     which is also the sequence a reader goes through. */
  async function openTotals(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByText(/All 60 cards, in grid order/))
  }

  /** A tile in the totals grid, by the accessible name its `CardTile` gives it. */
  function tile(name: string) {
    return screen.getByRole('button', { name })
  }

  it('lists the bases holding the card whose tile is pressed', async () => {
    const user = await cards(OWNERS, [
      inventory('#AAA', [{ cardId: 1, count: 3 }]),
      inventory('#BBB', [{ cardId: 2, count: 1 }]),
    ])
    await openTotals(user)

    await user.click(tile('Barbarian, Elixir — 3 held across the clan'))

    const table = await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    const rows = within(table).getAllByRole('row').slice(1)
    assert.equal(rows.length, 1)
    assert.match(rows[0]?.textContent ?? '', /Alda/)
    assert.match(rows[0]?.textContent ?? '', /3/)
    // Brix holds an Archer, not a Barbarian, so this table is not about them.
    assert.equal(within(table).queryByText('Brix'), null)
  })

  it('marks the pressed tile, so which card the table is about is not colour alone', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 3 }])])
    await openTotals(user)
    const barbarian = tile('Barbarian, Elixir — 3 held across the clan')
    assert.equal(barbarian.getAttribute('aria-pressed'), 'false')

    await user.click(barbarian)

    assert.equal(barbarian.getAttribute('aria-pressed'), 'true')
    // And the card is named in words above the table, for the tile scrolled off the top.
    const holders = await screen.findByRole('heading', { name: /Barbarian/ })
    assert.match(holders.textContent ?? '', /Elixir · 3 held across the clan/)
  })

  it('puts the base that can spare a copy above the one holding its only one', async () => {
    const user = await cards(OWNERS, [
      inventory('#AAA', [{ cardId: 1, count: 1 }]),
      inventory('#BBB', [{ cardId: 1, count: 4 }]),
    ])
    await openTotals(user)

    await user.click(tile('Barbarian, Elixir — 5 held across the clan'))

    const table = await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    const [first, second] = within(table).getAllByRole('row').slice(1)
    /* A base never gives away its last copy, so a base with four is an offer and a base
       with one is not — which is the distinction the column spells out in words. */
    assert.match(first?.textContent ?? '', /Brix/)
    assert.match(first?.textContent ?? '', /Can spare one/)
    assert.match(second?.textContent ?? '', /Alda/)
    assert.match(second?.textContent ?? '', /Its only copy/)
    assert.ok(screen.getByText('2 bases hold it · 1 with a spare to trade'))
  })

  it('puts the table away when the same tile is pressed again', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 3 }])])
    await openTotals(user)
    const barbarian = tile('Barbarian, Elixir — 3 held across the clan')

    await user.click(barbarian)
    await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    await user.click(barbarian)

    // The tile that opened it is the control somebody reaches for to close it.
    assert.equal(screen.queryByRole('table', { name: 'Bases holding Barbarian' }), null)
    assert.equal(barbarian.getAttribute('aria-pressed'), 'false')
  })

  it('swaps one card for another rather than stacking two tables', async () => {
    const user = await cards(OWNERS, [
      inventory('#AAA', [
        { cardId: 1, count: 3 },
        { cardId: 20, count: 2 },
      ]),
    ])
    await openTotals(user)

    await user.click(tile('Barbarian, Elixir — 3 held across the clan'))
    await user.click(tile('Minion, Dark Elixir — 2 held across the clan'))

    await screen.findByRole('table', { name: 'Bases holding Minion' })
    assert.equal(screen.queryByRole('table', { name: 'Bases holding Barbarian' }), null)
  })

  it('opens and closes from the keyboard, with no pointer involved', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 3 }])])
    await openTotals(user)
    const barbarian = tile('Barbarian, Elixir — 3 held across the clan')

    /* Focused directly rather than tabbed to: the grid is sixty stops and the property
       under test is that a `<button>` is what carries them, not where it sits in the
       order. Enter and Space are both a button's own activation. */
    barbarian.focus()
    assert.equal(document.activeElement, barbarian)
    await user.keyboard('{Enter}')
    await screen.findByRole('table', { name: 'Bases holding Barbarian' })

    await user.keyboard(' ')
    assert.equal(screen.queryByRole('table', { name: 'Bases holding Barbarian' }), null)
  })

  it('answers for a card nobody holds instead of showing an empty table', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 3 }])])
    await openTotals(user)

    /* 38 of the sixty are in this state in the live install. A tile that looked
       pressable and did nothing would be the worst of the three options, and a table
       with headers and no rows reads as broken — so it says the thing the badge cannot. */
    await user.click(tile('Archer, Elixir — none held across the clan'))

    // The sentence spans a `<strong>` and the text after it, so the paragraph is what
    // has to read correctly rather than either half.
    const answer = await screen.findByText(/Nobody in the clan holds it/)
    assert.match(answer.closest('p')?.textContent ?? '', /has to come from the game/)
    assert.equal(screen.queryByRole('table', { name: 'Bases holding Archer' }), null)
    assert.ok(screen.getByRole('heading', { name: /Archer/ }))
  })

  it('covers the whole clan whatever Show is set to', async () => {
    const user = await cards(OWNERS, [
      inventory('#AAA', [{ cardId: 1, count: 2 }]),
      inventory('#BBB', [{ cardId: 1, count: 5 }]),
    ])
    await openTotals(user)
    await user.selectOptions(await screen.findByLabelText('Show'), 'mine')

    await user.click(tile('Barbarian, Elixir — 7 held across the clan'))

    /* The panel is group-wide, like the leaderboard above it: the badge counts every
       tracked base, so a table that dropped the ones the picker does not offer would
       not add up to the number that was pressed. */
    const table = await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    assert.ok(within(table).getByText('Brix'))
    assert.ok(within(table).getByText('Alda'))
  })

  it('labels every cell, so the table survives being stacked on a phone', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 3 }])])
    await openTotals(user)

    await user.click(tile('Barbarian, Elixir — 3 held across the clan'))

    /* At ≤900px the cells become one card per base and print `data-label` in place of
       the column head they no longer sit under — so a cell without one loses its
       heading entirely. Checked here rather than by faking a viewport: the markup is
       the same at both widths, and it is the markup that has to be right.
       `.stack-title` is the exception by design, being the card's own heading. */
    const table = await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    for (const cell of within(table).getAllByRole('cell')) {
      assert.ok(
        cell.classList.contains('stack-title') || cell.hasAttribute('data-label'),
        `unlabelled cell: ${cell.textContent}`,
      )
    }
  })
})
