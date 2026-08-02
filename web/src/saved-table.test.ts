import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SavedClan } from './saved-clans.ts'
import {
  numberCompare,
  paginate,
  parseRowLimit,
  planOwnerChange,
  sortClanEntries,
  sortRosterRows,
  textCompare,
  type OwnableRow,
  type RosterRow,
} from './saved-table.ts'

/** A clan-roster row: the API's required member fields plus the local owner. */
const member = (over: Partial<RosterRow> & { tag: string; name: string }): RosterRow => ({
  role: 'member',
  townHallLevel: 1,
  expLevel: 1,
  trophies: 0,
  clanRank: 1,
  previousClanRank: 1,
  donations: 0,
  donationsReceived: 0,
  ...over,
})

const ROSTER: RosterRow[] = [
  member({ tag: '#AAA', name: 'darek', owner: 'Jared', trophies: 5200, clanRank: 1 }),
  member({ tag: '#BBB', name: 'Alt one', trophies: 900, clanRank: 4 }),
  member({ tag: '#CCC', name: 'Turtle', owner: 'Sam', trophies: 1800, clanRank: 2 }),
  member({ tag: '#DDD', name: 'Alt two', owner: 'Jared', trophies: 1200, clanRank: 3 }),
]

const names = (rows: OwnableRow[]) => rows.map((row) => row.name)

describe('textCompare / numberCompare', () => {
  it('sinks blank text to the bottom in both directions', () => {
    assert.equal(textCompare(undefined, 'Sam', true), 1)
    assert.equal(textCompare(undefined, 'Sam', false), 1)
    assert.equal(textCompare('Sam', '   ', true), -1)
    assert.equal(textCompare('Sam', '   ', false), -1)
    assert.equal(textCompare('', undefined, true), 0)
  })

  it('sinks unknown numbers to the bottom in both directions', () => {
    assert.equal(numberCompare(undefined, 5, true), 1)
    assert.equal(numberCompare(undefined, 5, false), 1)
    assert.equal(numberCompare(5, undefined, true), -1)
    assert.equal(numberCompare(5, undefined, false), -1)
    assert.equal(numberCompare(undefined, undefined, true), 0)
    // Direction still decides values that are actually present.
    assert.ok(numberCompare(1, 2, true) < 0)
    assert.ok(numberCompare(1, 2, false) > 0)
  })
})

describe('sortRosterRows', () => {
  it('groups by owner ascending with blanks last', () => {
    assert.deepEqual(names(sortRosterRows(ROSTER, 'owner', true)), [
      'Alt two',
      'darek',
      'Turtle',
      'Alt one',
    ])
  })

  it('keeps blanks last when the owner sort is reversed', () => {
    const sorted = sortRosterRows(ROSTER, 'owner', false)
    assert.equal(names(sorted).at(-1), 'Alt one', 'the ownerless row must stay at the bottom')
    assert.deepEqual(names(sorted).slice(0, 3), ['Turtle', 'Alt two', 'darek'])
  })

  it('orders stats highest-first when descending', () => {
    assert.deepEqual(names(sortRosterRows(ROSTER, 'trophies', false)), [
      'darek',
      'Turtle',
      'Alt two',
      'Alt one',
    ])
    assert.deepEqual(names(sortRosterRows(ROSTER, 'trophies', true)), [
      'Alt one',
      'Alt two',
      'Turtle',
      'darek',
    ])
  })

  it('breaks ties on name so ordering is stable', () => {
    const tied = [
      member({ tag: '#1', name: 'Zed', owner: 'Jared' }),
      member({ tag: '#2', name: 'Abe', owner: 'Jared' }),
    ]
    assert.deepEqual(names(sortRosterRows(tied, 'owner', true)), ['Abe', 'Zed'])
    assert.deepEqual(names(sortRosterRows(tied, 'owner', false)), ['Abe', 'Zed'])
  })

  it('does not mutate its input', () => {
    const before = names(ROSTER)
    sortRosterRows(ROSTER, 'name', false)
    assert.deepEqual(names(ROSTER), before)
  })
})

describe('planOwnerChange', () => {
  it('writes rows with no owner and defers rows that already have one', () => {
    const plan = planOwnerChange(ROSTER, 'Casey')

    assert.deepEqual(names(plan.toApply), ['Alt one'])
    assert.deepEqual(
      plan.conflicts.map((c) => [c.name, c.currentOwner, c.nextOwner]),
      [
        ['darek', 'Jared', 'Casey'],
        ['Turtle', 'Sam', 'Casey'],
        ['Alt two', 'Jared', 'Casey'],
      ],
    )
    assert.deepEqual(plan.unchanged, [])
  })

  it('treats a row that already matches as nothing to do', () => {
    const plan = planOwnerChange(ROSTER, 'Jared')
    assert.deepEqual(names(plan.unchanged), ['darek', 'Alt two'])
    assert.deepEqual(names(plan.toApply), ['Alt one'])
    assert.deepEqual(
      plan.conflicts.map((c) => c.name),
      ['Turtle'],
    )
  })

  it('requires approval to clear an existing owner', () => {
    const plan = planOwnerChange(ROSTER, '')

    assert.deepEqual(plan.toApply, [], 'clearing must never happen without approval')
    assert.deepEqual(
      plan.conflicts.map((c) => [c.name, c.nextOwner]),
      [
        ['darek', ''],
        ['Turtle', ''],
        ['Alt two', ''],
      ],
    )
    // The row that had no owner is already in the desired state.
    assert.deepEqual(names(plan.unchanged), ['Alt one'])
  })

  it('ignores surrounding whitespace on both sides of the comparison', () => {
    const padded = [member({ tag: '#1', name: 'A', owner: '  Jared  ' })]
    assert.deepEqual(planOwnerChange(padded, 'Jared ').unchanged.length, 1)
    assert.deepEqual(planOwnerChange(padded, 'Casey').conflicts.length, 1)
  })

  it('handles an empty selection', () => {
    const plan = planOwnerChange([], 'Casey')
    assert.deepEqual(plan, { toApply: [], conflicts: [], unchanged: [] })
  })

  it('accepts a bare tag/name/owner row and hands the caller its own objects back', () => {
    // The parameter type is the minimal ownable shape, so a full clan member and
    // a hand-rolled row both satisfy it — and the plan carries the caller's own
    // object, not a copy, so the caller can act on fields the planner never saw.
    const rows = [
      { tag: '#1', name: 'Fresh' },
      { tag: '#2', name: 'Taken', owner: 'Sam' },
    ]
    const plan = planOwnerChange(rows, 'Casey')

    assert.equal(plan.toApply.length, 1)
    assert.equal(plan.toApply.at(0), rows.at(0))
    assert.deepEqual(
      plan.conflicts.map((c) => [c.tag, c.currentOwner]),
      [['#2', 'Sam']],
    )
  })
})

/* ---------- saved clans ---------- */

const CLANS: SavedClan[] = [
  { tag: '#G88CYQP', name: 'Reddit', clanLevel: 26, members: 48, clanPoints: 42_000, warLeague: 'Crystal League I' },
  { tag: '#AAA1', name: 'zebra', clanLevel: 4, members: 12, clanPoints: 900 },
  { tag: '#BBB2', name: 'Anvil', clanLevel: 26, members: 3, clanPoints: 7_100, warLeague: 'Bronze League III' },
  { tag: '#CCC3', name: 'No stats yet' },
]

const clanNames = (entries: SavedClan[]) => entries.map((e) => e.name)

describe('sortClanEntries', () => {
  it('sorts names case-insensitively, A→Z', () => {
    assert.deepEqual(clanNames(sortClanEntries(CLANS, 'name', true)), [
      'Anvil',
      'No stats yet',
      'Reddit',
      'zebra',
    ])
  })

  it('keeps unknown numbers last in both directions', () => {
    // Only 'No stats yet' lacks clanPoints, so it stays at the bottom either way.
    assert.deepEqual(clanNames(sortClanEntries(CLANS, 'clanPoints', false)), [
      'Reddit',
      'Anvil',
      'zebra',
      'No stats yet',
    ])
    assert.deepEqual(clanNames(sortClanEntries(CLANS, 'clanPoints', true)), [
      'zebra',
      'Anvil',
      'Reddit',
      'No stats yet',
    ])
  })

  it('keeps a missing war league last in both directions', () => {
    const ascending = clanNames(sortClanEntries(CLANS, 'warLeague', true))
    const descending = clanNames(sortClanEntries(CLANS, 'warLeague', false))

    assert.deepEqual(ascending, ['Anvil', 'Reddit', 'No stats yet', 'zebra'])
    // Both leagueless rows stay at the bottom, in name order.
    assert.deepEqual(descending, ['Reddit', 'Anvil', 'No stats yet', 'zebra'])
  })

  it('breaks ties on name so equal levels never shuffle', () => {
    // Reddit and Anvil are both level 26, so the name tie-break decides them —
    // in the same order in both directions.
    assert.deepEqual(clanNames(sortClanEntries(CLANS, 'clanLevel', false)), [
      'Anvil',
      'Reddit',
      'zebra',
      'No stats yet',
    ])
    assert.deepEqual(clanNames(sortClanEntries(CLANS, 'clanLevel', true)), [
      'zebra',
      'Anvil',
      'Reddit',
      'No stats yet',
    ])
  })

  it('does not mutate its input', () => {
    const before = clanNames(CLANS)
    sortClanEntries(CLANS, 'members', false)
    assert.deepEqual(clanNames(CLANS), before)
  })
})

/* ---------- paging ---------- */

const ROWS = Array.from({ length: 7 }, (_, index) => index + 1)

describe('paginate', () => {
  it('returns the whole list, unpaged, for a limit of all', () => {
    const view = paginate(ROWS, 'all', 3)
    assert.deepEqual(view.rows, ROWS)
    assert.deepEqual(
      { page: view.page, pageCount: view.pageCount, from: view.from, to: view.to, total: view.total },
      { page: 1, pageCount: 1, from: 1, to: 7, total: 7 },
    )
  })

  it('treats a null limit the same as all', () => {
    assert.deepEqual(paginate(ROWS, null, 4), paginate(ROWS, 'all', 1))
  })

  it('reports zero bounds for an empty list', () => {
    assert.deepEqual(paginate([], 20, 1), {
      rows: [],
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
      total: 0,
    })
    // Even with no limit at all, there is no row 1 to point at.
    assert.deepEqual(paginate([], 'all', 1), {
      rows: [],
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
      total: 0,
    })
  })

  it('collapses to a single page when the limit exceeds the list', () => {
    const view = paginate(ROWS, 20, 1)
    assert.deepEqual(view.rows, ROWS)
    assert.equal(view.pageCount, 1)
    assert.equal(view.from, 1)
    assert.equal(view.to, 7)
  })

  it('slices a full first page', () => {
    const view = paginate(ROWS, 3, 1)
    assert.deepEqual(view.rows, [1, 2, 3])
    assert.deepEqual([view.from, view.to, view.pageCount], [1, 3, 3])
  })

  it('slices a short last page without padding it', () => {
    const view = paginate(ROWS, 3, 3)
    assert.deepEqual(view.rows, [7])
    assert.deepEqual([view.from, view.to, view.total], [7, 7, 7])
  })

  it('clamps a page past the end back to the last page', () => {
    const view = paginate(ROWS, 3, 99)
    assert.equal(view.page, 3, 'the returned page must be usable, not the stale request')
    assert.deepEqual(view.rows, [7])
    assert.notEqual(view.rows.length, 0, 'clamping must never land on an empty page')
  })

  it('clamps a page below the first', () => {
    for (const requested of [0, -5]) {
      const view = paginate(ROWS, 3, requested)
      assert.equal(view.page, 1)
      assert.deepEqual(view.rows, [1, 2, 3])
    }
  })

  it('clamps when rows are removed under a stale page number', () => {
    // Page 3 of 7 rows is valid; after deletions only one page is left.
    const shrunk = ROWS.slice(0, 2)
    const view = paginate(shrunk, 3, 3)
    assert.deepEqual(view.rows, shrunk)
    assert.deepEqual([view.page, view.pageCount, view.from, view.to], [1, 1, 1, 2])
  })

  it('covers every row exactly once across its pages', () => {
    const seen: number[] = []
    const first = paginate(ROWS, 2, 1)
    for (let page = 1; page <= first.pageCount; page += 1) {
      seen.push(...paginate(ROWS, 2, page).rows)
    }
    assert.deepEqual(seen, ROWS)
    assert.equal(first.pageCount, 4)
  })

  it('falls back to a single page for a nonsensical limit', () => {
    assert.deepEqual(paginate(ROWS, 0, 2).rows, ROWS)
    assert.deepEqual(paginate(ROWS, -1, 2).rows, ROWS)
  })

  it('survives a non-finite page number', () => {
    assert.deepEqual(paginate(ROWS, 3, Number.NaN).rows, [1, 2, 3])
  })
})

describe('parseRowLimit', () => {
  it('restores a stored number and the all sentinel', () => {
    assert.equal(parseRowLimit('50', 20), 50)
    assert.equal(parseRowLimit('all', 20), 'all')
  })

  it('falls back when nothing is stored or the value is junk', () => {
    assert.equal(parseRowLimit(null, 20), 20)
    assert.equal(parseRowLimit('', 5), 5)
    assert.equal(parseRowLimit('twenty', 5), 5)
    assert.equal(parseRowLimit('0', 5), 5)
    assert.equal(parseRowLimit('-10', 5), 5)
    assert.equal(parseRowLimit('2.5', 5), 5)
  })
})
