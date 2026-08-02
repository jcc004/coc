import { useEffect, useMemo, useRef, useState } from 'react'
import { ROLE_LABELS, type Clan, type ClanMember } from '@coc/shared'
import { api } from '../api.ts'
import { labelIcon } from '../coc-assets.ts'
import { formatFull, formatStat, humanizeCamel, ratio } from '../format.ts'
import { hrefFor, useAsync, type Recent } from '../hooks.ts'
import { applyOwners, knownOwners, useOwnersState } from '../owners.ts'
import { removeClan, saveClan, useSavedClans } from '../saved-clans.ts'
import {
  planOwnerChange,
  ROSTER_ASCENDING_BY_DEFAULT,
  ROSTER_COLUMNS,
  sortRosterRows,
  type OwnerConflict,
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
  StatTile,
  TileRow,
  TownHallBadge,
} from './primitives.tsx'
import { TagButton } from './TagButton.tsx'

const OWNER_LIST_ID = 'known-owners'

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

function RosterTable({ members }: { members: ClanMember[] }) {
  const ownersState = useOwnersState()
  const owners = ownersState.entries

  const [sortKey, setSortKey] = useState<RosterSortKey>('clanRank')
  const [ascending, setAscending] = useState(true)
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

  // Owner is a local annotation keyed by tag, so the roster is the API's member
  // list joined against the store whenever either side changes.
  const rows = useMemo<RosterRow[]>(() => {
    const byTag = new Map(owners.map((entry) => [entry.tag, entry.owner]))
    return members.map((member) => ({ ...member, owner: byTag.get(member.tag) }))
  }, [members, owners])

  const ordered = useMemo(
    () => sortRosterRows(rows, sortKey, ascending),
    [rows, sortKey, ascending],
  )

  /*
   * The game caps a clan at 50 members, so this table is never paged and the
   * header checkbox can safely mean the whole roster — every row it ticks is on
   * screen, which is what made page-scoped select-all necessary elsewhere.
   */
  const selected = useMemo(
    () => rows.filter((row) => selectedTags.has(row.tag)),
    [rows, selectedTags],
  )
  const allSelected = rows.length > 0 && selected.length === rows.length

  // The donation bar is a magnitude comparison within this roster, so it scales
  // to the clan's top donor rather than to some absolute ceiling.
  const topDonations = useMemo(
    () => members.reduce((max, member) => Math.max(max, member.donations), 0),
    [members],
  )

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.length > 0 && !allSelected
    }
  }, [selected.length, allSelected])

  function toggleSort(key: RosterSortKey) {
    if (key === sortKey) {
      setAscending((current) => !current)
    } else {
      setSortKey(key)
      setAscending(ROSTER_ASCENDING_BY_DEFAULT.includes(key))
    }
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
    setSelectedTags(allSelected ? new Set() : new Set(rows.map((row) => row.tag)))
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
          <span className="bulk-bar__count">{selected.length} selected</span>
          <input
            value={bulkOwner}
            onChange={(event) => setBulkOwner(event.target.value)}
            placeholder="Set owner (blank to clear)"
            aria-label="Owner to apply to selected members"
            list={OWNER_LIST_ID}
            autoComplete="off"
          />
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

      <div className="table-wrap">
        <table className="roster">
          <thead>
            <tr>
              <th className="select-cell">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label={`Select all ${rows.length} members`}
                  title={`Select all ${rows.length} members`}
                />
              </th>
              {ROSTER_COLUMNS.map((column) => (
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
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => (
              <tr key={row.tag}>
                <td className="select-cell">
                  <input
                    type="checkbox"
                    checked={selectedTags.has(row.tag)}
                    onChange={() => toggleSelected(row.tag)}
                    aria-label={`Select ${row.name}`}
                  />
                </td>
                <td className="num">{row.clanRank}</td>
                <td>
                  <a href={hrefFor({ view: 'player', tag: row.tag })}>{row.name}</a>{' '}
                  <span className="role-pill">{ROLE_LABELS[row.role]}</span>
                </td>
                <td>{row.owner ?? <span className="role-pill">—</span>}</td>
                {/* Badge only — sorting still reads `row.townHallLevel`, untouched. */}
                <td className="num">
                  <TownHallBadge level={row.townHallLevel} />
                </td>
                <td className="num">{formatFull(row.trophies)}</td>
                <td className="num">
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
                <td className="num">{formatFull(row.donationsReceived)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <datalist id={OWNER_LIST_ID}>
        {ownerNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <p className="empty-hint" style={{ marginTop: 12, fontSize: 13 }}>
        Owner is stored on the server, keyed by player tag, and is{' '}
        <strong>shared with everyone</strong> — one answer per base, not one per device. Tick
        members to set it in bulk; the header checkbox takes the whole roster.
      </p>
    </>
  )
}

export function ClanView({ tag, onLoaded }: { tag: string; onLoaded: (entry: Recent) => void }) {
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
        <RosterTable members={clan.memberList} />
      </Card>

      <CapitalRaidsCard tag={clan.tag} />
    </>
  )
}
