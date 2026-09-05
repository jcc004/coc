import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OwnerRecord } from '@coc/shared'
import { api } from '../api.ts'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { BaseOrderView } from './BaseOrderView.tsx'

/**
 * `#/base-order` — the button-based reorder controls (Move up/down/top/bottom,
 * Alphabetize), since native drag-and-drop has no jsdom-testable event sequence
 * worth writing (`DragEvent`/`DataTransfer` aren't meaningfully simulated there,
 * and the drag handlers call the exact same `order.reorder(moveTag(...))` path
 * the buttons do — see `BaseOrderView.tsx`'s own doc comment). The buttons
 * exercise the real reorder logic just as well.
 */

installTestCleanup()

const USER = sessionUser({ id: 1 })

const OWNERS: OwnerRecord[] = [
  { tag: '#AAA', owner: 'Rae', ownerUserId: 1 },
  { tag: '#BBB', owner: 'Rae', ownerUserId: 1 },
  { tag: '#CCC', owner: 'Rae', ownerUserId: 1 },
]

// Distinct member names so order is readable and Alphabetize has something real
// to do: initial saved order is Zed, Amy, Mel — deliberately not alphabetical.
const MEMBERS = [
  { tag: '#AAA', name: 'Zed' },
  { tag: '#BBB', name: 'Amy' },
  { tag: '#CCC', name: 'Mel' },
]

function stub(owners: OwnerRecord[] = OWNERS, savedOrder: string[] = ['#AAA', '#BBB', '#CCC']) {
  stubApi({
    owners: () => Promise.resolve({ owners }),
    savedClans: () => Promise.resolve({ clans: [{ tag: '#CLAN', name: 'Clan' }] }),
    clanMembers: () =>
      Promise.resolve({
        items: MEMBERS.map((m) => ({
          role: 'member' as const,
          tag: m.tag,
          name: m.name,
          townHallLevel: 15,
          expLevel: 100,
          trophies: 3000,
          clanRank: 1,
          previousClanRank: 1,
          donations: 0,
          donationsReceived: 0,
        })),
      }),
    getBaseOrder: () => Promise.resolve({ tags: savedOrder }),
  })
}

async function listLabels() {
  const list = await screen.findByRole('list', { name: 'Your bases, in order' })
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getByText(/^(Zed|Amy|Mel)$/).textContent)
}

describe('reordering with the buttons', () => {
  it('moves a base to the top and saves the new order', async () => {
    stub()
    const saveBaseOrder = mock.method(api, 'saveBaseOrder', (tags: string[]) =>
      Promise.resolve({ tags }),
    )
    const user = userEvent.setup()
    render(<BaseOrderView user={USER} />)

    assert.deepEqual(await listLabels(), ['Zed', 'Amy', 'Mel'])

    await user.click(await screen.findByRole('button', { name: 'Move Amy to top' }))

    assert.deepEqual(await listLabels(), ['Amy', 'Zed', 'Mel'])
    assert.deepEqual(saveBaseOrder.mock.calls[0]?.arguments, [['#BBB', '#AAA', '#CCC']])
  })

  it('moves a base down one position', async () => {
    stub()
    mock.method(api, 'saveBaseOrder', (tags: string[]) => Promise.resolve({ tags }))
    const user = userEvent.setup()
    render(<BaseOrderView user={USER} />)

    await listLabels()
    await user.click(await screen.findByRole('button', { name: 'Move Zed down' }))

    assert.deepEqual(await listLabels(), ['Amy', 'Zed', 'Mel'])
  })

  it('disables Move up on the first row and Move down on the last', async () => {
    stub()
    render(<BaseOrderView user={USER} />)
    await listLabels()

    assert.ok((await screen.findByRole('button', { name: 'Move Zed up' })).hasAttribute('disabled'))
    assert.ok(screen.getByRole('button', { name: 'Move Mel down' }).hasAttribute('disabled'))
    assert.equal(screen.getByRole('button', { name: 'Move Zed down' }).hasAttribute('disabled'), false)
  })
})

describe('Alphabetize', () => {
  it('sorts every base by its label and saves the result', async () => {
    stub()
    const saveBaseOrder = mock.method(api, 'saveBaseOrder', (tags: string[]) =>
      Promise.resolve({ tags }),
    )
    const user = userEvent.setup()
    render(<BaseOrderView user={USER} />)

    assert.deepEqual(await listLabels(), ['Zed', 'Amy', 'Mel'])

    await user.click(await screen.findByRole('button', { name: 'Alphabetize' }))

    assert.deepEqual(await listLabels(), ['Amy', 'Mel', 'Zed'])
    assert.deepEqual(saveBaseOrder.mock.calls[0]?.arguments, [['#BBB', '#CCC', '#AAA']])
  })

  it('is absent with zero or one base, since there is nothing to alphabetize', async () => {
    stub([OWNERS[0] as OwnerRecord], ['#AAA'])
    render(<BaseOrderView user={USER} />)

    await screen.findByRole('list', { name: 'Your bases, in order' })
    assert.equal(screen.queryByRole('button', { name: 'Alphabetize' }), null)
  })
})

describe('an account with no bases of its own', () => {
  it('says so, and asks to see an admin rather than showing an empty list', async () => {
    stub([])
    render(<BaseOrderView user={USER} />)

    assert.ok(
      await screen.findByText('You do not own any bases yet — ask an admin to assign one to your account.'),
    )
    assert.equal(screen.queryByRole('list', { name: 'Your bases, in order' }), null)
  })
})
