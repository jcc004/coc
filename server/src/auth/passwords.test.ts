import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hashPassword, verifyPassword } from './passwords.ts'

describe('password hashing', () => {
  it('verifies the password it was derived from', () => {
    const record = hashPassword('correct horse battery staple')
    assert.equal(verifyPassword('correct horse battery staple', record), true)
  })

  it('rejects a wrong password', () => {
    const record = hashPassword('correct horse battery staple')
    assert.equal(verifyPassword('correct horse battery stapl', record), false)
    assert.equal(verifyPassword('', record), false)
    assert.equal(verifyPassword('CORRECT HORSE BATTERY STAPLE', record), false)
  })

  it('never stores the password, and salts each record separately', () => {
    const a = hashPassword('same password for both')
    const b = hashPassword('same password for both')

    assert.notEqual(a.salt, b.salt)
    // Same input, different hash — so a stolen file cannot be attacked once for
    // every account that happens to share a password.
    assert.notEqual(a.hash, b.hash)
    assert.equal(a.hash.includes('same password'), false)
  })

  it('records the cost parameters in the hash so they can be raised later', () => {
    const record = hashPassword('correct horse battery staple')
    assert.match(record.hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{128}$/)
  })

  it('verifies a hash written with different cost parameters', () => {
    // Simulates an old row after N has been raised: the stored params win.
    const cheap = { hash: 'scrypt$1024$8$1$', salt: 'aabb' }
    const derived = hashPassword('x')
    assert.equal(verifyPassword('x', { hash: cheap.hash, salt: cheap.salt }), false)
    assert.equal(verifyPassword('x', derived), true)
  })

  it('returns false rather than throwing on a corrupt hash column', () => {
    assert.equal(verifyPassword('anything', { hash: '', salt: '' }), false)
    assert.equal(verifyPassword('anything', { hash: 'not-a-hash', salt: 'aa' }), false)
    assert.equal(verifyPassword('anything', { hash: 'bcrypt$1$1$1$aa', salt: 'aa' }), false)
  })
})
