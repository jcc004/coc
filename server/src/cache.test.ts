import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TtlCache } from './cache.ts'

/*
 * The cache in isolation, with no HTTP and no upstream.
 *
 * Coalescing is the property worth the most here and was previously untested
 * anywhere: it is the reason this is a class rather than a `Map` with timestamps,
 * because a page that renders a roster fires the same request several times before
 * the first answer lands, and without coalescing every one of those spends the
 * rate-limited Supercell token.
 */

/**
 * A loader that records every call and hands back a distinct value each time, so a
 * cached answer is distinguishable from a re-loaded one rather than merely equal.
 */
function countingLoader(prefix = 'v'): { load: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    load: async () => {
      calls += 1
      return `${prefix}${calls}`
    },
    calls: () => calls,
  }
}

/** A loader that does not settle until the returned `resolve` is called. */
function deferredLoader(): {
  load: () => Promise<string>
  resolve: (value: string) => void
  calls: () => number
} {
  let calls = 0
  let release: (value: string) => void = () => {}
  const settled = new Promise<string>((resolve) => {
    release = resolve
  })
  return {
    load: () => {
      calls += 1
      return settled
    },
    resolve: (value) => release(value),
    calls: () => calls,
  }
}

describe('a fresh value is served without calling the loader again', () => {
  it('loads once for two sequential reads of the same key', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1')
    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1', 'the second read is the cached one')
    assert.equal(loader.calls(), 1)
    assert.equal(cache.size, 1)
  })

  it('keys are independent — two keys are two loads', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1')
    assert.equal(await cache.wrap('clan:#B', loader.load), 'v2')
    assert.equal(cache.size, 2)
  })
})

describe('a value expires when its TTL is up', () => {
  it('reloads after the TTL has passed', async () => {
    // A 1ms TTL rather than a fake clock: the class reads `Date.now()` directly, and
    // waiting a couple of milliseconds is cheaper than injecting a clock for this.
    const cache = new TtlCache(1)
    const loader = countingLoader()

    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(await cache.wrap('clan:#A', loader.load), 'v2', 'the stale value must not serve')
    assert.equal(loader.calls(), 2)
  })

  it('replaces the expired entry rather than accumulating a second one', async () => {
    const cache = new TtlCache(1)
    const loader = countingLoader()

    await cache.wrap('clan:#A', loader.load)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await cache.wrap('clan:#A', loader.load)
    assert.equal(cache.size, 1, 'one key is one entry, however many times it is refreshed')
  })

  it('drops expired entries on prune and leaves fresh ones alone', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    await cache.wrap('short', loader.load, 1)
    await cache.wrap('long', loader.load)
    await new Promise((resolve) => setTimeout(resolve, 5))

    cache.prune()
    assert.equal(cache.size, 1)
    assert.equal(await cache.wrap('long', loader.load), 'v2', 'the surviving entry is the fresh one')
    assert.equal(loader.calls(), 2)
  })
})

describe('concurrent calls for one key are coalesced into one load', () => {
  it('runs the loader once for two overlapping calls and gives both the same value', async () => {
    const cache = new TtlCache(60_000)
    const loader = deferredLoader()

    // Both calls are made before either can settle, which is exactly the burst a
    // roster render produces. Without coalescing this is two upstream requests.
    const first = cache.wrap('clan:#A', loader.load)
    const second = cache.wrap('clan:#A', loader.load)
    assert.equal(loader.calls(), 1, 'the second caller must join the first, not start its own')

    loader.resolve('the clan')
    assert.deepEqual(await Promise.all([first, second]), ['the clan', 'the clan'])
    assert.equal(loader.calls(), 1)
  })

  it('coalesces ten callers as readily as two', async () => {
    const cache = new TtlCache(60_000)
    const loader = deferredLoader()

    const all = Array.from({ length: 10 }, () => cache.wrap('clan:#A', loader.load))
    loader.resolve('once')
    const values = await Promise.all(all)

    assert.deepEqual(values, Array.from({ length: 10 }, () => 'once'))
    assert.equal(loader.calls(), 1)
  })

  it('does not coalesce across different keys', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    const values = await Promise.all([
      cache.wrap('clan:#A', loader.load),
      cache.wrap('clan:#B', loader.load),
    ])
    assert.equal(new Set(values).size, 2, 'two keys must get two distinct answers')
    assert.equal(loader.calls(), 2)
  })

  it('stops coalescing once the in-flight call has settled', async () => {
    const cache = new TtlCache(1)
    const loader = countingLoader()

    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The in-flight map must have been cleared, or this would return v1 for ever.
    assert.equal(await cache.wrap('clan:#A', loader.load), 'v2')
  })
})

describe('ttlMsOverride applies to one call without disturbing the default', () => {
  it('expires an overridden key sooner than the cache default', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    await cache.wrap('war:#A', loader.load, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(await cache.wrap('war:#A', loader.load, 1), 'v2', 'the short TTL must win')
  })

  it('leaves other keys on the default TTL', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    await cache.wrap('war:#A', loader.load, 1)
    await cache.wrap('clan:#A', loader.load)
    await new Promise((resolve) => setTimeout(resolve, 5))

    await cache.wrap('war:#A', loader.load, 1)
    assert.equal(await cache.wrap('clan:#A', loader.load), 'v2', 'the default-TTL entry is intact')
  })

  it('still coalesces — a shorter TTL is not a licence to skip the cache', async () => {
    const cache = new TtlCache(60_000)
    const loader = deferredLoader()

    const both = [cache.wrap('war:#A', loader.load, 20_000), cache.wrap('war:#A', loader.load, 20_000)]
    assert.equal(loader.calls(), 1)
    loader.resolve('war')
    assert.deepEqual(await Promise.all(both), ['war', 'war'])
  })
})

describe('a non-positive TTL bypasses the cache entirely', () => {
  it('loads every time and stores nothing when the default TTL is zero', async () => {
    const cache = new TtlCache(0)
    const loader = countingLoader()

    assert.equal(await cache.wrap('clan:#A', loader.load), 'v1')
    assert.equal(await cache.wrap('clan:#A', loader.load), 'v2')
    assert.equal(cache.size, 0, 'a disabled cache must not hold anything')
  })

  it('treats a negative TTL the same as zero', async () => {
    const cache = new TtlCache(-1)
    const loader = countingLoader()

    await cache.wrap('clan:#A', loader.load)
    await cache.wrap('clan:#A', loader.load)
    assert.equal(loader.calls(), 2)
    assert.equal(cache.size, 0)
  })

  it('lets an override of zero disable caching for one key only', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    await cache.wrap('clan:#A', loader.load, 0)
    await cache.wrap('clan:#A', loader.load, 0)
    assert.equal(loader.calls(), 2)
    assert.equal(cache.size, 0)

    await cache.wrap('clan:#B', loader.load)
    assert.equal(cache.size, 1, 'the other key still caches normally')
  })

  it('does not coalesce a bypassed call, since there is nothing to coalesce against', async () => {
    const cache = new TtlCache(0)
    const loader = deferredLoader()

    const both = [cache.wrap('clan:#A', loader.load), cache.wrap('clan:#A', loader.load)]
    assert.equal(loader.calls(), 2, 'a bypass goes straight to the loader')
    loader.resolve('x')
    await Promise.all(both)
  })
})

describe('the entry count is bounded, oldest-first', () => {
  it('never exceeds the cap, however many distinct keys arrive', async () => {
    // The clan-search key embeds the caller's `?name=`, so distinct keys are
    // effectively unlimited. This is that, in miniature.
    const cache = new TtlCache(60_000, 3)
    const loader = countingLoader()

    for (let index = 0; index < 50; index += 1) {
      await cache.wrap(`clanSearch:${index}`, loader.load)
    }
    assert.equal(cache.size, 3)
  })

  it('evicts the oldest key and keeps the newest', async () => {
    const cache = new TtlCache(60_000, 2)
    const loader = countingLoader()

    await cache.wrap('a', loader.load)
    await cache.wrap('b', loader.load)
    await cache.wrap('c', loader.load)

    // `a` went; `b` and `c` are still cached, so neither costs a load.
    assert.equal(loader.calls(), 3)
    assert.equal(await cache.wrap('b', loader.load), 'v2')
    assert.equal(await cache.wrap('c', loader.load), 'v3')
    assert.equal(loader.calls(), 3, 'the two survivors must be served from the cache')

    assert.equal(await cache.wrap('a', loader.load), 'v4', 'and the evicted one reloads')
  })

  /*
   * The expiry this test needs is `a`'s, and only `a`'s — so it comes from a
   * per-call `ttlMsOverride`, the way the neighbouring eviction test does it,
   * rather than from a cache-wide TTL.
   *
   * It was written with `new TtlCache(1, 2)`: a one-millisecond TTL for everything,
   * which made the closing assertion a race against the clock. The refreshed `a` was
   * inserted with that same 1 ms lifetime, so it only read back as `v3` if the very
   * next line ran inside a millisecond — true in isolation, and false roughly one
   * run in fifteen of the full suite, which reported `v4` instead. A test that has
   * to win a race to pass is worse than no test: it teaches you to re-run rather
   * than to read the failure.
   */
  it('refreshing an existing key evicts nothing, because it replaces rather than adds', async () => {
    const cache = new TtlCache(60_000, 2)
    const loader = countingLoader()

    await cache.wrap('a', loader.load, 1) // 1 ms, so only this key goes stale
    await cache.wrap('b', loader.load) // the default 60 s
    await new Promise((resolve) => setTimeout(resolve, 5))

    // `a` has expired, so this reloads it and re-inserts under the default TTL. The
    // insert replaces a key that was already there, so it must make no room.
    assert.equal(await cache.wrap('a', loader.load), 'v3')

    assert.equal(cache.size, 2, 'the cap still holds')
    // The point: `b` was not evicted to seat a key the map already held. Read back
    // without a third load, which is what proves it was still cached.
    assert.equal(await cache.wrap('b', loader.load), 'v2', 'b survived the refresh of a')
    assert.equal(loader.calls(), 3, 'a loaded twice, b once')
  })

  it('prefers expired entries when it has to drop one', async () => {
    const cache = new TtlCache(60_000, 2)
    const loader = countingLoader()

    await cache.wrap('stale', loader.load, 1)
    await cache.wrap('fresh', loader.load)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await cache.wrap('new', loader.load)

    // `fresh` was inserted before `new` and would go first under blind FIFO; it
    // survives because the expired `stale` is cleared first.
    assert.equal(await cache.wrap('fresh', loader.load), 'v2')
    assert.equal(loader.calls(), 3)
  })
})

describe('a failed load is not remembered', () => {
  it('rejects the caller and caches nothing', async () => {
    const cache = new TtlCache(60_000)

    await assert.rejects(
      () => cache.wrap('clan:#A', () => Promise.reject(new Error('upstream is down'))),
      /upstream is down/,
    )
    assert.equal(cache.size, 0, 'a failure must not become a cached answer')
  })

  it('retries on the next call rather than replaying the failure', async () => {
    const cache = new TtlCache(60_000)
    let attempts = 0
    const flaky = async (): Promise<string> => {
      attempts += 1
      if (attempts === 1) throw new Error('rate limited')
      return 'recovered'
    }

    await assert.rejects(() => cache.wrap('clan:#A', flaky))
    assert.equal(await cache.wrap('clan:#A', flaky), 'recovered')
    assert.equal(cache.size, 1)
  })

  it('gives every coalesced caller the same rejection', async () => {
    const cache = new TtlCache(60_000)
    let calls = 0
    let fail: (error: Error) => void = () => {}
    const settled = new Promise<string>((_resolve, reject) => {
      fail = reject
    })
    const load = (): Promise<string> => {
      calls += 1
      return settled
    }

    const both = [cache.wrap('clan:#A', load), cache.wrap('clan:#A', load)]
    assert.equal(calls, 1)
    fail(new Error('upstream is down'))

    // Both callers must hear about it — a silent undefined would be worse than the
    // error, and one of them succeeding would be incoherent.
    const results = await Promise.allSettled(both)
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected'],
    )
    assert.equal(cache.size, 0)
  })

  it('leaves entries already cached under other keys untouched', async () => {
    const cache = new TtlCache(60_000)
    const loader = countingLoader()

    await cache.wrap('good', loader.load)
    await assert.rejects(() => cache.wrap('bad', () => Promise.reject(new Error('nope'))))

    assert.equal(cache.size, 1)
    assert.equal(await cache.wrap('good', loader.load), 'v1')
    assert.equal(loader.calls(), 1)
  })
})
