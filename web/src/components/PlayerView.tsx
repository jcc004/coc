import { useEffect } from 'react'
import { ROLE_LABELS, type Player, type PlayerItemLevel } from '@coc/shared'
import { api } from '../api.ts'
import { labelIcon, leagueIcon } from '../coc-assets.ts'
import { formatFull, formatStat, ratio } from '../format.ts'
import { hrefFor, useAsync, type Recent } from '../hooks.ts'
import { artFor, type ArtKind } from '../wiki-art.ts'
import {
  Card,
  ErrorPanel,
  GameIcon,
  LevelRow,
  Loading,
  StatTile,
  TileRow,
  TownHallBadge,
} from './primitives.tsx'
import { TagButton } from './TagButton.tsx'

function homeVillage(items: PlayerItemLevel[] | undefined): PlayerItemLevel[] {
  return (items ?? []).filter((item) => item.village === 'home')
}

function builderBase(items: PlayerItemLevel[] | undefined): PlayerItemLevel[] {
  return (items ?? []).filter((item) => item.village === 'builderBase')
}

function LevelGroup({
  title,
  items,
  kind,
}: {
  title: string
  items: PlayerItemLevel[]
  kind: ArtKind
}) {
  if (items.length === 0) return null
  return (
    <details className="group">
      <summary>
        {title} ({items.length})
      </summary>
      <div className="group__body meter-grid">
        {items.map((item) => (
          <LevelRow
            key={`${item.name}-${item.village}`}
            name={item.superTroopIsActive ? `${item.name} (boosted)` : item.name}
            level={item.level}
            maxLevel={item.maxLevel}
            /* The API name, not the decorated one: "(boosted)" is display text and
               would never resolve to art. */
            art={artFor(kind, item.name)}
          />
        ))}
      </div>
    </details>
  )
}

export function PlayerView({ tag, onLoaded }: { tag: string; onLoaded: (entry: Recent) => void }) {
  const state = useAsync<Player>((signal) => api.player(tag, signal), [tag])

  const player = state.status === 'ready' ? state.data : null
  useEffect(() => {
    if (player) onLoaded({ kind: 'player', tag: player.tag, name: player.name })
  }, [player, onLoaded])

  if (state.status === 'loading') return <Loading what={`player ${tag}`} />
  if (state.status === 'error') return <ErrorPanel error={state.error} />
  if (!player) return null

  const heroes = homeVillage(player.heroes)
  const equipment = player.heroEquipment ?? []

  return (
    <>
      <Card>
        <div className="profile">
          <div className="profile__main">
            <h1 className="profile__name">{player.name}</h1>
            <TagButton tag={player.tag} />
            <div className="profile__meta">
              <TownHallBadge
                level={player.townHallLevel}
                text={`Town Hall ${player.townHallLevel}`}
              />
              {player.townHallWeaponLevel ? <span>· Weapon {player.townHallWeaponLevel}</span> : null}
              <span>· Level {player.expLevel}</span>
              {player.clan ? (
                <span>
                  ·{' '}
                  <a href={hrefFor({ view: 'clan', tag: player.clan.tag })}>
                    {player.clan.name}
                  </a>
                  {player.role ? ` (${ROLE_LABELS[player.role]})` : ''}
                </span>
              ) : (
                <span>· No clan</span>
              )}
              {player.warPreference ? (
                <span>· War {player.warPreference === 'in' ? 'opted in' : 'opted out'}</span>
              ) : null}
            </div>
            {player.labels.length > 0 ? (
              <div className="recents" style={{ marginTop: 10 }}>
                {player.labels.map((label) => (
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
          </div>

          <div className="hero-figure">
            <div className="hero-figure__value" title={formatFull(player.trophies)}>
              {formatStat(player.trophies)}
            </div>
            <div className="hero-figure__label">Trophies</div>
            {player.league ? (
              <div className="hero-figure__league">
                <GameIcon
                  src={leagueIcon(player.league.id, player.league.iconUrls.small)}
                  fallback={player.league.iconUrls.small}
                />
                {player.league.name}
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <TileRow>
        <StatTile label="Best trophies" value={player.bestTrophies} />
        <StatTile label="War stars" value={player.warStars} />
        <StatTile label="Attack wins" value={player.attackWins} />
        <StatTile label="Defense wins" value={player.defenseWins} />
        <StatTile
          label="Donated"
          value={player.donations}
          note={`${ratio(player.donations, player.donationsReceived)} ratio`}
        />
        <StatTile label="Received" value={player.donationsReceived} />
        <StatTile label="Capital contributions" value={player.clanCapitalContributions} />
        {player.builderHallLevel ? (
          <StatTile
            label="Builder Hall"
            value={player.builderHallLevel}
            note={
              player.builderBaseTrophies
                ? `${formatFull(player.builderBaseTrophies)} trophies`
                : undefined
            }
          />
        ) : null}
      </TileRow>

      {heroes.length > 0 ? (
        <Card title="Heroes">
          <div className="meter-grid">
            {heroes.map((hero) => (
              <LevelRow
                key={hero.name}
                name={hero.name}
                level={hero.level}
                maxLevel={hero.maxLevel}
                art={artFor('hero', hero.name)}
              />
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="Progression">
        <LevelGroup title="Home village troops" items={homeVillage(player.troops)} kind="troop" />
        <LevelGroup title="Spells" items={homeVillage(player.spells)} kind="spell" />
        <LevelGroup title="Hero equipment" items={equipment} kind="equipment" />
        <LevelGroup title="Builder base troops" items={builderBase(player.troops)} kind="troop" />
        <details className="group">
          <summary>Achievements ({player.achievements.length})</summary>
          <div className="group__body meter-grid">
            {player.achievements.map((achievement) => (
              <LevelRow
                key={achievement.name}
                name={`${achievement.name} · ${achievement.stars}★`}
                /* Completed achievements keep counting past their target, so the
                   meter clamps while the label keeps the true running total. */
                level={Math.min(achievement.value, achievement.target)}
                maxLevel={achievement.target}
                valueLabel={`${formatStat(achievement.value)}/${formatStat(achievement.target)}`}
                title={`${formatFull(achievement.value)} of ${formatFull(achievement.target)} — ${achievement.info}`}
              />
            ))}
          </div>
        </details>
      </Card>
    </>
  )
}
