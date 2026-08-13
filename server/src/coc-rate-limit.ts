/**
 * Throttles the CoC-API proxy routes (`/api/players/:tag`, `/api/clans/...`) per
 * signed-in account. In-memory, like `auth/rate-limit.ts`, for the same reason: one
 * process, ten accounts, a counter that resets on restart.
 *
 * This is a different threat from login brute-forcing. Every proxy route is already
 * behind `requireAuth`, so the caller is a known account, not an anonymous guesser —
 * what this defends is the *cache*, not the credential. `cache.wrap`'s key is built
 * from the request's own parameters (tag, search filters, limit), so a caller who
 * varies them forces a fresh upstream call per request, spending the one
 * rate-limited Supercell token the whole app shares. Nginx's blanket 20 r/s already
 * bounds this crudely at the edge; this is the same idea scoped to what actually
 * matters — one account hammering fresh cache keys — rather than to raw request
 * volume, which a normal session (several tabs polling the same few tags) can
 * legitimately produce.
 *
 * A fixed window, not a sliding one: this is a "stop hammering it" brake, not a
 * precise fairness guarantee, and a fixed window is the simpler thing that still
 * does that job.
 */

export interface ApiRateVerdict {
  allowed: boolean
  /** Seconds until the window resets. 0 when allowed. */
  retryAfterSeconds: number
}

export interface ApiRateLimiter {
  check(key: string): ApiRateVerdict
}

export interface ApiRateLimiterOptions {
  /** Requests allowed per key per window. */
  limit?: number
  windowMs?: number
  now?: () => number
}

interface Bucket {
  count: number
  windowStart: number
}

/**
 * 120 requests/minute per account: generous enough that a normal session — several
 * tabs open on a clan's roster, war, and raid pages, each polling independently —
 * never comes close, while still being a real ceiling on a caller minting a fresh
 * cache key every request.
 */
const DEFAULT_LIMIT = 120
const DEFAULT_WINDOW_MS = 60_000

export function createApiRateLimiter(options: ApiRateLimiterOptions = {}): ApiRateLimiter {
  const limit = options.limit ?? DEFAULT_LIMIT
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const now = options.now ?? Date.now

  const buckets = new Map<string, Bucket>()

  /** Keeps the map from growing without bound over the process's lifetime. */
  function sweep(at: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.windowStart + windowMs <= at) buckets.delete(key)
    }
  }

  return {
    check(key) {
      const at = now()
      sweep(at)

      const existing = buckets.get(key)
      if (!existing || existing.windowStart + windowMs <= at) {
        buckets.set(key, { count: 1, windowStart: at })
        return { allowed: true, retryAfterSeconds: 0 }
      }

      existing.count += 1
      if (existing.count > limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((existing.windowStart + windowMs - at) / 1000),
        }
      }
      return { allowed: true, retryAfterSeconds: 0 }
    },
  }
}
