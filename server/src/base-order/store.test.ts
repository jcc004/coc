import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAuthStore } from '../auth/store.ts'
import { openDatabase } from '../db.ts'
import { createBaseOrderStore } from './store.ts'

// `user_id` is a real FK onto `users(id)` (ON DELETE CASCADE), so the tests need
// actual account rows rather than bare integers — the same reason
// `cards/cards.test.ts` seeds accounts through `createAuthStore` rather than
// writing a raw INSERT.
async function harness() {
  const db = openDatabase(':memory:')
  const auth = createAuthStore(db)
  const first = await auth.createUser({
    email: 'first@example.test',
    displayName: 'First',
    password: 'first-user-password',
    role: 'user',
  })
  const second = await auth.createUser({
    email: 'second@example.test',
    displayName: 'Second',
    password: 'second-user-password',
    role: 'user',
  })
  return { store: createBaseOrderStore(db), first: first.id, second: second.id }
}

describe('base order store', () => {
  it('answers an empty order for a user who has never saved one', async () => {
    const { store, first } = await harness()
    assert.deepEqual(store.getOrder(first), [])
  })

  it('round-trips a saved order', async () => {
    const { store, first } = await harness()
    store.setOrder(first, ['#AAABBB', '#CCCDDD'])
    assert.deepEqual(store.getOrder(first), ['#AAABBB', '#CCCDDD'])
  })

  it('upsert replaces the whole order rather than appending to it', async () => {
    const { store, first } = await harness()
    store.setOrder(first, ['#AAABBB', '#CCCDDD'])
    store.setOrder(first, ['#CCCDDD', '#AAABBB'])
    assert.deepEqual(
      store.getOrder(first),
      ['#CCCDDD', '#AAABBB'],
      'the second save must overwrite the first, not add a second row',
    )
  })

  it('keeps different users’ orders apart', async () => {
    const { store, first, second } = await harness()
    store.setOrder(first, ['#AAABBB'])
    store.setOrder(second, ['#CCCDDD'])
    assert.deepEqual(store.getOrder(first), ['#AAABBB'])
    assert.deepEqual(store.getOrder(second), ['#CCCDDD'])
  })
})
