/**
 * In-memory response cache with request coalescing.
 *
 * The CoC API throttles per token, and a UI that renders a clan roster will ask
 * for the same clan repeatedly while you click around. Coalescing matters as
 * much as the TTL: without it, a burst of identical requests all miss the cache
 * and all hit the upstream API.
 *
 * Bounded in two directions: a value expires after its TTL, and the map never holds
 * more than `maxEntries` — see {@link DEFAULT_MAX_ENTRIES} for why the second bound
 * is not redundant.
 */

interface Entry<T> {
  value: T
  expiresAt: number
}

/**
 * The most values held at once, before the oldest is dropped to make room.
 *
 * Sized against what this install can legitimately be looking at: ten members, a
 * handful of clans, a roster of about fifty players, times the seven cacheable
 * endpoints — low hundreds of keys at the very worst. 500 is comfortably above that
 * and far below the point where holding them matters.
 *
 * A bound is needed at all because one key is partly the caller's to choose:
 * `clanSearch:` embeds the `?name=` they typed, so distinct searches mint distinct
 * keys with no natural ceiling, and `prune()` drops only *expired* entries and only
 * once a minute. An authenticated caller could hold tens of MB for a 60-second
 * window just by searching. This is not a hostile-internet threat — every route
 * here needs a session — but it is a way for one member to degrade the server for
 * the other nine, which no amount of trust makes acceptable.
 */
const DEFAULT_MAX_ENTRIES = 500

export class TtlCache {
  #entries = new Map<string, Entry<unknown>>()
  #inflight = new Map<string, Promise<unknown>>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /**
   * Makes room for `key`, oldest-first. A key already present needs no room, since
   * storing it replaces a row rather than adding one.
   *
   * Insertion order is the eviction order, which `Map` gives for free — a hit
   * deliberately does **not** re-insert its key. That makes this FIFO rather than
   * LRU, and FIFO is the right trade here: entries live for one TTL and then die
   * anyway, so recency buys almost nothing, and an LRU would mean either a
   * dependency or a hand-rolled linked list to maintain. Expired entries go first,
   * so a full-but-stale cache evicts nothing that is still useful.
   */
  #makeRoom(key: string): void {
    if (this.#entries.has(key) || this.#entries.size < this.maxEntries) return

    this.prune()

    // `keys()` yields insertion order, so this walks oldest-first. A loop rather
    // than one delete because `maxEntries` can be set lower than the current size.
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size < this.maxEntries) break
      this.#entries.delete(oldest)
    }
  }

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
        // On the way in, not on the way out: a rejected `load` must leave the cache
        // exactly as it was, so a failed upstream call is retried rather than
        // remembered.
        this.#makeRoom(key)
        this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs })
        return value
      })
      .finally(() => {
        this.#inflight.delete(key)
      })

    this.#inflight.set(key, promise)
    return promise
  }

  /**
   * Drops expired entries. Called on a timer from `index.ts` and again whenever the
   * cache is full, so it is housekeeping rather than the thing keeping the map
   * bounded — that is `maxEntries`.
   */
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
