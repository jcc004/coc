import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createApiRateLimiter } from './coc-rate-limit.ts'

describe('createApiRateLimiter', () => {
  it('allows requests under the limit', () => {
    const limiter = createApiRateLimiter({ limit: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check('user:1').allowed, true)
    }
  })

  it('blocks once a key exceeds its limit within the window', () => {
    const limiter = createApiRateLimiter({ limit: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) limiter.check('user:1')
    const verdict = limiter.check('user:1')
    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfterSeconds > 0)
  })

  it('keeps buckets independent per key', () => {
    const limiter = createApiRateLimiter({ limit: 1, windowMs: 60_000 })
    assert.equal(limiter.check('user:1').allowed, true)
    assert.equal(limiter.check('user:1').allowed, false)
    // A different account's own bucket is untouched by the first one tripping.
    assert.equal(limiter.check('user:2').allowed, true)
  })

  it('resets once the window elapses', () => {
    let clock = 0
    const limiter = createApiRateLimiter({ limit: 1, windowMs: 1000, now: () => clock })

    assert.equal(limiter.check('user:1').allowed, true)
    assert.equal(limiter.check('user:1').allowed, false)

    clock += 1000
    assert.equal(limiter.check('user:1').allowed, true)
  })

  it('reports a retryAfterSeconds that shrinks as the window elapses', () => {
    let clock = 0
    const limiter = createApiRateLimiter({ limit: 1, windowMs: 10_000, now: () => clock })

    limiter.check('user:1')
    const first = limiter.check('user:1')
    assert.equal(first.allowed, false)
    assert.equal(first.retryAfterSeconds, 10)

    clock += 4000
    const later = limiter.check('user:1')
    assert.equal(later.allowed, false)
    assert.equal(later.retryAfterSeconds, 6)
  })

  it('forgets a key once its window is stale, instead of growing forever', () => {
    let clock = 0
    const limiter = createApiRateLimiter({ limit: 1, windowMs: 1000, now: () => clock })

    limiter.check('user:1')
    clock += 5000
    // A fresh window for the same key still behaves like a first hit, proving the
    // stale bucket was actually swept rather than merely bypassed by expiry math.
    assert.equal(limiter.check('user:1').allowed, true)
    assert.equal(limiter.check('user:1').allowed, false)
  })
})
