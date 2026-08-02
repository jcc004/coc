import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SavedClan } from './saved-clans.ts'
import {
  clanColumnLabel,
  CLAN_ASCENDING_BY_DEFAULT,
  CLAN_COLUMNS,
  CLAN_DESCENDING_BY_DEFAULT,
  nextSortState,
  ROSTER_ASCENDING_BY_DEFAULT,
  sortOptionLabel,
  filterRosterRows,
  hasRosterFilters,
  NO_ROSTER_FILTERS,
  ROSTER_COLUMNS,
  rosterColumnLabel,
  rosterTownHallLevels,
  UNASSIGNED_OWNER,
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

/* ---------- roster filters ---------- */

const FILTER_ROSTER: RosterRow[] = [
  member({ tag: '#A', name: 'darek', townHallLevel: 18, owner: 'Jared' }),
  member({ tag: '#B', name: 'Turtle', townHallLevel: 12, owner: 'Sam' }),
  member({ tag: '#C', name: 'Alt one', townHallLevel: 12 }),
  member({ tag: '#D', name: 'DAREK II', townHallLevel: 18, owner: 'Jared' }),
  member({ tag: '#E', name: 'Blank owner', townHallLevel: 9, owner: '  ' }),
]

const filterNames = (rows: RosterRow[]) => rows.map((r) => r.name)

describe('filterRosterRows', () => {
  it('returns everything when no filter is set', () => {
    assert.deepEqual(filterRosterRows(FILTER_ROSTER, NO_ROSTER_FILTERS), FILTER_ROSTER)
    assert.equal(hasRosterFilters(NO_ROSTER_FILTERS), false)
  })

  it('filters by Town Hall level', () => {
    const rows = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, townHall: '12' })
    assert.deepEqual(filterNames(rows), ['Turtle', 'Alt one'])
  })

  it('filters by exact owner', () => {
    const rows = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, owner: 'Jared' })
    assert.deepEqual(filterNames(rows), ['darek', 'DAREK II'])
  })

  it('treats absent and whitespace-only owners as unassigned', () => {
    const rows = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, owner: UNASSIGNED_OWNER })
    assert.deepEqual(filterNames(rows), ['Alt one', 'Blank owner'])
  })

  it('matches the member name case-insensitively, as a substring', () => {
    const rows = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, member: 'dar' })
    assert.deepEqual(filterNames(rows), ['darek', 'DAREK II'])
    // Surrounding whitespace in the box must not change the result.
    assert.deepEqual(
      filterNames(filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, member: '  dar  ' })),
      ['darek', 'DAREK II'],
    )
  })

  it('ANDs the filters together', () => {
    const rows = filterRosterRows(FILTER_ROSTER, { townHall: '18', owner: 'Jared', member: 'ii' })
    assert.deepEqual(filterNames(rows), ['DAREK II'])
  })

  it('can legitimately match nothing', () => {
    assert.deepEqual(filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, member: 'zzz' }), [])
    // Which is what the table's own empty state exists for.
    assert.equal(hasRosterFilters({ ...NO_ROSTER_FILTERS, member: 'zzz' }), true)
  })

  it('does not mutate its input', () => {
    const before = filterNames(FILTER_ROSTER)
    filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, townHall: '18' })
    assert.deepEqual(filterNames(FILTER_ROSTER), before)
  })

  it('reports whitespace-only member text as no filter at all', () => {
    // Otherwise the "N of M" badge and Clear button would appear for a stray space.
    assert.equal(hasRosterFilters({ ...NO_ROSTER_FILTERS, member: '   ' }), false)
  })
})

describe('rosterTownHallLevels', () => {
  it('lists the levels present, highest first, without duplicates', () => {
    assert.deepEqual(rosterTownHallLevels(FILTER_ROSTER), [18, 12, 9])
  })

  it('is empty for an empty roster', () => {
    assert.deepEqual(rosterTownHallLevels([]), [])
  })
})

describe('rosterColumnLabel / clanColumnLabel', () => {
  it('returns the same text the column header shows', () => {
    assert.equal(rosterColumnLabel('townHallLevel'), 'TH')
    assert.equal(rosterColumnLabel('donationsReceived'), 'Received')
    assert.equal(clanColumnLabel('clanPoints'), 'Points')
    assert.equal(clanColumnLabel('warLeague'), 'War league')
  })

  /* The stacked phone layout prints these instead of a column head, so every
     column must resolve — a missing one would leave a cell unlabelled. */
  it('covers every column both tables declare', () => {
    for (const column of ROSTER_COLUMNS) {
      assert.equal(rosterColumnLabel(column.key), column.label)
    }
    for (const column of CLAN_COLUMNS) {
      assert.equal(clanColumnLabel(column.key), column.label)
    }
  })
})

describe('nextSortState', () => {
  it('reverses the column that is already sorted, whichever way it was running', () => {
    assert.deepEqual(nextSortState({ key: 'name', ascending: true }, 'name', ['name']), {
      key: 'name',
      ascending: false,
    })
    assert.deepEqual(nextSortState({ key: 'name', ascending: false }, 'name', ['name']), {
      key: 'name',
      ascending: true,
    })
  })

  /* The direction a fresh column starts in is the whole reason this is shared:
     picking one must not inherit the direction of the column you left. */
  it('gives a fresh column its own natural direction, not the previous one', () => {
    assert.deepEqual(
      nextSortState({ key: 'trophies', ascending: false }, 'name', ROSTER_ASCENDING_BY_DEFAULT),
      { key: 'name', ascending: true },
    )
    assert.deepEqual(
      nextSortState({ key: 'name', ascending: true }, 'trophies', ROSTER_ASCENDING_BY_DEFAULT),
      { key: 'trophies', ascending: false },
    )
  })

  it('leaves the roster ordered as it was before the two tables shared this', () => {
    // clanRank / name / owner ascend; every stat opens highest-first.
    for (const column of ROSTER_COLUMNS) {
      const { ascending } = nextSortState(
        { key: 'expLevel' as never, ascending: true },
        column.key,
        ROSTER_ASCENDING_BY_DEFAULT,
      )
      assert.equal(ascending, ROSTER_ASCENDING_BY_DEFAULT.includes(column.key), column.key)
    }
  })

  it('keeps the saved-clans defaults the inverse of the descending list', () => {
    for (const column of CLAN_COLUMNS) {
      const { ascending } = nextSortState(
        { key: 'tag' as const, ascending: false },
        column.key,
        CLAN_ASCENDING_BY_DEFAULT,
      )
      assert.equal(ascending, !CLAN_DESCENDING_BY_DEFAULT.includes(column.key), column.key)
    }
  })

  it('derives the ascending list so it cannot disagree with the descending one', () => {
    assert.deepEqual(
      [...CLAN_ASCENDING_BY_DEFAULT].sort(),
      ['name', 'tag', 'warLeague'],
      'every clan column is in exactly one of the two lists',
    )
  })
})

describe('sortOptionLabel', () => {
  it('spells out the abbreviated headings, which have no column to explain them', () => {
    assert.equal(sortOptionLabel({ key: 'clanRank', label: '#', numeric: true, long: 'Clan rank' }), 'Clan rank')
    assert.equal(sortOptionLabel({ key: 'trophies', label: 'Trophies', numeric: true }), 'Trophies')
  })

  it('never returns a label too short to read on its own', () => {
    for (const column of [...ROSTER_COLUMNS, ...CLAN_COLUMNS]) {
      assert.ok(
        sortOptionLabel(column).length >= 3,
        `${column.key} reads as "${sortOptionLabel(column)}" in the Sort menu`,
      )
    }
  })
})

describe('filters compose with paging', () => {
  it('pages the filtered set, not the whole roster', () => {
    const filtered = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, townHall: '12' })
    const view = paginate(filtered, 1, 2)
    assert.equal(view.total, 2, 'total reflects the filter, not the 5-row roster')
    assert.equal(view.pageCount, 2)
    assert.deepEqual(filterNames(view.rows), ['Alt one'])
  })

  it('clamps to page 1 when a filter shrinks the set below the current page', () => {
    const filtered = filterRosterRows(FILTER_ROSTER, { ...NO_ROSTER_FILTERS, member: 'dar' })
    const view = paginate(filtered, 20, 3)
    assert.equal(view.page, 1)
    assert.deepEqual(filterNames(view.rows), ['darek', 'DAREK II'])
  })
})
