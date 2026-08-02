import { useMemo, useState, type FormEvent, type MouseEvent } from 'react'
import { isValidTag, normalizeTag, usesCanonicalAlphabet } from '@coc/shared'
import { ApiError, api } from '../api.ts'
import { formatFull } from '../format.ts'
import { hrefFor, navigate, useRowLimit } from '../hooks.ts'
import { removeClan, saveClan, updateClan, useSavedClans, type SavedClan } from '../saved-clans.ts'
import {
  CLAN_COLUMNS,
  CLAN_DESCENDING_BY_DEFAULT,
  paginate,
  sortClanEntries,
  type ClanSortKey,
  type RowLimit,
} from '../saved-table.ts'
import { Pager, RowLimitSelect } from './primitives.tsx'

const LIMIT_KEY = 'coc:savedClans:limit'
const LIMIT_OPTIONS: RowLimit[] = [5, 10, 20, 50, 'all']

/** Only the API-derived columns; a custom label and the tag are left alone. */
async function refreshOne(entry: SavedClan): Promise<void> {
  const clan = await api.clan(entry.tag)
  saveClan({
    tag: clan.tag,
    name: clan.name,
    custom: entry.custom,
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
      saveClan({
        tag: clan.tag,
        name: label.trim() || clan.name,
        custom: label.trim().length > 0,
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
      <form className="search" onSubmit={submit}>
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

function SavedClanRow({ entry }: { entry: SavedClan }) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(entry.name)

  /* Controls inside a row that is itself a navigation target must stop the
     click reaching the row handler. */
  const swallow = (event: MouseEvent) => event.stopPropagation()

  function startEditing(event: MouseEvent) {
    event.stopPropagation()
    setNameDraft(entry.name)
    setEditing(true)
  }

  function commit(event: FormEvent) {
    event.preventDefault()
    updateClan(entry.tag, { name: nameDraft })
    setEditing(false)
  }

  if (editing) {
    return (
      <tr>
        <td colSpan={7}>
          <form className="search row-edit" onSubmit={commit}>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              aria-label={`Display name for ${entry.tag}`}
              placeholder="Display name"
              autoFocus
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
    <tr className="clickable" onClick={() => navigate({ view: 'clan', tag: entry.tag })}>
      <td>
        <a href={hrefFor({ view: 'clan', tag: entry.tag })} onClick={swallow}>
          {entry.name}
        </a>
      </td>
      <td className="tag-cell">{entry.tag}</td>
      <td className="num">{entry.clanLevel ?? '—'}</td>
      <td className="num">{entry.members ?? '—'}</td>
      <td className="num">{entry.clanPoints === undefined ? '—' : formatFull(entry.clanPoints)}</td>
      <td>
        {entry.warLeague ?? (
          <span className="role-pill">{entry.updatedAt ? 'None' : 'Unknown'}</span>
        )}
      </td>
      <td className="row-actions" onClick={swallow}>
        <a className="chip" href={hrefFor({ view: 'war', tag: entry.tag })}>
          War
        </a>
        <button type="button" className="chip" onClick={startEditing}>
          Edit
        </button>
        <button
          type="button"
          className="chip"
          onClick={() => {
            if (confirm(`Remove ${entry.name} (${entry.tag}) from your saved clans?`)) {
              removeClan(entry.tag)
            }
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  )
}

export function SavedClansView() {
  const clans = useSavedClans()

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
    if (key === sortKey) {
      setAscending((current) => !current)
    } else {
      setSortKey(key)
      setAscending(!CLAN_DESCENDING_BY_DEFAULT.includes(key))
    }
    // A new order makes the old page number meaningless.
    setPage(1)
  }

  async function refreshAll() {
    setRefreshing(true)
    setRefreshProblem(null)
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
        <h2 className="section-title">Add a saved clan</h2>
        <AddForm />
        <p className="empty-hint" style={{ marginTop: 8, fontSize: 13 }}>
          Blank display name uses the in-game clan name.
        </p>
      </section>

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
                onClick={refreshAll}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing…' : 'Refresh all'}
              </button>
            ) : null}
          </div>
        </div>

        {refreshProblem ? <p className="notice__hint">{refreshProblem}</p> : null}

        {clans.length === 0 ? (
          <p className="empty-hint">
            No clans saved yet. Add a tag above, or open any clan and press <strong>Save</strong>.
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="roster">
                <thead>
                  <tr>
                    {CLAN_COLUMNS.map((column) => (
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
                    <SavedClanRow key={entry.tag} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>

            <Pager view={view} noun="clans" onPage={setPage} />

            <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
              Click a row to open the clan, or <strong>War</strong> for its current war.
            </p>
          </>
        )}
      </section>
    </>
  )
}
