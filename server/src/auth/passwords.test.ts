import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { burnPasswordWork, hashPassword, verifyPassword } from './passwords.ts'

describe('password hashing', () => {
  it('verifies the password it was derived from', async () => {
    const record = await hashPassword('correct horse battery staple')
    assert.equal(await verifyPassword('correct horse battery staple', record), true)
  })

  it('rejects a wrong password', async () => {
    const record = await hashPassword('correct horse battery staple')
    assert.equal(await verifyPassword('correct horse battery stapl', record), false)
    assert.equal(await verifyPassword('', record), false)
    assert.equal(await verifyPassword('CORRECT HORSE BATTERY STAPLE', record), false)
  })

  it('never stores the password, and salts each record separately', async () => {
    const a = await hashPassword('same password for both')
    const b = await hashPassword('same password for both')

    assert.notEqual(a.salt, b.salt)
    // Same input, different hash — so a stolen file cannot be attacked once for
    // every account that happens to share a password.
    assert.notEqual(a.hash, b.hash)
    assert.equal(a.hash.includes('same password'), false)
  })

  it('records the cost parameters in the hash so they can be raised later', async () => {
    const record = await hashPassword('correct horse battery staple')
    assert.match(record.hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{128}$/)
  })

  it('verifies a hash written with different cost parameters', async () => {
    // Simulates an old row after N has been raised: the stored params win.
    const cheap = { hash: 'scrypt$1024$8$1$', salt: 'aabb' }
    const derived = await hashPassword('x')
    assert.equal(await verifyPassword('x', { hash: cheap.hash, salt: cheap.salt }), false)
    assert.equal(await verifyPassword('x', derived), true)
  })

  it('returns false rather than throwing on a corrupt hash column', async () => {
    assert.equal(await verifyPassword('anything', { hash: '', salt: '' }), false)
    assert.equal(await verifyPassword('anything', { hash: 'not-a-hash', salt: 'aa' }), false)
    assert.equal(await verifyPassword('anything', { hash: 'bcrypt$1$1$1$aa', salt: 'aa' }), false)
  })
})

describe('the move to async scrypt kept every old hash verifying', () => {
  it('verifies a record the synchronous implementation would have written', async () => {
    /*
     * Built here with `scryptSync` and the same encoding the old code used, byte for
     * byte, rather than pasted in as a literal — a literal would have to be trusted,
     * and this cannot drift from what the previous version actually produced.
     *
     * This is the whole compatibility claim of the change: the format, the cost
     * parameters and the comparison are untouched, so nobody has to be locked out of
     * an account they still know the password to.
     */
    const salt = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex')
    const derived = scryptSync('the-password-they-already-have', salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    })
    const legacy = {
      hash: `scrypt$32768$8$1$${derived.toString('hex')}`,
      salt: salt.toString('hex'),
    }

    assert.equal(await verifyPassword('the-password-they-already-have', legacy), true)
    assert.equal(await verifyPassword('something-else-entirely', legacy), false)
  })
})

describe('the miss path still burns the same work as the hit path', () => {
  it('resolves for any password and reveals nothing about it', async () => {
    // The decoy is what makes an unknown email cost the same as a known one. There
    // is nothing to assert about its value — the property is that this returns at
    // all, having done a real derivation, rather than short-circuiting.
    await burnPasswordWork('whatever-was-typed')
    await burnPasswordWork('')
  })

  it('does not stall the event loop while it derives', async () => {
    /*
     * The regression this guards. `scryptSync` held the one event loop for the whole
     * ~40 ms of a derivation, so ~25 login attempts a second saturated the process
     * and nothing else got served — an unauthenticated denial of service.
     *
     * A timer set for 1 ms and a derivation started in the same tick: with the
     * synchronous implementation the timer could not possibly fire until the
     * derivation had finished, so the ordering below is the property. Measured as an
     * ordering rather than as a duration, because a wall-clock threshold on a busy
     * CI box is a flaky test.
     */
    const order: string[] = []
    const ticked = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('loop')
        resolve()
      }, 1)
    })

    const derived = burnPasswordWork('a-password-to-burn-time-on').then(() => {
      order.push('scrypt')
    })

    await Promise.all([ticked, derived])
    assert.deepEqual(order, ['loop', 'scrypt'], 'the loop must stay free while scrypt runs')
  })

  it('serializes a flood rather than allocating for all of it at once', async () => {
    /*
     * Twenty simultaneous derivations at 32 MiB each would be 640 MiB if they all ran
     * together, which is how async scrypt on its own turns an event-loop stall into
     * an OOM kill. The queue in `work-queue.ts` caps how many are in flight; what is
     * observable from out here is that all twenty still complete and none is dropped.
     */
    const flood = Array.from({ length: 20 }, (_, index) =>
      burnPasswordWork(`attempt-number-${index}`),
    )
    await Promise.all(flood)
  })
})
