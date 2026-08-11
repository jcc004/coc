import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CARD_SEASON,
  type BaseInventory,
  type ClanMember,
  type OwnerRecord,
  type TradeRecord,
} from '@coc/shared'
import { CARD_JUMP_TARGETS } from '../card-sections.ts'
import { installTestCleanup, sessionUser, stubApi, type ApiStubs } from '../test-support.ts'
import { CardsView } from './CardsView.tsx'

/**
 * The card page, from the two questions it can get wrong in a way that leaves somebody
 * staring at a screen they cannot act on: **which bases am I offered** (the Mine/All
 * filter, which defaults differently depending on whether this account owns anything),
 * and **what is the whole clan doing** (the leaderboard and the totals, which are
 * deliberately *not* narrowed by that filter).
 *
 * The scoring curve, the base filter's rules and the labeling are pure and tested in
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
/* Four more, so the leaderboard can be longer than one page and hold more than two
   owners. They are roster members and nothing else: the bases come from the owner
   assignments, so a member no test assigns never appears on the page. */
const CASS = member({ tag: '#CCC', name: 'Cass' })
const DANA = member({ tag: '#DDD', name: 'Dana' })
const ELI = member({ tag: '#EEE', name: 'Eli' })
const FENN = member({ tag: '#FFF', name: 'Fenn' })

/** One base's holdings. Sparse, ascending by card id, exactly as the server sends. */
const inventory = (
  tag: string,
  counts: BaseInventory['counts'],
  updatedAt?: string,
): BaseInventory => ({ tag, counts, ...(updatedAt === undefined ? {} : { updatedAt }) })

/**
 * A minimal `TradeRecord`, following `trader-standings.test.ts`'s own `trade()`
 * helper — only `baseA`/`baseB`/`status` matter to the "Most active trader" board,
 * so every other field is a fixed, arbitrary value overridable per test.
 */
function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: 1,
    season: CARD_SEASON,
    baseA: '#AAA',
    baseB: '#BBB',
    cardFromA: 3,
    cardFromB: 7,
    category: 'Elixir',
    status: 'complete',
    proposedByUserId: 1,
    proposedBy: 'Anna',
    proposedAt: '2026-08-02T10:00:00.000Z',
    resolvedByUserId: 1,
    resolvedBy: 'Anna',
    resolvedAt: '2026-08-02T11:00:00.000Z',
    undoneByUserId: null,
    undoneBy: null,
    undoneAt: null,
    ...over,
  }
}

async function cards(
  owners: OwnerRecord[],
  bases: BaseInventory[],
  who = RAE,
  extraStubs: ApiStubs = {},
) {
  const user = userEvent.setup()
  stubApi({
    owners: () => Promise.resolve({ owners }),
    cardInventory: () => Promise.resolve({ season: CARD_SEASON, bases }),
    trades: () => Promise.resolve({ season: CARD_SEASON, trades: [] }),
    // The bases are named from the saved clans' rosters, one request per clan rather
    // than one per base — so a clan is what a test has to supply to get names.
    savedClans: () => Promise.resolve({ clans: [{ tag: '#CLAN', name: 'Clan' }] }),
    clanMembers: () => Promise.resolve({ items: [ALDA, BRIX, CASS, DANA, ELI, FENN] }),
    // No saved order by default, which reconciles to the same alphabetical list
    // `allOptions` already offers — a test only has to stub this when it actually
    // cares about the Mine picker's order.
    getBaseOrder: () => Promise.resolve({ tags: [] }),
    ...extraStubs,
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

  /*
   * The Mine order — `useBaseOrder`'s read side, reused rather than reimplemented.
   * `reconcileOrder` and `applyBaseOrder` each carry their own tests for the
   * general rule; these three are the wiring, that the picker actually shows what
   * those functions compute, and only for Mine.
   */
  const MINE: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#BBB', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#CCC', owner: 'Rae', ownerUserId: RAE.id },
  ]

  function baseOptionLabels(picker: HTMLElement): (string | null)[] {
    return within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent)
  }

  it('orders the Mine picker by the saved base order, not alphabetically', async () => {
    await cards(MINE, [], RAE, {
      getBaseOrder: () => Promise.resolve({ tags: ['#CCC', '#AAA', '#BBB'] }),
    })

    const picker = await screen.findByLabelText('Base')
    await waitFor(() => assert.deepEqual(baseOptionLabels(picker), ['Cass', 'Alda', 'Brix']))
  })

  it('appends a base the saved order never mentioned, after the ones it does', async () => {
    // `#AAA` and `#CCC` predate the saved order (or were assigned since), so
    // `reconcileOrder` appends them in the order the owner list already had them.
    await cards(MINE, [], RAE, { getBaseOrder: () => Promise.resolve({ tags: ['#BBB'] }) })

    const picker = await screen.findByLabelText('Base')
    await waitFor(() => assert.deepEqual(baseOptionLabels(picker), ['Brix', 'Alda', 'Cass']))
  })

  it('leaves the All list alphabetical, ignoring the saved order entirely', async () => {
    const user = await cards(MINE, [], RAE, {
      getBaseOrder: () => Promise.resolve({ tags: ['#CCC', '#AAA', '#BBB'] }),
    })

    await user.selectOptions(await screen.findByLabelText('Show'), 'all')

    const picker = await screen.findByLabelText('Base')
    await waitFor(() => assert.deepEqual(baseOptionLabels(picker), ['Alda', 'Brix', 'Cass']))
  })

  /*
   * The remembered base. The rules are `last-base.ts`' and are tested there; these
   * two are the wiring, which is the half a pure function cannot hold — that the
   * choice is written when the picker is used, read back when the page mounts, and
   * keyed to the account that made it.
   *
   * `cleanup()` then `render()` again *is* the reload here: it unmounts the page and
   * mounts a fresh one over the same `localStorage`, which is the only state a real
   * refresh carries across.
   */
  const TRACKED: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Sam', ownerUserId: 2 },
    { tag: '#BBB', owner: 'Sam', ownerUserId: 2 },
  ]

  it('reselects the base that was last picked, after a reload', async () => {
    const user = await cards(TRACKED, [])

    // Alda is the head of the list, so Brix is a choice and not the default.
    await user.selectOptions(await screen.findByLabelText('Base'), '#BBB')
    assert.equal(localStorage.getItem('coc:cardBase:1'), '#BBB')

    cleanup()
    render(<CardsView user={RAE} />)

    const picker = await screen.findByLabelText('Base')
    await waitFor(() => assert.equal((picker as HTMLSelectElement).value, '#BBB'))
  })

  it('falls back to the first base when the remembered one is no longer tracked', async () => {
    // Unassigned, removed, or the season rolled: a stale key must not leave the page
    // blank or stuck on a base the picker no longer offers.
    localStorage.setItem('coc:cardBase:1', '#ZZZ')
    await cards(TRACKED, [])

    const picker = await screen.findByLabelText('Base')
    assert.equal((picker as HTMLSelectElement).value, '#AAA')
  })

  it('renders the page as usual when the stored base is not a tag at all', async () => {
    // `localStorage` is user-writable, and this value is read while seeding state
    // during render — where a throw is the whole app, with no boundary above it.
    localStorage.setItem('coc:cardBase:1', '{"tag":"#BBB"}')
    await cards(TRACKED, [])

    const picker = await screen.findByLabelText('Base')
    assert.equal((picker as HTMLSelectElement).value, '#AAA')
  })

  it('keys the remembered base per account, so a shared browser does not leak it', async () => {
    localStorage.setItem('coc:cardBase:1', '#BBB')
    await cards(TRACKED, [], sessionUser({ id: 2, displayName: 'Sam' }))

    const picker = await screen.findByLabelText('Base')
    assert.equal((picker as HTMLSelectElement).value, '#AAA')
    assert.equal(localStorage.getItem('coc:cardBase:1'), '#BBB')
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

  it('labels every cell, so the board survives being stacked on a phone', async () => {
    /* At ≤900px the table becomes one card per base and each cell prints `data-label`
       in place of the column head it no longer sits under — so a new column without
       one loses its heading entirely on a phone. `.stack-title` is the exception by
       design, being the card's own heading. */
    await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])

    const board = await screen.findByRole('table', { name: 'Collection leaderboard' })
    for (const cell of within(board).getAllByRole('cell')) {
      assert.ok(
        cell.classList.contains('stack-title') || cell.hasAttribute('data-label'),
        `unlabeled cell: ${cell.textContent}`,
      )
    }
  })
})

/**
 * The Last updated column and the Owner filter — "which of my bases has nobody entered
 * counts for lately", which the picker could only answer one base at a time.
 *
 * The filtering, the options and the words for a base with no stamp are pure and
 * tested in `card-standings.ts`. What is here is the half that has no test anywhere
 * else: that the rank printed beside a filtered row is still the rank that base holds
 * on the **whole** board, and that a page number left past the end of a board the
 * filter has just shortened is repaired rather than left showing nothing.
 */
describe('the leaderboard’s owner filter and staleness column', () => {
  /*
   * Six tracked bases, six different scores, so every base holds a rank of its own and
   * a renumbered board is unmistakable. Three owners: two accounts, one unlinked legacy
   * label (Dave, who has never signed in), and one base with no assignment at all —
   * which reaches the board through its counts, since the tracked bases are the owner
   * assignments plus anything holding cards.
   */
  const BOARD: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#BBB', owner: 'Sam', ownerUserId: 2 },
    { tag: '#CCC', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#DDD', owner: 'Dave', ownerUserId: null },
    { tag: '#EEE', owner: 'Sam', ownerUserId: 2 },
  ]

  const TWO_DAYS_AGO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  const COUNTS: BaseInventory[] = [
    inventory('#AAA', [{ cardId: 1, count: 5 }], TWO_DAYS_AGO),
    inventory('#BBB', [{ cardId: 1, count: 4 }], TWO_DAYS_AGO),
    inventory('#CCC', [{ cardId: 1, count: 3 }], TWO_DAYS_AGO),
    inventory('#DDD', [{ cardId: 1, count: 2 }], TWO_DAYS_AGO),
    inventory('#EEE', [{ cardId: 1, count: 1 }], TWO_DAYS_AGO),
    // Fenn: counts but no owner assignment, and no stamp — the never-saved case.
    inventory('#FFF', []),
  ]

  const boardTable = () => screen.findByRole('table', { name: 'Collection leaderboard' })

  /** The rank printed beside one member, read off the row rather than off the array. */
  function rankOf(table: HTMLElement, member: string): string {
    const row = within(table).getByText(member).closest('tr')
    assert.ok(row, `${member} is not on the board`)
    return within(row).getAllByRole('cell')[0]?.textContent ?? ''
  }

  it('keeps a base’s rank on the whole board when the filter narrows it to one owner', async () => {
    const user = await cards(BOARD, COUNTS)
    const table = await boardTable()
    await within(table).findByText('Cass')

    await user.selectOptions(await screen.findByLabelText('Owner'), 'Rae')

    /* Rae's two bases are 1st and 3rd of six. Renumbering them 1 and 2 would make the
       one column that carries meaning into a row counter, and it would read as a
       leaderboard of one — which is the thing this board must never become. */
    assert.equal(rankOf(table, 'Alda'), '1')
    assert.equal(rankOf(table, 'Cass'), '3')
    assert.equal(within(table).queryByText('Brix'), null)
  })

  it('offers everyone, the bases with no owner, and the linked owners on the board', async () => {
    // Dave is an unlinked legacy label (`ownerUserId: null`), the same as Fenn's base
    // having no assignment at all — the filter groups by account id now, so Dave is not
    // a distinct option, only folded into "No owner set".
    await cards(BOARD, COUNTS)
    await boardTable()

    const filter = await screen.findByLabelText('Owner')
    assert.deepEqual(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
      ['Everyone', 'No owner set', 'Rae', 'Sam'],
    )
    // Everyone is the default, so the board opens as it always did.
    assert.equal((filter as HTMLSelectElement).value, '')
  })

  it('finds both the base no account owns and the unlinked-label base under "No owner set"', async () => {
    /* Dave's assignment is a label nobody has matched to an account, so it carries no
       `ownerUserId` — the same "no id" state as Fenn's base, which has no assignment at
       all. The filter now groups strictly by id, so both fall under the one sentinel. */
    const user = await cards(BOARD, COUNTS)
    const table = await boardTable()

    await user.selectOptions(await screen.findByLabelText('Owner'), 'No owner set')

    // Last of the six, and still numbered 6 rather than 1.
    assert.equal(rankOf(table, 'Fenn'), '6')
    // Dana is Dave's, an unlinked label — folded in alongside Fenn, still ranked 4.
    assert.equal(rankOf(table, 'Dana'), '4')
    assert.equal(within(table).queryByText('Alda'), null)
  })

  it('clamps a page number the filter has left past the end of the board', async () => {
    // Six bases at the default five rows is two pages; Rae's two are one.
    const user = await cards(BOARD, COUNTS)
    const table = await boardTable()
    await within(table).findByText('Cass')

    await user.click(await screen.findByRole('button', { name: /Next/ }))
    assert.ok(screen.getByText('Page 2 of 2'))

    await user.selectOptions(await screen.findByLabelText('Owner'), 'Rae')

    /* Without the clamp this is an empty table under a pager saying page 2 of 1. The
       repair is `paginate`'s clamped page fed back — the same one a base losing its
       owner assignment needs, rather than a second effect for the filter. */
    assert.equal(rankOf(table, 'Alda'), '1')
    assert.equal(rankOf(table, 'Cass'), '3')
  })

  it('says Never for a base nobody has ever entered counts for', async () => {
    const user = await cards(BOARD, COUNTS)
    const table = await boardTable()

    await user.selectOptions(await screen.findByLabelText('Owner'), 'No owner set')

    /* The one value in this column worth reading the column for. It is decided from
       the absence of a stamp, so it cannot come out as `Invalid Date` or as a blank
       cell that reads like a rendering fault. */
    const fenn = within(table).getByText('Fenn').closest('tr')
    const cells = within(fenn as HTMLElement).getAllByRole('cell')
    assert.equal(cells[cells.length - 1]?.textContent, 'Never')
  })

  it('prints the age of a base that has been saved, with the exact time on the cell', async () => {
    await cards(BOARD, COUNTS)
    const table = await boardTable()

    const alda = (await within(table).findByText('Alda')).closest('tr')
    const cells = within(alda as HTMLElement).getAllByRole('cell')
    const last = cells[cells.length - 1]
    // Relative to scan the column with, exact on the tooltip so nothing is lost.
    assert.equal(last?.textContent, '2 days ago')
    assert.ok(last?.querySelector('span[title]')?.getAttribute('title'))
  })

  it('draws no filter at all when there is only one owner to choose', async () => {
    /* Two options that select the same board is a control that answers a press by
       doing nothing — the same reason the density control is not drawn when it offers
       one value. */
    await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [
      inventory('#AAA', [{ cardId: 1, count: 1 }], TWO_DAYS_AGO),
    ])
    await boardTable()

    assert.equal(screen.queryByLabelText('Owner'), null)
  })
})

/**
 * The View picker — seven rankings sharing one table shell (`LeaderboardTable`) and
 * one Owner/row-limit/pager instance (`Leaderboard`). The rankings themselves are
 * pure and tested in their own modules (`rarity-standings.ts`, `row-standings.ts`,
 * and so on); what is here is the wiring those modules cannot test themselves — that
 * the picker actually swaps the table, that the choice persists, that the Deck
 * sub-picker only appears for "By category," and that the shared chrome still works
 * once the active board is not Overall.
 */
describe('the leaderboard view picker', () => {
  const OWNERS: OwnerRecord[] = [
    { tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id },
    { tag: '#BBB', owner: 'Sam', ownerUserId: 2 },
  ]

  it('offers all seven boards, in order, and opens on Overall', async () => {
    await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])

    const picker = await screen.findByLabelText('View')
    assert.deepEqual(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
      [
        'Overall',
        'Rarity',
        'Full rows',
        'By category',
        'Full decks',
        'Spares on hand',
        'Most active trader',
      ],
    )
    assert.equal((picker as HTMLSelectElement).value, 'overall')
    await screen.findByRole('table', { name: 'Collection leaderboard' })
  })

  it('switches to a different board’s own table and columns', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])

    await user.selectOptions(await screen.findByLabelText('View'), 'Rarity')

    const table = await screen.findByRole('table', { name: 'Rarity leaderboard' })
    assert.ok(within(table).getByRole('columnheader', { name: 'Rarity score' }))
    // The old board is gone, not just relabeled — this is a different table.
    assert.equal(screen.queryByRole('table', { name: 'Collection leaderboard' }), null)
  })

  it('remembers the chosen board after a reload', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])

    await user.selectOptions(await screen.findByLabelText('View'), 'Spares on hand')
    assert.equal(localStorage.getItem('coc:cardLeaderboardView'), 'spares')

    cleanup()
    render(<CardsView user={RAE} />)

    const picker = await screen.findByLabelText('View')
    await waitFor(() => assert.equal((picker as HTMLSelectElement).value, 'spares'))
    await screen.findByRole('table', { name: 'Spares on hand leaderboard' })
  })

  it('shows a Deck sub-picker only for By category, defaulting to the first deck', async () => {
    const user = await cards(OWNERS, [inventory('#AAA', [{ cardId: 1, count: 1 }])])
    assert.equal(screen.queryByLabelText('Deck'), null)

    await user.selectOptions(await screen.findByLabelText('View'), 'By category')

    const deck = await screen.findByLabelText('Deck')
    assert.equal((deck as HTMLSelectElement).value, 'Elixir')
    await screen.findByRole('table', { name: 'Elixir leaderboard' })

    await user.selectOptions(deck, 'Dark Elixir')
    await screen.findByRole('table', { name: 'Dark Elixir leaderboard' })
    // Switching away and back must not lose the picker entirely.
    await user.selectOptions(await screen.findByLabelText('View'), 'Overall')
    assert.equal(screen.queryByLabelText('Deck'), null)
  })

  it('keeps the Owner filter working under a non-overall view, without renumbering', async () => {
    const user = await cards(OWNERS, [
      inventory('#AAA', [{ cardId: 1, count: 1 }]),
      inventory('#BBB', [{ cardId: 20, count: 1 }]),
    ])
    await user.selectOptions(await screen.findByLabelText('View'), 'Rarity')
    const table = await screen.findByRole('table', { name: 'Rarity leaderboard' })
    await within(table).findByText('Brix')

    await user.selectOptions(await screen.findByLabelText('Owner'), 'Rae')

    assert.ok(within(table).getByText('Alda'))
    assert.equal(within(table).queryByText('Brix'), null)
  })

  it('ranks the "Most active trader" board by completed trades, base by base', async () => {
    const user = await cards(OWNERS, [], RAE, {
      trades: () =>
        Promise.resolve({
          season: CARD_SEASON,
          trades: [
            trade({ id: 1, baseA: '#AAA', baseB: '#BBB' }),
            trade({
              id: 2,
              baseA: '#AAA',
              baseB: '#BBB',
              status: 'pending',
              resolvedAt: null,
              resolvedBy: null,
              resolvedByUserId: null,
            }),
          ],
        }),
    })

    await user.selectOptions(await screen.findByLabelText('View'), 'Most active trader')

    const table = await screen.findByRole('table', { name: 'Most active trader leaderboard' })
    // One complete trade each; the pending one must not count.
    const alda = (await within(table).findByText('Alda')).closest('tr')
    const cells = within(alda as HTMLElement).getAllByRole('cell')
    assert.equal(cells[3]?.textContent, '1')
  })
})

describe('the clan-wide card totals', () => {
  it('says in words that nobody holds a card, rather than only graying the tile', async () => {
    await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [
      inventory('#AAA', [{ cardId: 1, count: 3 }]),
    ])

    // A color cue and a *missing* badge cannot be the whole story, so the zero is in
    // the tile's own accessible name.
    await screen.findByLabelText('Barbarian, Elixir — 3 held across the clan')
    assert.ok(screen.getByLabelText('Archer, Elixir — none held across the clan'))
  })

  /*
   * Regression: switching the totals grid's sort control more than once used to
   * *append* the next sort's tiles below the previous ones instead of replacing
   * them, worse with every further switch. The cause was `CardTotalsGrid`'s
   * per-deck grouping assuming its input was always deck-contiguous — true for
   * "Grid order" but not once a sort interleaves the four decks by count — so
   * several sibling `<div key={deck.category}>` groups ended up sharing one key.
   * React does not tolerate a duplicate key among siblings, and the reported
   * symptom (grows on each subsequent switch) is exactly what that produces.
   * These tests exercise the actual sequence that broke it, not just one switch.
   */
  describe('the sort control', () => {
    async function openTotals(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByText(/All 60 cards, in grid order/))
    }

    function totalTiles() {
      return screen.getAllByRole('button', { name: /held across the clan/ })
    }

    it('never duplicates a tile across repeated sort switches', async () => {
      const user = await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [
        inventory('#AAA', [
          { cardId: 1, count: 3 },
          { cardId: 2, count: 1 },
        ]),
      ])
      await openTotals(user)
      assert.equal(totalTiles().length, 60)

      const sort = screen.getByLabelText('Sort')
      await user.selectOptions(sort, 'Highest to lowest')
      assert.equal(totalTiles().length, 60)

      // The transition that broke it: switching a *second* time, to the other
      // non-default sort.
      await user.selectOptions(sort, 'Lowest to highest')
      assert.equal(totalTiles().length, 60)

      await user.selectOptions(sort, 'Grid order')
      assert.equal(totalTiles().length, 60)
    })

    /** Just the totals grid's own deck groups — `BaseCardEditor`'s entry grid
     *  above it on the same page has four `role="group"` sections of its own
     *  (`card-deck-*`), so an unscoped `getAllByRole('group')` would count
     *  both grids' groups together. The totals grid's headings are their own
     *  id family, `card-total-deck-*` (`CardTotalsGrid`), which is what makes
     *  the two distinguishable at all. */
    function totalsDeckGroups() {
      return document.querySelectorAll('[aria-labelledby^="card-total-deck-"]')
    }

    it('groups tiles by deck only in grid order, never in a sorted view', async () => {
      const user = await cards([{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }], [
        inventory('#AAA', [{ cardId: 1, count: 3 }]),
      ])
      await openTotals(user)

      // Four decks, four groups, in grid order.
      assert.equal(totalsDeckGroups().length, 4)

      await user.selectOptions(screen.getByLabelText('Sort'), 'Highest to lowest')

      // No deck structure at all once the order is no longer the grid's — there
      // is no coherent way to group four decks' worth of interleaved cards.
      assert.equal(totalsDeckGroups().length, 0)
    })
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

  it('marks the pressed tile, so which card the table is about is not color alone', async () => {
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
    assert.ok(
      screen.getByText('2 bases hold it · 1 with a spare to trade · 0 of 2 reporting bases need it'),
    )
  })

  it('counts the reporting bases with no copy, which have no row in the table at all', async () => {
    /*
     * The one number on that line a reader cannot recover by scanning the table, and
     * the one the storage shape makes easy to get wrong. Counts are sparse — a count
     * of 0 deletes the row — so a base that reported and holds no Barbarian has no
     * Barbarian row anywhere, and looking for a stored zero would find nobody needing
     * anything. Four bases here have reported and two of them are in that state:
     *
     *   #BBB reported an Archer and no Barbarian.
     *   #DDD was saved and then cleared to nothing, so it keeps a stamp and no counts.
     *
     * #EEE is the control. It is a tracked base — the owner assignments carry it — but
     * nobody has ever entered it, so it has not told us it lacks the card and it must
     * be in neither figure. If it leaked in, the denominator would read 5.
     */
    const stamped = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const user = await cards(
      [...OWNERS, { tag: '#EEE', owner: 'Eli', ownerUserId: 3 }],
      [
        inventory('#AAA', [{ cardId: 1, count: 3 }]),
        inventory('#BBB', [{ cardId: 2, count: 1 }]),
        inventory('#CCC', [{ cardId: 1, count: 1 }]),
        inventory('#DDD', [], stamped),
      ],
    )
    await openTotals(user)

    await user.click(tile('Barbarian, Elixir — 4 held across the clan'))

    assert.ok(
      await screen.findByText(
        '2 bases hold it · 1 with a spare to trade · 2 of 4 reporting bases need it',
      ),
    )
    // And the two it counts really are absent from the table below it.
    const table = await screen.findByRole('table', { name: 'Bases holding Barbarian' })
    assert.equal(within(table).getAllByRole('row').length - 1, 2)
    assert.equal(within(table).queryByText('Brix'), null)
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
        `unlabeled cell: ${cell.textContent}`,
      )
    }
  })
})

/**
 * The jump row under the controls, and the arrows back up.
 *
 * Which sections exist and what the chips are called is `card-sections.ts`', tested
 * there. What is here is the half that module cannot check about itself: that every id
 * it hands out is a heading this page actually draws. A chip pointing at a renamed id
 * scrolls nowhere, leaves the reader at the top and looks exactly like a page that had
 * nothing to scroll — no throw, nothing on screen, which is why it is pinned here.
 */
describe('jumping about the card page', () => {
  const OWNERS: OwnerRecord[] = [{ tag: '#AAA', owner: 'Rae', ownerUserId: RAE.id }]
  const BASES = [inventory('#AAA', [{ cardId: 1, count: 3 }])]

  /**
   * jsdom implements no scrolling at all, so the calls are recorded rather than done.
   *
   * **Both scrolls, in one list.** A chip aligns its heading with `scrollIntoView`; the
   * back-to-top arrow scrolls the window to 0 instead, because the top heading sits
   * about 120px into the document and aligning it leaves the banner off-screen. Keeping
   * them in one ordered list is what lets a test say *which* of the two happened — and
   * catches the arrow quietly reverting to the element, which would look like a pass
   * against a list that only held one kind.
   *
   * `target` is the element's id, or `'window'` for the window scroll. No id collides
   * with that: the page's are all `cards-*`, which `card-sections.ts` explains.
   *
   * Swapped through the property descriptor rather than by reading the method into a
   * variable: an unbound method reference is exactly what `@typescript-eslint`'s
   * `unbound-method` rule is for, and the descriptor also restores a property that was
   * never there — which is the real case for `scrollIntoView`, since jsdom defines none
   * for this to shadow. `window.scrollTo` it does define, as a throwing stub.
   */
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

  it('points every chip at a heading that is really on the page', async () => {
    await cards(OWNERS, BASES)
    await screen.findByRole('navigation', { name: 'Jump to a section' })

    for (const target of CARD_JUMP_TARGETS) {
      const heading = document.getElementById(target.id)
      assert.ok(heading, `${target.id} is not on the page`)
      // A focus target has to be focusable, and these are headings, not controls.
      assert.equal(heading?.getAttribute('tabindex'), '-1')
    }
  })

  it('draws all four chips in page order, with the totals last', async () => {
    /*
     * Four at every width, because the fourth is hidden in **CSS** and jsdom neither
     * lays out nor applies a media query. That is the split on purpose: this test owns
     * the DOM and the order, and the browser measurement owns whether the row is one
     * line at 390px. Faking a viewport here would be this file quietly asserting a
     * layout it cannot see.
     */
    await cards(OWNERS, BASES)
    const row = await screen.findByRole('navigation', { name: 'Jump to a section' })

    assert.deepEqual(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
      ['Suggestions', 'Tracker', 'Leaderboard', 'Totals'],
    )
  })

  it('puts the hiding class on the totals chip and on no other', async () => {
    /* The class is the whole mechanism, and it is invisible to every other test here —
       jsdom will not apply the rule, so nothing else would notice it going missing. */
    await cards(OWNERS, BASES)
    const row = await screen.findByRole('navigation', { name: 'Jump to a section' })

    assert.deepEqual(
      within(row)
        .getAllByRole('button')
        .filter((button) => button.classList.contains('card-jump__wide'))
        .map((button) => button.textContent),
      ['Totals'],
    )
  })

  it('jumps to the totals from its chip, the same as any other', async () => {
    const scrolls = captureScrolls()
    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Totals' }))

      assert.deepEqual(
        scrolls.calls.map((call) => call.target),
        ['cards-totals'],
      )
      assert.equal(document.activeElement?.id, 'cards-totals')
    } finally {
      scrolls.restore()
    }
  })

  it('scrolls to the section a chip names, and moves the caret there', async () => {
    const scrolls = captureScrolls()
    try {
      const user = await cards(OWNERS, BASES)
      /* Scoped to the top jump row: the Trade Suggestions heading now carries its
         own "Tracker" chip (`HeadingJumpChip`, `CardsView.tsx`) pointing at the same
         section, so an unscoped query for the name is ambiguous. */
      const row = await screen.findByRole('navigation', { name: 'Jump to a section' })
      await user.click(within(row).getByRole('button', { name: 'Tracker' }))

      assert.deepEqual(
        scrolls.calls.map((call) => call.target),
        ['cards-tracker'],
      )
      /* Scrolling without moving focus leaves a keyboard user at the top of the page
         with the thing they pressed now a whole document away. */
      assert.equal(document.activeElement?.id, 'cards-tracker')
    } finally {
      scrolls.restore()
    }
  })

  it('gives all four sections below the top an arrow back up, including the totals', async () => {
    /* Four arrows, not three. The totals chip is hidden below 480px, so on a phone the
       totals section is the one place with a way back and no way down — which is the
       right way round, since it is the bottom of the page and the worst place to be
       stranded. The arrow is never hidden at any width. */
    await cards(OWNERS, BASES)

    for (const from of [
      'Trade suggestions',
      'Trade tracker',
      'Collection leaderboard',
      'Cards across the clan',
    ]) {
      assert.ok(
        await screen.findByRole('button', { name: `Back to top, from ${from}` }),
        `no arrow on ${from}`,
      )
    }
  })

  it('names each arrow by the section it leaves, so four of them are not one control', async () => {
    await cards(OWNERS, BASES)
    const arrow = await screen.findByRole('button', { name: 'Back to top, from Trade tracker' })

    /* The glyph is `aria-hidden` and the words are a visually-hidden span — the
       `HelpLink` pattern. An `aria-label` over a text node leaves `↑` in the tree on
       some combinations, and an arrow is not a word. */
    assert.equal(arrow.querySelector('[aria-hidden="true"]')?.textContent, '↑')
    assert.equal(arrow.getAttribute('aria-label'), null)
    assert.equal(arrow.getAttribute('title'), 'Back to top, from Trade tracker')
  })

  it('sends an arrow to the top of the page, not to its own section', async () => {
    const scrolls = captureScrolls()
    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Back to top, from Trade tracker' }))

      /* The window, not `cards-top` — see below for why the distinction is the point.
         What this test owns is that the arrow does not scroll to the section it sits
         on, which is the failure that would leave the reader where they already were. */
      assert.deepEqual(
        scrolls.calls.map((call) => call.target),
        ['window'],
      )
      assert.equal(document.activeElement?.id, 'cards-top')
    } finally {
      scrolls.restore()
    }
  })

  it('scrolls the window to 0 rather than aligning the top heading', async () => {
    /*
     * The distinction is invisible in jsdom and was invisible in a screenshot too, which
     * is why it is pinned. `cards-top` is a heading inside the first card, roughly 120px
     * down the document — the shell's padding, the banner and its margin, the card's
     * border and padding. `scrollIntoView` on it does exactly what it says and stops
     * with the banner off-screen, which is what the arrow was reported as getting wrong.
     *
     * So: no element scroll at all on this press, and a window scroll to a literal 0.
     * Asserting only "the window was scrolled" would pass on a `scrollIntoView` that had
     * merely been swapped for `window.scrollTo({ top: heading.offsetTop })`.
     */
    const scrolls = captureScrolls()
    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Back to top, from Trade tracker' }))

      assert.deepEqual(scrolls.calls, [{ target: 'window', behavior: 'smooth', top: 0 }])
    } finally {
      scrolls.restore()
    }
  })

  it('lets the arrow refuse motion too, not just the chips', async () => {
    /* The arrow is on the other branch of `jumpToSection` now, so the reduced-motion
       rule has two paths to hold on and the chip test only covers one. */
    const scrolls = captureScrolls()
    const restoreMedia = withReducedMotion(true)

    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Back to top, from Trade tracker' }))

      assert.equal(scrolls.calls[0]?.behavior, 'auto')
    } finally {
      restoreMedia()
      scrolls.restore()
    }
  })

  it('slides by default, because nothing has asked it not to', async () => {
    // `test-dom.ts` answers false to every media query, which is the no-preference case.
    const scrolls = captureScrolls()
    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Leaderboard' }))

      assert.equal(scrolls.calls[0]?.behavior, 'smooth')
    } finally {
      scrolls.restore()
    }
  })

  it('jumps outright when the reader has asked for less motion', async () => {
    /* The stub in `test-dom.ts` is deliberately inert, so a test that cares about a
       media query has to replace `window.matchMedia` itself — which is what the note
       there says to do. */
    const scrolls = captureScrolls()
    const restoreMedia = withReducedMotion(true)

    try {
      const user = await cards(OWNERS, BASES)
      await user.click(await screen.findByRole('button', { name: 'Leaderboard' }))

      assert.equal(scrolls.calls[0]?.behavior, 'auto')
    } finally {
      restoreMedia()
      scrolls.restore()
    }
  })
})
