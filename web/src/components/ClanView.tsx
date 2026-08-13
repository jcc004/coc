import { useEffect, useState } from 'react'
import type { Clan, SessionUser } from '@coc/shared'
import { api } from '../api.ts'
import { labelIcon } from '../coc-assets.ts'
import { formatFull, formatStat, humanizeCamel } from '../format.ts'
import { hrefFor, useAsync, type Recent } from '../hooks.ts'
import { removeClan, saveClan, useSavedClans } from '../saved-clans.ts'
import { CapitalRaidsCard } from './CapitalRaidsCard.tsx'
import { Card, ErrorPanel, GameIcon, Loading, StatTile, TileRow } from './primitives.tsx'
import { RosterTable } from './RosterTable.tsx'
import { TagButton } from './TagButton.tsx'

/**
 * A clan: the profile card, the war and capital tiles, the roster, and the raid log.
 *
 * The roster is `RosterTable.tsx` rather than a function down the page. It was two
 * thirds of this file — 660 lines and thirteen pieces of state — which made "what does
 * the clan page show" a question you had to scroll past a whole owner-assignment
 * workflow to answer.
 */

/**
 * The shortcut `SavedClansView.tsx`'s own doc comment refers to: this toggle calls
 * the identical `saveClan`/`removeClan` writes as that view's Edit/Remove chips, so
 * it is gated the same way and for the same reason — hidden, not disabled, for a
 * non-admin, since the write would just come back refused.
 */
function SaveToggle({ clan, isAdmin }: { clan: Clan; isAdmin: boolean }) {
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

  if (!isAdmin) return null

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
              <SaveToggle clan={clan} isAdmin={user.role === 'admin'} />
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
