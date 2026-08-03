import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ClanMember, OwnerRecord } from '@coc/shared'
import { api } from '../api.ts'
import { adminAccount, installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { RosterTable } from './RosterTable.tsx'

/**
 * The roster's Owner column, which is where the one distinction that decides
 * permissions gets drawn: a base assigned to an *account* grants its holder the right
 * to write that base's card counts, and a pre-accounts label that happens to name the
 * same person grants nothing at all. The two look identical as bare text, which is how
 * two people came to disagree about who owns a base in the first place.
 *
 * The state machine behind the controls is asserted without a DOM in
 * `roster-state.test.ts`; what is here is the part only a rendered table can answer —
 * who is offered which control, and what a control actually sends.
 */

installTestCleanup()

const RAE = adminAccount({ id: 1, displayName: 'Rae', role: 'admin' })
const SAM = adminAccount({ id: 2, displayName: 'Sam' })

const member = (over: Partial<ClanMember> & { tag: string; name: string }): ClanMember => ({
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

const ALDA = member({ tag: '#AAA', name: 'Alda', clanRank: 1 })
const BRIX = member({ tag: '#BBB', name: 'Brix', clanRank: 2 })

/** Renders the table and waits for the owner store's first snapshot to land. */
async function roster(members: ClanMember[], owners: OwnerRecord[], who = sessionUser()) {
  const user = userEvent.setup()
  stubApi({
    owners: () => Promise.resolve({ owners }),
    users: () => Promise.resolve({ users: [RAE, SAM] }),
  })
  render(<RosterTable members={members} user={who} />)
  await screen.findByText(members[0]?.name ?? '')
  return user
}

/**
 * The rows only. The Owner *filter* offers every label in use and the help copy under
 * the table quotes the same phrases, so an unscoped query for a name or for "not an
 * account" matches three places at once and proves nothing about the cell.
 */
const rows = () => within(screen.getByRole('table'))

describe('the Owner column, for a member', () => {
  it('shows who owns a base but offers no way to change it', async () => {
    const users = mock.method(api, 'users', () => Promise.resolve({ users: [RAE, SAM] }))
    await roster([ALDA], [{ tag: '#AAA', owner: 'Sam', ownerUserId: 2 }])

    assert.ok(rows().getByText('Sam'))
    // Assigning is admin-only on the server, and a control whose only outcome is a
    // 403 is a lie told at the moment of clicking.
    assert.equal(screen.queryByLabelText('Owner of Alda'), null)
    // And the admin-only account list is not even requested for them.
    assert.equal(users.mock.callCount(), 0)
  })

  it('says in words when an owner is a label that grants nobody anything', async () => {
    await roster([ALDA], [{ tag: '#AAA', owner: 'Sam', ownerUserId: null }])

    // Not admin trivia: it is why a base somebody looks after is one they cannot
    // type card counts into.
    assert.ok(rows().getByText('not an account'))
    // And the count is a fact about the table in front of you, not general advice.
    assert.match(
      screen.getByText(/still a\s+typed-in name/).textContent ?? '',
      /1 of this roster's assignments is still a typed-in name/,
    )
  })

  it('shows an unassigned base as unassigned rather than as somebody', async () => {
    await roster([ALDA], [])
    assert.ok(rows().getByText('—'))
  })
})

describe('the Owner column, for an admin', () => {
  it('assigns the account that was picked, by id and never by name', async () => {
    const assignOwner = mock.method(api, 'assignOwner', () =>
      Promise.resolve({ owner: { tag: '#AAA', owner: 'Sam', ownerUserId: 2 } }),
    )
    const user = await roster([ALDA], [], sessionUser({ role: 'admin' }))

    await user.selectOptions(await screen.findByLabelText('Owner of Alda'), '2')

    await waitFor(() => assert.equal(assignOwner.mock.callCount(), 1))
    // `PUT /api/owners/:tag` takes a user id and nothing else — a name could only
    // ever be guessed at, and a guess that misses becomes another unlinked label.
    assert.deepEqual(assignOwner.mock.calls[0]?.arguments, ['#AAA', 2])
  })

  it('clears an assignment rather than assigning it to nobody', async () => {
    const removeOwner = mock.method(api, 'removeOwner', () => Promise.resolve({ ok: true as const }))
    const user = await roster(
      [ALDA],
      [{ tag: '#AAA', owner: 'Sam', ownerUserId: 2 }],
      sessionUser({ role: 'admin' }),
    )

    await user.selectOptions(await screen.findByLabelText('Owner of Alda'), '')

    await waitFor(() => assert.equal(removeOwner.mock.callCount(), 1))
    assert.deepEqual(removeOwner.mock.calls[0]?.arguments, ['#AAA'])
  })

  it('cannot submit a legacy label back to the server', async () => {
    const assignOwner = mock.method(api, 'assignOwner', () => Promise.reject(new Error('never')))
    await roster(
      [ALDA],
      [{ tag: '#AAA', owner: 'sam_1', ownerUserId: null }],
      sessionUser({ role: 'admin' }),
    )

    /* The stored label has to be *showable* — those rows are the only surviving record
       of who a base belongs to — but it is not a choice, so the option carrying it is
       disabled and `parseOwnerChoice` refuses it a second time. */
    const option = within(await screen.findByLabelText('Owner of Alda')).getByRole('option', {
      name: /sam_1 — not an account/,
    })
    assert.equal((option as HTMLOptionElement).disabled, true)
    assert.equal(assignOwner.mock.callCount(), 0)
  })

  it('reports a refused write in the cell that caused it', async () => {
    stubApi({})
    mock.method(api, 'assignOwner', () =>
      Promise.reject(new Error('An admin assigns ownership of a base.')),
    )
    const user = await roster([ALDA], [], sessionUser({ role: 'admin' }))

    await user.selectOptions(await screen.findByLabelText('Owner of Alda'), '2')

    // The server's own wording, because a 403 here states the rule.
    await screen.findByText('An admin assigns ownership of a base.')
  })
})

describe('a bulk owner change', () => {
  it('writes only the rows nobody owns and defers the rest for approval', async () => {
    const applyOwners = mock.method(api, 'applyOwners', () =>
      Promise.resolve({
        applied: [{ tag: '#AAA', owner: 'Sam', ownerUserId: 2 }],
        cleared: [],
        conflicts: [],
      }),
    )
    const user = await roster(
      [ALDA, BRIX],
      [{ tag: '#BBB', owner: 'Rae', ownerUserId: 1 }],
      sessionUser({ role: 'admin' }),
    )

    await user.click(screen.getByLabelText('Select Alda'))
    await user.click(screen.getByLabelText('Select Brix'))
    await user.selectOptions(screen.getByLabelText('Owner to apply to selected members'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }))

    await waitFor(() => assert.equal(applyOwners.mock.callCount(), 1))
    /*
     * Only Alda, and carrying `expectedOwner: ''` — the assertion "I believe nobody
     * owns this". The server refuses the row if that no longer holds, which is what
     * stops a stale tab clobbering a change it never saw.
     */
    assert.deepEqual(applyOwners.mock.calls[0]?.arguments, [
      [{ tag: '#AAA', owner: 'Sam', expectedOwner: '' }],
    ])

    // Brix already had an owner, so it becomes an explicit decision instead.
    await screen.findByText('Confirm overwriting existing owners')
    const approvals = screen.getByRole('list')
    assert.match(within(approvals).getByRole('listitem').textContent ?? '', /Brix/)
    assert.match(within(approvals).getByRole('listitem').textContent ?? '', /Rae/)
  })

  it('makes the overwrite conditional on the value that was approved', async () => {
    const applyOwners = mock.method(api, 'applyOwners', () =>
      Promise.resolve({ applied: [], cleared: [], conflicts: [] }),
    )
    const user = await roster(
      [BRIX],
      [{ tag: '#BBB', owner: 'Rae', ownerUserId: 1 }],
      sessionUser({ role: 'admin' }),
    )

    await user.click(screen.getByLabelText('Select Brix'))
    await user.selectOptions(screen.getByLabelText('Owner to apply to selected members'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }))
    await screen.findByText('Confirm overwriting existing owners')

    // Nothing was written: the only selected row needed a decision first.
    assert.equal(applyOwners.mock.callCount(), 0)

    await user.click(screen.getByRole('button', { name: 'Approve all' }))
    await user.click(screen.getByRole('button', { name: 'Apply 1 approved' }))

    await waitFor(() => assert.equal(applyOwners.mock.callCount(), 1))
    /* `expectedOwner` is the value the approval was given *against*. Overwriting a
       different one would be exactly the silent clobber this flow exists to prevent. */
    assert.deepEqual(applyOwners.mock.calls[0]?.arguments, [
      [{ tag: '#BBB', owner: 'Sam', expectedOwner: 'Rae' }],
    ])
  })

  it('writes nothing when the approvals are all left unticked', async () => {
    const applyOwners = mock.method(api, 'applyOwners', () =>
      Promise.resolve({ applied: [], cleared: [], conflicts: [] }),
    )
    const user = await roster(
      [BRIX],
      [{ tag: '#BBB', owner: 'Rae', ownerUserId: 1 }],
      sessionUser({ role: 'admin' }),
    )

    await user.click(screen.getByLabelText('Select Brix'))
    await user.selectOptions(screen.getByLabelText('Owner to apply to selected members'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }))
    await screen.findByText('Confirm overwriting existing owners')

    await user.click(screen.getByRole('button', { name: 'Apply 0 approved' }))

    assert.equal(applyOwners.mock.callCount(), 0)
    // Every conflicting row keeps its owner, so the whole thing is finished.
    await waitFor(() => assert.equal(screen.queryByText('Confirm overwriting existing owners'), null))
  })
})

describe('the header checkbox', () => {
  it('ticks only the members on the page it is shown with', async () => {
    localStorage.setItem('coc:rosterLimit', '5')
    const members = Array.from({ length: 12 }, (_, index) =>
      member({ tag: `#T${index}`, name: `Member ${index}`, clanRank: index + 1 }),
    )
    const user = await roster(members, [])

    await user.click(screen.getByLabelText('Select the 5 members on this page'))

    /* Page-scoped on purpose: it used to mean the whole roster, which was safe only
       while the table was unpaged and unfiltered. Now that it is both, whole-roster
       would silently select members the filter is hiding. */
    assert.ok(screen.getByText('5 selected'))
  })
})
