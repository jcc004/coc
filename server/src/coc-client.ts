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

/**
 * Statuses worth a second attempt without asking the caller to click again: a rate
 * limit that may have cleared, and the 5xx band, which upstream returns for its own
 * transient trouble. Every other status (404, the 403 IP-binding/private-war-log
 * cases, a malformed request) is a real answer that retrying cannot change — see
 * {@link describeFailure}'s hints, which exist because those need a human to act,
 * not a client that tries again.
 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Never wait longer than this for one retry, `Retry-After` included — a request
 *  handler is waiting on the other end of this call, and a multi-second stall is a
 *  worse experience than surfacing the error and letting the existing 429 hint
 *  ("back off and retry") apply to the human instead. */
const MAX_RETRY_DELAY_MS = 3_000

export interface CocClientOptions {
  token: string
  baseUrl?: string
  /** Abort an upstream call that hangs. Defaults to 10s. */
  timeoutMs?: number
  /** Attempts beyond the first, for a retryable failure. Defaults to 2. */
  maxRetries?: number
  /** Injectable so a test does not have to wait on real backoff delays. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable so a test can fail a specific attempt without a real network call. */
  fetchImpl?: typeof fetch
}

type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CocApiError; retryAfterMs?: number }

export function createCocClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = 10_000,
  maxRetries = 2,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
}: CocClientOptions) {
  if (!token) {
    throw new Error(
      'COC_API_TOKEN is not set. Copy .env.example to .env and paste the token from ' +
        'https://developer.clashofclans.com/#/account',
    )
  }

  async function attempt<T>(url: URL, path: string): Promise<AttemptResult<T>> {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
      return {
        ok: false,
        error: new CocApiError(
          504,
          timedOut ? 'upstreamTimeout' : 'upstreamUnreachable',
          timedOut
            ? `Clash of Clans API did not respond within ${timeoutMs}ms`
            : `Could not reach the Clash of Clans API: ${(cause as Error).message}`,
        ),
      }
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as CocErrorBody | undefined
      const error = describeFailure(response.status, body, path)
      // Supercell's own number, when it sends one, wins over a guessed backoff —
      // but still capped, so a large value cannot turn one call into a long hang.
      const retryAfterHeader = response.headers.get('retry-after')
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
      const retryAfterMs =
        retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
          ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
          : undefined
      return { ok: false, error, retryAfterMs }
    }

    return { ok: true, value: (await response.json()) as T }
  }

  async function request<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }

    let lastError: CocApiError | undefined
    for (let n = 0; n <= maxRetries; n++) {
      const result = await attempt<T>(url, path)
      if (result.ok) return result.value

      lastError = result.error
      const canRetry = n < maxRetries && RETRYABLE_STATUS.has(result.error.status)
      if (!canRetry) throw result.error

      // Exponential backoff (300ms, 600ms, ...) when upstream gave no number of its
      // own, capped the same way a Retry-After value is.
      const backoffMs = Math.min(300 * 2 ** n, MAX_RETRY_DELAY_MS)
      await sleep(result.retryAfterMs ?? backoffMs)
    }

    // Unreachable while maxRetries >= 0: the loop above always either returns or
    // throws on its last iteration. Satisfies the return type without an assertion.
    throw lastError ?? new CocApiError(504, 'upstreamUnreachable', 'Clash of Clans API request failed.')
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
