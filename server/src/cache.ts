/**
 * In-memory response cache with request coalescing.
 *
 * The CoC API throttles per token, and a UI that renders a clan roster will ask
 * for the same clan repeatedly while you click around. Coalescing matters as
 * much as the TTL: without it, a burst of identical requests all miss the cache
 * and all hit the upstream API.
 */

interface Entry<T> {
  value: T
  expiresAt: number
}

export class TtlCache {
  #entries = new Map<string, Entry<unknown>>()
  #inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Runs `load` unless a fresh value — or an identical in-flight call — exists.
   * `ttlMsOverride` lets fast-moving data (a live war) expire sooner than the
   * default without giving up coalescing.
   */
  async wrap<T>(key: string, load: () => Promise<T>, ttlMsOverride?: number): Promise<T> {
    const ttlMs = ttlMsOverride ?? this.ttlMs
    if (ttlMs <= 0) return load()

    const hit = this.#entries.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value as T

    const pending = this.#inflight.get(key)
    if (pending) return pending as Promise<T>

    const promise = load()
      .then((value) => {
        this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs })
        return value
      })
      .finally(() => {
        this.#inflight.delete(key)
      })

    this.#inflight.set(key, promise)
    return promise
  }

  /** Drops expired entries. Called opportunistically; the map stays small. */
  prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key)
    }
  }

  get size(): number {
    return this.#entries.size
  }
}
