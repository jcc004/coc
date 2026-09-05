import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen } from '@testing-library/react'
import type { BaseInventory, OwnerRecord, SessionUser } from '@coc/shared'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { TradeSuggestions } from './TradeSuggestions.tsx'

/**
 * `CompleteNowButton`'s fast path — propose and complete a suggested swap in one
 * click — used to be admin-only, and is now party-or-admin (see its own doc
 * comment in `TradeSuggestions.tsx`). That rule is `tradeProposeAccess`
 * (`../trade-tracker.ts`), which is well covered on its own; what has never been
 * covered is the *wiring* in this component — whether the button the table
 * actually renders agrees with that rule for a trade the signed-in session is not
 * a party to. That is exactly the shape `claude-kit/rules/invariants.md`'s "New
 * functionality gets tested from every user type a project has" asks for: an
 * admin viewing someone else's trade, and a plain member viewing the same one,
 * must not see the same row.
 *
 * `#AAAAAA` (Alice, owned by user 2) and `#BBBBBB` (Bob, owned by user 3) each
 * hold a spare of one Elixir card the other lacks (Barbarian/Archer, ids 1 and
 * 2 — both Elixir per `cards.generated.ts`), which is a mutual, two-sided swap:
 * it shows under the table's default Sides filter with no extra setup, and it
 * is between two other members for every user fixture below — none of them owns
 * either base except where a test says so explicitly.
 */

installTestCleanup()

const ALICE = '#AAAAAA'
const BOB = '#BBBBBB'

const LABELS: Record<string, string> = { [ALICE]: 'Alice', [BOB]: 'Bob' }

const OWNERS: OwnerRecord[] = [
  { tag: ALICE, owner: 'Alice', ownerUserId: 2 },
  { tag: BOB, owner: 'Bob', ownerUserId: 3 },
]

const BASES: BaseInventory[] = [
  // Two Barbarians (id 1), none of Bob's Archer (id 2) — a spare to give, a need to fill.
  { tag: ALICE, counts: [{ cardId: 1, count: 2 }] },
  // Mirror image: two Archers, no Barbarian.
  { tag: BOB, counts: [{ cardId: 2, count: 2 }] },
]

/** Renders the clan-wide table with one mutual trade on it, Alice-for-Bob. */
async function renderFor(user: SessionUser) {
  stubApi({
    owners: () => Promise.resolve({ owners: OWNERS }),
    trades: () => Promise.resolve({ season: '2026-08', trades: [] }),
  })
  render(
    <TradeSuggestions
      bases={BASES}
      labelOf={(tag) => LABELS[tag] ?? tag}
      ownerOf={(tag) => OWNERS.find((owner) => owner.tag === tag)?.owner}
      user={user}
    />,
  )
  await screen.findByRole('table', { name: 'Trade suggestions' })
}

describe('an admin viewing a trade between two other members', () => {
  it('sees the Complete fast-path button', async () => {
    await renderFor(sessionUser({ id: 1, role: 'admin' }))

    assert.ok(screen.getByRole('button', { name: 'Complete' }))
  })

  it('also sees the Propose button, for the same reason', async () => {
    await renderFor(sessionUser({ id: 1, role: 'admin' }))

    assert.ok(screen.getByRole('button', { name: 'Propose' }))
  })
})

describe('a non-party member viewing the same trade', () => {
  it('does not see the Complete fast-path button', async () => {
    await renderFor(sessionUser({ id: 1, role: 'user' }))

    assert.equal(screen.queryByRole('button', { name: 'Complete' }), null)
  })

  it('does not see the Propose button either, and is told who can', async () => {
    await renderFor(sessionUser({ id: 1, role: 'user' }))

    assert.equal(screen.queryByRole('button', { name: 'Propose' }), null)
    assert.ok(screen.getByText('Alice or Bob can propose this'))
  })
})

describe('a member who is a party to the trade', () => {
  it('sees both Propose and the Complete fast path, without being an admin', async () => {
    // User 2 owns Alice's base — one of the two sides — per `OWNERS` above.
    await renderFor(sessionUser({ id: 2, role: 'user' }))

    assert.ok(screen.getByRole('button', { name: 'Propose' }))
    assert.ok(screen.getByRole('button', { name: 'Complete' }))
  })
})
