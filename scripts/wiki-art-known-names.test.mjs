import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KNOWN_ENTRIES, mergeKnownNames } from './wiki-art-known-names.mjs'

test('mergeKnownNames keeps every discovered entry', () => {
  const discovered = [{ kind: 'troop', name: 'Barbarian', village: 'home' }]
  const merged = mergeKnownNames(discovered, [])
  assert.deepEqual(merged, discovered)
})

test('mergeKnownNames adds a known entry the discovered list is missing', () => {
  const discovered = [{ kind: 'troop', name: 'Barbarian', village: 'home' }]
  const known = [{ kind: 'equipment', name: 'Vampstache', village: 'home' }]
  const merged = mergeKnownNames(discovered, known)
  assert.deepEqual(
    merged.map((e) => `${e.kind}:${e.name}`).sort(),
    ['equipment:Vampstache', 'troop:Barbarian'],
  )
})

test('mergeKnownNames dedups by kind:name and keeps the discovered copy', () => {
  const discovered = [{ kind: 'equipment', name: 'Vampstache', village: 'home', sampled: true }]
  const known = [{ kind: 'equipment', name: 'Vampstache', village: 'home' }]
  const merged = mergeKnownNames(discovered, known)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sampled, true)
})

test('mergeKnownNames does not collide equipment and troop entries of the same name', () => {
  // A pet name and a same-named future equipment item (hypothetical) must stay
  // separate — kinds are namespaced everywhere else in this app for exactly this
  // reason (see ArtKind in web/src/wiki-art.ts), and the merge key has to match.
  const discovered = [{ kind: 'troop', name: 'Frost Flake', village: 'home' }]
  const known = [{ kind: 'equipment', name: 'Frost Flake', village: 'home' }]
  const merged = mergeKnownNames(discovered, known)
  assert.equal(merged.length, 2)
})

test('KNOWN_ENTRIES has exactly the documented counts, no duplicates, and no Revenge Deck', () => {
  const equipment = KNOWN_ENTRIES.filter((e) => e.kind === 'equipment')
  const pets = KNOWN_ENTRIES.filter((e) => e.kind === 'troop')
  assert.equal(equipment.length, 41)
  assert.equal(pets.length, 12)

  const keys = KNOWN_ENTRIES.map((e) => `${e.kind}:${e.name}`)
  assert.equal(new Set(keys).size, keys.length)

  assert.ok(!equipment.some((e) => e.name === 'Revenge Deck'))
  assert.ok(KNOWN_ENTRIES.every((e) => e.village === 'home'))
})
