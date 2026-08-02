import { useEffect, useMemo, useState } from 'react'
import { ROLE_LABELS, type Clan, type ClanMember } from '@coc/shared'
import { api } from '../api.ts'
import { labelIcon } from '../coc-assets.ts'
import { formatFull, formatStat, humanizeCamel, ratio } from '../format.ts'
import { hrefFor, useAsync, type Recent } from '../hooks.ts'
import { removeClan, saveClan, useSavedClans } from '../saved-clans.ts'
import { Card, ErrorPanel, GameIcon, Loading, Meter, StatTile, TileRow } from './primitives.tsx'
import { TagButton } from './TagButton.tsx'

function SaveToggle({ clan }: { clan: Clan }) {
  const saved = useSavedClans().some((entry) => entry.tag === clan.tag)

  return (
    <button
      type="button"
      className="icon-button"
      style={{ marginBottom: 10 }}
      onClick={() => {
        if (saved) {
          removeClan(clan.tag)
        } else {
          saveClan({
            tag: clan.tag,
            name: clan.name,
            clanLevel: clan.clanLevel,
            members: clan.members,
            warLeague: clan.warLeague?.name,
            clanPoints: clan.clanPoints,
          })
        }
      }}
    >
      {saved ? '★ Saved' : '☆ Save'}
    </button>
  )
}

type SortKey = 'clanRank' | 'name' | 'townHallLevel' | 'trophies' | 'donations' | 'donationsReceived'

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'clanRank', label: '#', numeric: true },
  { key: 'name', label: 'Member', numeric: false },
  { key: 'townHallLevel', label: 'TH', numeric: true },
  { key: 'trophies', label: 'Trophies', numeric: true },
  { key: 'donations', label: 'Donated', numeric: true },
  { key: 'donationsReceived', label: 'Received', numeric: true },
]

/** Ranks and names read best ascending; every stat reads best highest-first. */
const ASCENDING_BY_DEFAULT: SortKey[] = ['clanRank', 'name']

function compare(a: ClanMember, b: ClanMember, key: SortKey): number {
  if (key === 'name') return a.name.localeCompare(b.name)
  return a[key] - b[key]
}

function RosterTable({ members }: { members: ClanMember[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('clanRank')
  const [ascending, setAscending] = useState(true)

  const sorted = useMemo(() => {
    const copy = [...members]
    copy.sort((a, b) => (ascending ? compare(a, b, sortKey) : compare(b, a, sortKey)))
    return copy
  }, [members, sortKey, ascending])

  // The donation bar is a magnitude comparison within this roster, so it scales
  // to the clan's top donor rather than to some absolute ceiling.
  const topDonations = useMemo(
    () => members.reduce((max, member) => Math.max(max, member.donations), 0),
    [members],
  )

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((current) => !current)
    } else {
      setSortKey(key)
      setAscending(ASCENDING_BY_DEFAULT.includes(key))
    }
  }

  return (
    <div className="table-wrap">
      <table className="roster">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} className={column.numeric ? 'num' : undefined}>
                <button type="button" onClick={() => toggleSort(column.key)}>
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
          {sorted.map((member) => (
            <tr key={member.tag}>
              <td className="num">{member.clanRank}</td>
              <td>
                <a href={hrefFor({ view: 'player', tag: member.tag })}>{member.name}</a>{' '}
                <span className="role-pill">{ROLE_LABELS[member.role]}</span>
              </td>
              <td className="num">{member.townHallLevel}</td>
              <td className="num">{formatFull(member.trophies)}</td>
              <td className="num">
                <div className="donation-cell">
                  <span title={`${ratio(member.donations, member.donationsReceived)} donated/received`}>
                    {formatFull(member.donations)}
                  </span>
                  <Meter
                    value={member.donations}
                    max={topDonations}
                    label={`${member.name} donated ${member.donations}`}
                  />
                </div>
              </td>
              <td className="num">{formatFull(member.donationsReceived)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    </>
  )
}
