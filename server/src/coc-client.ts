import {
  encodeTagForPath,
  type CapitalRaidSeasonsResponse,
  type Clan,
  type ClanMembersResponse,
  type ClanSearchResponse,
  type CocErrorBody,
  type CurrentWar,
  type Player,
  type WarLogResponse,
} from '@coc/shared'

const DEFAULT_BASE_URL = 'https://api.clashofclans.com/v1'

export class CocApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'CocApiError'
  }
}

/**
 * Turns an upstream failure into something actionable.
 *
 * 403 is the one that needs context. On most endpoints it means the token's IP
 * binding no longer matches. But on the war endpoints it overwhelmingly means
 * the clan has set its war log to private — verified: a private-war-log clan
 * returns 403 accessDenied for both /currentwar and /warlog. Showing the IP
 * hint there would send you chasing the wrong problem.
 *
 * /capitalraidseasons is deliberately *not* in that branch: verified against
 * four private-war-log clans, it answers 200 with full raid history. A 403 there
 * really is the IP binding, so it gets the default hint.
 */
function describeFailure(
  status: number,
  body: CocErrorBody | undefined,
  path: string,
): CocApiError {
  const reason = body?.reason ?? 'unknown'
  const message = body?.message ?? `Clash of Clans API returned ${status}`
  const isWarPath = /\/(currentwar|warlog)/.test(path)

  const hints: Record<number, string> = {
    403: isWarPath
      ? 'This clan keeps its war log private, which also hides the current war. ' +
        'Nothing to fix — only the clan can change that. (If every request is failing, ' +
        'not just wars, it is your key’s IP binding instead.)'
      : 'Your API key is bound to a specific IP address, and the message above names the ' +
        'one Supercell actually saw. Mint a key for THAT address at ' +
        'https://developer.clashofclans.com/#/account and update COC_API_TOKEN. It is the ' +
        "host's *outbound* address, which on a host behind a reserved or floating IP is not " +
        'the address its DNS points at.',
    404: 'Check the tag — a typo or a deleted account both look like this.',
    429: 'Rate limited by Supercell. Back off and retry; raise CACHE_TTL_SECONDS to reduce calls.',
    503: 'Clash of Clans is in maintenance. Nothing to fix on this end — wait it out.',
  }

  return new CocApiError(status, reason, message, hints[status])
}

export interface CocClientOptions {
  token: string
  baseUrl?: string
  /** Abort an upstream call that hangs. Defaults to 10s. */
  timeoutMs?: number
}

export function createCocClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 10_000,
}: CocClientOptions) {
  if (!token) {
    throw new Error(
      'COC_API_TOKEN is not set. Copy .env.example to .env and paste the token from ' +
        'https://developer.clashofclans.com/#/account',
    )
  }

  async function request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }

    let response: Response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
      throw new CocApiError(
        504,
        timedOut ? 'upstreamTimeout' : 'upstreamUnreachable',
        timedOut
          ? `Clash of Clans API did not respond within ${timeoutMs}ms`
          : `Could not reach the Clash of Clans API: ${(cause as Error).message}`,
      )
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as CocErrorBody | undefined
      throw describeFailure(response.status, body, path)
    }

    return (await response.json()) as T
  }

  return {
    getPlayer(tag: string): Promise<Player> {
      return request(`/players/${encodeTagForPath(tag)}`)
    },

    getClan(tag: string): Promise<Clan> {
      return request(`/clans/${encodeTagForPath(tag)}`)
    },

    getClanMembers(tag: string, limit?: number): Promise<ClanMembersResponse> {
      return request(`/clans/${encodeTagForPath(tag)}/members`, { limit })
    },

    getCurrentWar(tag: string): Promise<CurrentWar> {
      return request(`/clans/${encodeTagForPath(tag)}/currentwar`)
    },

    getWarLog(tag: string, limit?: number): Promise<WarLogResponse> {
      return request(`/clans/${encodeTagForPath(tag)}/warlog`, { limit: limit ?? 20 })
    },

    getCapitalRaidSeasons(tag: string, limit?: number): Promise<CapitalRaidSeasonsResponse> {
      return request(`/clans/${encodeTagForPath(tag)}/capitalraidseasons`, { limit: limit ?? 10 })
    },

    searchClans(params: {
      name?: string
      minMembers?: number
      maxMembers?: number
      minClanLevel?: number
      limit?: number
    }): Promise<ClanSearchResponse> {
      return request('/clans', { ...params, limit: params.limit ?? 20 })
    },
  }
}

export type CocClient = ReturnType<typeof createCocClient>
