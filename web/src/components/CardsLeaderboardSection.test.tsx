import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CARD_SEASON, type BaseInventory } from '@coc/shared'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { CardsLeaderboardSection } from './CardsLeaderboardSection.tsx'

/**
 * `CardsLeaderboardSection` extracted out of `CardsView.tsx` — the seven-board
 * picker and its own wiring (the seven rankings' memos, the view/category
 * picker state, `leaderboardBoards`). `CardsView.test.tsx`'s
 * `describe('the collection leaderboard', ...)` and
 * `describe('the leaderboard view picker', ...)` already cover this behavior
 * through the whole page; this is the same behavior through a much lighter,
 * isolated render — not a duplicate of those tests.
 */

installTestCleanup()

const RAE = sessionUser({ id: 1 })

const LABELS: Record<string, string> = { '#AAA': 'Alda', '#BBB': 'Brix' }
const OWNERS: Record<string, string> = { '#AAA': 'Rae', '#BBB': 'Sam' }
const OWNER_USER_IDS: Record<string, number> = { '#AAA': 1, '#BBB': 2 }

const inventory = (tag: string, counts: BaseInventory['counts']): BaseInventory => ({ tag, counts })

async function section(bases: BaseInventory[], tags: string[] = ['#AAA', '#BBB']) {
  stubApi({ trades: () => Promise.resolve({ season: CARD_SEASON, trades: [] }) })
  const user = userEvent.setup()
  render(
    <CardsLeaderboardSection
      bases={bases}
      tags={tags}
      labelOf={(tag) => LABELS[tag] ?? tag}
      ownerOf={(tag) => OWNERS[tag]}
      ownerUserIdOf={(tag) => OWNER_USER_IDS[tag] ?? null}
      user={RAE}
    />,
  )
  return user
}

describe('the default board', () => {
  it('opens on Overall, with its own intro text and table', async () => {
    await section([inventory('#AAA', [{ cardId: 1, count: 1 }])])

    const picker = await screen.findByLabelText('View')
    assert.equal((picker as HTMLSelectElement).value, 'overall')
    assert.ok(screen.getByText(/breadth outranks hoarding/))
    await screen.findByRole('table', { name: 'Collection leaderboard' })
  })

  it('shows the points-specific scoring disclosure for Overall', async () => {
    await section([inventory('#AAA', [{ cardId: 1, count: 1 }])])
    assert.ok(screen.getByText('How the points work'))
  })
})

describe('switching the View picker', () => {
  it('replaces the board, its intro and its scoring disclosure', async () => {
    const user = await section([inventory('#AAA', [{ cardId: 1, count: 1 }])])

    await user.selectOptions(await screen.findByLabelText('View'), 'Rarity')

    const table = await screen.findByRole('table', { name: 'Rarity leaderboard' })
    assert.ok(within(table).getByRole('columnheader', { name: 'Rarity score' }))
    // The old board's own table and text are gone, not merely relabeled.
    assert.equal(screen.queryByRole('table', { name: 'Collection leaderboard' }), null)
    assert.equal(screen.queryByText(/breadth outranks hoarding/), null)
    assert.ok(screen.getByText(/how scarce it is across the whole clan right now/))
    // Every non-Overall board shares the same disclosure summary text.
    assert.ok(screen.getByText('How this board scores'))
  })
})

describe('the "By category" board', () => {
  const BASES = [
    inventory('#AAA', [{ cardId: 1, count: 1 }]), // Elixir
    inventory('#BBB', [{ cardId: 20, count: 1 }]), // Dark Elixir
  ]

  it('shows a Deck picker defaulting to the first deck', async () => {
    const user = await section(BASES)
    assert.equal(screen.queryByLabelText('Deck'), null)

    await user.selectOptions(await screen.findByLabelText('View'), 'By category')

    const deck = await screen.findByLabelText('Deck')
    assert.equal((deck as HTMLSelectElement).value, 'Elixir')
    await screen.findByRole('table', { name: 'Elixir leaderboard' })
  })

  it('switching the deck re-ranks by that deck alone, not just relabels the table', async () => {
    /*
     * Both bases appear on every deck's board (a base holding none of a deck still
     * ranks last on it, at 0 distinct) — so the assertion has to be the distinct
     * count per row, not presence, or a wrong `categoryRankings[deck]` lookup that
     * happened to keep showing both bases would still read as passing.
     */
    const user = await section(BASES)
    await user.selectOptions(await screen.findByLabelText('View'), 'By category')

    const elixir = await screen.findByRole('table', { name: 'Elixir leaderboard' })
    const aldaOnElixir = (await within(elixir).findByText('Alda')).closest('tr')
    const brixOnElixir = (await within(elixir).findByText('Brix')).closest('tr')
    assert.match(aldaOnElixir?.textContent ?? '', /1\/\d+/)
    assert.match(brixOnElixir?.textContent ?? '', /0\/\d+/)

    await user.selectOptions(await screen.findByLabelText('Deck'), 'Dark Elixir')

    const darkElixir = await screen.findByRole('table', { name: 'Dark Elixir leaderboard' })
    const aldaOnDark = (await within(darkElixir).findByText('Alda')).closest('tr')
    const brixOnDark = (await within(darkElixir).findByText('Brix')).closest('tr')
    assert.match(aldaOnDark?.textContent ?? '', /0\/\d+/)
    assert.match(brixOnDark?.textContent ?? '', /1\/\d+/)
  })
})
