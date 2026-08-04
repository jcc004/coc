import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  INITIAL_ROSTER_STATE,
  rosterReducer,
  type RosterAction,
  type RosterState,
} from './roster-state.ts'
import type { OwnerConflict } from './saved-table.ts'

/**
 * The roster's transitions, asserted without a table.
 *
 * These are the rules that used to be spread across six handlers and two async
 * functions in a 660-line component, where the only way to establish any of them was
 * to read all of it. Every one below is a decision somebody made about what a control
 * does to the *other* nine values — which is exactly the kind of thing that quietly
 * stops being true.
 */

const conflict = (tag: string, currentOwner: string): OwnerConflict => ({
  tag,
  name: `member ${tag}`,
  currentOwner,
  nextOwner: 'Sam',
})

/** Folds a sequence of actions over the initial state, as the table would. */
function after(...actions: RosterAction[]): RosterState {
  return actions.reduce(rosterReducer, INITIAL_ROSTER_STATE)
}

const tags = (set: ReadonlySet<string>) => [...set].sort()

describe('sorting', () => {
  it('gives a freshly chosen column its natural direction', () => {
    // `clanRank`, `name` and `owner` read best ascending; every stat reads highest-first.
    const byTrophies = after({ type: 'sorted', key: 'trophies' })
    assert.equal(byTrophies.sortKey, 'trophies')
    assert.equal(byTrophies.ascending, false)

    const byName = after({ type: 'sorted', key: 'name' })
    assert.equal(byName.sortKey, 'name')
    assert.equal(byName.ascending, true)
  })

  it('reverses the column that is already sorted rather than resetting it', () => {
    const twice = after({ type: 'sorted', key: 'trophies' }, { type: 'sorted', key: 'trophies' })
    assert.equal(twice.sortKey, 'trophies')
    assert.equal(twice.ascending, true)
  })

  it('returns to the first page, so a reorder cannot look like rows going missing', () => {
    const state = after({ type: 'paged', page: 3 }, { type: 'sorted', key: 'donations' })
    assert.equal(state.page, 1)
  })
})

describe('paging', () => {
  it('is the same state when the page has not moved, so a clamp can be dispatched blind', () => {
    const third = after({ type: 'paged', page: 3 })
    assert.equal(rosterReducer(third, { type: 'paged', page: 3 }), third)
  })
})

describe('filtering', () => {
  it('changes one filter and leaves the other two alone', () => {
    const state = after(
      { type: 'filtered', field: 'member', value: 'sam' },
      { type: 'filtered', field: 'townHall', value: '16' },
    )
    assert.deepEqual(state.filters, { member: 'sam', townHall: '16', owner: '' })
  })

  it('returns to the first page, since page 4 of a two-page list is an empty table', () => {
    const state = after({ type: 'paged', page: 4 }, { type: 'filtered', field: 'owner', value: 'Sam' })
    assert.equal(state.page, 1)
  })

  it('clears all three filters at once, and the page with them', () => {
    const state = after(
      { type: 'filtered', field: 'member', value: 'sam' },
      { type: 'filtered', field: 'townHall', value: '16' },
      { type: 'filtered', field: 'owner', value: 'Rae' },
      { type: 'paged', page: 2 },
      { type: 'filtersCleared' },
    )
    assert.deepEqual(state.filters, { member: '', townHall: '', owner: '' })
    assert.equal(state.page, 1)
  })
})

describe('selection', () => {
  it('toggles the row it is given and no other', () => {
    const two = after({ type: 'rowPicked', tag: '#A' }, { type: 'rowPicked', tag: '#B' })
    assert.deepEqual(tags(two.selected), ['#A', '#B'])
    assert.deepEqual(tags(rosterReducer(two, { type: 'rowPicked', tag: '#A' }).selected), ['#B'])
  })

  it('only ever touches the tags the header checkbox was given', () => {
    /* The header checkbox is page-scoped: whole-roster would silently select members
       the filter is hiding, which is the bug that made it page-scoped in the first
       place. So a tag selected on another page has to survive both directions. */
    const state = after(
      { type: 'rowPicked', tag: '#OFFPAGE' },
      { type: 'pagePicked', tags: ['#A', '#B'], selecting: true },
    )
    assert.deepEqual(tags(state.selected), ['#A', '#B', '#OFFPAGE'])

    const cleared = rosterReducer(state, {
      type: 'pagePicked',
      tags: ['#A', '#B'],
      selecting: false,
    })
    assert.deepEqual(tags(cleared.selected), ['#OFFPAGE'])
  })

  it('drops the pending approvals and the note along with the selection', () => {
    const state = after(
      { type: 'rowPicked', tag: '#A' },
      { type: 'writeSettled', note: '1 need approval below', pending: [conflict('#A', 'Rae')] },
      { type: 'approvalPicked', tag: '#A' },
      { type: 'selectionDropped' },
    )
    // All three described a selection that no longer exists.
    assert.deepEqual(tags(state.selected), [])
    assert.equal(state.conflicts, null)
    assert.equal(state.note, null)
  })

  it('keeps a failed write reported even after the selection is cleared', () => {
    // The failure is a fact about the server, not about what is ticked.
    const state = after(
      { type: 'rowPicked', tag: '#A' },
      { type: 'writeFailed', problem: 'Could not reach the server.' },
      { type: 'selectionDropped' },
    )
    assert.equal(state.problem, 'Could not reach the server.')
  })
})

describe('a bulk write', () => {
  it('clears the last failure when it starts', () => {
    const state = after(
      { type: 'writeFailed', problem: 'Could not apply that owner.' },
      { type: 'writeStarted' },
    )
    assert.equal(state.busy, true)
    assert.equal(state.problem, null)
  })

  it('leaves the previous note standing while it runs', () => {
    // It is still the last thing that actually happened, and blanking it would make
    // the panel flicker between a result and nothing on every apply.
    const state = after(
      { type: 'writeSettled', note: '2 updated', pending: [] },
      { type: 'writeStarted' },
    )
    assert.equal(state.note, '2 updated')
  })

  it('makes no claim about what happened when it fails', () => {
    const state = after(
      { type: 'writeStarted' },
      { type: 'writeFailed', problem: 'Could not apply that owner.' },
    )
    assert.equal(state.busy, false)
    assert.equal(state.note, null)
    assert.equal(state.problem, 'Could not apply that owner.')
  })

  it('releases the selection once nothing is left needing a decision', () => {
    const state = after(
      { type: 'rowPicked', tag: '#A' },
      { type: 'writeStarted' },
      { type: 'writeSettled', note: '1 updated', pending: [] },
    )
    assert.equal(state.busy, false)
    assert.equal(state.conflicts, null)
    assert.deepEqual(tags(state.selected), [])
  })

  it('keeps the selection while rows are still waiting on approval', () => {
    /* Those rows *are* the remaining work: untick them and the approval list would
       describe members the table no longer shows as chosen. */
    const state = after(
      { type: 'rowPicked', tag: '#A' },
      { type: 'rowPicked', tag: '#B' },
      { type: 'writeSettled', note: '1 need approval below', pending: [conflict('#B', 'Rae')] },
    )
    assert.deepEqual(tags(state.selected), ['#A', '#B'])
    assert.deepEqual(state.conflicts?.map((row) => row.tag), ['#B'])
  })

  it('starts every approval unticked, including a second round', () => {
    // Approving against a value the server has since replaced is the silent clobber
    // this whole flow exists to prevent, so consent never carries over.
    const state = after(
      { type: 'writeSettled', note: 'x', pending: [conflict('#A', 'Rae')] },
      { type: 'approvalPicked', tag: '#A' },
      { type: 'writeSettled', note: 'y', pending: [conflict('#A', 'Nia')] },
    )
    assert.deepEqual(tags(state.approved), [])
    assert.deepEqual(state.conflicts?.map((row) => row.currentOwner), ['Nia'])
  })
})

describe('approving overwrites', () => {
  const withConflicts: RosterAction = {
    type: 'writeSettled',
    note: '2 need approval below',
    pending: [conflict('#A', 'Rae'), conflict('#B', 'Nia')],
  }

  it('approves all when some are unticked, and none when every one is ticked', () => {
    const all = after(withConflicts, { type: 'approvalsToggled' })
    assert.deepEqual(tags(all.approved), ['#A', '#B'])
    assert.deepEqual(tags(rosterReducer(all, { type: 'approvalsToggled' }).approved), [])
  })

  it('keeps the selection when the approvals are canceled, so it can be retried', () => {
    const state = after(
      { type: 'rowPicked', tag: '#A' },
      withConflicts,
      { type: 'approvalPicked', tag: '#A' },
      { type: 'approvalsDropped' },
    )
    assert.equal(state.conflicts, null)
    assert.deepEqual(tags(state.approved), [])
    assert.deepEqual(tags(state.selected), ['#A'])
  })

  it('drops the selection when Apply is pressed with nothing approved', () => {
    // Every conflicting row keeps its owner, which is a decision, so the work is done.
    const state = after({ type: 'rowPicked', tag: '#A' }, withConflicts, {
      type: 'approvalsDeclined',
    })
    assert.equal(state.conflicts, null)
    assert.deepEqual(tags(state.selected), [])
    // Nothing was written, so the last note still describes what really happened.
    assert.equal(state.note, '2 need approval below')
  })
})

describe('the bulk owner', () => {
  it('is remembered across a write, so a second apply does not need re-picking', () => {
    const state = after(
      { type: 'bulkOwnerPicked', owner: 'Sam' },
      { type: 'writeSettled', note: '1 updated', pending: [] },
    )
    assert.equal(state.bulkOwner, 'Sam')
  })
})
