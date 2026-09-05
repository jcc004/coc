import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BaseInventory } from '@coc/shared'
import { cardTotals } from '../card-standings.ts'
import { ALL_CARDS } from '../cards.ts'
import { installTestCleanup } from '../test-support.ts'
import { CardTotals, useCardTotalSort } from './CardTotals.tsx'

/**
 * `CardTotals` combines `CardTotalsGrid` and `CardHolders` — both are tested on
 * their own in their adjacent files, so what is worth testing here is only what
 * this wrapper itself adds: the `picked` state that decides whether, and for
 * which card, the holders panel below the grid shows at all.
 *
 * `useCardTotalSort` is a standalone, exported hook with no test-file precedent
 * elsewhere in this repo for testing a hook in isolation — a tiny host component
 * stands in for `renderHook`, which this repo does not depend on.
 */

installTestCleanup()

const CARD_A = ALL_CARDS[0]!
const CARD_B = ALL_CARDS[1]!

function inventory(tag: string, counts: BaseInventory['counts']): BaseInventory {
  return { tag, counts }
}

/** Two real cards, one held by a base and one not — `cardTotals`'s own second
 *  argument narrows it to exactly these two instead of drawing all sixty. */
function totalsFixture() {
  const bases: BaseInventory[] = [
    inventory('#AAA', [{ cardId: CARD_A.id, count: 3 }]),
  ]
  return cardTotals(bases, [CARD_A, CARD_B])
}

async function renderTotals() {
  const user = userEvent.setup()
  render(
    <CardTotals
      totals={totalsFixture()}
      columns={6}
      bases={[inventory('#AAA', [{ cardId: CARD_A.id, count: 3 }])]}
      labelOf={(tag) => tag}
      grouped={false}
      fodderById={null}
    />,
  )
  return user
}

function tileFor(card: { name: string }) {
  return screen.getByRole('button', { name: new RegExp(card.name) })
}

describe('CardTotals', () => {
  it('shows no holders panel until a tile is picked', async () => {
    await renderTotals()
    assert.equal(screen.queryByRole('heading', { level: 3 }), null)
  })

  it('opens the holders panel for the card whose tile was pressed', async () => {
    const user = await renderTotals()
    await user.click(tileFor(CARD_A))

    assert.ok(screen.getByRole('heading', { name: new RegExp(CARD_A.name), level: 3 }))
  })

  it('closes the panel when the same tile is pressed again', async () => {
    const user = await renderTotals()
    await user.click(tileFor(CARD_A))
    await user.click(tileFor(CARD_A))

    assert.equal(screen.queryByRole('heading', { level: 3 }), null)
  })

  it('switches the panel to a different card rather than showing both', async () => {
    const user = await renderTotals()
    await user.click(tileFor(CARD_A))
    await user.click(tileFor(CARD_B))

    assert.ok(screen.getByRole('heading', { name: new RegExp(CARD_B.name), level: 3 }))
    assert.equal(screen.queryByRole('heading', { name: new RegExp(CARD_A.name) }), null)
    // Exactly one panel, not two accumulating.
    assert.equal(screen.getAllByRole('heading', { level: 3 }).length, 1)
  })
})

/** Stands in for `renderHook`, which this repo does not depend on: reads the
 *  current sort as visible text, and offers two buttons to change it. */
function SortProbe({ storageKey }: { storageKey: string }) {
  const [sort, setSort] = useCardTotalSort(storageKey)
  return (
    <div>
      <p>Current: {sort}</p>
      <button type="button" onClick={() => setSort('highest')}>
        Choose highest
      </button>
      <button type="button" onClick={() => setSort('lowest')}>
        Choose lowest
      </button>
    </div>
  )
}

describe('useCardTotalSort', () => {
  it('reads the parsed default when nothing is stored for the key', () => {
    render(<SortProbe storageKey="test:sort:fresh" />)
    assert.ok(screen.getByText('Current: default'))
  })

  it('updates the returned value and writes the raw string to localStorage', async () => {
    const user = userEvent.setup()
    render(<SortProbe storageKey="test:sort:a" />)

    await user.click(screen.getByRole('button', { name: 'Choose highest' }))

    assert.ok(screen.getByText('Current: highest'))
    assert.equal(localStorage.getItem('test:sort:a'), 'highest')
  })

  it('keeps two different keys independent of each other', async () => {
    const user = userEvent.setup()
    render(
      <>
        <SortProbe storageKey="test:sort:b" />
        <SortProbe storageKey="test:sort:c" />
      </>,
    )

    await user.click(screen.getAllByRole('button', { name: 'Choose highest' })[0]!)
    await user.click(screen.getAllByRole('button', { name: 'Choose lowest' })[1]!)

    assert.equal(localStorage.getItem('test:sort:b'), 'highest')
    assert.equal(localStorage.getItem('test:sort:c'), 'lowest')
  })

  it('reads a previously stored choice back on the next mount', () => {
    localStorage.setItem('test:sort:persisted', 'lowest')
    render(<SortProbe storageKey="test:sort:persisted" />)

    assert.ok(screen.getByText('Current: lowest'))
  })
})
