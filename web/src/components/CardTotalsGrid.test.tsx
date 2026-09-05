import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mock } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type CardTotal } from '../card-standings.ts'
import { ALL_CARDS, type GeneratedCard } from '../cards.ts'
import { type TradeFodderEntry } from '../trade-fodder.ts'
import { installTestCleanup } from '../test-support.ts'
import { HOLDERS_ID } from './CardHolders.tsx'
import { CardTotalsGrid } from './CardTotalsGrid.tsx'

/**
 * `CardTotalsGrid` split out of `CardsView.tsx` — the clan-wide totals grid, one
 * `CardTotalPick` tile per card. `CardHolders.test.tsx` covers the panel a tile's
 * press opens; this covers the grid and the tile itself: which one carries
 * `aria-controls`, how the same card reads differently between the Totals and
 * Trade Fodder views, and the deck-grouping split that replaced a duplicate-key
 * bug (see the component's own doc comment on `grouped`).
 */

installTestCleanup()

function required<T>(value: T | undefined, message: string): T {
  assert.ok(value, message)
  return value
}

const CARD_A = required(ALL_CARDS[0], 'ALL_CARDS must have at least one card')
const CARD_B = required(
  ALL_CARDS.find((card) => card.category !== CARD_A.category),
  'need a second card from a different category to exercise grouping',
)

/** The tile's own accessible name — `${card.name}, ${card.category} — ${summary}`,
 *  computed here rather than duplicated per test. */
function tileName(card: GeneratedCard, summary: string): string {
  return `${card.name}, ${card.category} — ${summary}`
}

function totals(overrides: Partial<Record<number, { total: number; absent: boolean }>> = {}): CardTotal[] {
  return [
    { card: CARD_A, total: overrides[CARD_A.id]?.total ?? 3, absent: overrides[CARD_A.id]?.absent ?? false },
    { card: CARD_B, total: overrides[CARD_B.id]?.total ?? 0, absent: overrides[CARD_B.id]?.absent ?? true },
  ]
}

describe('which tile carries aria-controls', () => {
  it('only the picked tile points at HOLDERS_ID; the rest carry none', () => {
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={CARD_A.id}
        onPick={() => undefined}
        grouped={false}
        fodderById={null}
      />,
    )

    const pickedTile = screen.getByRole('button', {
      name: tileName(CARD_A, '3 held across the clan'),
    })
    const otherTile = screen.getByRole('button', {
      name: tileName(CARD_B, 'none held across the clan'),
    })

    assert.equal(pickedTile.getAttribute('aria-controls'), HOLDERS_ID)
    assert.equal(otherTile.getAttribute('aria-controls'), null)
    assert.equal(pickedTile.getAttribute('aria-pressed'), 'true')
    assert.equal(otherTile.getAttribute('aria-pressed'), 'false')
  })
})

describe('the same card reads differently in the Totals view and the Trade Fodder view', () => {
  it('Totals view: the summary is heldAcrossTheClan', () => {
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={false}
        fodderById={null}
      />,
    )

    assert.ok(screen.getByRole('button', { name: tileName(CARD_A, '3 held across the clan') }))
  })

  it('Trade Fodder view: the same card, same total, reads its held/extra fields instead', () => {
    const fodder: TradeFodderEntry = { card: CARD_A, total: 3, held: true, extra: 1 }
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={false}
        fodderById={new Map([[CARD_A.id, fodder]])}
      />,
    )

    assert.ok(
      screen.getByRole('button', { name: tileName(CARD_A, '1 spare once everyone has one') }),
      'held with a surplus reads as spare',
    )
  })

  it('Trade Fodder view: held with no surplus reads differently from held with one', () => {
    const fodder: TradeFodderEntry = { card: CARD_A, total: 3, held: true, extra: 0 }
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={false}
        fodderById={new Map([[CARD_A.id, fodder]])}
      />,
    )

    assert.ok(
      screen.getByRole('button', { name: tileName(CARD_A, 'held by every base, no spares yet') }),
    )
  })

  it('Trade Fodder view: not yet held by every base reads as still-collecting, not fodder', () => {
    const fodder: TradeFodderEntry = { card: CARD_A, total: 3, held: false, extra: 0 }
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={false}
        fodderById={new Map([[CARD_A.id, fodder]])}
      />,
    )

    assert.ok(
      screen.getByRole('button', { name: tileName(CARD_A, 'not held by every base yet') }),
    )
  })
})

describe('grouped vs. flat rendering', () => {
  it('grouped: true puts each deck in its own labeled group, one per category present', () => {
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={true}
        fodderById={null}
      />,
    )

    const groups = screen.getAllByRole('group')
    assert.equal(groups.length, 2, 'one group per distinct category in totals')

    const categoryOf = new Map(groups.map((group) => [within(group).getByRole('heading').textContent, group]))
    assert.ok(categoryOf.has(CARD_A.category), 'a group is labeled with card A’s own category')
    assert.ok(categoryOf.has(CARD_B.category), 'a group is labeled with card B’s own category')

    assert.ok(within(categoryOf.get(CARD_A.category)!).getByRole('button', { name: new RegExp(CARD_A.name) }))
    assert.ok(within(categoryOf.get(CARD_B.category)!).getByRole('button', { name: new RegExp(CARD_B.name) }))
  })

  it('grouped: false draws every tile directly, with no group wrapper at all', () => {
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={() => undefined}
        grouped={false}
        fodderById={null}
      />,
    )

    assert.equal(screen.queryAllByRole('group').length, 0)
    assert.ok(screen.getByRole('button', { name: new RegExp(CARD_A.name) }))
    assert.ok(screen.getByRole('button', { name: new RegExp(CARD_B.name) }))
  })
})

describe('pressing a tile', () => {
  it('picks the card when nothing is picked yet', async () => {
    const user = userEvent.setup()
    const onPick = mock.fn()
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={null}
        onPick={onPick}
        grouped={false}
        fodderById={null}
      />,
    )

    await user.click(screen.getByRole('button', { name: new RegExp(CARD_A.name) }))

    assert.equal(onPick.mock.callCount(), 1)
    assert.deepEqual(onPick.mock.calls[0]?.arguments, [CARD_A.id])
  })

  it('unpicks (calls onPick(null)) when the already-picked tile is pressed again', async () => {
    const user = userEvent.setup()
    const onPick = mock.fn()
    render(
      <CardTotalsGrid
        totals={totals()}
        columns={6}
        picked={CARD_A.id}
        onPick={onPick}
        grouped={false}
        fodderById={null}
      />,
    )

    await user.click(screen.getByRole('button', { name: new RegExp(CARD_A.name) }))

    assert.equal(onPick.mock.callCount(), 1)
    assert.deepEqual(onPick.mock.calls[0]?.arguments, [null])
  })
})
