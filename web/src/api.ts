import {
  normalizeTag,
  type ApiErrorResponse,
  type Clan,
  type ClanMembersResponse,
  type ClanSearchResponse,
  type CurrentWar,
  type Player,
  type WarLogResponse,
} from '@coc/shared'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: 'application/json' } })

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiErrorResponse | undefined
    throw new ApiError(
      response.status,
      body?.error.reason ?? 'unknown',
      body?.error.message ?? `Request failed with status ${response.status}`,
      body?.error.hint,
    )
  }

  return (await response.json()) as T
}

const tagPath = (tag: string) => encodeURIComponent(normalizeTag(tag))

export const api = {
  player: (tag: string, signal?: AbortSignal) => get<Player>(`/api/players/${tagPath(tag)}`, signal),

  clan: (tag: string, signal?: AbortSignal) => get<Clan>(`/api/clans/${tagPath(tag)}`, signal),

  clanMembers: (tag: string, signal?: AbortSignal) =>
    get<ClanMembersResponse>(`/api/clans/${tagPath(tag)}/members`, signal),

  currentWar: (tag: string, signal?: AbortSignal) =>
    get<CurrentWar>(`/api/clans/${tagPath(tag)}/currentwar`, signal),

  warLog: (tag: string, signal?: AbortSignal) =>
    get<WarLogResponse>(`/api/clans/${tagPath(tag)}/warlog?limit=20`, signal),

  searchClans: (name: string, signal?: AbortSignal) =>
    get<ClanSearchResponse>(`/api/clans?name=${encodeURIComponent(name)}`, signal),
}
