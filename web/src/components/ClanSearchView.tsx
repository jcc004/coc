import type { ClanSearchResponse } from '@coc/shared'
import { api } from '../api.ts'
import { formatFull } from '../format.ts'
import { hrefFor, useAsync } from '../hooks.ts'
import { Card, ErrorPanel, Loading } from './primitives.tsx'

export function ClanSearchView({ name }: { name: string }) {
  const state = useAsync<ClanSearchResponse>((signal) => api.searchClans(name, signal), [name])

  if (state.status === 'loading') return <Loading what={`clans matching “${name}”`} />
  if (state.status === 'error') return <ErrorPanel error={state.error} />
  if (state.status !== 'ready') return null

  const clans = state.data.items

  return (
    <Card title={`${clans.length} clans matching “${name}”`}>
      {clans.length === 0 ? (
        <p className="empty-hint">No clans found. Clan search matches on name only.</p>
      ) : (
        <ul className="result-list">
          {clans.map((clan) => (
            <li key={clan.tag}>
              <img src={clan.badgeUrls.small} alt="" />
              <div>
                <a href={hrefFor({ view: 'clan', tag: clan.tag })}>{clan.name}</a>
                <div className="result-list__meta">
                  {clan.tag} · Level {clan.clanLevel} · {clan.members}/50
                  {clan.location ? ` · ${clan.location.name}` : ''}
                </div>
              </div>
              <div className="result-list__stats">
                {formatFull(clan.clanPoints)} pts
                <br />
                {formatFull(clan.requiredTrophies)} required
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
