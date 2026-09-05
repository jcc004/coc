import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BaseStanding } from '../card-standings.ts'
import type { CategoryStanding } from '../category-standings.ts'
import type { DeckCompletionStanding } from '../deck-completion-standings.ts'
import { installTestCleanup } from '../test-support.ts'
import {
  DECKS_COLUMNS,
  Leaderboard,
  overallColumns,
  CATEGORY_COLUMNS,
  type LeaderboardColumn,
} from './Leaderboard.tsx'

/**
 * `Leaderboard.tsx` is the generic ranked-table machinery this page's seven boards
 * all share. What's worth testing here is the load-bearing behavior that isn't
 * already pinned by `CardsView.test.tsx`'s own black-box coverage of the whole
 * page: the column configs' own cell logic (called directly, no need to mount a
 * whole board to exercise a formatter), and `Leaderboard`'s own Owner-filter and
 * empty-board rules.
 */

installTestCleanup()

const BASE_ROW: BaseStanding = {
  tag: '#AAA',
  label: 'Alda',
  owner: 'Alda',
  ownerUserId: 1,
  points: 42,
  distinct: 3,
  total: 5,
  size: 10,
  recorded: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
  rank: 1,
}

function cell<T>(columns: LeaderboardColumn<T>[], key: string, row: T) {
  const column = columns.find((entry) => entry.key === key)
  assert.ok(column, `no column named "${key}"`)
  return column.cell(row)
}

describe('overallColumns', () => {
  const formatExact = (date: Date) => date.toISOString()

  it('shows the distinct/size fraction for a recorded base', () => {
    render(<>{cell(overallColumns(formatExact), 'cards', { ...BASE_ROW, recorded: true })}</>)
    assert.ok(screen.getByText('3/10'))
  })

  it('says "Nothing recorded yet" instead of a 0-holding fraction for an unrecorded base', () => {
    /* A base nobody has ever saved is not the same as a base holding zero of
       everything — the doc comment on this column names the distinction. */
    render(<>{cell(overallColumns(formatExact), 'cards', { ...BASE_ROW, recorded: false })}</>)
    assert.ok(screen.getByText('Nothing recorded yet'))
    assert.equal(screen.queryByText('3/10'), null)
  })
})

describe('CATEGORY_COLUMNS', () => {
  const CATEGORY_ROW: CategoryStanding = {
    ...BASE_ROW,
    points: 12,
    distinct: 7,
    size: 19,
    doubled: false,
  }

  it('marks a doubled deck with ×2', () => {
    render(<>{cell(CATEGORY_COLUMNS, 'distinct', { ...CATEGORY_ROW, doubled: true })}</>)
    assert.ok(screen.getByText('×2', { exact: false }))
  })

  it('shows no ×2 marker for a deck that is not doubled', () => {
    render(<>{cell(CATEGORY_COLUMNS, 'distinct', { ...CATEGORY_ROW, doubled: false })}</>)
    assert.equal(screen.queryByText('×2', { exact: false }), null)
  })
})

describe('DECKS_COLUMNS', () => {
  const DECKS_ROW: DeckCompletionStanding = {
    ...BASE_ROW,
    completedCount: 0,
    completedDecks: [],
    doubledCount: 0,
    doubledDecks: [],
  }

  it('says "None yet" when no deck is complete', () => {
    render(<>{cell(DECKS_COLUMNS, 'which', DECKS_ROW)}</>)
    assert.ok(screen.getByText('None yet'))
  })

  it('names each completed deck, marking the doubled ones with ×2', () => {
    render(
      <>
        {cell(DECKS_COLUMNS, 'which', {
          ...DECKS_ROW,
          completedDecks: ['Elixir', 'Dark Elixir'],
          doubledDecks: ['Elixir'],
        })}
      </>,
    )
    const chips = screen.getAllByText(/^Elixir|^Dark Elixir/, { selector: '.chip--deck' })
    const byName = new Map(chips.map((chip) => [chip.textContent, chip]))
    assert.ok(byName.get('Elixir ×2'), 'Elixir chip is not marked ×2')
    assert.ok(byName.get('Dark Elixir'), 'Dark Elixir chip should have no ×2 marker')
  })
})

describe('Leaderboard', () => {
  const columns = overallColumns((date) => date.toISOString())

  function row(over: Partial<BaseStanding>): BaseStanding {
    return { ...BASE_ROW, ...over }
  }

  it('renders nothing for an empty board', () => {
    const { container } = render(
      <Leaderboard rows={[]} ariaLabel="Test board" columns={columns} />,
    )
    assert.equal(container.textContent, '')
    assert.equal(screen.queryByRole('table'), null)
  })

  it('hides the Owner select when every row shares the same owner', () => {
    render(
      <Leaderboard
        rows={[row({ tag: '#AAA', ownerUserId: 1 }), row({ tag: '#BBB', ownerUserId: 1 })]}
        ariaLabel="Test board"
        columns={columns}
      />,
    )
    assert.equal(screen.queryByLabelText('Owner'), null)
  })

  it('shows the Owner select once the board has more than one owner, and narrows the table', async () => {
    const user = userEvent.setup()
    render(
      <Leaderboard
        rows={[
          row({ tag: '#AAA', label: 'Alda', ownerUserId: 1, owner: 'Alda' }),
          row({ tag: '#BBB', label: 'Brix', ownerUserId: 2, owner: 'Brix' }),
        ]}
        ariaLabel="Test board"
        columns={columns}
      />,
    )

    const select = screen.getByLabelText('Owner')
    assert.ok(within(select).getByRole('option', { name: 'Alda' }))
    assert.ok(within(select).getByRole('option', { name: 'Brix' }))
    assert.ok(screen.getByRole('link', { name: 'Alda' }))
    assert.ok(screen.getByRole('link', { name: 'Brix' }))

    await user.selectOptions(select, 'Alda')
    assert.ok(screen.getByRole('link', { name: 'Alda' }))
    assert.equal(screen.queryByRole('link', { name: 'Brix' }), null)
  })

  it('always draws the `filters` slot, even when Owner alone would not', () => {
    /* Two rows, one shared owner — Owner alone would stay hidden — but the Deck
       picker `filters` always has a real choice, so the whole filter row still
       draws. */
    render(
      <Leaderboard
        rows={[row({ tag: '#AAA', ownerUserId: 1 }), row({ tag: '#BBB', ownerUserId: 1 })]}
        ariaLabel="Test board"
        columns={columns}
        filters={<label htmlFor="deck-pick">Deck</label>}
      />,
    )
    assert.ok(screen.getByText('Deck'))
    assert.equal(screen.queryByLabelText('Owner'), null)
  })

  it('paginates once the board is longer than the default row limit, and hides the pager under it', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      row({ tag: `#${index}`, label: `Base ${index}`, rank: index + 1 }),
    )

    const { rerender } = render(<Leaderboard rows={many} ariaLabel="Test board" columns={columns} />)
    assert.ok(screen.getByText(/Showing 1–5 of 6 bases/))
    assert.equal(within(screen.getByRole('table')).getAllByRole('row').length, 6) // header + 5 data rows

    rerender(<Leaderboard rows={many.slice(0, 5)} ariaLabel="Test board" columns={columns} />)
    assert.equal(screen.queryByText(/Showing/), null)
  })
})
