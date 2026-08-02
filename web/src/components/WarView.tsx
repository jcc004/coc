import {
  parseCocTimestamp,
  type CurrentWar,
  type WarClan,
  type WarLogEntry,
  type WarLogResponse,
  type WarMember,
} from '@coc/shared'
import { api } from '../api.ts'
import { formatDateTime, formatFull, formatRelative } from '../format.ts'
import { hrefFor, useAsync } from '../hooks.ts'
import {
  Card,
  ErrorPanel,
  Loading,
  Meter,
  StatTile,
  TileRow,
  TownHallBadge,
} from './primitives.tsx'

const STATE_LABEL: Record<string, string> = {
  notInWar: 'Not in war',
  preparation: 'Preparation day',
  inWar: 'Battle day',
  warEnded: 'War ended',
}

const RESULT_LABEL: Record<string, string> = { win: 'Win', lose: 'Loss', tie: 'Tie' }

function starsEarned(member: WarMember): number {
  return (member.attacks ?? []).reduce((total, attack) => total + attack.stars, 0)
}

function bestDestruction(member: WarMember): number {
  return (member.attacks ?? []).reduce(
    (best, attack) => Math.max(best, attack.destructionPercentage),
    0,
  )
}

/** Total attacks available to one side, or null when the war has no roster. */
function attackAllowance(war: CurrentWar): number | null {
  if (war.teamSize === undefined) return null
  return war.teamSize * (war.attacksPerMember ?? 2)
}

function SideRoster({ side, war }: { side: WarClan; war: CurrentWar }) {
  const members = [...(side.members ?? [])].sort((a, b) => a.mapPosition - b.mapPosition)
  if (members.length === 0) return null

  const perMember = war.attacksPerMember ?? 2

  return (
    <div className="table-wrap">
      <table className="roster">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Member</th>
            <th className="num">TH</th>
            <th className="num">Stars</th>
            <th className="num">Best hit</th>
            <th className="num">Attacks</th>
            <th className="num">Defended</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.tag}>
              <td className="num">{member.mapPosition}</td>
              <td>
                <a href={hrefFor({ view: 'player', tag: member.tag })}>{member.name}</a>
              </td>
              {/* `townhallLevel` — lowercase `h` is the war payload's own spelling. */}
              <td className="num">
                <TownHallBadge level={member.townhallLevel} />
              </td>
              <td className="num">{starsEarned(member)}</td>
              <td className="num">
                {member.attacks?.length ? `${bestDestruction(member)}%` : '—'}
              </td>
              <td className="num">
                {member.attacks?.length ?? 0}/{perMember}
              </td>
              <td className="num">
                {member.bestOpponentAttack
                  ? `${member.bestOpponentAttack.stars}★ ${member.bestOpponentAttack.destructionPercentage}%`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CurrentWarPanel({ war }: { war: CurrentWar }) {
  if (war.state === 'notInWar') {
    return (
      <Card title="Current war">
        <p className="empty-hint">
          This clan is not in a war right now. Regular wars appear here; Clan War League rounds
          do not.
        </p>
      </Card>
    )
  }

  const allowance = attackAllowance(war)
  const endsAt = war.endTime ? parseCocTimestamp(war.endTime) : null
  const startsAt = war.startTime ? parseCocTimestamp(war.startTime) : null

  return (
    <>
      <Card>
        <div className="war-header">
          <div className="war-side">
            {war.clan.tag ? (
              <a href={hrefFor({ view: 'clan', tag: war.clan.tag })}>
                <img src={war.clan.badgeUrls.medium} alt="" />
              </a>
            ) : (
              <img src={war.clan.badgeUrls.medium} alt="" />
            )}
            <div className="war-side__name">{war.clan.name ?? 'This clan'}</div>
            <div className="war-side__meta">Level {war.clan.clanLevel}</div>
          </div>

          <div className="war-score">
            <div className="war-score__value">
              {war.clan.stars}<span className="war-score__dash">–</span>{war.opponent.stars}
            </div>
            <div className="war-score__label">Stars</div>
            <div className="war-score__state">
              {STATE_LABEL[war.state] ?? war.state}
              {war.teamSize ? ` · ${war.teamSize}v${war.teamSize}` : ''}
            </div>
            {war.state === 'preparation' && startsAt ? (
              <div className="war-score__time" title={formatDateTime(startsAt)}>
                Battle starts {formatRelative(startsAt)}
              </div>
            ) : null}
            {war.state === 'inWar' && endsAt ? (
              <div className="war-score__time" title={formatDateTime(endsAt)}>
                Ends {formatRelative(endsAt)}
              </div>
            ) : null}
            {war.state === 'warEnded' && endsAt ? (
              <div className="war-score__time" title={formatDateTime(endsAt)}>
                Ended {formatRelative(endsAt)}
              </div>
            ) : null}
          </div>

          <div className="war-side war-side--right">
            {war.opponent.tag ? (
              <a href={hrefFor({ view: 'clan', tag: war.opponent.tag })}>
                <img src={war.opponent.badgeUrls.medium} alt="" />
              </a>
            ) : (
              <img src={war.opponent.badgeUrls.medium} alt="" />
            )}
            <div className="war-side__name">{war.opponent.name ?? 'Opponent'}</div>
            <div className="war-side__meta">Level {war.opponent.clanLevel}</div>
          </div>
        </div>
      </Card>

      <TileRow>
        <StatTile label="Destruction" value={`${war.clan.destructionPercentage.toFixed(2)}%`} />
        <StatTile
          label="Opponent destruction"
          value={`${war.opponent.destructionPercentage.toFixed(2)}%`}
        />
        <StatTile
          label="Attacks used"
          value={allowance ? `${war.clan.attacks}/${allowance}` : war.clan.attacks}
        />
        <StatTile
          label="Opponent attacks"
          value={allowance ? `${war.opponent.attacks}/${allowance}` : war.opponent.attacks}
        />
        {war.battleModifier && war.battleModifier !== 'none' ? (
          <StatTile label="Modifier" value={war.battleModifier} />
        ) : null}
      </TileRow>

      {allowance ? (
        <Card title="Attack usage">
          <div className="meter-row">
            <div>
              <div className="meter-row__name">{war.clan.name ?? 'This clan'}</div>
              <Meter
                value={war.clan.attacks}
                max={allowance}
                label={`${war.clan.attacks} of ${allowance} attacks used`}
              />
            </div>
            <div className="meter-row__level">
              {war.clan.attacks}/{allowance}
            </div>
          </div>
          <div className="meter-row">
            <div>
              <div className="meter-row__name">{war.opponent.name ?? 'Opponent'}</div>
              <Meter
                value={war.opponent.attacks}
                max={allowance}
                label={`${war.opponent.attacks} of ${allowance} opponent attacks used`}
              />
            </div>
            <div className="meter-row__level">
              {war.opponent.attacks}/{allowance}
            </div>
          </div>
        </Card>
      ) : null}

      {war.clan.members?.length ? (
        <Card title={`${war.clan.name ?? 'This clan'} roster`}>
          <SideRoster side={war.clan} war={war} />
        </Card>
      ) : null}

      {war.opponent.members?.length ? (
        <Card title={`${war.opponent.name ?? 'Opponent'} roster`}>
          <SideRoster side={war.opponent} war={war} />
        </Card>
      ) : null}
    </>
  )
}

function WarLogRow({ entry }: { entry: WarLogEntry }) {
  const ended = parseCocTimestamp(entry.endTime)
  return (
    <tr>
      <td>
        {entry.result ? (
          <span className={`result result--${entry.result}`}>{RESULT_LABEL[entry.result]}</span>
        ) : (
          <span className="role-pill">CWL</span>
        )}
      </td>
      <td>
        {entry.opponent.tag ? (
          <a href={hrefFor({ view: 'clan', tag: entry.opponent.tag })}>
            {entry.opponent.name ?? entry.opponent.tag}
          </a>
        ) : (
          (entry.opponent.name ?? '—')
        )}
      </td>
      <td className="num">
        {entry.clan.stars}–{entry.opponent.stars}
      </td>
      <td className="num">{entry.clan.destructionPercentage.toFixed(1)}%</td>
      <td className="num">{entry.opponent.destructionPercentage.toFixed(1)}%</td>
      <td className="num">
        {entry.teamSize}v{entry.teamSize}
      </td>
      <td className="num">{entry.clan.expEarned === undefined ? '—' : formatFull(entry.clan.expEarned)}</td>
      <td title={formatDateTime(ended)}>{formatRelative(ended)}</td>
    </tr>
  )
}

function WarLogPanel({ tag }: { tag: string }) {
  const state = useAsync<WarLogResponse>((signal) => api.warLog(tag, signal), [tag])

  if (state.status === 'loading') return <Loading what="war log" />
  if (state.status === 'error') return <ErrorPanel error={state.error} />
  if (state.status !== 'ready') return null

  const entries = state.data.items

  return (
    <Card title={`War log · last ${entries.length}`}>
      {entries.length === 0 ? (
        <p className="empty-hint">No recorded wars.</p>
      ) : (
        <div className="table-wrap">
          <table className="roster">
            <thead>
              <tr>
                <th>Result</th>
                <th>Opponent</th>
                <th className="num">Stars</th>
                <th className="num">Destruction</th>
                <th className="num">Theirs</th>
                <th className="num">Size</th>
                <th className="num">XP</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <WarLogRow key={`${entry.endTime}-${entry.opponent.tag ?? entry.opponent.name}`} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function WarView({ tag }: { tag: string }) {
  const state = useAsync<CurrentWar>((signal) => api.currentWar(tag, signal), [tag])

  return (
    <>
      {state.status === 'loading' ? <Loading what={`war for ${tag}`} /> : null}
      {state.status === 'error' ? <ErrorPanel error={state.error} /> : null}
      {state.status === 'ready' ? <CurrentWarPanel war={state.data} /> : null}

      {/* Fetched separately: a clan can be mid-war while the log is unavailable,
          and one failing should not blank the other. */}
      <WarLogPanel tag={tag} />
    </>
  )
}
