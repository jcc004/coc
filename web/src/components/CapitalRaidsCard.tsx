import {
  parseCocTimestamp,
  type CapitalRaidSeason,
  type CapitalRaidSeasonsResponse,
} from '@coc/shared'
import { api } from '../api.ts'
import { formatDateTime, formatFull } from '../format.ts'
import { hrefFor, useAsync } from '../hooks.ts'
import { Card, ErrorPanel, Loading } from './primitives.tsx'

const STATE_LABEL: Record<string, string> = { ongoing: 'Ongoing', ended: 'Ended' }

const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** `Jul 24 – Jul 27` — how a weekend is identified everywhere in this card. */
function weekendRange(season: CapitalRaidSeason): string {
  const start = parseCocTimestamp(season.startTime)
  const end = parseCocTimestamp(season.endTime)
  return `${DAY.format(start)} – ${DAY.format(end)}`
}

/** Exact bounds on hover, since the visible range drops the year and the time. */
function weekendTitle(season: CapitalRaidSeason): string {
  const start = formatDateTime(parseCocTimestamp(season.startTime))
  const end = formatDateTime(parseCocTimestamp(season.endTime))
  return `${start} – ${end}`
}

function MemberBreakdown({ season }: { season: CapitalRaidSeason }) {
  const members = season.members

  return (
    <details className="group">
      <summary>
        {weekendRange(season)} · member breakdown{members ? ` (${members.length})` : ''}
      </summary>
      <div className="group__body">
        {members === undefined ? (
          <p className="empty-hint">
            The API only returns the per-member breakdown while a weekend is still in progress, so
            this one has totals but no attribution.
          </p>
        ) : members.length === 0 ? (
          <p className="empty-hint">Nobody has attacked yet this weekend.</p>
        ) : (
          <div className="table-wrap">
            {/* Stacks into one labelled card per member on a phone; the roles keep
                it a table for assistive tech once `display` changes. */}
            <table className="roster roster--stack" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader">Member</th>
                  <th className="num" role="columnheader">
                    Attacks
                  </th>
                  <th className="num" role="columnheader">
                    Capital loot
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {[...members]
                  .sort((a, b) => b.capitalResourcesLooted - a.capitalResourcesLooted)
                  .map((member) => (
                    <tr key={member.tag} role="row">
                      <td className="stack-title" role="cell">
                        <a href={hrefFor({ view: 'player', tag: member.tag })}>{member.name}</a>
                      </td>
                      {/* The limit is base + bonus; `attacks` legitimately reaches it. */}
                      <td className="num" role="cell" data-label="Attacks">
                        {member.attacks}/{member.attackLimit + member.bonusAttackLimit}
                      </td>
                      <td className="num" role="cell" data-label="Capital loot">
                        {formatFull(member.capitalResourcesLooted)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  )
}

function RaidSeasons({ seasons }: { seasons: CapitalRaidSeason[] }) {
  if (seasons.length === 0) {
    return (
      <p className="empty-hint">
        No raid weekends on record. A clan that has never taken part in one has no history here.
      </p>
    )
  }

  return (
    <>
      <div className="table-wrap">
        <table className="roster roster--stack" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader">Weekend</th>
              <th role="columnheader">State</th>
              <th className="num" role="columnheader">
                Capital loot
              </th>
              <th className="num" role="columnheader">
                Raids
              </th>
              <th className="num" role="columnheader">
                Enemy districts
              </th>
              <th className="num" role="columnheader">
                Offensive reward
              </th>
              <th className="num" role="columnheader">
                Defensive reward
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {seasons.map((season) => (
              <tr key={season.startTime} role="row">
                {/* The date range is what names a weekend, so it heads the card. */}
                <td className="stack-title" role="cell" title={weekendTitle(season)}>
                  {weekendRange(season)}
                </td>
                <td role="cell" data-label="State">
                  <span className="role-pill">{STATE_LABEL[season.state] ?? season.state}</span>
                </td>
                <td className="num" role="cell" data-label="Capital loot">
                  {formatFull(season.capitalTotalLoot)}
                </td>
                <td className="num" role="cell" data-label="Raids">
                  {season.raidsCompleted}
                </td>
                <td className="num" role="cell" data-label="Enemy districts">
                  {season.enemyDistrictsDestroyed}
                </td>
                <td className="num" role="cell" data-label="Offensive reward">
                  {formatFull(season.offensiveReward)}
                </td>
                <td className="num" role="cell" data-label="Defensive reward">
                  {formatFull(season.defensiveReward)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {seasons.map((season) => (
        <MemberBreakdown key={season.startTime} season={season} />
      ))}
    </>
  )
}

export function CapitalRaidsCard({ tag }: { tag: string }) {
  const state = useAsync<CapitalRaidSeasonsResponse>(
    (signal) => api.capitalRaidSeasons(tag, signal),
    [tag],
  )

  return (
    <Card title="Capital raid weekends">
      {state.status === 'loading' ? <Loading what="capital raid weekends" /> : null}
      {/*
       * Unlike the war endpoints this one is public even for a clan with a private
       * war log, so a 403 here is the key's IP binding — the error panel's own hint
       * already says so.
       */}
      {state.status === 'error' ? <ErrorPanel error={state.error} /> : null}
      {state.status === 'ready' ? <RaidSeasons seasons={state.data.items} /> : null}
    </Card>
  )
}
