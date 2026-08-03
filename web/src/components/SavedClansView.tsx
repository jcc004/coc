import { useMemo, useState, type FormEvent, type MouseEvent } from 'react'
import {
  isValidTag,
  normalizeTag,
  usesCanonicalAlphabet,
  type SessionUser,
} from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { formatFull } from '../format.ts'
import { hrefFor, navigate, useRowLimit, useStackedTables } from '../hooks.ts'
import {
  removeClan,
  saveClan,
  updateClan,
  useSavedClansState,
  type SavedClan,
} from '../saved-clans.ts'
import {
  clanColumnLabel,
  CLAN_ASCENDING_BY_DEFAULT,
  CLAN_COLUMNS,
  nextSortState,
  paginate,
  sortClanEntries,
  type ClanSortKey,
  type RowLimit,
} from '../saved-table.ts'
import { ErrorPanel, Loading, Pager, RowLimitSelect, SortControl } from './primitives.tsx'

const LIMIT_KEY = 'coc:savedClans:limit'
const LIMIT_OPTIONS: RowLimit[] = [5, 10, 20, 50, 'all']

/**
 * Only the API-derived columns; a custom label and the tag are left alone. The
 * server keeps the label whenever the row is already marked custom, so a refresh
 * cannot undo somebody else's rename either.
 */
async function refreshOne(entry: SavedClan): Promise<void> {
  const clan = await api.clan(entry.tag)
  await saveClan({
    tag: clan.tag,
    name: clan.name,
    ...(entry.custom ? { custom: true } : {}),
    clanLevel: clan.clanLevel,
    members: clan.members,
    warLeague: clan.warLeague?.name,
    clanPoints: clan.clanPoints,
  })
}

function AddForm() {
  const [tag, setTag] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const raw = tag.trim()
    if (!raw || busy) return

    if (!isValidTag(raw)) {
      setProblem('Tags are 3–12 letters and digits, e.g. #G88CYQP.')
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const clan = await api.clan(raw)
      await saveClan({
        tag: clan.tag,
        name: label.trim() || clan.name,
        ...(label.trim() ? { custom: true } : {}),
        clanLevel: clan.clanLevel,
        members: clan.members,
        warLeague: clan.warLeague?.name,
        clanPoints: clan.clanPoints,
      })
      setTag('')
      setLabel('')
    } catch (cause) {
      const notFound = cause instanceof ApiError && cause.status === 404
      setProblem(
        notFound
          ? `No clan with tag ${normalizeTag(raw)}.${
              usesCanonicalAlphabet(raw)
                ? ''
                : ' That tag uses letters outside the usual set — check for a typo.'
            }`
          : cause instanceof Error
            ? cause.message
            : 'Could not add that clan.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <form className="search" onSubmit={(event) => void submit(event)}>
        <input
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="Clan tag, e.g. #G88CYQP"
          aria-label="Clan tag"
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
        <button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add clan'}
        </button>
      </form>
      {problem ? (
        <p className="notice__hint" style={{ borderTop: 'none', paddingTop: 8 }}>
          {problem}
        </p>
      ) : null}
    </>
  )
}

function SavedClanRow({
  entry,
  onProblem,
}: {
  entry: SavedClan
  onProblem: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(entry.name)
  const [busy, setBusy] = useState(false)

  /* Controls inside a row that is itself a navigation target must stop the
     click reaching the row handler. */
  const swallow = (event: MouseEvent) => event.stopPropagation()

  function startEditing(event: MouseEvent) {
    event.stopPropagation()
    setNameDraft(entry.name)
    setEditing(true)
  }

  async function commit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await updateClan(entry.tag, { name: nameDraft })
      setEditing(false)
    } catch (cause) {
      // Stay in the editor: closing it would imply the rename landed.
      onProblem(cause instanceof Error ? cause.message : `Could not rename ${entry.tag}.`)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    // Shared data, so the confirm has to say what it really does.
    if (!confirm(`Remove ${entry.name} (${entry.tag})? This removes it for everyone.`)) return
    try {
      await removeClan(entry.tag)
    } catch (cause) {
      onProblem(cause instanceof Error ? cause.message : `Could not remove ${entry.tag}.`)
    }
  }

  if (editing) {
    return (
      <tr role="row">
        <td colSpan={7} role="cell">
          <form className="search row-edit" onSubmit={(event) => void commit(event)}>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              aria-label={`Display name for ${entry.tag}`}
              placeholder="Display name"
              autoFocus
            />
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="icon-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr
      className="clickable"
      role="row"
      onClick={() => navigate({ view: 'clan', tag: entry.tag })}
    >
      <td className="stack-title" role="cell">
        <a href={hrefFor({ view: 'clan', tag: entry.tag })} onClick={swallow}>
          {entry.name}
        </a>
      </td>
      <td className="tag-cell" role="cell" data-label={clanColumnLabel('tag')}>
        {entry.tag}
      </td>
      <td className="num" role="cell" data-label={clanColumnLabel('clanLevel')}>
        {entry.clanLevel ?? '—'}
      </td>
      <td className="num" role="cell" data-label={clanColumnLabel('members')}>
        {entry.members ?? '—'}
      </td>
      <td className="num" role="cell" data-label={clanColumnLabel('clanPoints')}>
        {entry.clanPoints === undefined ? '—' : formatFull(entry.clanPoints)}
      </td>
      <td role="cell" data-label={clanColumnLabel('warLeague')}>
        {entry.warLeague ?? (
          <span className="role-pill">{entry.updatedAt ? 'None' : 'Unknown'}</span>
        )}
      </td>
      <td className="row-actions" role="cell" onClick={swallow}>
        <a className="chip" href={hrefFor({ view: 'war', tag: entry.tag })}>
          War
        </a>
        <button type="button" className="chip" onClick={startEditing}>
          Edit
        </button>
        <button type="button" className="chip" onClick={() => void remove()}>
          Remove
        </button>
      </td>
    </tr>
  )
}

export function SavedClansView({ user }: { user: Pick<SessionUser, 'role'> }) {
  /*
   * The saved-clans list is shared, and so is the act of adding to it: one tag typed
   * here appears on everybody's homepage. So the form is an admin's, by request.
   *
   * **Hidden, not disabled** — an entry form nobody here can submit is worse than no
   * form. What a member loses is only the shortcut: opening any clan and pressing
   * Save on its page adds it just the same, which is what the empty-state and the
   * footnote below point at. This is presentation; the server's own rule on
   * `POST /api/saved/clans` is what actually decides.
   */
  const isAdmin = user.role === 'admin'
  const state = useSavedClansState()
  const clans = state.entries
  const [rowProblem, setRowProblem] = useState<string | null>(null)

  const stacked = useStackedTables()
  const [sortKey, setSortKey] = useState<ClanSortKey>('name')
  const [ascending, setAscending] = useState(true)
  const [limit, setLimit] = useRowLimit(LIMIT_KEY, 5)
  const [page, setPage] = useState(1)

  const [refreshing, setRefreshing] = useState(false)
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null)

  const ordered = useMemo(
    () => sortClanEntries(clans, sortKey, ascending),
    [clans, sortKey, ascending],
  )

  const view = paginate(ordered, limit, page)

  function toggleSort(key: ClanSortKey) {
    const next = nextSortState({ key: sortKey, ascending }, key, CLAN_ASCENDING_BY_DEFAULT)
    setSortKey(next.key)
    setAscending(next.ascending)
    // A new order makes the old page number meaningless.
    setPage(1)
  }

  async function refreshAll() {
    setRefreshing(true)
    setRefreshProblem(null)
    setRowProblem(null)
    // Sequential on purpose, matching the players table: keeps the upstream rate
    // limit comfortable even as the list grows.
    const failures: string[] = []
    for (const entry of clans) {
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
        <div className="card-header">
          <h2 className="section-title" style={{ margin: 0 }}>
            Saved clans{clans.length > 0 ? ` · ${clans.length}` : ''}
          </h2>
          <div className="card-header__tools">
            {clans.length > 0 ? (
              <RowLimitSelect
                id="saved-clans-limit"
                options={LIMIT_OPTIONS}
                value={limit}
                onChange={(next) => {
                  setLimit(next)
                  setPage(1)
                }}
              />
            ) : null}
            {clans.length > 0 ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => void refreshAll()}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing…' : 'Refresh all'}
              </button>
            ) : null}
          </div>
        </div>

        {refreshProblem ? <p className="notice__hint">{refreshProblem}</p> : null}

        {/* A write that failed must be said out loud, not swallowed. */}
        {rowProblem ? (
          <div className="notice notice--error">
            <p className="notice__body">{rowProblem}</p>
          </div>
        ) : null}

        {state.status === 'error' && state.error ? <ErrorPanel error={state.error} /> : null}

        {clans.length === 0 && state.status === 'loading' ? (
          <Loading what="saved clans" />
        ) : clans.length === 0 && state.status === 'idle' ? null : clans.length === 0 ? (
          <p className="empty-hint">
            No clans saved yet.{' '}
            {isAdmin ? (
              <>
                Add a tag below, or open any clan and press <strong>Save</strong>.
              </>
            ) : (
              <>
                Open any clan and press <strong>Save</strong> to add it, or ask an admin.
              </>
            )}
          </p>
        ) : (
          <>
            {/* Stacked, the column heads are hidden, so this is the visible way
                to reorder — see `useStackedTables`. */}
            {stacked ? (
              <SortControl
                id="saved-clans-sort"
                columns={CLAN_COLUMNS}
                sortKey={sortKey}
                ascending={ascending}
                onSort={toggleSort}
              />
            ) : null}

            <div className="table-wrap">
              {/* One labelled card per clan at tablet width and below — see the
                  note in styles.css. */}
              <table className="roster roster--stack" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    {CLAN_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        className={column.numeric ? 'num' : undefined}
                        role="columnheader"
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
                    <th role="columnheader" />
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {view.rows.map((entry) => (
                    <SavedClanRow key={entry.tag} entry={entry} onProblem={setRowProblem} />
                  ))}
                </tbody>
              </table>
            </div>

            <Pager view={view} noun="clans" onPage={setPage} />

            <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
              Click a row to open the clan, or <strong>War</strong> for its current war. This list
              is <strong>shared</strong> — everyone signed in sees and edits the same one.
            </p>
          </>
        )}
      </section>

      {isAdmin ? (
        <section className="card">
          <h2 className="section-title">Add a saved clan</h2>
          <AddForm />
          <p className="empty-hint" style={{ marginTop: 8, fontSize: 13 }}>
            Blank display name uses the in-game clan name.
          </p>
        </section>
      ) : null}
    </>
  )
}
