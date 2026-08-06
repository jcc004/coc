import { useEffect } from 'react'
import { ROLE_LABELS, type Player, type PlayerItemLevel, type SessionUser } from '@coc/shared'
import { api } from '../api.ts'
import { ownerCellFor } from '../owner-picker.ts'
import { ownerRecordFor, useOwners } from '../owners.ts'
import { labelIcon, leagueIcon } from '../coc-assets.ts'
import { formatFull, formatStat, ratio } from '../format.ts'
import { hrefFor, useAsync, type Recent } from '../hooks.ts'
import { artFor, type ArtKind } from '../wiki-art.ts'
import { PlayerCardPanel } from './PlayerCardPanel.tsx'
import { PlayerProgressPanel } from './PlayerProgressPanel.tsx'
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

/**
 * Whose base this is, beside the member name.
 *
 * The owner was only discoverable here by opening the card panel and reading a
 * refusal message — which is how two people came to disagree about who plays a base.
 * It belongs next to the name, because "who is this?" and "whose is it?" are the same
 * question asked of the same row.
 *
 * The three states come from `ownerCellFor`, the same tested rule the roster's picker
 * uses, so the player page and the clan page cannot disagree about what a cell means.
 * The distinction that matters is the third one: a **legacy label** is free text
 * somebody typed before accounts existed. It names a person but grants nobody
 * anything — not even the right to edit that base's card counts — so it is marked
 * rather than shown as though it were an assignment. That is precisely the confusion
 * this badge exists to end, so blurring it here would defeat the point.
 *
 * `accounts` is deliberately empty: `GET /api/admin/users` is admin-only, and the
 * label comes from the assignment, which everybody may read. An empty list only costs
 * the "did you mean this account" suggestion, which belongs on the admin's picker
 * rather than here.
 */
function OwnerBadge({ tag }: { tag: string }) {
  const cell = ownerCellFor(ownerRecordFor(useOwners(), tag), [])

  if (cell.kind === 'unassigned') {
    return (
      <p className="profile__owner profile__owner--none">
        No owner set — ask an admin to assign this base
      </p>
    )
  }

  if (cell.kind === 'legacy') {
    return (
      <p className="profile__owner profile__owner--legacy">
        Owner <strong>{cell.label}</strong>
        <span className="profile__owner-note">
          {' '}
          · a name typed before accounts existed, so it is not linked to one. Only an admin can
          edit this base's cards until it is.
        </span>
      </p>
    )
  }

  return (
    <p className="profile__owner">
      Owner <strong>{cell.label}</strong>
    </p>
  )
}

function homeVillage(items: PlayerItemLevel[] | undefined): PlayerItemLevel[] {
  return (items ?? []).filter((item) => item.village === 'home')
}

function builderBase(items: PlayerItemLevel[] | undefined): PlayerItemLevel[] {
  return (items ?? []).filter((item) => item.village === 'builderBase')
}

function HeroCard({ title, heroes }: { title: string; heroes: PlayerItemLevel[] }) {
  if (heroes.length === 0) return null
  return (
    <Card title={title}>
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
  )
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

export function PlayerView({
  tag,
  user,
  onLoaded,
}: {
  tag: string
  /** Passed to the card panel: only a base's owner may type counts into it. */
  user: SessionUser
  onLoaded: (entry: Recent) => void
}) {
  const state = useAsync<Player>((signal) => api.player(tag, signal), [tag])

  const player = state.status === 'ready' ? state.data : null
  useEffect(() => {
    if (player) onLoaded({ kind: 'player', tag: player.tag, name: player.name })
  }, [player, onLoaded])

  if (state.status === 'loading') return <Loading what={`player ${tag}`} />
  if (state.status === 'error') return <ErrorPanel error={state.error} />
  if (!player) return null

  const heroes = homeVillage(player.heroes)
  const builderHeroes = builderBase(player.heroes)
  const equipment = player.heroEquipment ?? []

  return (
    <>
      <Card>
        <div className="profile">
          <div className="profile__main">
            <h1 className="profile__name">{player.name}</h1>
            <TagButton tag={player.tag} />
            {/* Under the name rather than inside the meta line below: that line is
                game facts — Town Hall, level, clan — and ownership is a fact about
                this install, not about the player. */}
            <OwnerBadge tag={player.tag} />
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

      {/* Directly under the profile header, above the stats: a player page is a
          base in the card event, and the tag it is keyed by is this one. Collapsed,
          so sixty tiles cannot bury the rest of the page. */}
      <PlayerCardPanel tag={player.tag} name={player.name} user={user} />

      {/* Beside the card panel rather than folded into it: cards and weekly
          progress are two different weekly rituals sharing one base, not one
          feature. Same mount shape, same reason it needs the tag and the session
          user and nothing else picked for it. */}
      <PlayerProgressPanel tag={player.tag} name={player.name} user={user} />

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

      <HeroCard title="Heroes" heroes={heroes} />
      <HeroCard title="Builder base heroes" heroes={builderHeroes} />

      <Card title="Progression">
        <LevelGroup title="Home village troops" items={homeVillage(player.troops)} kind="troop" />
        <LevelGroup title="Spells" items={homeVillage(player.spells)} kind="spell" />
        <LevelGroup title="Hero equipment" items={equipment} kind="equipment" />
        <LevelGroup title="Builder base troops" items={builderBase(player.troops)} kind="troop" />
        <details className="group">
          <summary>Achievements ({player.achievements.length})</summary>
          <div className="group__body meter-grid">
            {player.achievements.map((achievement, index) => (
              <LevelRow
                /* Supercell's API has returned two entries with the identical name
                   for one account (a stale pre-rename "Keep Your Account Safe!"
                   alongside the current one), so `name` alone cannot key this list. */
                key={`${achievement.name}-${index}`}
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
