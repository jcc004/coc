import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLoginLimiter } from './rate-limit.ts'

describe('createLoginLimiter', () => {
  it('allows a fresh email/IP pair', () => {
    const limiter = createLoginLimiter()
    const verdict = limiter.check({ email: 'new@example.com', ip: '1.2.3.4' })
    assert.equal(verdict.allowed, true)
    assert.equal(verdict.retryAfterSeconds, 0)
  })

  it('locks the email bucket after emailLimit failures', () => {
    const clock = 0
    const limiter = createLoginLimiter({ emailLimit: 3, ipLimit: 100, now: () => clock })
    const keys = { email: 'victim@example.com', ip: '' }

    limiter.recordFailure(keys)
    limiter.recordFailure(keys)
    assert.equal(limiter.check(keys).allowed, true, 'still under the limit at 2 failures')

    limiter.recordFailure(keys) // 3rd failure trips it
    const verdict = limiter.check(keys)
    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfterSeconds > 0)
  })

  it('locks the IP bucket independently, once its own looser limit trips', () => {
    const clock = 0
    const limiter = createLoginLimiter({ emailLimit: 2, ipLimit: 3, now: () => clock })
    const ip = '9.9.9.9'

    // Different emails sprayed from the same IP: each email's own bucket only takes
    // one failure, never enough to trip emailLimit, but the shared IP bucket accumulates.
    limiter.recordFailure({ email: 'user0@example.com', ip })
    limiter.recordFailure({ email: 'user1@example.com', ip })
    assert.equal(
      limiter.check({ email: 'user0@example.com', ip: '' }).allowed,
      true,
      "an individual email's own bucket is untouched by the IP-level spray",
    )
    assert.equal(limiter.check({ email: 'user2@example.com', ip }).allowed, true)

    limiter.recordFailure({ email: 'user2@example.com', ip }) // 3rd failure trips the IP bucket
    const verdict = limiter.check({ email: 'someone-new@example.com', ip })
    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfterSeconds > 0)
  })

  it('never uses an empty ip as a shared bucket key', () => {
    const clock = 0
    const limiter = createLoginLimiter({ emailLimit: 100, ipLimit: 2, now: () => clock })

    // Two different callers with no resolvable IP. If '' were used as a literal shared
    // key, alice's failures would trip the (tight) ipLimit and lock out bob too.
    limiter.recordFailure({ email: 'alice@example.com', ip: '' })
    limiter.recordFailure({ email: 'alice@example.com', ip: '' })
    limiter.recordFailure({ email: 'alice@example.com', ip: '' })

    assert.equal(limiter.check({ email: 'bob@example.com', ip: '' }).allowed, true)
  })

  it('recordSuccess clears the email bucket but leaves the IP bucket counting', () => {
    const clock = 0
    const limiter = createLoginLimiter({ emailLimit: 10, ipLimit: 3, now: () => clock })
    const keys = { email: 'carol@example.com', ip: '5.5.5.5' }

    limiter.recordFailure(keys)
    limiter.recordFailure(keys) // IP bucket now at 2 failures, one below its limit of 3

    limiter.recordSuccess(keys) // clears the email bucket only

    // The email bucket was reset, so this single new failure comes nowhere near the
    // (high) email limit of 10 on its own. But the IP bucket kept its earlier 2
    // failures uncleared - one more failure crosses ipLimit=3 and locks it, which
    // could only happen if recordSuccess left the IP side untouched.
    limiter.recordFailure(keys)
    const verdict = limiter.check(keys)
    assert.equal(verdict.allowed, false)
    assert.ok(verdict.retryAfterSeconds > 0)
  })

  it('unlocks once lockoutMs has actually elapsed', () => {
    let clock = 0
    const limiter = createLoginLimiter({
      emailLimit: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
      now: () => clock,
    })
    const keys = { email: 'dave@example.com', ip: '' }

    limiter.recordFailure(keys)
    limiter.recordFailure(keys) // trips the lock
    assert.equal(limiter.check(keys).allowed, false)

    clock += 60_000 // exactly lockoutMs later
    assert.equal(limiter.check(keys).allowed, true)
  })

  it('starts a fresh streak after unlocking, so one more failure does not instantly re-lock', () => {
    let clock = 0
    // A large window relative to the lockout isolates the fresh-streak reset in
    // bump() (rate-limit.ts:98-101) from sweep()'s separate window-expiry path,
    // which is covered on its own below.
    const limiter = createLoginLimiter({
      emailLimit: 2,
      windowMs: 1_000_000,
      lockoutMs: 60_000,
      now: () => clock,
    })
    const keys = { email: 'erin@example.com', ip: '' }

    limiter.recordFailure(keys)
    limiter.recordFailure(keys) // trips the lock; the stale failure count is reset to 0
    assert.equal(limiter.check(keys).allowed, false)

    clock += 60_000 // lockout elapses, but the failure window is still "current"
    assert.equal(limiter.check(keys).allowed, true)

    limiter.recordFailure(keys)
    // If the pre-lockout failure count had carried over, this single failure would
    // immediately reach emailLimit=2 again and re-lock. It must not.
    assert.equal(limiter.check(keys).allowed, true)
  })

  it('sweeps a stale bucket so it behaves identically to a never-touched key', () => {
    let clock = 0
    const limiter = createLoginLimiter({
      emailLimit: 2,
      windowMs: 10_000,
      lockoutMs: 10_000,
      now: () => clock,
    })
    const staleKeys = { email: 'frank@example.com', ip: '' }
    const freshKeys = { email: 'gwen@example.com', ip: '' }

    limiter.recordFailure(staleKeys)
    limiter.recordFailure(staleKeys) // locks, lockedUntil = 10_000

    clock += 100_000 // long past both the lockout and the failure window

    // A single failure on the aged-out key and a single failure on a key that was
    // never touched before must produce identical, allowed states - proving the
    // old bucket was actually collected rather than just papered over by expiry math.
    limiter.recordFailure(staleKeys)
    limiter.recordFailure(freshKeys)
    assert.equal(limiter.check(staleKeys).allowed, true)
    assert.equal(limiter.check(freshKeys).allowed, true)

    // And they lock in lockstep too: this is each key's 2nd failure since the reset.
    limiter.recordFailure(staleKeys)
    limiter.recordFailure(freshKeys)
    assert.equal(limiter.check(staleKeys).allowed, false)
    assert.equal(limiter.check(freshKeys).allowed, false)
  })
})
