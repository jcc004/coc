import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ROLE_LABELS,
  type AdminUser,
  type Clan,
  type ClanMember,
  type OwnerRecord,
  type SessionUser,
} from '@coc/shared'
import { api } from '../api.ts'
import { labelIcon } from '../coc-assets.ts'
import { formatFull, formatStat, humanizeCamel, ratio } from '../format.ts'
import { hrefFor, useAsync, useRowLimit, useStackedTables, type Recent } from '../hooks.ts'
import {
  legacyOwnerCount,
  ownerCellFor,
  ownerOptions,
  parseOwnerChoice,
  type OwnerCell,
} from '../owner-picker.ts'
import { applyOwners, assignOwner, clearOwner, knownOwners, useOwnersState } from '../owners.ts'
import { removeClan, saveClan, useSavedClans } from '../saved-clans.ts'
import {
  filterRosterRows,
  hasRosterFilters,
  nextSortState,
  paginate,
  planOwnerChange,
  ROSTER_ASCENDING_BY_DEFAULT,
  rosterColumnLabel,
  ROSTER_COLUMNS,
  rosterTownHallLevels,
  sortRosterRows,
  UNASSIGNED_OWNER,
  type OwnerConflict,
  type RosterFilters,
  type RosterRow,
  type RosterSortKey,
} from '../saved-table.ts'
import { CapitalRaidsCard } from './CapitalRaidsCard.tsx'
import {
  Card,
  ErrorPanel,
  GameIcon,
  Loading,
  Meter,
  Pager,
  RowLimitSelect,
  SortControl,
  StatTile,
  TileRow,
  TownHallBadge,
} from './primitives.tsx'
import { TagButton } from './TagButton.tsx'

/** The bulk bar's suggestions: **account** display names, not labels in use. */

/**
 * The value the picker shows for a row whose owner is a pre-accounts label. It is
 * never submitted — the option carrying it is `disabled`, and `parseOwnerChoice`
 * refuses it a second time — it exists so the select can *show what is stored*.
 * Falling back to the empty option would draw a row that names somebody as "No
 * owner", which is the one thing the migration must not do: those 32 rows are the
 * only surviving record of who those bases belong to in real life.
 */
const LEGACY_VALUE = 'legacy'

/**
 * The owner as read-only text: what a non-admin gets, since assigning is an admin
 * decision and a control that always 403s is worse than no control.
 *
 * A member still **sees** the owner — that is the point of the column, and the rows
 * are shared and world-readable — including whether it is a real account. "not an
 * account" is not admin trivia to them either: it is why a base they might be
 * looking after is one they cannot type card counts into.
 */
function OwnerText({ cell }: { cell: OwnerCell }) {
  if (cell.kind === 'unassigned') return <span className="role-pill">—</span>
  if (cell.kind === 'account') return <>{cell.label}</>

  return (
    <span className="owner-legacy">
      {cell.label} <span className="owner-legacy__mark">not an account</span>
    </span>
  )
}

/**
 * The Owner cell for an admin: a select over accounts.
 *
 * A select rather than the old free-text box because the thing being chosen is an
 * account — `PUT /api/owners/:tag` takes a user id and nothing else — so typing a
 * name could only ever be guessed at, and a guess that misses becomes another
 * unlinked label. **No owner** is the first option and clears the assignment, which
 * has to stay possible.
 *
 * A legacy row is drawn distinctly three ways at once, none of them colour alone:
 * its stored label sits in the select as an unchoosable option that says *not an
 * account*, the control takes a `--warning` edge, and the line beneath names it as a
 * legacy label — with the account it most likely meant, where the fold in
 * `owner-picker.ts` finds exactly one. Confirming is still a click: the suggestion
 * is a prompt, never an assignment.
 *
 * Failures are reported in the cell that caused them, like every other row write
 * here, and the message is the server's own.
 */
function OwnerPicker({
  tag,
  name,
  cell,
  accounts,
}: {
  tag: string
  name: string
  cell: OwnerCell
  accounts: readonly AdminUser[]
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const current = cell.kind === 'account' ? { userId: cell.userId, label: cell.label } : undefined
  const options = ownerOptions(accounts, current)

  const value =
    cell.kind === 'account' ? String(cell.userId) : cell.kind === 'legacy' ? LEGACY_VALUE : ''

  async function choose(raw: string) {
    const choice = parseOwnerChoice(raw)
    // The legacy placeholder, or anything else this list never offered.
    if (choice === null) return

    setBusy(true)
    setProblem(null)
    try {
      if (choice.kind === 'clear') await clearOwner(tag)
      else await assignOwner(tag, choice.userId)
    } catch (cause) {
      // The server's wording, not ours: a 403 here says an admin assigns
      // ownership, which is the fact, and a 404 says the account is gone.
      setProblem(cause instanceof Error ? cause.message : `Could not set the owner of ${tag}.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="owner-cell">
      <select
        className={cell.kind === 'legacy' ? 'owner-cell__select--legacy' : undefined}
        value={value}
        disabled={busy}
        /* Named per row: `.section-title` and the column head are uppercased in
           CSS and Chrome derives a name from the *transformed* text, so pointing at
           the header would read "OWNER". The member's name is also what makes fifty
           of these tell each other apart. */
        aria-label={`Owner of ${name}`}
        onChange={(event) => void choose(event.target.value)}
      >
        <option value="">No owner</option>
        {cell.kind === 'legacy' ? (
          <option value={LEGACY_VALUE} disabled>
            {cell.label} — not an account
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.userId} value={String(option.userId)}>
            {option.label}
          </option>
        ))}
      </select>

      {cell.kind === 'legacy' ? (
        <p className="owner-cell__note">
          Legacy label
          {cell.suggestion ? (
            <>
              {' · likely '}
              <strong>{cell.suggestion.label}</strong>
            </>
          ) : (
            ' · no matching account'
          )}
        </p>
      ) : null}

      {problem ? <p className="owner-cell__problem">{problem}</p> : null}
    </div>
  )
}

function SaveToggle({ clan }: { clan: Clan }) {
  const saved = useSavedClans().some((entry) => entry.tag === clan.tag)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function toggle() {
    setBusy(true)
    setProblem(null)
    try {
      if (saved) {
        await removeClan(clan.tag)
      } else {
        await saveClan({
          tag: clan.tag,
          name: clan.name,
          clanLevel: clan.clanLevel,
          members: clan.members,
          warLeague: clan.warLeague?.name,
          clanPoints: clan.clanPoints,
        })
      }
    } catch (cause) {
      // The list is shared and the write goes to the server, so a failure must
      // not leave the star looking as though it stuck.
      setProblem(cause instanceof Error ? cause.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="icon-button"
        style={{ marginBottom: 10 }}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? '…' : saved ? '★ Saved' : '☆ Save'}
      </button>
      {problem ? <p className="notice__hint">{problem}</p> : null}
    </>
  )
}

function RosterTable({ members, user }: { members: ClanMember[]; user: SessionUser }) {
  const ownersState = useOwnersState()
  const owners = ownersState.entries
  const stacked = useStackedTables()

  /*
   * Every owner write is admin-only on the server, so the controls for them are
   * admin-only here. Not as a second layer of enforcement — the server is the lock —
   * but because offering a member a control whose only possible outcome is a 403 is
   * a lie told at the moment of clicking.
   */
  const isAdmin = user.role === 'admin'

  /*
   * The accounts the picker offers. `GET /api/admin/users` is admin-only, so it is
   * simply **not requested** for anyone else — `useAsync(null)` stays idle, which is
   * what keeps a member's session from firing a request that would 403 in the
   * network log and tell them nothing.
   */
  const accountsState = useAsync(isAdmin ? (signal) => api.users(signal) : null, [isAdmin])
  const accounts = useMemo<AdminUser[]>(
    () => (accountsState.status === 'ready' ? accountsState.data.users : []),
    [accountsState],
  )

  const [sortKey, setSortKey] = useState<RosterSortKey>('clanRank')
  const [ascending, setAscending] = useState(true)
  const [limit, setLimit] = useRowLimit('coc:rosterLimit', 10)
  const [page, setPage] = useState(1)
  const [thFilter, setThFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [memberFilter, setMemberFilter] = useState('')
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [bulkOwner, setBulkOwner] = useState('')
  const [conflicts, setConflicts] = useState<OwnerConflict[] | null>(null)
  const [approvedTags, setApprovedTags] = useState<Set<string>>(new Set())
  const [applyNote, setApplyNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const selectAllRef = useRef<HTMLInputElement>(null)

  const ownerNames = useMemo(() => knownOwners(), [owners])

  // Server conflicts arrive carrying only a tag, so the roster supplies the name.
  const nameByTag = useMemo(
    () => new Map(members.map((member) => [member.tag, member.name])),
    [members],
  )

  /*
   * The assignments this roster's members have, by tag. The *whole record*, not just
   * the label: the Owner cell has to know whether a row points at an account or is
   * one of the pre-accounts labels, and only `ownerUserId` answers that.
   */
  const ownerByTag = useMemo(() => {
    const wanted = new Set(members.map((member) => member.tag))
    return new Map<string, OwnerRecord>(
      owners.filter((entry) => wanted.has(entry.tag)).map((entry) => [entry.tag, entry]),
    )
  }, [members, owners])

  /** How much of the migration is still outstanding in *this* clan. */
  const legacyHere = useMemo(() => legacyOwnerCount([...ownerByTag.values()]), [ownerByTag])

  // Owner is an annotation keyed by tag, so the roster is the API's member list
  // joined against the store whenever either side changes. The row carries the
  // label, because that is what sorts and what the Owner filter matches.
  const rows = useMemo<RosterRow[]>(
    () => members.map((member) => ({ ...member, owner: ownerByTag.get(member.tag)?.owner })),
    [members, ownerByTag],
  )

  /** Town Hall levels actually present, so the filter never offers an empty result. */
  const thLevels = useMemo(() => rosterTownHallLevels(rows), [rows])

  const filters = useMemo<RosterFilters>(
    () => ({ townHall: thFilter, owner: ownerFilter, member: memberFilter }),
    [thFilter, ownerFilter, memberFilter],
  )

  const filtered = useMemo(() => filterRosterRows(rows, filters), [rows, filters])

  const ordered = useMemo(
    () => sortRosterRows(filtered, sortKey, ascending),
    [filtered, sortKey, ascending],
  )

  const view = useMemo(() => paginate(ordered, limit, page), [ordered, limit, page])

  // Landing on a page past the end after filtering or a deletion would show an
  // empty table; `paginate` clamps, and this puts the control back in step.
  useEffect(() => {
    if (view.page !== page) setPage(view.page)
  }, [view.page, page])

  const filtersActive = hasRosterFilters(filters)

  /*
   * Page-scoped, like the saved tables: the header checkbox may only ever tick
   * rows that are on screen. It used to mean the whole roster, which was safe
   * only while the table was unpaged and unfiltered — now that it is both,
   * whole-roster would silently select members the filter is hiding.
   */
  const pageTags = useMemo(() => new Set(view.rows.map((row) => row.tag)), [view.rows])
  const selected = useMemo(
    () => rows.filter((row) => selectedTags.has(row.tag)),
    [rows, selectedTags],
  )
  const selectedOnPage = useMemo(
    () => view.rows.filter((row) => selectedTags.has(row.tag)).length,
    [view.rows, selectedTags],
  )
  const offPage = selected.length - selectedOnPage
  const allSelected = view.rows.length > 0 && selectedOnPage === view.rows.length

  // The donation bar is a magnitude comparison within this roster, so it scales
  // to the clan's top donor rather than to some absolute ceiling.
  const topDonations = useMemo(
    () => members.reduce((max, member) => Math.max(max, member.donations), 0),
    [members],
  )

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedOnPage > 0 && !allSelected
    }
  }, [selectedOnPage, allSelected])

  function toggleSort(key: RosterSortKey) {
    // Back to page 1: keeping the offset would land you in the middle of a
    // freshly reordered list, which reads as rows having gone missing.
    setPage(1)
    const next = nextSortState({ key: sortKey, ascending }, key, ROSTER_ASCENDING_BY_DEFAULT)
    setSortKey(next.key)
    setAscending(next.ascending)
  }

  function toggleSelected(tag: string) {
    setSelectedTags((current) => {
      const next = new Set(current)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  /** Adds or removes only this page's rows, leaving any off-page selection alone. */
  function toggleSelectAll() {
    setSelectedTags((current) => {
      const next = new Set(current)
      for (const tag of pageTags) {
        if (allSelected) next.delete(tag)
        else next.add(tag)
      }
      return next
    })
  }

  /**
   * Applies the owner to every selected member that this browser believes has
   * none, and defers the rest to an explicit per-row approval step. Clearing (an
   * empty owner box) is destructive too, so it takes the same route.
   *
   * The data is shared, so there is a second source of conflict beyond the ones
   * `planOwnerChange` can see: somebody else may have set an owner since this page
   * loaded. Each row therefore carries the value this tab believes is stored, and
   * the server refuses any row where that no longer holds. Those refusals join the
   * locally-known conflicts in the very same approval list, now showing the real
   * current value.
   */
  async function applyOwnerToSelected() {
    const plan = planOwnerChange(selected, bulkOwner)
    const next = bulkOwner.trim()

    setBusy(true)
    setProblem(null)
    try {
      // `expectedOwner: ''` is the assertion "I believe nobody owns this".
      const rows = plan.toApply.map((row) => ({ tag: row.tag, owner: next, expectedOwner: '' }))
      const result = rows.length > 0 ? await applyOwners(rows) : null

      const stale: OwnerConflict[] = (result?.conflicts ?? []).map((conflict) => ({
        tag: conflict.tag,
        name: nameByTag.get(conflict.tag) ?? conflict.tag,
        currentOwner: conflict.currentOwner,
        nextOwner: next,
      }))

      const pending = [...plan.conflicts, ...stale]
      const written = (result?.applied.length ?? 0) + (result?.cleared.length ?? 0)

      const notes: string[] = []
      if (written > 0) notes.push(`${written} updated`)
      if (plan.unchanged.length > 0) notes.push(`${plan.unchanged.length} already matched`)
      if (pending.length > 0) notes.push(`${pending.length} need approval below`)
      setApplyNote(notes.length > 0 ? notes.join(' · ') : 'Nothing selected.')

      setConflicts(pending.length > 0 ? pending : null)
      setApprovedTags(new Set())
      if (pending.length === 0) setSelectedTags(new Set())
    } catch (cause) {
      // Nothing is claimed to have happened, because it may well not have.
      setApplyNote(null)
      setProblem(cause instanceof Error ? cause.message : 'Could not apply that owner.')
    } finally {
      setBusy(false)
    }
  }

  async function commitApprovedOverwrites() {
    const approved = (conflicts ?? []).filter((conflict) => approvedTags.has(conflict.tag))
    if (approved.length === 0) {
      setConflicts(null)
      setApprovedTags(new Set())
      setSelectedTags(new Set())
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      // The approval was given against `currentOwner`, so that is what the write
      // is conditional on — approving a value and then overwriting a *different*
      // one would be exactly the silent clobber this flow exists to prevent.
      const result = await applyOwners(
        approved.map((conflict) => ({
          tag: conflict.tag,
          owner: conflict.nextOwner,
          expectedOwner: conflict.currentOwner,
        })),
      )

      const rejected: OwnerConflict[] = result.conflicts.map((conflict) => ({
        tag: conflict.tag,
        name: nameByTag.get(conflict.tag) ?? conflict.tag,
        currentOwner: conflict.currentOwner,
        nextOwner:
          approved.find((row) => row.tag === conflict.tag)?.nextOwner ?? '',
      }))

      const written = result.applied.length + result.cleared.length
      const kept = (conflicts?.length ?? 0) - approved.length

      setApplyNote(
        rejected.length > 0
          ? `${written} overwritten · ${kept} kept as-is · ${rejected.length} changed again while you were deciding — approve below against the new value`
          : `${written} overwritten · ${kept} kept as-is`,
      )
      // A rejected row goes straight back into the list, now showing what is
      // really stored, so the decision is made against the truth.
      setConflicts(rejected.length > 0 ? rejected : null)
      setApprovedTags(new Set())
      if (rejected.length === 0) setSelectedTags(new Set())
    } catch (cause) {
      setApplyNote(null)
      setProblem(cause instanceof Error ? cause.message : 'Could not apply those changes.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {selected.length > 0 ? (
        <div className="bulk-bar">
          {/* Off-page counted separately: with filters and paging, a selection can
              include members you cannot currently see, and a bulk apply would
              still hit them. */}
          <span className="bulk-bar__count">
            {selected.length} selected
            {offPage > 0 ? ` · ${offPage} not shown` : ''}
          </span>
          {/*
             A select over accounts, not a text box.

             It used to be free text with a `datalist` of names already in use — which
             constrained nothing (a datalist only suggests) and *offered* the legacy
             labels, so the quickest way to create a brand-new unlinked owner was to
             accept one of its own suggestions. The server stores unmatched text with
             no `ownerUserId`, so that produced a base whose owner names a person and
             grants nobody anything, including the right to edit its card counts.

             Same options as the per-row picker, from the same `ownerOptions` call, so
             the two controls cannot disagree about who may own a base. The value is
             still the display name because `POST /api/owners/bulk` takes text — but it
             is now always an exact account name, which is what makes the server's
             lookup resolve instead of falling back to a label.
          */}
          <select
            value={bulkOwner}
            onChange={(event) => setBulkOwner(event.target.value)}
            aria-label="Owner to apply to selected members"
          >
            <option value="">No owner (clear)</option>
            {ownerOptions(accounts).map((option) => (
              <option key={option.userId} value={option.label}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void applyOwnerToSelected()} disabled={busy}>
            {busy ? 'Applying…' : 'Apply to selected'}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setSelectedTags(new Set())
              setConflicts(null)
              setApplyNote(null)
            }}
          >
            Clear selection
          </button>
        </div>
      ) : null}

      {applyNote ? <p className="notice__hint">{applyNote}</p> : null}

      {/* A write that failed must never be left looking like one that worked. */}
      {problem ? (
        <div className="notice notice--error">
          <p className="notice__body">{problem}</p>
        </div>
      ) : null}

      {ownersState.status === 'error' && !problem ? (
        <div className="notice notice--error">
          <p className="notice__body">
            Could not load owners — the column below may be out of date.{' '}
            {ownersState.error?.message}
          </p>
        </div>
      ) : null}

      {conflicts ? (
        <div className="notice">
          <p className="notice__title">Confirm overwriting existing owners</p>
          <p className="notice__body">
            These members already have an owner. Approve each one you want changed — anything left
            unchecked keeps its current owner.
          </p>
          <ul className="conflict-list">
            {conflicts.map((conflict) => (
              <li key={conflict.tag}>
                <label>
                  <input
                    type="checkbox"
                    checked={approvedTags.has(conflict.tag)}
                    onChange={() =>
                      setApprovedTags((current) => {
                        const next = new Set(current)
                        if (next.has(conflict.tag)) next.delete(conflict.tag)
                        else next.add(conflict.tag)
                        return next
                      })
                    }
                  />
                  <span>
                    <strong>{conflict.name}</strong>{' '}
                    <span className="tag-cell">{conflict.tag}</span> — owner{' '}
                    <strong>{conflict.currentOwner}</strong> →{' '}
                    <strong>{conflict.nextOwner || '(cleared)'}</strong>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="conflict-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() =>
                setApprovedTags(
                  approvedTags.size === conflicts.length
                    ? new Set()
                    : new Set(conflicts.map((conflict) => conflict.tag)),
                )
              }
            >
              {approvedTags.size === conflicts.length ? 'Approve none' : 'Approve all'}
            </button>
            <button
              type="button"
              onClick={() => void commitApprovedOverwrites()}
              disabled={busy}
            >
              {busy ? 'Applying…' : `Apply ${approvedTags.size} approved`}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setConflicts(null)
                setApprovedTags(new Set())
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="roster-filters">
        <label htmlFor="roster-member">
          Member
          <input
            id="roster-member"
            value={memberFilter}
            onChange={(event) => {
              setMemberFilter(event.target.value)
              setPage(1)
            }}
            placeholder="Search name"
            autoComplete="off"
          />
        </label>

        <label htmlFor="roster-th">
          TH
          <select
            id="roster-th"
            value={thFilter}
            onChange={(event) => {
              setThFilter(event.target.value)
              setPage(1)
            }}
          >
            <option value="">All</option>
            {thLevels.map((level) => (
              <option key={level} value={String(level)}>
                {level}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor="roster-owner">
          Owner
          <select
            id="roster-owner"
            value={ownerFilter}
            onChange={(event) => {
              setOwnerFilter(event.target.value)
              setPage(1)
            }}
          >
            <option value="">All</option>
            <option value={UNASSIGNED_OWNER}>Unassigned</option>
            {ownerNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {filtersActive ? (
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setThFilter('')
              setOwnerFilter('')
              setMemberFilter('')
              setPage(1)
            }}
          >
            Clear filters
          </button>
        ) : null}

        {filtersActive ? (
          <span className="role-pill">
            {filtered.length} of {rows.length} members
          </span>
        ) : null}
      </div>

      {/* Stacked, the column heads are hidden, so the Sort control is the visible
          way to reorder. Rendered instead of the head buttons rather than
          alongside them — see `useStackedTables`. */}
      {stacked ? (
        <SortControl
          id="roster-sort"
          columns={ROSTER_COLUMNS}
          sortKey={sortKey}
          ascending={ascending}
          onSort={toggleSort}
        />
      ) : null}

      {/*
       * `roster--stack` turns this into one labelled card per member at tablet
       * width and below. Stacking changes `display`, which strips a table's
       * semantics from the accessibility tree, so every element here carries the
       * role it would have had — see the note in styles.css.
       */}
      <div className="table-wrap">
        <table className="roster roster--stack" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th className="select-cell" role="columnheader">
                <label className="select-hit">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label={`Select the ${view.rows.length} members on this page`}
                    title={`Select the ${view.rows.length} members on this page`}
                  />
                </label>
              </th>
              {ROSTER_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className={column.numeric ? 'num' : undefined}
                  role="columnheader"
                  /* Carries the sort state whichever control set it, so the table
                     reports its own ordering rather than leaving it to the button. */
                  aria-sort={
                    sortKey === column.key ? (ascending ? 'ascending' : 'descending') : 'none'
                  }
                >
                  {stacked ? (
                    column.label
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      aria-label={`Sort by ${column.label}`}
                    >
                      {column.label}
                      {sortKey === column.key ? (
                        <span className="sort-caret"> {ascending ? '↑' : '↓'}</span>
                      ) : null}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.rows.map((row) => (
              <tr key={row.tag} role="row">
                <td className="select-cell" role="cell" data-label="Select">
                  <label className="select-hit">
                    <input
                      type="checkbox"
                      checked={selectedTags.has(row.tag)}
                      onChange={() => toggleSelected(row.tag)}
                      aria-label={`Select ${row.name}`}
                    />
                  </label>
                </td>
                <td className="num" role="cell" data-label={rosterColumnLabel('clanRank')}>
                  {row.clanRank}
                </td>
                {/* The card's heading when stacked, so it takes no `data-label`. */}
                <td className="stack-title" role="cell">
                  <a href={hrefFor({ view: 'player', tag: row.tag })}>{row.name}</a>{' '}
                  <span className="role-pill">{ROLE_LABELS[row.role]}</span>
                </td>
                {/*
                 * An admin gets the picker, everybody else the label.
                 *
                 * This cell used to print `row.owner` — the raw stored text — for
                 * everyone, which is how two people came to disagree about who owns a
                 * base: an account-linked owner and a pre-accounts label look identical
                 * as bare text, and only the first grants its owner the right to edit
                 * that base's card counts. `ownerCellFor` draws the distinction, and
                 * both components below render it rather than restating it.
                 *
                 * `accounts` is empty for a non-admin, which `ownerCellFor` handles: the
                 * label comes from the assignment and is readable by anyone, so an empty
                 * list costs only the "did you mean this account" suggestion.
                 */}
                <td role="cell" data-label={rosterColumnLabel('owner')}>
                  {isAdmin ? (
                    <OwnerPicker
                      tag={row.tag}
                      name={row.name}
                      cell={ownerCellFor(ownerByTag.get(row.tag), accounts)}
                      accounts={accounts}
                    />
                  ) : (
                    <OwnerText cell={ownerCellFor(ownerByTag.get(row.tag), accounts)} />
                  )}
                </td>
                {/* Badge only — sorting still reads `row.townHallLevel`, untouched. */}
                <td className="num" role="cell" data-label={rosterColumnLabel('townHallLevel')}>
                  <TownHallBadge level={row.townHallLevel} />
                </td>
                <td className="num" role="cell" data-label={rosterColumnLabel('trophies')}>
                  {formatFull(row.trophies)}
                </td>
                <td className="num" role="cell" data-label={rosterColumnLabel('donations')}>
                  <div className="donation-cell">
                    <span title={`${ratio(row.donations, row.donationsReceived)} donated/received`}>
                      {formatFull(row.donations)}
                    </span>
                    <Meter
                      value={row.donations}
                      max={topDonations}
                      label={`${row.name} donated ${row.donations}`}
                    />
                  </div>
                </td>
                <td className="num" role="cell" data-label={rosterColumnLabel('donationsReceived')}>
                  {formatFull(row.donationsReceived)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.rows.length === 0 ? (
        <p className="empty-hint">No members match those filters.</p>
      ) : null}

      {/* Under the table, beside the pager: the two controls answer the same
          question ("what am I looking at, and how do I see the rest"), and the
          count is what you reach for once you have scrolled to the bottom. */}
      <div className="roster-footer">
        <RowLimitSelect
          id="roster-rows"
          options={[5, 10, 20, 50]}
          value={limit}
          onChange={(next) => {
            setLimit(next)
            setPage(1)
          }}
        />
        <Pager view={view} noun="members" onPage={setPage} />
      </div>
    </>
  )
}

export function ClanView({
  tag,
  user,
  onLoaded,
}: {
  tag: string
  /** Assigning an owner is admin-only, so the roster needs the signed-in user. */
  user: SessionUser
  onLoaded: (entry: Recent) => void
}) {
  const state = useAsync<Clan>((signal) => api.clan(tag, signal), [tag])

  const clan = state.status === 'ready' ? state.data : null
  useEffect(() => {
    if (clan) onLoaded({ kind: 'clan', tag: clan.tag, name: clan.name })
  }, [clan, onLoaded])

  if (state.status === 'loading') return <Loading what={`clan ${tag}`} />
  if (state.status === 'error') return <ErrorPanel error={state.error} />
  if (!clan) return null

  const warRecord = clan.isWarLogPublic
    ? `${formatFull(clan.warWins)}W · ${formatFull(clan.warTies ?? 0)}T · ${formatFull(clan.warLosses ?? 0)}L`
    : `${formatFull(clan.warWins)} wins`

  return (
    <>
      <Card>
        <div className="profile">
          <img className="profile__badge" src={clan.badgeUrls.medium} alt="" />
          <div className="profile__main">
            <h1 className="profile__name">{clan.name}</h1>
            <TagButton tag={clan.tag} />
            <div className="profile__meta">
              <span>Level {clan.clanLevel}</span>
              <span>· {clan.members}/50 members</span>
              <span>· {clan.type === 'inviteOnly' ? 'Invite only' : clan.type}</span>
              {clan.location ? <span>· {clan.location.name}</span> : null}
              {clan.warLeague ? <span>· {clan.warLeague.name}</span> : null}
            </div>
            {clan.labels.length > 0 ? (
              <div className="recents" style={{ marginTop: 10 }}>
                {clan.labels.map((label) => (
                  <span key={label.id} className="chip chip--static">
                    <GameIcon
                      src={labelIcon(label.id, label.iconUrls.small)}
                      fallback={label.iconUrls.small}
                    />
                    {label.name}
                  </span>
                ))}
              </div>
            ) : null}
            {clan.description ? <p className="profile__description">{clan.description}</p> : null}
          </div>

          <div className="hero-figure">
            <div className="hero-figure__actions">
              <SaveToggle clan={clan} />
              <a
                className="icon-button"
                style={{ display: 'inline-block', marginBottom: 10 }}
                href={hrefFor({ view: 'war', tag: clan.tag })}
              >
                ⚔ War
              </a>
            </div>
            <div className="hero-figure__value" title={formatFull(clan.clanPoints)}>
              {formatStat(clan.clanPoints)}
            </div>
            <div className="hero-figure__label">Clan points</div>
          </div>
        </div>
      </Card>

      <TileRow>
        <StatTile
          label="War record"
          value={warRecord}
          note={clan.isWarLogPublic ? undefined : 'War log is private'}
        />
        <StatTile
          label="War win streak"
          value={clan.warWinStreak}
          note={clan.warWinStreak > 0 ? 'on a streak' : undefined}
          noteTone={clan.warWinStreak > 0 ? 'good' : undefined}
        />
        <StatTile label="War frequency" value={humanizeCamel(clan.warFrequency)} />
        <StatTile label="Required trophies" value={clan.requiredTrophies} />
        <StatTile
          label="Capital points"
          value={clan.clanCapitalPoints}
          note={
            clan.clanCapital?.capitalHallLevel
              ? `Capital Hall ${clan.clanCapital.capitalHallLevel}`
              : undefined
          }
        />
        <StatTile label="Builder base points" value={clan.clanBuilderBasePoints} />
      </TileRow>

      <Card title={`Roster · ${clan.memberList.length} members`}>
        <RosterTable members={clan.memberList} user={user} />
      </Card>

      <CapitalRaidsCard tag={clan.tag} />
    </>
  )
}
