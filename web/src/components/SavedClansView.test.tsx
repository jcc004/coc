import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { render, screen } from '@testing-library/react'
import type { SavedClanRecord } from '@coc/shared'
import { installTestCleanup, sessionUser, stubApi } from '../test-support.ts'
import { SavedClansView } from './SavedClansView.tsx'

/**
 * Writing the saved-clan list is now an admin decision, server and client both —
 * see the doc comment on `SavedClansView` itself. What is worth a component test is
 * the gating: the controls that write (Edit, Remove, the add form, Refresh all) are
 * *absent* for a non-admin, not merely disabled, and still present for an admin. The
 * server-side refusal has its own coverage in `server/src/app.test.ts`; this is only
 * the presentation half of that same rule.
 */

installTestCleanup()

const CLAN: SavedClanRecord = {
  tag: '#G88CYQP',
  name: 'Reddit',
  clanLevel: 26,
  members: 48,
  clanPoints: 42000,
  warLeague: 'Champion League I',
}

function stub(clans: SavedClanRecord[] = [CLAN]): void {
  stubApi({ savedClans: () => Promise.resolve({ clans }) })
}

async function renderFor(role: 'admin' | 'user') {
  render(<SavedClansView user={sessionUser({ role })} />)
  return screen.findByText(CLAN.name)
}

describe('an admin', () => {
  it('sees Edit and Remove on every row', async () => {
    stub()
    await renderFor('admin')

    assert.ok(screen.getByRole('button', { name: 'Edit' }))
    assert.ok(screen.getByRole('button', { name: 'Remove' }))
  })

  it('sees the standalone add form', async () => {
    stub()
    await renderFor('admin')

    assert.ok(screen.getByRole('heading', { name: 'Add a saved clan' }))
    assert.ok(screen.getByLabelText('Clan tag'))
  })

  it('sees Refresh all once there is a clan to refresh', async () => {
    stub()
    await renderFor('admin')

    assert.ok(screen.getByRole('button', { name: 'Refresh all' }))
  })

  it('is told to add a tag below when the list is empty', async () => {
    stub([])
    render(<SavedClansView user={sessionUser({ role: 'admin' })} />)

    await screen.findByText(/Add a tag below/)
  })
})

describe('a member', () => {
  it('has no Edit or Remove on any row', async () => {
    stub()
    await renderFor('user')

    assert.equal(screen.queryByRole('button', { name: 'Edit' }), null)
    assert.equal(screen.queryByRole('button', { name: 'Remove' }), null)
    // The read-only War link stays — it navigates, it does not write.
    assert.ok(screen.getByRole('link', { name: 'War' }))
  })

  it('has no standalone add form', async () => {
    stub()
    await renderFor('user')

    assert.equal(screen.queryByRole('heading', { name: 'Add a saved clan' }), null)
    assert.equal(screen.queryByLabelText('Clan tag'), null)
  })

  it('has no Refresh all, even though there is a clan to refresh', async () => {
    stub()
    await renderFor('user')

    assert.equal(screen.queryByRole('button', { name: 'Refresh all' }), null)
  })

  it('is told to ask an admin when the list is empty', async () => {
    stub([])
    render(<SavedClansView user={sessionUser({ role: 'user' })} />)

    await screen.findByText(/Ask an admin to add one/)
  })
})
