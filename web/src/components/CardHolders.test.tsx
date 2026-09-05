import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import type { BaseInventory } from '@coc/shared'
import { type CardTotal } from '../card-standings.ts'
import { ALL_CARDS } from '../cards.ts'
import { installTestCleanup } from '../test-support.ts'
import { CardHolders, heldAcrossTheClan } from './CardHolders.tsx'

/**
 * `CardHolders` split out of `CardsView.tsx` — the "who holds this card" panel a
 * totals-grid tile press opens. Exercises the real `card-holders.ts` logic
 * (`cardHolders`, `cardDemand`, `basesNeeding`) through realistic `BaseInventory`
 * fixtures rather than stubbing it, since the whole point of this component is
 * drawing exactly what that module reports.
 */

installTestCleanup()

function required<T>(value: T | undefined, message: string): T {
  assert.ok(value, message)
  return value
}

const CARD = required(ALL_CARDS[0], 'ALL_CARDS must have at least one card')
const identity = (tag: string) => tag

function base(tag: string, counts: { cardId: number; count: number }[]): BaseInventory {
  return { tag, counts }
}

function entryFor(bases: readonly BaseInventory[]): CardTotal {
  const total = bases.reduce((sum, b) => sum + (b.counts.find((c) => c.cardId === CARD.id)?.count ?? 0), 0)
  return { card: CARD, total, absent: total === 0 }
}

describe('nobody holds it', () => {
  it('says so plainly, with no holders table at all', () => {
    const bases = [base('#A', []), base('#B', [])]
    render(<CardHolders entry={entryFor(bases)} bases={bases} labelOf={identity} />)

    assert.ok(screen.getByText('Nobody in the clan holds it.'))
    assert.equal(screen.queryByRole('table', { name: /Bases holding/ }), null)
  })
})

describe('the holders table', () => {
  it('lists only bases that hold at least one copy, and gets Can-spare/Its-only-copy right per base', () => {
    const bases = [
      base('#A', [{ cardId: CARD.id, count: 1 }]),
      base('#B', [{ cardId: CARD.id, count: 2 }]),
      base('#C', []),
    ]
    render(<CardHolders entry={entryFor(bases)} bases={bases} labelOf={identity} />)

    const table = screen.getByRole('table', { name: `Bases holding ${CARD.name}` })
    const rows = within(table).getAllByRole('row').slice(1) // drop the header row
    assert.equal(rows.length, 2, 'the zero-count base has no row at all')

    const rowFor = (tag: string) => rows.find((row) => within(row).queryByText(tag) !== null)
    assert.ok(within(rowFor('#A')!).getByText('Its only copy'), 'one copy cannot be spared')
    assert.ok(within(rowFor('#B')!).getByText('Can spare one'), 'two copies clears MIN_TRADEABLE_COUNT')
  })
})

describe('the "still need it" block', () => {
  it('names exactly the reporting bases with no row in the holders table', () => {
    const bases = [
      base('#A', [{ cardId: CARD.id, count: 1 }]),
      base('#B', []),
      base('#C', []),
    ]
    render(<CardHolders entry={entryFor(bases)} bases={bases} labelOf={identity} />)

    assert.ok(screen.getByText('2 bases still need it:'))
    const needingTable = screen.getByRole('table', { name: `Bases that still need ${CARD.name}` })
    assert.deepEqual(
      within(needingTable)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
      ['#B', '#C'],
    )
  })

  it('reads "every reporting base already holds it" when nobody is missing it', () => {
    const bases = [
      base('#A', [{ cardId: CARD.id, count: 1 }]),
      base('#B', [{ cardId: CARD.id, count: 3 }]),
    ]
    render(<CardHolders entry={entryFor(bases)} bases={bases} labelOf={identity} />)

    assert.ok(screen.getByText('Every reporting base already holds it.'))
    assert.equal(screen.queryByRole('table', { name: /still need/ }), null)
  })

  it('is entirely absent when nothing has reported at all -- absence is not an answer', () => {
    render(<CardHolders entry={entryFor([])} bases={[]} labelOf={identity} />)

    assert.equal(screen.queryByText('Every reporting base already holds it.'), null)
    assert.equal(screen.queryByText(/still need it/), null)
    // No holders either, on the same empty inventory.
    assert.ok(screen.getByText('Nobody in the clan holds it.'))
  })
})

describe('heldAcrossTheClan', () => {
  it('reports the count for a card somebody holds', () => {
    assert.equal(heldAcrossTheClan(3), '3 held across the clan')
  })

  it('reports "none" rather than "0" for a card nobody holds', () => {
    assert.equal(heldAcrossTheClan(0), 'none held across the clan')
  })
})
