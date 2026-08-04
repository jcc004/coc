/**
 * Login throttling. In-memory on purpose: one process, ten accounts, and a
 * counter that resets on restart is an acceptable cost against not needing a
 * second store. It is a brute-force brake, not an audit log.
 *
 * Two independent buckets, never a global one:
 *
 * - **email** — tight (5 failures), because that is the credential actually
 *   under attack. Locking it costs one person one lockout window.
 * - **client IP** — loose (30 failures), to slow someone spraying many
 *   addresses from one host. It has to stay loose because the whole household or
 *   office can share an IP, and a strict IP limit would let one wrong password
 *   lock out everyone behind that NAT.
 *
 * An empty `ip` — no forwarded header and no socket address — skips the IP bucket
 * entirely rather than filing every caller under one placeholder key. A shared key
 * is a counter that can lock out the app as a whole, which is the failure mode that
 * matters most when the tool has one admin and no other way in.
 */

export interface LimiterKeys {
  /** Normalised login credential. Lowercased again here so the bucket is stable. */
  email: string
  /** `''` when it cannot be determined; the IP bucket is then not used. */
  ip: string
}

export interface LimitVerdict {
  allowed: boolean
  /** Seconds until the caller may try again. 0 when allowed. */
  retryAfterSeconds: number
}

export interface LoginLimiter {
  check(keys: LimiterKeys): LimitVerdict
  recordFailure(keys: LimiterKeys): void
  /**
   * Called on a successful login. Clears the *email* bucket, so a near-miss streak
   * by the legitimate owner does not linger and lock them out later in the session.
   * The IP bucket is deliberately left standing: one correct password proves nothing
   * about the failures around it, and clearing the loose 30-failure brake here would
   * hand someone spraying that host a free reset every time they guessed an account
   * right — which is the exact case that bucket exists to survive.
   */
  recordSuccess(keys: LimiterKeys): void
}

export interface LimiterOptions {
  /** Failures allowed per email before it locks. */
  emailLimit?: number
  /** Failures allowed per client IP before it locks. */
  ipLimit?: number
  /** Failures older than this stop counting. */
  windowMs?: number
  /** How long a bucket stays locked once it trips. */
  lockoutMs?: number
  now?: () => number
}

interface Bucket {
  failures: number
  firstFailureAt: number
  lockedUntil: number
}

export function createLoginLimiter(options: LimiterOptions = {}): LoginLimiter {
  const emailLimit = options.emailLimit ?? 5
  const ipLimit = options.ipLimit ?? 30
  const windowMs = options.windowMs ?? 15 * 60_000
  const lockoutMs = options.lockoutMs ?? 15 * 60_000
  const now = options.now ?? Date.now

  const buckets = new Map<string, Bucket>()

  /** Keeps the map from growing without bound on a public host. */
  function sweep(at: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.lockedUntil <= at && bucket.firstFailureAt + windowMs <= at) buckets.delete(key)
    }
  }

  function verdictFor(key: string, at: number): number {
    const bucket = buckets.get(key)
    if (!bucket || bucket.lockedUntil <= at) return 0
    return Math.ceil((bucket.lockedUntil - at) / 1000)
  }

  function bump(key: string, limit: number, at: number): void {
    const existing = buckets.get(key)
    const bucket =
      existing && existing.firstFailureAt + windowMs > at
        ? existing
        : { failures: 0, firstFailureAt: at, lockedUntil: 0 }

    bucket.failures += 1
    if (bucket.failures >= limit) {
      bucket.lockedUntil = at + lockoutMs
      // Start a fresh streak, so the next failure after the lockout expires does
      // not instantly re-lock on a stale count.
      bucket.failures = 0
      bucket.firstFailureAt = at
    }
    buckets.set(key, bucket)
  }

  const userKey = (email: string) => `u:${email.toLowerCase()}`
  const ipKey = (ip: string) => `i:${ip}`

  return {
    check({ email, ip }) {
      const at = now()
      sweep(at)
      const retryAfterSeconds = Math.max(
        verdictFor(userKey(email), at),
        ip ? verdictFor(ipKey(ip), at) : 0,
      )
      return { allowed: retryAfterSeconds === 0, retryAfterSeconds }
    },

    recordFailure({ email, ip }) {
      const at = now()
      bump(userKey(email), emailLimit, at)
      if (ip) bump(ipKey(ip), ipLimit, at)
    },

    recordSuccess({ email }) {
      // Email bucket only; `ip` is left out on purpose — see `LoginLimiter` above.
      buckets.delete(userKey(email))
    },
  }
}
