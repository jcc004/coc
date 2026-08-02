import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { isValidTag, normalizeTag, usesCanonicalAlphabet } from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { formatFull } from '../format.ts'
import { hrefFor, navigate, useRowLimit } from '../hooks.ts'
import {
  knownOwners,
  removePlayer,
  savePlayer,
  updatePlayer,
  useSavedPlayers,
  type SavedPlayer,
} from '../saved.ts'
import {
  COLUMNS,
  DESCENDING_BY_DEFAULT,
  paginate,
  planOwnerChange,
  sortEntries,
  type OwnerConflict,
  type RowLimit,
  type SortKey,
} from '../saved-table.ts'
import { Pager, RowLimitSelect } from './primitives.tsx'

const OWNER_LIST_ID = 'known-owners'

const LIMIT_KEY = 'coc:saved:limit'
const LIMIT_OPTIONS: RowLimit[] = [20, 50, 'all']

async function refreshOne(entry: SavedPlayer): Promise<void> {
  const player = await api.player(entry.tag)
  savePlayer({
    tag: player.tag,
    name: player.name,
    custom: entry.custom,
    clanTag: player.clan?.tag,
    clanName: player.clan?.name,
    townHallLevel: player.townHallLevel,
    trophies: player.trophies,
  })
}

function OwnerDatalist({ owners }: { owners: string[] }) {
  return (
    <datalist id={OWNER_LIST_ID}>
      {owners.map((name) => (
        <option key={name} value={name} />
      ))}
    </datalist>
  )
}

function AddForm({ owners }: { owners: string[] }) {
  const [tag, setTag] = useState('')
  const [label, setLabel] = useState('')
  const [owner, setOwner] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const raw = tag.trim()
    if (!raw || busy) return

    if (!isValidTag(raw)) {
      setProblem('Tags are 3–12 letters and digits, e.g. #2PP0JCCLV.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const player = await api.player(raw)
      savePlayer({
        tag: player.tag,
        name: label.trim() || player.name,
        custom: label.trim().length > 0,
        owner: owner.trim() || undefined,
        clanTag: player.clan?.tag,
        clanName: player.clan?.name,
        townHallLevel: player.townHallLevel,
        trophies: player.trophies,
      })
      setTag('')
      setLabel('')
      // Owner is deliberately kept: adding several bases for one owner is common.
    } catch (cause) {
      const notFound = cause instanceof ApiError && cause.status === 404
      setProblem(
        notFound
          ? `No player with tag ${normalizeTag(raw)}.${
              usesCanonicalAlphabet(raw)
                ? ''
                : ' That tag uses letters outside the usual set — check for a typo.'
            }`
          : cause instanceof Error
            ? cause.message
            : 'Could not add that player.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form className="search" onSubmit={submit}>
        <input
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="Player tag, e.g. #2PP0JCCLV"
          aria-label="Player tag"
          autoComplete="off"
          spellCheck={false}
        />
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Display name (optional)"
          aria-label="Display name, optional"
          autoComplete="off"
        />
        <input
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder="Owner (optional)"
          aria-label="Owner, optional"
          list={OWNER_LIST_ID}
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add player'}
        </button>
      </form>
      {problem ? (
        <p className="notice__hint" style={{ borderTop: 'none', paddingTop: 8 }}>
          {problem}
        </p>
      ) : null}
      <p className="empty-hint" style={{ marginTop: 8, fontSize: 13 }}>
        Blank display name uses the in-game name. Owner is stored only on this device.
      </p>
    </>
  )
}

function SavedRow({
  entry,
  owners,
  selected,
  onToggleSelected,
}: {
  entry: SavedPlayer
  owners: string[]
  selected: boolean
  onToggleSelected: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(entry.name)
  const [ownerDraft, setOwnerDraft] = useState(entry.owner ?? '')

  /* Controls inside a row that is itself a navigation target must stop the
     click reaching the row handler. */
  const swallow = (event: MouseEvent) => event.stopPropagation()

  function startEditing(event: MouseEvent) {
    event.stopPropagation()
    setNameDraft(entry.name)
    setOwnerDraft(entry.owner ?? '')
    setEditing(true)
  }

  function commit(event: FormEvent) {
    event.preventDefault()
    updatePlayer(entry.tag, { name: nameDraft, owner: ownerDraft })
    setEditing(false)
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={8}>
          <form className="search row-edit" onSubmit={commit}>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              aria-label={`Display name for ${entry.tag}`}
              placeholder="Display name"
              autoFocus
            />
            <input
              value={ownerDraft}
              onChange={(event) => setOwnerDraft(event.target.value)}
              aria-label={`Owner of ${entry.tag}`}
              placeholder="Owner"
              list={OWNER_LIST_ID}
              autoComplete="off"
            />
            <button type="submit">Save</button>
            <button type="button" className="icon-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr className="clickable" onClick={() => navigate({ view: 'player', tag: entry.tag })}>
      <td className="select-cell" onClick={swallow}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelected}
          aria-label={`Select ${entry.name}`}
        />
      </td>
      <td>
        <a href={hrefFor({ view: 'player', tag: entry.tag })} onClick={swallow}>
          {entry.name}
        </a>
      </td>
      <td>{entry.owner ?? <span className="role-pill">—</span>}</td>
      <td className="tag-cell">{entry.tag}</td>
      <td className="num">{entry.townHallLevel ?? '—'}</td>
      <td className="num">{entry.trophies === undefined ? '—' : formatFull(entry.trophies)}</td>
      <td>
        {entry.clanTag ? (
          <a href={hrefFor({ view: 'clan', tag: entry.clanTag })} onClick={swallow}>
            {entry.clanName ?? entry.clanTag}
          </a>
        ) : (
          <span className="role-pill">{entry.updatedAt ? 'No clan' : 'Unknown'}</span>
        )}
      </td>
      <td className="row-actions" onClick={swallow}>
        {entry.clanTag ? (
          <a className="chip" href={hrefFor({ view: 'war', tag: entry.clanTag })}>
            War
          </a>
        ) : null}
        <button type="button" className="chip" onClick={startEditing}>
          Edit
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => {
            if (confirm(`Remove ${entry.name} (${entry.tag}) from your saved players?`)) {
              removePlayer(entry.tag)
            }
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  )
}

export function SavedPlayersView() {
  const players = useSavedPlayers()
  const owners = useMemo(() => knownOwners(), [players])

  const [sortKey, setSortKey] = useState<SortKey>('owner')
  const [ascending, setAscending] = useState(true)
  const [limit, setLimit] = useRowLimit(LIMIT_KEY, 20)
  const [page, setPage] = useState(1)
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [bulkOwner, setBulkOwner] = useState('')
  const [conflicts, setConflicts] = useState<OwnerConflict[] | null>(null)
  const [approvedTags, setApprovedTags] = useState<Set<string>>(new Set())
  const [applyNote, setApplyNote] = useState<string | null>(null)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null)

  const selectAllRef = useRef<HTMLInputElement>(null)

  const ordered = useMemo(
    () => sortEntries(players, sortKey, ascending),
    [players, sortKey, ascending],
  )

  const view = paginate(ordered, limit, page)

  const selected = useMemo(
    () => players.filter((entry) => selectedTags.has(entry.tag)),
    [players, selectedTags],
  )

  /*
   * The header checkbox is scoped to the visible page, never the whole list:
   * ticking rows you cannot see and then bulk-editing them is a footgun. Rows
   * already ticked on another page stay ticked, and the bulk bar says so.
   */
  const visibleSelected = view.rows.filter((entry) => selectedTags.has(entry.tag))
  const allVisibleSelected = view.rows.length > 0 && visibleSelected.length === view.rows.length
  const selectedOffPage = selected.length - visibleSelected.length

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleSelected.length > 0 && !allVisibleSelected
    }
  }, [visibleSelected.length, allVisibleSelected])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((current) => !current)
    } else {
      setSortKey(key)
      setAscending(!DESCENDING_BY_DEFAULT.includes(key))
    }
    // A new order makes the old page number meaningless.
    setPage(1)
  }

  function toggleSelected(tag: string) {
    setSelectedTags((current) => {
      const next = new Set(current)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedTags((current) => {
      const next = new Set(current)
      for (const entry of view.rows) {
        if (allVisibleSelected) next.delete(entry.tag)
        else next.add(entry.tag)
      }
      return next
    })
  }

  /**
   * Applies the owner to every selected row that has none, and defers rows that
   * already carry an owner to an explicit per-row approval step. Clearing (an
   * empty owner box) is destructive too, so it takes the same route.
   */
  function applyOwnerToSelected() {
    const plan = planOwnerChange(selected, bulkOwner)

    for (const entry of plan.toApply) {
      updatePlayer(entry.tag, { owner: bulkOwner.trim() })
    }

    const notes: string[] = []
    if (plan.toApply.length > 0) notes.push(`${plan.toApply.length} updated`)
    if (plan.unchanged.length > 0) notes.push(`${plan.unchanged.length} already matched`)
    if (plan.conflicts.length > 0) notes.push(`${plan.conflicts.length} need approval below`)
    setApplyNote(notes.length > 0 ? notes.join(' · ') : 'Nothing selected.')

    setConflicts(plan.conflicts.length > 0 ? plan.conflicts : null)
    setApprovedTags(new Set())

    if (plan.conflicts.length === 0) setSelectedTags(new Set())
  }

  function commitApprovedOverwrites() {
    for (const conflict of conflicts ?? []) {
      if (approvedTags.has(conflict.tag)) {
        updatePlayer(conflict.tag, { owner: conflict.nextOwner })
      }
    }
    const approvedCount = approvedTags.size
    const skipped = (conflicts?.length ?? 0) - approvedCount
    setApplyNote(
      `${approvedCount} overwritten · ${skipped} kept as-is`,
    )
    setConflicts(null)
    setApprovedTags(new Set())
    setSelectedTags(new Set())
  }

  async function refreshAll() {
    setRefreshing(true)
    setRefreshProblem(null)
    // Sequential on purpose: a personal list is short, and this keeps the
    // upstream rate limit comfortable even if the list grows.
    const failures: string[] = []
    for (const entry of players) {
      try {
        await refreshOne(entry)
      } catch {
        failures.push(entry.tag)
      }
    }
    if (failures.length > 0) setRefreshProblem(`Could not refresh: ${failures.join(', ')}`)
    setRefreshing(false)
  }

  return (
    <>
      <section className="card">
        <h2 className="section-title">Add a saved base</h2>
        <AddForm owners={owners} />
      </section>

      <section className="card">
        <div className="card-header">
          <h2 className="section-title" style={{ margin: 0 }}>
            Saved bases{players.length > 0 ? ` · ${players.length}` : ''}
          </h2>
          {players.length > 0 ? (
            <div className="card-header__tools">
              <RowLimitSelect
                id="saved-players-limit"
                options={LIMIT_OPTIONS}
                value={limit}
                onChange={(next) => {
                  setLimit(next)
                  setPage(1)
                }}
              />
              <button
                type="button"
                className="icon-button"
                onClick={refreshAll}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing…' : 'Refresh all'}
              </button>
            </div>
          ) : null}
        </div>

        {refreshProblem ? <p className="notice__hint">{refreshProblem}</p> : null}

        {players.length === 0 ? (
          <p className="empty-hint">
            Nothing saved yet. Add a tag above, or open any player profile and press{' '}
            <strong>Save</strong>.
          </p>
        ) : (
          <>
            {selected.length > 0 ? (
              <div className="bulk-bar">
                <span className="bulk-bar__count">
                  {selected.length} selected
                  {selectedOffPage > 0 ? ` · ${selectedOffPage} on other pages` : ''}
                </span>
                <input
                  value={bulkOwner}
                  onChange={(event) => setBulkOwner(event.target.value)}
                  placeholder="Set owner (blank to clear)"
                  aria-label="Owner to apply to selected rows"
                  list={OWNER_LIST_ID}
                  autoComplete="off"
                />
                <button type="button" onClick={applyOwnerToSelected}>
                  Apply to selected
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

            {conflicts ? (
              <div className="notice">
                <p className="notice__title">Confirm overwriting existing owners</p>
                <p className="notice__body">
                  These rows already have an owner. Approve each one you want changed —
                  anything left unchecked keeps its current owner.
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
                  <button type="button" onClick={commitApprovedOverwrites}>
                    Apply {approvedTags.size} approved
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

            <div className="table-wrap">
              <table className="roster">
                <thead>
                  <tr>
                    <th className="select-cell">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        aria-label={`Select the ${view.rows.length} rows on this page`}
                        title={`Select the ${view.rows.length} rows on this page`}
                      />
                    </th>
                    {COLUMNS.map((column) => (
                      <th key={column.key} className={column.numeric ? 'num' : undefined}>
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
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((entry) => (
                    <SavedRow
                      key={entry.tag}
                      entry={entry}
                      owners={owners}
                      selected={selectedTags.has(entry.tag)}
                      onToggleSelected={() => toggleSelected(entry.tag)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <Pager view={view} noun="bases" onPage={setPage} />

            <OwnerDatalist owners={owners} />

            <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
              Click a row to open the player. Click the clan to open the clan, or{' '}
              <strong>War</strong> for its current war. Tick rows to set their owner in bulk — the
              header checkbox takes only the rows on this page.
            </p>
          </>
        )}
      </section>
    </>
  )
}
